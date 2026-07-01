'use strict';

const { CLOSED_STATUSES } = require('./tiers');

/** Retention policy — mirrors pg_cron jobs in 006_retention.sql */
const LIVE_TICKS_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const CANDLE_RETENTION_MS = {
  '1m': 30 * 24 * 60 * 60 * 1000,
  '5m': 90 * 24 * 60 * 60 * 1000,
  '1h': 2 * 365 * 24 * 60 * 60 * 1000,
  '1d': 2 * 365 * 24 * 60 * 60 * 1000,
};

/** Grace after market close before deleting all candles for that market */
const CLOSED_MARKET_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

const CLOSED_MARKET_DELETE_BATCH = 50;

function toIso(ms) {
  return new Date(ms).toISOString();
}

/**
 * Cutoff timestamps for each purge step (testable).
 * @param {number} [nowMs]
 */
function getRetentionCutoffs(nowMs = Date.now()) {
  return {
    liveTicks: toIso(nowMs - LIVE_TICKS_MAX_AGE_MS),
    candles: Object.fromEntries(
      Object.entries(CANDLE_RETENTION_MS).map(([interval, ageMs]) => [
        interval,
        toIso(nowMs - ageMs),
      ])
    ),
    closedMarketGrace: toIso(nowMs - CLOSED_MARKET_GRACE_MS),
  };
}

/**
 * Markets closed longer than grace — uses market.close_time or event.close_time.
 * @param {Array<{ id: number, close_time?: string|null, events?: { close_time?: string|null }|null }>} markets
 * @param {string} graceCutoffIso
 */
function filterStaleClosedMarkets(markets, graceCutoffIso) {
  const graceMs = Date.parse(graceCutoffIso);
  if (Number.isNaN(graceMs)) {
    return [];
  }

  return (markets ?? [])
    .filter((market) => {
      const closeTime = market.close_time ?? market.events?.close_time ?? null;
      if (!closeTime) {
        return false;
      }
      const closedMs = Date.parse(closeTime);
      return !Number.isNaN(closedMs) && closedMs < graceMs;
    })
    .map((market) => market.id);
}

function sumDeleted(counts) {
  return Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
}

async function deleteWithCount(supabase, table, applyFilters) {
  let query = supabase.from(table).delete({ count: 'exact' });
  query = applyFilters(query);
  const { count, error } = await query;
  if (error) {
    throw new Error(`${table} delete: ${error.message}`);
  }
  return count ?? 0;
}

async function purgeLiveTicks(supabase, cutoffIso) {
  return deleteWithCount(supabase, 'live_ticks', (q) => q.lt('ts', cutoffIso));
}

async function purgeCandlesByInterval(supabase, interval, cutoffIso) {
  return deleteWithCount(supabase, 'candles', (q) =>
    q.eq('interval', interval).lt('ts', cutoffIso)
  );
}

async function loadClosedMarkets(supabase) {
  const { data, error } = await supabase
    .from('markets')
    .select('id, close_time, events(close_time)')
    .in('status', CLOSED_STATUSES);

  if (error) {
    throw new Error(`markets closed lookup: ${error.message}`);
  }

  return data ?? [];
}

async function purgeClosedMarketCandles(supabase, graceCutoffIso) {
  const markets = await loadClosedMarkets(supabase);
  const staleIds = filterStaleClosedMarkets(markets, graceCutoffIso);
  if (staleIds.length === 0) {
    return 0;
  }

  let deleted = 0;
  for (let i = 0; i < staleIds.length; i += CLOSED_MARKET_DELETE_BATCH) {
    const batch = staleIds.slice(i, i + CLOSED_MARKET_DELETE_BATCH);
    const count = await deleteWithCount(supabase, 'candles', (q) => q.in('market_id', batch));
    deleted += count;
  }

  return deleted;
}

/**
 * Run full retention cycle (fallback when pg_cron unavailable).
 * @returns {Promise<{ deleted: Record<string, number>, total: number, demoted: number }>}
 */
async function runRetentionCycle(supabase, demoteStale) {
  const cutoffs = getRetentionCutoffs();
  const deleted = {
    live_ticks: await purgeLiveTicks(supabase, cutoffs.liveTicks),
    candles_1m: await purgeCandlesByInterval(supabase, '1m', cutoffs.candles['1m']),
    candles_5m: await purgeCandlesByInterval(supabase, '5m', cutoffs.candles['5m']),
    candles_1h: await purgeCandlesByInterval(supabase, '1h', cutoffs.candles['1h']),
    candles_1d: await purgeCandlesByInterval(supabase, '1d', cutoffs.candles['1d']),
    closed_markets: await purgeClosedMarketCandles(supabase, cutoffs.closedMarketGrace),
  };

  const demoted = await demoteStale(supabase);

  return {
    deleted,
    total: sumDeleted(deleted),
    demoted,
  };
}

module.exports = {
  LIVE_TICKS_MAX_AGE_MS,
  CANDLE_RETENTION_MS,
  CLOSED_MARKET_GRACE_MS,
  CLOSED_MARKET_DELETE_BATCH,
  getRetentionCutoffs,
  filterStaleClosedMarkets,
  sumDeleted,
  purgeLiveTicks,
  purgeCandlesByInterval,
  purgeClosedMarketCandles,
  runRetentionCycle,
};
