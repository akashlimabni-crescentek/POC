import type { CandleRow, LiveTickRow, MarketPriceLatest } from './types';

function tickPrice(tick: LiveTickRow): number | null {
  return tick.mid ?? tick.last_price ?? tick.ask ?? tick.bid ?? null;
}

function floorToBucket(tsMs: number, bucketMs: number): number {
  return Math.floor(tsMs / bucketMs) * bucketMs;
}

/**
 * Fold a single realtime price observation into OHLCV candle rows without
 * refetching history. Updates the current bucket's high/low/close, or appends a
 * fresh candle when the observation crosses into a new bucket. Shared by the
 * live_ticks and market_prices_latest feeds so both aggregate identically.
 */
export function foldPriceIntoCandles(
  candles: CandleRow[],
  price: number,
  tsMs: number,
  marketId: number,
  bucketMs?: number
): CandleRow[] {
  if (!Number.isFinite(price) || Number.isNaN(tsMs)) {
    return candles;
  }

  if (!candles.length) {
    const bucketStart = bucketMs ? floorToBucket(tsMs, bucketMs) : tsMs;
    return [
      {
        market_id: marketId,
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
  const tickBucket = bucketMs ? floorToBucket(tsMs, bucketMs) : lastMs;
  const lastBucket = bucketMs ? floorToBucket(lastMs, bucketMs) : lastMs;

  // A price that predates the current live bucket is stale — ignore it so we
  // never rewrite a closed candle with an out-of-order update.
  if (bucketMs && tickBucket < lastBucket) {
    return candles;
  }

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

/**
 * Apply a live tick (from the live_ticks feed) to OHLCV candle rows.
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
  return foldPriceIntoCandles(candles, price, tickMs, tick.market_id, bucketMs);
}

/**
 * Apply a market_prices_latest row to OHLCV candle rows. Uses the same price
 * the line chart plots (last_price ?? mid) so the live candle's close stays in
 * lockstep with the line, and updates on every realtime price change.
 */
export function applyMarketPriceToCandles(
  candles: CandleRow[],
  row: MarketPriceLatest,
  bucketMs?: number
): CandleRow[] {
  const price = row.last_price ?? row.mid;
  if (price == null || !row.updated_at) {
    return candles;
  }

  const tsMs = Date.parse(row.updated_at);
  return foldPriceIntoCandles(candles, price, tsMs, row.market_id, bucketMs);
}
