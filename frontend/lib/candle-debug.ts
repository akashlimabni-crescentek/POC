import type { CandleRow } from './types';

/** Compact OHLCV row for console inspection. */
export function formatCandleRowForLog(row: CandleRow) {
  return {
    ts: row.ts,
    interval: row.interval,
    o: row.open,
    h: row.high,
    l: row.low,
    c: row.close,
    v: row.volume,
    tc: row.trade_count,
  };
}

/**
 * Log a metadata line plus the full row list. Uses console.table when non-empty
 * so rows are easy to scan in DevTools.
 */
export function logCandleRows(
  label: string,
  rows: CandleRow[],
  meta: Record<string, unknown> = {}
): void {
  const formatted = rows.map(formatCandleRowForLog);
  console.log(label, { ...meta, rowCount: rows.length, rows: formatted });
  if (formatted.length > 0) {
    console.table(formatted);
  }
}

/** Log finer-bucket rows grouped by stored interval. */
export function logCandleRowsByInterval(
  label: string,
  byInterval: Record<string, CandleRow[]>,
  meta: Record<string, unknown> = {}
): void {
  const summary = Object.fromEntries(
    Object.entries(byInterval).map(([iv, rows]) => [iv, rows.length])
  );
  console.log(label, { ...meta, rowCounts: summary });
  for (const [iv, rows] of Object.entries(byInterval)) {
    if (rows.length === 0) {
      continue;
    }
    const formatted = rows.map(formatCandleRowForLog);
    console.log(`${label} [${iv}]`, formatted);
    console.table(formatted);
  }
}
