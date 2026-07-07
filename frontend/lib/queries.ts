import type { SupabaseClient } from '@supabase/supabase-js';
import { createBrowserClient } from './supabase/client';
import { logCandleRows, logCandleRowsByInterval } from './candle-debug';
import { pickRelation } from './utils';
import type {
  CandleInterval,
  CandleRow,
  EventRow,
  MarketPriceLatest,
  MarketRow,
  Provider,
} from './types';

const DEFAULT_PAGE_SIZE = 50;

const CANDLE_LOOKBACK_MS: Record<CandleInterval, number> = {
  '1m': 7 * 24 * 60 * 60 * 1000,
  '5m': 30 * 24 * 60 * 60 * 1000,
  '15m': 30 * 24 * 60 * 60 * 1000,
  '1h': 90 * 24 * 60 * 60 * 1000,
  '4h': 90 * 24 * 60 * 60 * 1000,
  '1d': 365 * 24 * 60 * 60 * 1000,
  '1w': 365 * 24 * 60 * 60 * 1000,
};

export async function getProviders(supabase: SupabaseClient): Promise<Provider[]> {
  const { data, error } = await supabase.from('providers').select('id, slug, name').order('id');

  if (error) {
    throw new Error(`getProviders failed: ${error.message}`);
  }

  return data ?? [];
}

export async function getEvents(
  supabase: SupabaseClient,
  providerSlug: string,
  options: { page?: number; limit?: number; search?: string } = {}
): Promise<{ events: EventRow[]; total: number }> {
  const page = Math.max(1, options.page ?? 1);
  const limit = options.limit ?? DEFAULT_PAGE_SIZE;
  const offset = (page - 1) * limit;
  const search = options.search?.trim() ?? '';

  const { data: provider, error: providerError } = await supabase
    .from('providers')
    .select('id')
    .eq('slug', providerSlug)
    .maybeSingle();

  if (providerError) {
    throw new Error(`getEvents provider lookup failed: ${providerError.message}`);
  }

  if (!provider) {
    return { events: [], total: 0 };
  }

  let query = supabase
    .from('events')
    .select('id, provider_id, external_id, title, slug, category, close_time, status, updated_at', {
      count: 'exact',
    })
    .eq('provider_id', provider.id);

  if (search) {
    query = query.ilike('title', `%${search}%`);
  }

  const { data, error, count } = await query
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    throw new Error(`getEvents failed: ${error.message}`);
  }

  return { events: data ?? [], total: count ?? 0 };
}

export async function getEventById(
  supabase: SupabaseClient,
  eventId: number
): Promise<EventRow | null> {
  const { data, error } = await supabase
    .from('events')
    .select(
      'id, provider_id, external_id, title, slug, category, close_time, status, updated_at, providers(slug, name)'
    )
    .eq('id', eventId)
    .maybeSingle();

  if (error) {
    throw new Error(`getEventById failed: ${error.message}`);
  }

  return data;
}

export async function getEventMarkets(
  supabase: SupabaseClient,
  eventId: number
): Promise<MarketRow[]> {
  const { data, error } = await supabase
    .from('markets')
    .select(
      'id, event_id, provider_id, external_id, title, outcome_label, status, close_time, ingestion_tier, market_prices_latest(*)'
    )
    .eq('event_id', eventId)
    .order('id');

  if (error) {
    throw new Error(`getEventMarkets failed: ${error.message}`);
  }

  return data ?? [];
}

export async function getMarketById(
  supabase: SupabaseClient,
  marketId: number
): Promise<MarketRow | null> {
  const { data, error } = await supabase
    .from('markets')
    .select(
      'id, event_id, provider_id, external_id, title, outcome_label, status, close_time, ingestion_tier, market_prices_latest(*), events(id, title), providers(slug, name)'
    )
    .eq('id', marketId)
    .maybeSingle();

  if (error) {
    throw new Error(`getMarketById failed: ${error.message}`);
  }

  return data;
}

/**
 * Index-friendly candle query: market_id + interval + ts range.
 */
