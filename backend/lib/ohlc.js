'use strict';

/** Max flat candles to synthesize when market is quiet (3 hours at 1m) */
const GAP_FILL_CAP = 36;

/** Evict per-token in-memory state after 24h with no real tick */
const TOKEN_EVICTION_MS = 24 * 60 * 60 * 1000;

const INTERVAL_MS = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};

const AGGREGATION_CHAIN = {
  '5m': '1m',
  '1h': '5m',
  '1d': '1h',
};

function getBucketMs(interval) {
  const ms = INTERVAL_MS[interval];
  if (!ms) {
    throw new Error(`[ohlc] unknown interval: ${interval}`);
  }
  return ms;
}

function toMs(ts) {
  return typeof ts === 'number' ? ts : new Date(ts).getTime();
}

function floorToBucket(ts, intervalMs) {
  const t = toMs(ts);
  return Math.floor(t / intervalMs) * intervalMs;
}

function bucketIso(ts) {
  return new Date(ts).toISOString();
}

function createBucket(ts, price) {
  const p = Number(price);
  return {
    ts: bucketIso(ts),
    open: p,
    high: p,
    low: p,
    close: p,
    volume: 0,
    trade_count: 0,
  };
}

/** Update OHLC from a price tick (bid/ask/mid/last). Prices are 0–1 probability. */
function applyTick(bucket, price) {
  if (price == null || Number.isNaN(Number(price))) {
    return bucket;
  }
  const p = Number(price);
  bucket.high = Math.max(bucket.high, p);
  bucket.low = Math.min(bucket.low, p);
  bucket.close = p;
  return bucket;
}

/**
 * Apply a trade: volume += size (0 if missing/≤0), trade_count += 1.
 * Never mix count into volume (CHT-02).
 */
function applyTrade(bucket, price, size) {
  applyTick(bucket, price);
  const vol = size != null && Number(size) > 0 ? Number(size) : 0;
  bucket.volume += vol;
  bucket.trade_count += 1;
  return bucket;
}

/**
 * Synthesize flat candles for quiet periods between last written and current bucket.
 * Capped at GAP_FILL_CAP buckets; only most recent cap filled if gap exceeds limit.
 */
function computeGapFills(lastWrittenBucketTs, currentBucketTs, lastKnownClose, intervalMs, options = {}) {
  if (lastKnownClose == null || lastWrittenBucketTs == null) {
    return { fills: [], capExceeded: false };
  }

  const cap = options.cap ?? GAP_FILL_CAP;
  const lastMs = floorToBucket(lastWrittenBucketTs, intervalMs);
  const currentMs = floorToBucket(currentBucketTs, intervalMs);
  const close = Number(lastKnownClose);

  const fills = [];
  let nextMs = lastMs + intervalMs;

  while (nextMs < currentMs) {
    fills.push({
      ts: bucketIso(nextMs),
      open: close,
      high: close,
      low: close,
      close,
      volume: 0,
      trade_count: 0,
    });
    nextMs += intervalMs;
  }

  if (fills.length > cap) {
    if (options.onCapExceeded) {
      options.onCapExceeded({ gap: fills.length, cap });
    }
    return { fills: fills.slice(-cap), capExceeded: true };
  }

  return { fills, capExceeded: false };
}

/** True when per-token state should be evicted (24h idle). */
function shouldEvict(lastRealTickAt, now = Date.now()) {
  if (!lastRealTickAt) {
    return true;
  }
  return now - toMs(lastRealTickAt) >= TOKEN_EVICTION_MS;
}

/**
 * Aggregate lower-interval candles into a higher interval bucket.
 * @param {Array<{ts, open, high, low, close, volume, trade_count}>} sourceCandles
 * @param {'5m'|'1h'|'1d'} targetInterval
 */
function aggregateCandles(sourceCandles, targetInterval) {
  const intervalMs = getBucketMs(targetInterval);
  const buckets = new Map();

  const sorted = [...sourceCandles].sort((a, b) => toMs(a.ts) - toMs(b.ts));

  for (const candle of sorted) {
    const bucketStart = floorToBucket(candle.ts, intervalMs);
    let bucket = buckets.get(bucketStart);

    if (!bucket) {
      bucket = {
        ts: bucketIso(bucketStart),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume ?? 0,
        trade_count: candle.trade_count ?? 0,
      };
      buckets.set(bucketStart, bucket);
    } else {
      bucket.high = Math.max(bucket.high, candle.high);
      bucket.low = Math.min(bucket.low, candle.low);
      bucket.close = candle.close;
      bucket.volume += candle.volume ?? 0;
      bucket.trade_count += candle.trade_count ?? 0;
    }
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([, v]) => v);
}

/**
 * Roll up candles through the chain (e.g. 1m → 5m → 1h → 1d).
 */
function aggregateToInterval(sourceCandles, sourceInterval, targetInterval) {
  const order = ['1m', '5m', '1h', '1d'];
  const fromIdx = order.indexOf(sourceInterval);
  const toIdx = order.indexOf(targetInterval);

  if (fromIdx === -1 || toIdx === -1 || fromIdx >= toIdx) {
    throw new Error(`[ohlc] invalid aggregation ${sourceInterval} → ${targetInterval}`);
  }

  let current = sourceCandles;
  for (let i = fromIdx + 1; i <= toIdx; i++) {
    current = aggregateCandles(current, order[i]);
  }
  return current;
}

module.exports = {
  GAP_FILL_CAP,
  TOKEN_EVICTION_MS,
  INTERVAL_MS,
  AGGREGATION_CHAIN,
  getBucketMs,
  floorToBucket,
  createBucket,
  applyTick,
  applyTrade,
  computeGapFills,
  shouldEvict,
  aggregateCandles,
  aggregateToInterval,
};
