import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  GAP_FILL_CAP,
  TOKEN_EVICTION_MS,
  getBucketMs,
  createBucket,
  applyTick,
  applyTrade,
  computeGapFills,
  shouldEvict,
  aggregateCandles,
  aggregateToInterval,
} = require('../lib/ohlc');

describe('ohlc', () => {
  it('getBucketMs returns correct intervals', () => {
    expect(getBucketMs('1m')).toBe(60_000);
    expect(getBucketMs('5m')).toBe(300_000);
    expect(getBucketMs('1h')).toBe(3_600_000);
    expect(getBucketMs('1d')).toBe(86_400_000);
  });

  it('applyTick updates high/low/close', () => {
    const bucket = createBucket(Date.parse('2026-01-01T00:00:00Z'), 0.5);
    applyTick(bucket, 0.6);
    expect(bucket.high).toBe(0.6);
    expect(bucket.low).toBe(0.5);
    expect(bucket.close).toBe(0.6);

    applyTick(bucket, 0.4);
    expect(bucket.low).toBe(0.4);
    expect(bucket.close).toBe(0.4);
  });

  it('applyTrade separates volume and trade_count', () => {
    const bucket = createBucket(Date.parse('2026-01-01T00:00:00Z'), 0.5);

    applyTrade(bucket, 0.55, 10);
    expect(bucket.volume).toBe(10);
    expect(bucket.trade_count).toBe(1);

    applyTrade(bucket, 0.6, null);
    expect(bucket.volume).toBe(10);
    expect(bucket.trade_count).toBe(2);

    applyTrade(bucket, 0.61, 0);
    expect(bucket.volume).toBe(10);
    expect(bucket.trade_count).toBe(3);
  });

  it('computeGapFills fills every missing bucket', () => {
    const intervalMs = getBucketMs('1m');
    const last = Date.parse('2026-01-01T00:00:00Z');
    const current = Date.parse('2026-01-01T00:05:00Z');

    const { fills, capExceeded } = computeGapFills(last, current, 0.42, intervalMs);

    expect(capExceeded).toBe(false);
    expect(fills).toHaveLength(4);
    expect(fills[0].open).toBe(0.42);
    expect(fills[0].volume).toBe(0);
    expect(fills[0].trade_count).toBe(0);
  });

  it('computeGapFills caps at GAP_FILL_CAP buckets', () => {
    const intervalMs = getBucketMs('1m');
    const last = Date.parse('2026-01-01T00:00:00Z');
    const current = last + intervalMs * (GAP_FILL_CAP + 10);

    let warned = false;
    const { fills, capExceeded } = computeGapFills(last, current, 0.5, intervalMs, {
      onCapExceeded: () => {
        warned = true;
      },
    });

    expect(capExceeded).toBe(true);
    expect(warned).toBe(true);
    expect(fills).toHaveLength(GAP_FILL_CAP);
  });

  it('shouldEvict after TOKEN_EVICTION_MS idle', () => {
    const now = Date.parse('2026-01-02T00:00:00Z');
    const recent = now - TOKEN_EVICTION_MS + 1000;
    const stale = now - TOKEN_EVICTION_MS - 1000;

    expect(shouldEvict(recent, now)).toBe(false);
    expect(shouldEvict(stale, now)).toBe(true);
    expect(shouldEvict(null, now)).toBe(true);
  });

  it('aggregateCandles rolls 1m into 5m', () => {
    const candles = [
      { ts: '2026-01-01T00:00:00Z', open: 0.4, high: 0.5, low: 0.4, close: 0.45, volume: 10, trade_count: 2 },
      { ts: '2026-01-01T00:01:00Z', open: 0.45, high: 0.55, low: 0.44, close: 0.5, volume: 5, trade_count: 1 },
      { ts: '2026-01-01T00:02:00Z', open: 0.5, high: 0.52, low: 0.48, close: 0.49, volume: 3, trade_count: 1 },
    ];

    const agg = aggregateCandles(candles, '5m');
    expect(agg).toHaveLength(1);
    expect(agg[0].open).toBe(0.4);
    expect(agg[0].high).toBe(0.55);
    expect(agg[0].low).toBe(0.4);
    expect(agg[0].close).toBe(0.49);
    expect(agg[0].volume).toBe(18);
    expect(agg[0].trade_count).toBe(4);
  });

  it('aggregateToInterval chains 1m → 1h', () => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    const candles = Array.from({ length: 60 }, (_, i) => ({
      ts: new Date(base + i * 60_000).toISOString(),
      open: 0.5,
      high: 0.5 + i * 0.001,
      low: 0.5,
      close: 0.5 + i * 0.001,
      volume: 1,
      trade_count: 1,
    }));

    const hourly = aggregateToInterval(candles, '1m', '1h');
    expect(hourly).toHaveLength(1);
    expect(hourly[0].volume).toBe(60);
    expect(hourly[0].trade_count).toBe(60);
  });
});
