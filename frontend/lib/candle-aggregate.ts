import type { CandleRow } from './types';

/** Roll up finer candles into larger buckets (e.g. 5m → 15m, 1h → 4h). */
export function aggregateCandles(rows: CandleRow[], bucketMs: number): CandleRow[] {
  if (!rows.length) {
    return [];
  }

  const buckets = new Map<number, CandleRow>();

  for (const row of rows) {
    if (row.close == null) {
      continue;
    }

    const tsMs = Date.parse(row.ts);
    if (Number.isNaN(tsMs)) {
      continue;
    }

    const bucketStart = Math.floor(tsMs / bucketMs) * bucketMs;
    const existing = buckets.get(bucketStart);

    if (!existing) {
      buckets.set(bucketStart, {
        ...row,
        ts: new Date(bucketStart).toISOString(),
        open: row.open ?? row.close,
        high: row.high ?? row.close,
        low: row.low ?? row.close,
        close: row.close,
        volume: row.volume ?? 0,
        trade_count: row.trade_count ?? 0,
      });
      continue;
    }

    existing.high = Math.max(existing.high ?? row.close, row.high ?? row.close);
    existing.low = Math.min(existing.low ?? row.close, row.low ?? row.close);
    existing.close = row.close;
    existing.volume = (existing.volume ?? 0) + (row.volume ?? 0);
    existing.trade_count = (existing.trade_count ?? 0) + (row.trade_count ?? 0);
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([, candle]) => candle);
}
