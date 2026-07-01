import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseProbPrice,
  midPrice,
  buildTokenToMarketMap,
  diffTokenSets,
  collectCompletedCandles,
  createTokenState,
  updateSnapshot,
} = require('../workers/polymarket/live-ws');
const { getBucketMs } = require('../lib/ohlc');

describe('polymarket/live-ws', () => {
  it('parseProbPrice parses string decimals', () => {
    expect(parseProbPrice('.48')).toBe(0.48);
    expect(parseProbPrice('0.52')).toBe(0.52);
    expect(parseProbPrice(null)).toBeNull();
  });

  it('midPrice prefers bid/ask average', () => {
    expect(midPrice(0.4, 0.6, null)).toBe(0.5);
    expect(midPrice(null, null, 0.55)).toBe(0.55);
  });

  it('buildTokenToMarketMap maps all token_ids', () => {
    const map = buildTokenToMarketMap([
      { id: 1, token_ids: ['t1', 't2'] },
      { id: 2, token_ids: ['t3'] },
    ]);
    expect(map.get('t1')).toBe(1);
    expect(map.get('t3')).toBe(2);
    expect(map.size).toBe(3);
  });

  it('diffTokenSets computes subscribe/unsubscribe', () => {
    const current = new Set(['a', 'b']);
    const next = new Set(['b', 'c']);
    const { toSubscribe, toUnsubscribe } = diffTokenSets(current, next);
    expect(toSubscribe).toEqual(['c']);
    expect(toUnsubscribe).toEqual(['a']);
  });

  it('collectCompletedCandles writes finished 1m buckets', () => {
    const intervalMs = getBucketMs('1m');
    const start = floorToBucket(Date.parse('2026-01-01T00:00:00Z'), intervalMs);
    const state = createTokenState(99);
    state.bucketStartMs = start;
    state.bucket = {
      ts: new Date(start).toISOString(),
      open: 0.5,
      high: 0.55,
      low: 0.48,
      close: 0.52,
      volume: 10,
      trade_count: 2,
    };
    state.lastKnownClose = 0.52;

    const tokenStates = new Map([['tok', state]]);
    const now = start + intervalMs + 1;
    const rows = collectCompletedCandles(tokenStates, now);

    expect(rows).toHaveLength(1);
    expect(rows[0].market_id).toBe(99);
    expect(rows[0].interval).toBe('1m');
    expect(rows[0].close).toBe(0.52);
  });

  it('updateSnapshot sets pending live snapshot', () => {
    const state = createTokenState(5);
    updateSnapshot(state, { bid: 0.4, ask: 0.6, last: 0.55, ts: Date.now() });
    expect(state.pendingSnapshot.market_id).toBe(5);
    expect(state.pendingSnapshot.mid).toBe(0.5);
    expect(state.lastKnownClose).toBe(0.5);
  });
});

function floorToBucket(ts, intervalMs) {
  return Math.floor(ts / intervalMs) * intervalMs;
}
