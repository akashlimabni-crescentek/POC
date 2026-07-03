import type { CandleRow, LiveTickRow } from './types';

function tickPrice(tick: LiveTickRow): number | null {
  return tick.mid ?? tick.last_price ?? tick.ask ?? tick.bid ?? null;
}

function floorToBucket(tsMs: number, bucketMs: number): number {
  return Math.floor(tsMs / bucketMs) * bucketMs;
}

/**
 * Apply a live tick to OHLCV candle rows without refetching history.
 * Updates the last bucket or appends a new candle when the tick crosses a bucket boundary.
 */
export function applyLiveTickToCandles(
  candles: CandleRow[],
  tick: LiveTickRow,
  bucketMs?: number
): CandleRow[] {
  const price = tickPrice(tick);
  if (price == null) {
    return candles;
  }

  const tickMs = Date.parse(tick.ts);
  if (Number.isNaN(tickMs)) {
    return candles;
  }

  if (!candles.length) {
    const bucketStart = bucketMs ? floorToBucket(tickMs, bucketMs) : tickMs;
    return [
      {
        market_id: tick.market_id,
        interval: '1m',
        ts: new Date(bucketStart).toISOString(),
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 0,
        trade_count: 0,
      },
    ];
  }

  const last = candles[candles.length - 1];
  const lastMs = Date.parse(last.ts);
  const tickBucket = bucketMs ? floorToBucket(tickMs, bucketMs) : lastMs;
  const lastBucket = bucketMs ? floorToBucket(lastMs, bucketMs) : lastMs;

  if (bucketMs && tickBucket > lastBucket) {
    const next = [...candles];
    next.push({
      ...last,
      ts: new Date(tickBucket).toISOString(),
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 0,
      trade_count: 0,
    });
    return next;
  }

  const next = [...candles];
  const updated = { ...last };
  updated.close = price;
  updated.high = Math.max(updated.high ?? price, price);
  updated.low = Math.min(updated.low ?? price, price);
  next[next.length - 1] = updated;
  return next;
}
