import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getFetchWindow, mergeLastCandleTs } = require('../lib/history-common');
const { tradesTo1mCandles, clobPointsToCandles } = require('../workers/polymarket/history');
const { mapKalshiCandlestick } = require('../workers/kalshi/history');

describe('history-common', () => {
  it('getFetchWindow uses deep lookback on first backfill', () => {
    const first = getFetchWindow(true, '1d');
    const inc = getFetchWindow(false, '1d');
    expect(first.endTs - first.startTs).toBeGreaterThan(inc.endTs - inc.startTs);
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
});
