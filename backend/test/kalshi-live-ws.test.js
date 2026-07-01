import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  extractKalshiPrices,
  buildTickerToMarketMap,
  diffTickerSets,
  checkSequenceGap,
  collectCompletedCandles,
  createTickerState,
  updateSnapshot,
} = require('../workers/kalshi/live-ws');
const { getBucketMs } = require('../lib/ohlc');

describe('kalshi/live-ws', () => {
  it('extractKalshiPrices normalizes cents and dollars to 0-1', () => {
    const fromCents = extractKalshiPrices({ yes_bid: 40, yes_ask: 60, price: 55 });
    expect(fromCents.bid).toBe(0.4);
    expect(fromCents.ask).toBe(0.6);
    expect(fromCents.last).toBe(0.55);

    const fromDollars = extractKalshiPrices({
      yes_bid_dollars: '0.41',
      yes_ask_dollars: '0.59',
      price_dollars: '0.5',
    });
    expect(fromDollars.bid).toBe(0.41);
    expect(fromDollars.last).toBe(0.5);
  });

  it('buildTickerToMarketMap maps external_id to market id', () => {
    const map = buildTickerToMarketMap([
      { id: 10, external_id: 'TICK-A' },
      { id: 11, external_id: 'TICK-B' },
    ]);
    expect(map.get('TICK-A')).toBe(10);
    expect(map.size).toBe(2);
  });

  it('diffTickerSets computes subscribe/unsubscribe lists', () => {
    const current = new Set(['A', 'B']);
    const next = new Set(['B', 'C']);
    expect(diffTickerSets(current, next)).toEqual({
      toSubscribe: ['C'],
      toUnsubscribe: ['A'],
    });
  });

  it('checkSequenceGap detects missing sequence numbers', () => {
    const lastSeqBySid = new Map([[1, 5]]);
    expect(checkSequenceGap(lastSeqBySid, 1, 7)).toBe(true);
    expect(checkSequenceGap(lastSeqBySid, 1, 6)).toBe(false);
    expect(lastSeqBySid.get(1)).toBe(6);
  });

  it('collectCompletedCandles emits 1m rows', () => {
    const intervalMs = getBucketMs('1m');
    const start = floorToBucket(Date.parse('2026-01-01T00:00:00Z'), intervalMs);
    const state = createTickerState(42);
    state.bucketStartMs = start;
    state.bucket = {
      ts: new Date(start).toISOString(),
      open: 0.5,
      high: 0.52,
      low: 0.49,
      close: 0.51,
      volume: 3,
      trade_count: 2,
    };
    state.lastKnownClose = 0.51;

    const rows = collectCompletedCandles(new Map([['T', state]]), start + intervalMs + 1);
    expect(rows[0].market_id).toBe(42);
    expect(rows[0].close).toBe(0.51);
  });

  it('updateSnapshot stores normalized pending snapshot', () => {
    const state = createTickerState(7);
    updateSnapshot(state, { bid: 0.4, ask: 0.6, last: 0.55, ts: Date.now() });
    expect(state.pendingSnapshot.market_id).toBe(7);
    expect(state.pendingSnapshot.mid).toBe(0.5);
  });
});

function floorToBucket(ts, intervalMs) {
  return Math.floor(ts / intervalMs) * intervalMs;
}
