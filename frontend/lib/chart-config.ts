import type { CandleInterval } from './types';

export type ChartMode = 'line' | 'ohlcv';

export type LineTimeRange = '1H' | '6H' | '1D' | '1W' | '1M' | 'ALL';

export type OhlcvInterval = '5m' | '15m' | '1H' | '4H' | '1D' | '1W';

export const LINE_TIME_RANGES: LineTimeRange[] = ['1H', '6H', '1D', '1W', '1M', 'ALL'];

export const OHLCV_INTERVALS: OhlcvInterval[] = ['5m', '15m', '1H', '4H', '1D', '1W'];

export const LINE_RANGE_MS: Record<Exclude<LineTimeRange, 'ALL'>, number> = {
  '1H': 60 * 60 * 1000,
  '6H': 6 * 60 * 60 * 1000,
  '1D': 24 * 60 * 60 * 1000,
  '1W': 7 * 24 * 60 * 60 * 1000,
  '1M': 30 * 24 * 60 * 60 * 1000,
};

/** Max lookback when range is ALL (line mode). */
export const LINE_ALL_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

export const OUTCOME_COLORS = [
  '#22d3ee',
  '#a78bfa',
  '#fb923c',
  '#4ade80',
  '#f472b6',
  '#facc15',
  '#60a5fa',
  '#f87171',
  '#2dd4bf',
  '#c084fc',
  '#38bdf8',
  '#eab308',
] as const;

type OhlcvSource = {
  sourceInterval: CandleInterval;
  aggregateMs?: number;
  lookbackMs: number;
};

// 15m / 4h / 1w are now persisted directly (backend history rollup), so every
// selectable interval reads its own stored rows — no client-side aggregateMs.
export const OHLCV_SOURCE: Record<OhlcvInterval, OhlcvSource> = {
  '5m': { sourceInterval: '5m', lookbackMs: 30 * 24 * 60 * 60 * 1000 },
  '15m': { sourceInterval: '15m', lookbackMs: 30 * 24 * 60 * 60 * 1000 },
  '1H': { sourceInterval: '1h', lookbackMs: 90 * 24 * 60 * 60 * 1000 },
  '4H': { sourceInterval: '4h', lookbackMs: 90 * 24 * 60 * 60 * 1000 },
  '1D': { sourceInterval: '1d', lookbackMs: 365 * 24 * 60 * 60 * 1000 },
  '1W': { sourceInterval: '1w', lookbackMs: 365 * 24 * 60 * 60 * 1000 },
};

/** Pick stored candle interval for a line-chart time range. */
export function lineSourceInterval(range: LineTimeRange): CandleInterval {
  switch (range) {
    case '1H':
    case '6H':
      return '1m';
    case '1D':
      return '5m';
    case '1W':
    case '1M':
    case 'ALL':
      return '1h';
  }
}

export function lineRangeToWindow(range: LineTimeRange): { from: string; to: string } {
  const to = Date.now();
  const ms =
    range === 'ALL' ? LINE_ALL_LOOKBACK_MS : LINE_RANGE_MS[range];
  return {
    from: new Date(to - ms).toISOString(),
    to: new Date(to).toISOString(),
  };
}

export function ohlcvRangeToWindow(interval: OhlcvInterval): { from: string; to: string } {
  const to = Date.now();
  const { lookbackMs } = OHLCV_SOURCE[interval];
  return {
    from: new Date(to - lookbackMs).toISOString(),
    to: new Date(to).toISOString(),
  };
}

const CANDLE_INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
};

/** Milliseconds for a stored candle interval (1m / 5m / 1h / 1d). */
export function candleIntervalMs(interval: CandleInterval): number {
  return CANDLE_INTERVAL_MS[interval];
}

/** Bucket width for live tick → OHLCV candle updates in the chart UI. */
export function ohlcvBucketMs(interval: OhlcvInterval): number {
  const cfg = OHLCV_SOURCE[interval];
  if (cfg.aggregateMs) {
    return cfg.aggregateMs;
  }
  return CANDLE_INTERVAL_MS[cfg.sourceInterval];
}

/**
 * The forming (right-edge) candle for a selected interval is not read whole
 * from the DB — the DB only writes a coarse candle once its bucket closes, so
 * the current bucket would sit frozen for up to a full interval. Instead we
 * reconstruct it *now* by stepping down through the finer, already-stored
 * candles that fall inside the current bucket, then finishing with the live
 * tick tail.
 *
 * `SUB_INTERVAL_LADDER[selected]` lists those finer stored intervals ordered
 * **coarsest → finest**. The composer consumes as many whole coarse blocks as
 * fit before `now`, then drops to the next finer rung for the remainder, and
 * finally the live aggregator covers the ragged sub-minute tail. Every rung
 * here must be an integer divisor of the selected interval and of the rung
 * above it, so blocks tile the bucket exactly.
 *
 * finer intervals are aggregated transiently and never stored as 1m.
 */
export const SUB_INTERVAL_LADDER: Record<OhlcvInterval, CandleInterval[]> = {
  '5m': [],
  '15m': ['5m'],
  '1H': ['15m', '5m'],
  '4H': ['1h', '15m', '5m'],
  '1D': ['4h', '1h', '15m', '5m'],
  '1W': ['1d', '4h', '1h', '15m', '5m'],
};

export function outcomeColor(index: number): string {
  return OUTCOME_COLORS[index % OUTCOME_COLORS.length];
}
