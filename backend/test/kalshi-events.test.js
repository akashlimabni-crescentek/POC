import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  filterByConfiguredSeries,
  filterByConfiguredEventTickers,
  mapMarketStatus,
  mapEventStatus,
  mapEventRow,
  mapMarketRow,
  groupMarketsByEvent,
  resolveIngestionTier,
} = require('../workers/kalshi/events');

describe('kalshi/events', () => {
  it('filterByConfiguredSeries post-filters warm poll results', () => {
    const markets = [
      { ticker: 'A', series_ticker: 'SERIES-A' },
      { ticker: 'B', series_ticker: 'SERIES-B' },
    ];
    expect(filterByConfiguredSeries(markets, ['SERIES-A'])).toHaveLength(1);
    expect(filterByConfiguredSeries(markets, [])).toHaveLength(2);
  });

  it('filterByConfiguredEventTickers post-filters by event_ticker', () => {
    const markets = [
      { ticker: 'A', event_ticker: 'EVT-1' },
      { ticker: 'B', event_ticker: 'EVT-2' },
    ];
    expect(filterByConfiguredEventTickers(markets, ['EVT-1'])).toHaveLength(1);
    expect(filterByConfiguredEventTickers(markets, [])).toHaveLength(2);
  });

  it('mapMarketStatus maps Kalshi open to open', () => {
    expect(mapMarketStatus('open')).toBe('open');
    expect(mapMarketStatus('settled')).toBe('settled');
  });

  it('mapEventStatus derives from market group', () => {
    expect(mapEventStatus([{ status: 'open' }, { status: 'closed' }])).toBe('active');
    expect(mapEventStatus([{ status: 'settled' }])).toBe('settled');
  });

  it('groupMarketsByEvent groups by event_ticker', () => {
    const grouped = groupMarketsByEvent([
      { event_ticker: 'EVT', ticker: 'M1' },
      { event_ticker: 'EVT', ticker: 'M2' },
      { event_ticker: 'OTHER', ticker: 'M3' },
    ]);
    expect(grouped.get('EVT')).toHaveLength(2);
    expect(grouped.get('OTHER')).toHaveLength(1);
  });

  it('mapEventRow and mapMarketRow produce DB-shaped rows', () => {
    const markets = [
      {
        ticker: 'MKT-YES',
        event_ticker: 'EVT-1',
        series_ticker: 'SERIES-A',
        title: 'Will X happen?',
        subtitle: 'Yes',
        status: 'open',
        close_time: '2026-12-31T00:00:00Z',
      },
    ];

    const eventRow = mapEventRow('EVT-1', markets, 2);
    expect(eventRow.external_id).toBe('EVT-1');
    expect(eventRow.provider_id).toBe(2);
    expect(eventRow.status).toBe('active');

    const marketRow = mapMarketRow(markets[0], 10, 2, 'warm');
    expect(marketRow.external_id).toBe('MKT-YES');
    expect(marketRow.event_id).toBe(10);
    expect(marketRow.series_ticker).toBe('SERIES-A');
    expect(marketRow.ingestion_tier).toBe('warm');
  });

  it('resolveIngestionTier preserves hot', () => {
    expect(resolveIngestionTier('hot')).toBe('hot');
    expect(resolveIngestionTier('cold')).toBe('warm');
  });
});
