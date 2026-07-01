import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { upsertBatched } = require('../lib/bulk-upsert');

function createMockSupabase(behavior) {
  return {
    from: vi.fn(() => ({
      upsert: behavior,
    })),
  };
}

describe('upsertBatched', () => {
  it('requires onConflict', async () => {
    const supabase = createMockSupabase(vi.fn());
    await expect(upsertBatched(supabase, 'events', [{ id: 1 }], {})).rejects.toThrow(
      'onConflict is required'
    );
  });

  it('upserts in batches and returns written count', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const supabase = createMockSupabase(upsert);

    const rows = Array.from({ length: 250 }, (_, i) => ({ id: i }));
    const result = await upsertBatched(supabase, 'markets', rows, {
      onConflict: 'id',
      batchSize: 100,
    });

    expect(upsert).toHaveBeenCalledTimes(3);
    expect(result.written).toBe(250);
    expect(result.failed).toHaveLength(0);
  });

  it('collects failed batches', async () => {
    let call = 0;
    const upsert = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 2) {
        return { error: { message: 'db error' } };
      }
      return { error: null };
    });
    const supabase = createMockSupabase(upsert);

    const rows = Array.from({ length: 200 }, (_, i) => ({ id: i }));
    const result = await upsertBatched(supabase, 'markets', rows, {
      onConflict: 'id',
      batchSize: 100,
    });

    expect(result.written).toBe(100);
    expect(result.failed).toHaveLength(100);
  });
});
