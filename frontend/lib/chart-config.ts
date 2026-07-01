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

export const OHLCV_SOURCE: Record<OhlcvInterval, OhlcvSource> = {
  '5m': { sourceInterval: '5m', lookbackMs: 30 * 24 * 60 * 60 * 1000 },
  '15m': { sourceInterval: '5m', aggregateMs: 15 * 60 * 1000, lookbackMs: 30 * 24 * 60 * 60 * 1000 },
  '1H': { sourceInterval: '1h', lookbackMs: 90 * 24 * 60 * 60 * 1000 },
  '4H': { sourceInterval: '1h', aggregateMs: 4 * 60 * 60 * 1000, lookbackMs: 90 * 24 * 60 * 60 * 1000 },
  '1D': { sourceInterval: '1d', lookbackMs: 365 * 24 * 60 * 60 * 1000 },
  '1W': { sourceInterval: '1d', aggregateMs: 7 * 24 * 60 * 60 * 1000, lookbackMs: 365 * 24 * 60 * 60 * 1000 },
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

export function outcomeColor(index: number): string {
  return OUTCOME_COLORS[index % OUTCOME_COLORS.length];
}
