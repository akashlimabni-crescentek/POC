import type { SupabaseClient } from '@supabase/supabase-js';
import type { LiveTickRow, MarketIngestionStateRow, MarketPriceLatest } from './types';

export type RealtimeUnsubscribe = () => void;

type PostgresHandler<T> = (row: T) => void;

const LOG_PREFIX = '[realtime]';

function realtimeApiUrl(): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/$/, '');
  return base ? `${base}/realtime/v1/websocket` : 'unknown';
}

function logChannelStatus(
  channelName: string,
  table: string,
  marketIds: number[],
  status: string,
  err?: Error
): void {
  const api = realtimeApiUrl();
  const meta = { api, channel: channelName, table, marketIds };

  if (status === 'SUBSCRIBED') {
    console.log(`${LOG_PREFIX} WebSocket connected`, meta);
    return;
  }

  if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
    console.error(`${LOG_PREFIX} WebSocket failed`, { ...meta, status, error: err?.message });
    return;
  }

  if (status === 'CLOSED') {
    console.log(`${LOG_PREFIX} WebSocket closed`, meta);
  }
}

function logRealtimeData(
  table: string,
  payload: { eventType?: string; new: Record<string, unknown> }
): void {
  const row = payload.new;
  const receivedAt = new Date().toISOString();

  const base = {
    source: 'realtime-push',
    table,
    event: payload.eventType ?? 'UNKNOWN',
    market_id: row.market_id,
    receivedAt,
  };

  if (table === 'market_prices_latest') {
    console.log(`${LOG_PREFIX} live data received (no page refresh)`, {
      ...base,
      last_price: row.last_price,
      mid: row.mid,
      bid: row.bid,
      ask: row.ask,
      updated_at: row.updated_at,
    });
    return;
  }

  if (table === 'live_ticks') {
    console.log(`${LOG_PREFIX} live data received (no page refresh)`, {
      ...base,
      ts: row.ts,
      last_price: row.last_price,
      mid: row.mid,
    });
    return;
  }

  if (table === 'market_ingestion_state') {
    console.log(`${LOG_PREFIX} live data received (no page refresh)`, {
      ...base,
      tier: row.tier,
      last_backfill_at: row.last_backfill_at,
      last_poll_ts: row.last_poll_ts,
    });
  }
}

function handlePayload<T extends { market_id: number }>(
  table: string,
  payload: { eventType?: string; new: unknown },
  onUpdate: PostgresHandler<T>
): void {
  if (!payload.new || typeof payload.new !== 'object') {
    return;
  }

  logRealtimeData(table, payload as { eventType?: string; new: Record<string, unknown> });
  onUpdate(payload.new as T);
}

function subscribeTable<T extends { market_id: number }>(
  supabase: SupabaseClient,
  channelName: string,
  table: 'market_prices_latest' | 'live_ticks' | 'market_ingestion_state',
  marketId: number,
  onUpdate: PostgresHandler<T>
): RealtimeUnsubscribe {
  const channel = supabase
    .channel(channelName)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table,
        filter: `market_id=eq.${marketId}`,
      },
      (payload) => {
        handlePayload(table, payload, onUpdate);
      }
    )
    .subscribe((status, err) => {
      logChannelStatus(channelName, table, [marketId], status, err);
    });

  return () => {
    console.log(`${LOG_PREFIX} unsubscribed`, { channel: channelName, table, marketIds: [marketId] });
    supabase.removeChannel(channel);
  };
}

function subscribeTableMany<T extends { market_id: number }>(
  supabase: SupabaseClient,
  channelName: string,
  table: 'market_prices_latest' | 'live_ticks' | 'market_ingestion_state',
  marketIds: number[],
  onUpdate: PostgresHandler<T>
): RealtimeUnsubscribe {
  if (!marketIds.length) {
    return () => {};
  }

  let channel = supabase.channel(channelName);

  for (const marketId of marketIds) {
    channel = channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table,
        filter: `market_id=eq.${marketId}`,
      },
      (payload) => {
        handlePayload(table, payload, onUpdate);
      }
    );
  }

  channel.subscribe((status, err) => {
    logChannelStatus(channelName, table, marketIds, status, err);
  });

  return () => {
    console.log(`${LOG_PREFIX} unsubscribed`, { channel: channelName, table, marketIds });
    supabase.removeChannel(channel);
  };
}

/** Subscribe to market_prices_latest for a single market. */
export function subscribeMarketPrices(
  supabase: SupabaseClient,
  marketId: number,
  onUpdate: PostgresHandler<MarketPriceLatest>
): RealtimeUnsubscribe {
  return subscribeTable(supabase, `market-prices-${marketId}`, 'market_prices_latest', marketId, onUpdate);
}

/** Subscribe to market_prices_latest for multiple markets on one channel. */
export function subscribeMarketPricesMany(
  supabase: SupabaseClient,
  channelKey: string,
  marketIds: number[],
  onUpdate: PostgresHandler<MarketPriceLatest>
): RealtimeUnsubscribe {
  return subscribeTableMany(supabase, channelKey, 'market_prices_latest', marketIds, onUpdate);
}

/** Subscribe to live_ticks for a single market. */
export function subscribeLiveTicks(
  supabase: SupabaseClient,
  marketId: number,
  onUpdate: PostgresHandler<LiveTickRow>
): RealtimeUnsubscribe {
  return subscribeTable(supabase, `live-ticks-${marketId}`, 'live_ticks', marketId, onUpdate);
}

/** Subscribe to live_ticks for multiple markets on one channel. */
export function subscribeLiveTicksMany(
  supabase: SupabaseClient,
  channelKey: string,
  marketIds: number[],
  onUpdate: PostgresHandler<LiveTickRow>
): RealtimeUnsubscribe {
  return subscribeTableMany(supabase, channelKey, 'live_ticks', marketIds, onUpdate);
}

/** Subscribe to market_ingestion_state for a single market. */
export function subscribeMarketIngestionState(
  supabase: SupabaseClient,
  marketId: number,
  onUpdate: PostgresHandler<MarketIngestionStateRow>
): RealtimeUnsubscribe {
  return subscribeTable(
    supabase,
    `ingestion-state-${marketId}`,
    'market_ingestion_state',
    marketId,
    onUpdate
  );
}

/** Subscribe to market_ingestion_state for multiple markets on one channel. */
export function subscribeMarketIngestionStateMany(
  supabase: SupabaseClient,
  channelKey: string,
  marketIds: number[],
  onUpdate: PostgresHandler<MarketIngestionStateRow>
): RealtimeUnsubscribe {
  return subscribeTableMany(supabase, channelKey, 'market_ingestion_state', marketIds, onUpdate);
}
