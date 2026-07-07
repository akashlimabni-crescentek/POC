'use strict';

/** Intervals persisted by the Kalshi history worker (no 1m). */
const STORED_INTERVALS = ['5m', '15m', '1h', '4h', '1d', '1w'];

/** Lookback windows for first hot-promotion backfill (seconds). */
const LOOKBACK_SECONDS = {
  '1m': 7 * 24 * 60 * 60, // polymarket/history only — Kalshi does not store 1m
  '5m': 30 * 24 * 60 * 60,
  '15m': 30 * 24 * 60 * 60,
  '1h': 90 * 24 * 60 * 60,
  '4h': 90 * 24 * 60 * 60,
  '1d': 365 * 24 * 60 * 60,
  '1w': 365 * 24 * 60 * 60,
};

/** Rolling window for polymarket/history incremental trade replay. */
const INCREMENTAL_LOOKBACK_SECONDS = 2 * 60 * 60;

const INTERVAL_MS = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
};

/** Kalshi GET /markets/candlesticks — max candlesticks per request (API limit 10000) */
const KALSHI_MAX_CANDLES_PER_REQUEST = 9000;

function getIntervalMs(interval) {
  const ms = INTERVAL_MS[interval];
  if (!ms) {
    throw new Error(`[history-common] unknown interval: ${interval}`);
  }
  return ms;
}

/**
 * Unix-second window for the most recently **closed** bucket of `interval`.
 * Example: at 09:20 with 5m buckets → { startTs: 09:15, endTs: 09:20 }.
 */
function getLastClosedBucketWindowSec(interval, nowSec = Math.floor(Date.now() / 1000)) {
  const bucketSec = getIntervalMs(interval) / 1000;
  const bucketMs = getIntervalMs(interval);
  const currentBucketStartMs = Math.floor((nowSec * 1000) / bucketMs) * bucketMs;
  const lastClosedBucketStartMs = currentBucketStartMs - bucketMs;
  const startSec = Math.floor(lastClosedBucketStartMs / 1000);
  const endSec = Math.floor(currentBucketStartMs / 1000);
  return {
    startTs: startSec,
    endTs: endSec,
    bucketStartIso: new Date(lastClosedBucketStartMs).toISOString(),
  };
}

/** Full lookback window for first promotion backfill. */
function getFirstBackfillWindow(interval) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    startTs: nowSec - (LOOKBACK_SECONDS[interval] ?? LOOKBACK_SECONDS['5m']),
    endTs: nowSec,
  };
}

/**
 * @deprecated Use getFirstBackfillWindow or getLastClosedBucketWindowSec.
 * Kept for polymarket/history compatibility.
 */
function getFetchWindow(isFirstBackfill, interval) {
  if (isFirstBackfill) {
    return getFirstBackfillWindow(interval);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  // Polymarket history replays trades over a rolling 2h window.
  if (interval === '1m') {
    return {
      startTs: nowSec - INCREMENTAL_LOOKBACK_SECONDS,
      endTs: nowSec,
    };
  }
  return getLastClosedBucketWindowSec(interval, nowSec);
}

/** True when a new closed bucket exists that we have not persisted yet. */
function isIntervalDue(interval, lastCandleTs, nowSec = Math.floor(Date.now() / 1000)) {
  const { bucketStartIso } = getLastClosedBucketWindowSec(interval, nowSec);
  if (!lastCandleTs) {
    return true;
  }
  return lastCandleTs < bucketStartIso;
}

function splitTimeWindowsForCandles(startTs, endTs, periodMinutes, tickerCount = 1) {
  const perTicker = Math.max(
    1,
    Math.floor(KALSHI_MAX_CANDLES_PER_REQUEST / Math.max(1, tickerCount))
  );
  const chunkSec = perTicker * periodMinutes * 60;
  const windows = [];
  let start = startTs;

  while (start < endTs) {
    const end = Math.min(endTs, start + chunkSec);
    windows.push({ startTs: start, endTs: end });
    if (end <= start) {
      break;
    }
    start = end;
  }

  return windows;
}

function toCandleRows(marketId, interval, candles) {
  return candles.map((c) => ({
    market_id: marketId,
    interval,
    ts: c.ts,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume ?? 0,
    trade_count: c.trade_count ?? 0,
  }));
}

function maxCandleTs(candles) {
  if (!candles.length) return null;
  return candles.reduce((max, c) => (c.ts > max ? c.ts : max), candles[0].ts);
}

function mergeLastCandleTs(existing, updates) {
  const merged = { ...(existing ?? {}) };
  for (const [interval, ts] of Object.entries(updates)) {
    if (!ts) continue;
    if (!merged[interval] || ts > merged[interval]) {
      merged[interval] = ts;
    }
  }
  return merged;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

module.exports = {
  STORED_INTERVALS,
  LOOKBACK_SECONDS,
  INCREMENTAL_LOOKBACK_SECONDS,
  INTERVAL_MS,
  KALSHI_MAX_CANDLES_PER_REQUEST,
  getIntervalMs,
  getLastClosedBucketWindowSec,
  getFirstBackfillWindow,
  getFetchWindow,
  isIntervalDue,
  splitTimeWindowsForCandles,
  toCandleRows,
  maxCandleTs,
  mergeLastCandleTs,
  chunkArray,
};
