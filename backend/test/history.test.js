import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  getFetchWindow,
  getFirstBackfillWindow,
  getLastClosedBucketWindowSec,
  isIntervalDue,
  mergeLastCandleTs,
} = require('../lib/history-common');
const { tradesTo1mCandles, clobPointsToCandles } = require('../workers/polymarket/history');
const { mapKalshiCandlestick } = require('../workers/kalshi/history');

describe('history-common', () => {
  it('getFetchWindow uses deep lookback on first backfill', () => {
    const first = getFetchWindow(true, '1d');
    const inc = getFetchWindow(false, '1m');
    expect(first.endTs - first.startTs).toBeGreaterThan(inc.endTs - inc.startTs);
  });

  it('getLastClosedBucketWindowSec returns one 5m bucket', () => {
    // 2026-07-07 09:22:00 UTC → last closed 5m bucket ends at 09:20
    const nowSec = Math.floor(Date.parse('2026-07-07T09:22:00.000Z') / 1000);
    const win = getLastClosedBucketWindowSec('5m', nowSec);
    expect(win.startTs).toBe(Math.floor(Date.parse('2026-07-07T09:15:00.000Z') / 1000));
    expect(win.endTs).toBe(Math.floor(Date.parse('2026-07-07T09:20:00.000Z') / 1000));
  });

  it('isIntervalDue when last candle is older than last closed bucket', () => {
    const nowSec = Math.floor(Date.parse('2026-07-07T09:22:00.000Z') / 1000);
    expect(isIntervalDue('5m', '2026-07-07T09:10:00.000Z', nowSec)).toBe(true);
    expect(isIntervalDue('5m', '2026-07-07T09:15:00.000Z', nowSec)).toBe(false);
  });

  it('getFirstBackfillWindow covers configured lookback for 5m', () => {
    const win = getFirstBackfillWindow('5m');
    expect(win.endTs - win.startTs).toBe(30 * 24 * 60 * 60);
  });

  it('splitTimeWindowsForCandles respects Kalshi 10k candlestick cap', () => {
    const { splitTimeWindowsForCandles } = require('../lib/history-common');
    const startTs = 0;
    const endTs = 7 * 24 * 60 * 60; // 7 days
    const windows = splitTimeWindowsForCandles(startTs, endTs, 1, 4);
    expect(windows.length).toBeGreaterThan(1);
  });

  it('mergeLastCandleTs keeps max timestamp per interval', () => {
    const merged = mergeLastCandleTs(
      { '1m': '2026-01-01T00:00:00Z' },
      { '1m': '2026-01-01T01:00:00Z', '5m': '2026-01-01T00:30:00Z' }
    );
    expect(merged['1m']).toBe('2026-01-01T01:00:00Z');
    expect(merged['5m']).toBe('2026-01-01T00:30:00Z');
  });
});

describe('polymarket/history', () => {
  it('tradesTo1mCandles aggregates trades into buckets', () => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    const candles = tradesTo1mCandles([
      { price: 0.5, size: 10, timestamp: base + 10_000 },
      { price: 0.55, size: 5, timestamp: base + 20_000 },
      { price: 0.6, size: 1, timestamp: base + 70_000 },
    ]);

    expect(candles.length).toBeGreaterThanOrEqual(2);
    expect(candles[0].volume).toBe(15);
    expect(candles[0].trade_count).toBe(2);
  });

  it('clobPointsToCandles maps price points', () => {
    const candles = clobPointsToCandles([{ t: 1704067200, p: 0.42 }]);
    expect(candles[0].close).toBe(0.42);
  });
});

describe('kalshi/history', () => {
  it('mapKalshiCandlestick normalizes dollar OHLC to 0-1', () => {
    const candle = mapKalshiCandlestick({
      end_period_ts: 1704067200,
      price: {
        open_dollars: '0.40',
        high_dollars: '0.55',
        low_dollars: '0.35',
        close_dollars: '0.50',
      },
      volume_fp: '12.00',
      yes_bid: {},
      yes_ask: {},
      open_interest_fp: '0.00',
    });

    expect(candle.open).toBe(0.4);
    expect(candle.close).toBe(0.5);
    expect(candle.volume).toBe(12);
  });

  it('mapKalshiCandlestick uses yes_bid/yes_ask when trade price OHLC is missing', () => {
    const candle = mapKalshiCandlestick({
      end_period_ts: 1782900000,
      price: { previous_dollars: '0.9200' },
      volume_fp: '0.00',
      yes_bid: {
        close_dollars: '0.9200',
        high_dollars: '0.9200',
        low_dollars: '0.9200',
        open_dollars: '0.9200',
      },
      yes_ask: {
        close_dollars: '0.9300',
        high_dollars: '0.9400',
        low_dollars: '0.9300',
        open_dollars: '0.9400',
      },
    });

    expect(candle.open).toBeCloseTo(0.93);
    expect(candle.close).toBeCloseTo(0.925);
    expect(candle.high).toBe(0.94);
    expect(candle.low).toBe(0.92);
  });
});
