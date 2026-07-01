import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  getRetentionCutoffs,
  filterStaleClosedMarkets,
  sumDeleted,
  runRetentionCycle,
  LIVE_TICKS_MAX_AGE_MS,
  CANDLE_RETENTION_MS,
  CLOSED_MARKET_GRACE_MS,
} = require('../lib/retention');

describe('retention', () => {
  it('exports retention policy constants', () => {
    expect(LIVE_TICKS_MAX_AGE_MS).toBe(6 * 60 * 60 * 1000);
    expect(CANDLE_RETENTION_MS['1m']).toBe(30 * 24 * 60 * 60 * 1000);
    expect(CLOSED_MARKET_GRACE_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('getRetentionCutoffs returns ISO cutoffs per interval', () => {
    const now = Date.parse('2026-06-01T12:00:00Z');
    const cutoffs = getRetentionCutoffs(now);

    expect(cutoffs.liveTicks).toBe(new Date(now - LIVE_TICKS_MAX_AGE_MS).toISOString());
    expect(cutoffs.candles['1m']).toBe(new Date(now - CANDLE_RETENTION_MS['1m']).toISOString());
    expect(cutoffs.closedMarketGrace).toBe(
      new Date(now - CLOSED_MARKET_GRACE_MS).toISOString()
    );
  });

  it('filterStaleClosedMarkets uses market or event close_time', () => {
    const graceCutoff = '2026-01-01T00:00:00Z';
    const ids = filterStaleClosedMarkets(
      [
        { id: 1, close_time: '2025-11-01T00:00:00Z' },
        { id: 2, close_time: null, events: { close_time: '2025-10-01T00:00:00Z' } },
        { id: 3, close_time: '2026-02-01T00:00:00Z' },
        { id: 4, close_time: null, events: null },
      ],
      graceCutoff
    );

    expect(ids).toEqual([1, 2]);
  });

  it('sumDeleted totals row counts', () => {
    expect(sumDeleted({ a: 10, b: 5, c: 0 })).toBe(15);
  });

  it('runRetentionCycle purges, demotes, and returns totals', async () => {
    const demoteStale = vi.fn(async () => 2);
    const supabase = {
      from: vi.fn((table) => {
        if (table === 'markets') {
          return {
            select: vi.fn(() => ({
              in: vi.fn(async () => ({
                data: [{ id: 99, close_time: '2025-01-01T00:00:00Z' }],
                error: null,
              })),
            })),
          };
        }

        return {
          delete: vi.fn(() => ({
            lt: vi.fn(() => ({
              eq: vi.fn(() => ({
                lt: vi.fn(async () => ({ count: 3, error: null })),
              })),
            })),
            eq: vi.fn(() => ({
              lt: vi.fn(async () => ({ count: 4, error: null })),
            })),
            in: vi.fn(async () => ({ count: 7, error: null })),
          })),
        };
      }),
    };

    const result = await runRetentionCycle(supabase, demoteStale);

    expect(demoteStale).toHaveBeenCalledOnce();
    expect(result.demoted).toBe(2);
    expect(result.deleted.live_ticks).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeGreaterThanOrEqual(0);
  });
});
