import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseTokenIds,
  mapEventRow,
  resolveIngestionTier,
} = require('../workers/polymarket/events');

describe('polymarket/events', () => {
  it('parseTokenIds handles array and JSON string', () => {
    expect(parseTokenIds({ clobTokenIds: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(parseTokenIds({ clobTokenIds: '["x","y"]' })).toEqual(['x', 'y']);
    expect(parseTokenIds({})).toEqual([]);
  });

  it('mapEventRow maps Gamma event fields', () => {
    const row = mapEventRow(
      {
        id: 'evt-1',
        title: 'Test Event',
        slug: 'test-event',
        active: true,
        closed: false,
        endDate: '2026-12-31T00:00:00Z',
        updatedAt: '2026-01-01T12:00:00Z',
      },
      1
    );

    expect(row.provider_id).toBe(1);
    expect(row.external_id).toBe('evt-1');
    expect(row.status).toBe('active');
    expect(row.title).toBe('Test Event');
  });

  it('resolveIngestionTier preserves hot', () => {
    expect(resolveIngestionTier('hot')).toBe('hot');
    expect(resolveIngestionTier('cold')).toBe('warm');
    expect(resolveIngestionTier(undefined)).toBe('warm');
  });
});
