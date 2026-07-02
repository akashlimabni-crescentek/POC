import type { CandleRow, LiveTickRow } from './types';

function tickPrice(tick: LiveTickRow): number | null {
  return tick.mid ?? tick.last_price ?? tick.ask ?? tick.bid ?? null;
}

/** Update the last candle bucket from a live tick (no history refetch). */
export function applyLiveTickToCandles(candles: CandleRow[], tick: LiveTickRow): CandleRow[] {
  if (!candles.length) {
    return candles;
  }

  const price = tickPrice(tick);
  if (price == null) {
    return candles;
  }

  const next = [...candles];
  const last = { ...next[next.length - 1] };
  last.close = price;
  last.high = Math.max(last.high ?? price, price);
  last.low = Math.min(last.low ?? price, price);
  next[next.length - 1] = last;
  return next;
}
