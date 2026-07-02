'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { createBrowserClient } from '@/lib/supabase/client';
import { pickLatestPrice } from '@/lib/queries';
import { getMarketDisplayName } from '@/lib/market-label';
import {
  subscribeMarketIngestionStateMany,
  subscribeMarketPricesMany,
} from '@/lib/realtime';
import { formatProbability } from '@/lib/chart';
import type { MarketPriceLatest, MarketRow } from '@/lib/types';

type EventMarketsListProps = {
  eventTitle: string | null;
  markets: MarketRow[];
};

export default function EventMarketsList({ eventTitle, markets: initialMarkets }: EventMarketsListProps) {
  const [markets, setMarkets] = useState(initialMarkets);

  useEffect(() => {
    setMarkets(initialMarkets);
  }, [initialMarkets]);

  useEffect(() => {
    const supabase = createBrowserClient();
    const marketIds = initialMarkets.map((market) => market.id);

    const unsubscribePrices = subscribeMarketPricesMany(
      supabase,
      `event-markets-prices-${marketIds.join('-')}`,
      marketIds,
      (row: MarketPriceLatest) => {
        setMarkets((prev) =>
          prev.map((market) =>
            market.id === row.market_id ? { ...market, market_prices_latest: row } : market
          )
        );
      }
    );

    const unsubscribeIngestion = subscribeMarketIngestionStateMany(
      supabase,
      `event-markets-ingestion-${marketIds.join('-')}`,
      marketIds,
      (row) => {
        if (!row.tier) {
          return;
        }
        setMarkets((prev) =>
          prev.map((market) =>
            market.id === row.market_id ? { ...market, ingestion_tier: row.tier! } : market
          )
        );
      }
    );

    return () => {
      unsubscribePrices();
      unsubscribeIngestion();
    };
  }, [initialMarkets]);

  if (!markets.length) {
    return (
      <div className="card">
        <p style={{ margin: 0 }}>No markets linked to this event yet.</p>
      </div>
    );
  }

  return (
    <div className="market-list">
      {markets.map((market) => {
        const latest = pickLatestPrice(market);
        const displayName = getMarketDisplayName(market, eventTitle);

        return (
          <Link key={market.id} href={`/markets/${market.id}`} className="card card-link">
            <div className="market-row">
              <div>
                <div style={{ fontWeight: 600 }}>{displayName}</div>
                <div className="muted" style={{ fontSize: '0.875rem', marginTop: '0.25rem' }}>
                  {market.external_id}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <span className={`badge badge-${market.ingestion_tier}`}>{market.ingestion_tier}</span>
                <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                  {formatProbability(latest?.last_price ?? latest?.mid)}
                </span>
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
