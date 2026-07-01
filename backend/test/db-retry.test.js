import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

vi.mock('../lib/http-client', () => ({
  sleep: vi.fn(() => Promise.resolve()),
}));

const { insertWithRetry } = require('../lib/db-retry');

function createMockSupabase(insertResult) {
  const insert = vi.fn().mockResolvedValue(insertResult);
  return {
    supabase: {
      from: vi.fn(() => ({ insert })),
    },
    insert,
  };
}

describe('db-retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns zero counts for empty rows', async () => {
    const { supabase } = createMockSupabase({ error: null });
    const result = await insertWithRetry(supabase, 'live_ticks', []);
    expect(result).toEqual({ inserted: 0, dropped: 0 });
  });

  it('inserts all rows on first success', async () => {
    const { supabase, insert } = createMockSupabase({ error: null });
    const rows = [{ market_id: 1 }, { market_id: 2 }];
    const result = await insertWithRetry(supabase, 'live_ticks', rows);

    expect(insert).toHaveBeenCalledOnce();
    expect(result).toEqual({ inserted: 2, dropped: 0 });
  });

  it('retries with backoff then succeeds', async () => {
    const { supabase, insert } = createMockSupabase({ error: { message: 'transient' } });
    insert
      .mockResolvedValueOnce({ error: { message: 'transient' } })
      .mockResolvedValueOnce({ error: null });

    const result = await insertWithRetry(supabase, 'live_ticks', [{ market_id: 1 }]);

    expect(insert).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ inserted: 1, dropped: 0 });
  });

  it('drops rows after max attempts without throwing', async () => {
    const { supabase, insert } = createMockSupabase({ error: { message: 'db down' } });
    const result = await insertWithRetry(supabase, 'live_ticks', [{ market_id: 1 }], {
      maxAttempts: 3,
    });

    expect(insert).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ inserted: 0, dropped: 1 });
  });
});