export async function getCandles(
  supabase: SupabaseClient,
  marketId: number,
  interval: CandleInterval,
  from?: string,
  to?: string
): Promise<CandleRow[]> {
  const now = Date.now();
  const fromIso =
    from ?? new Date(now - CANDLE_LOOKBACK_MS[interval]).toISOString();
  const toIso = to ?? new Date(now).toISOString();

  console.log('[candle] getCandles → DB query', {
    source: 'history-table',
    fn: 'getCandles',
    market_id: marketId,
    interval,
    from: fromIso,
    to: toIso,
    note: 'Completed historical bars (forming bucket is stripped client-side)',
  });

  const { data, error } = await supabase
    .from('candles')
    .select('market_id, interval, ts, open, high, low, close, volume, trade_count')
    .eq('market_id', marketId)
    .eq('interval', interval)
    .gte('ts', fromIso)
    .lte('ts', toIso)
    .order('ts', { ascending: true });

  if (error) {
    throw new Error(`getCandles failed: ${error.message}`);
  }

  const rows = data ?? [];
  logCandleRows('[candle] getCandles ← DB result', rows, {
    source: 'history-table',
    fn: 'getCandles',
    market_id: marketId,
    interval,
    from: fromIso,
    to: toIso,
  });

  return rows;
}


/**
 * Fetch the finer stored candles that fall inside the current forming bucket,
 * for every interval in `ladder`, in one round-trip. Used to reconstruct the
 * right-edge candle without waiting for its own coarse row to be written.
 * Returns rows grouped by interval so the composer can step down the ladder.
 */
export async function getFinerCandlesForBucket(
  supabase: SupabaseClient,
  marketId: number,
  ladder: CandleInterval[],
  bucketStartIso: string,
  toIso: string,
  meta?: { reason?: string; callSeq?: number }
): Promise<Record<string, CandleRow[]>> {
  const byInterval: Record<string, CandleRow[]> = {};
  for (const iv of ladder) {
    byInterval[iv] = [];
  }

  if (ladder.length === 0) {
    return byInterval;
  }

  console.log('[candle] getFinerCandlesForBucket → DB query', {
    source: 'history-table',
    fn: 'getFinerCandlesForBucket',
    reason: meta?.reason ?? 'unknown',
    callSeq: meta?.callSeq ?? null,
    market_id: marketId,
    intervals: ladder,
    bucketFrom: bucketStartIso,
    bucketTo: toIso,
    note: 'Finer stored candles inside the current forming bucket (not the completed history bars)',
  });

  const { data, error } = await supabase
    .from('candles')
    .select('market_id, interval, ts, open, high, low, close, volume, trade_count')
    .eq('market_id', marketId)
    .in('interval', ladder)
    .gte('ts', bucketStartIso)
    .lte('ts', toIso)
    .order('ts', { ascending: true });

  if (error) {
    throw new Error(`getFinerCandlesForBucket failed: ${error.message}`);
  }

  for (const row of data ?? []) {
    (byInterval[row.interval] ??= []).push(row);
  }

  // logCandleRowsByInterval('[candle] getFinerCandlesForBucket ← DB result', byInterval, {
  //   source: 'history-table',
  //   fn: 'getFinerCandlesForBucket',
  //   reason: meta?.reason ?? 'unknown',
  //   callSeq: meta?.callSeq ?? null,
  //   market_id: marketId,
  //   bucketFrom: bucketStartIso,
  //   bucketTo: toIso,
  //   totalRows: (data ?? []).length,
  // });

  return byInterval;
}

/**
 * Promote all active/open markets for an event to hot tier (browser only).
 */
export async function promoteEventToHot(eventId: number): Promise<void> {
  const supabase = createBrowserClient();
  const { error } = await supabase.rpc('promote_event_to_hot', {
    p_event_id: eventId,
  });

  if (error) {
    throw new Error(`promote_event_to_hot failed: ${error.message}`);
  }
}

export function pickLatestPrice(market: {
  market_prices_latest?: MarketPriceLatest | MarketPriceLatest[] | null;
}): MarketPriceLatest | null {
  return pickRelation(market.market_prices_latest);
}
