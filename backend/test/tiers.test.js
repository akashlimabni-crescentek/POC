import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  HOT_TIER,
  WARM_TIER,
  COLD_TIER,
  getHotMarkets,
  demoteStale,
  isActiveMarketStatus,
  shouldReceiveLiveIngestion,
} = require('../lib/tiers');

function createChainable(result) {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    in: vi.fn(() => chain),
    neq: vi.fn(() => chain),
    update: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => result.maybeSingle ?? { data: null, error: null }),
    then: undefined,
  };
  chain.then = (resolve, reject) => Promise.resolve(result.final ?? result).then(resolve, reject);
  return chain;
}

describe('tiers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('exports tier constants', () => {
    expect(HOT_TIER).toBe('hot');
    expect(WARM_TIER).toBe('warm');
    expect(COLD_TIER).toBe('cold');
  });

  it('getHotMarkets returns hot active markets for provider', async () => {
    const markets = [{ id: 1, external_id: 'M1', ingestion_tier: 'hot' }];
    const supabase = {
      from: vi.fn((table) => {
        if (table === 'providers') {
          return createChainable({ maybeSingle: { data: { id: 2 }, error: null } });
        }
        if (table === 'markets') {
          return createChainable({ final: { data: markets, error: null } });
        }
        return createChainable({});
      }),
    };

    const result = await getHotMarkets(supabase, 'polymarket');
    expect(result).toEqual(markets);
  });

  it('demoteStale updates markets and ingestion_state', async () => {
    const supabase = {
      from: vi.fn((table) => {
        if (table === 'markets') {
          return createChainable({
            final: { data: [{ id: 10 }, { id: 11 }], error: null },
          });
        }
        if (table === 'market_ingestion_state') {
          return createChainable({ final: { error: null } });
        }
        return createChainable({});
      }),
    };

    const count = await demoteStale(supabase);
    expect(count).toBe(2);
    expect(supabase.from).toHaveBeenCalledWith('market_ingestion_state');
  });

  it('shouldReceiveLiveIngestion requires hot + active/open', () => {
    expect(shouldReceiveLiveIngestion({ ingestion_tier: 'hot', status: 'open' })).toBe(true);
    expect(shouldReceiveLiveIngestion({ ingestion_tier: 'warm', status: 'open' })).toBe(false);
    expect(shouldReceiveLiveIngestion({ ingestion_tier: 'hot', status: 'closed' })).toBe(false);
    expect(isActiveMarketStatus('active')).toBe(true);
    expect(isActiveMarketStatus('closed')).toBe(false);
  });
});
