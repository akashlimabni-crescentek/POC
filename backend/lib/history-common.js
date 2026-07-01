'use strict';

/** Lookback windows for first hot-promotion backfill (seconds) */
const LOOKBACK_SECONDS = {
  '1m': 7 * 24 * 60 * 60,
  '5m': 7 * 24 * 60 * 60,
  '1h': 90 * 24 * 60 * 60,
  '1d': 365 * 24 * 60 * 60,
};

/** Incremental poll lookback (seconds) */
const INCREMENTAL_LOOKBACK_SECONDS = 2 * 60 * 60;

/** Kalshi GET /markets/candlesticks — max candlesticks per request (API limit 10000) */
const KALSHI_MAX_CANDLES_PER_REQUEST = 9000;

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

function getFetchWindow(isFirstBackfill, interval) {
  const nowSec = Math.floor(Date.now() / 1000);
  if (isFirstBackfill) {
    return {
      startTs: nowSec - (LOOKBACK_SECONDS[interval] ?? LOOKBACK_SECONDS['1m']),
      endTs: nowSec,
    };
  }
  return {
    startTs: nowSec - INCREMENTAL_LOOKBACK_SECONDS,
    endTs: nowSec,
  };
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
  LOOKBACK_SECONDS,
  INCREMENTAL_LOOKBACK_SECONDS,
  KALSHI_MAX_CANDLES_PER_REQUEST,
  getFetchWindow,
  splitTimeWindowsForCandles,
  toCandleRows,
  maxCandleTs,
  mergeLastCandleTs,
  chunkArray,
};
