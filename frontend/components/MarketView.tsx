'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { createBrowserClient } from '@/lib/supabase/client';
import { getCandles } from '@/lib/queries';
import { getMarketDisplayName } from '@/lib/market-label';
import { aggregateCandles } from '@/lib/candle-aggregate';
import { applyLiveTickToCandles } from '@/lib/live-tick-candles';
import {
  subscribeLiveTicks,
  subscribeMarketIngestionState,
  subscribeMarketPrices,
} from '@/lib/realtime';
import {
  OHLCV_INTERVALS,
  OHLCV_SOURCE,
  ohlcvBucketMs,
  ohlcvRangeToWindow,
  type OhlcvInterval,
} from '@/lib/chart-config';
import { formatProbability } from '@/lib/chart';
import { formatGmtIso } from '@/lib/datetime';
import { pickProvider, pickRelation } from '@/lib/utils';
import OhlcvChart from '@/components/OhlcvChart';
import type { CandleRow, MarketPriceLatest, MarketRow } from '@/lib/types';

const STALE_MS = 30_000;

function pickPrice(latest: MarketRow['market_prices_latest']): MarketPriceLatest | null {
  if (Array.isArray(latest)) {
    return latest[0] ?? null;
  }
  return latest ?? null;
}

function isStale(updatedAt: string | null | undefined): boolean {
  if (!updatedAt) {
    return true;
  }
  return Date.now() - Date.parse(updatedAt) > STALE_MS;
}

export default function MarketView({ market }: { market: MarketRow }) {
  const [ohlcvInterval, setOhlcvInterval] = useState<OhlcvInterval>('5m');
  const [candles, setCandles] = useState<CandleRow[]>([]);
  const [candlesResetKey, setCandlesResetKey] = useState('');
  const [candlesLoading, setCandlesLoading] = useState(true);
  const [price, setPrice] = useState<MarketPriceLatest | null>(pickPrice(market.market_prices_latest));
  const [ingestionTier, setIngestionTier] = useState(market.ingestion_tier);

  const eventTitle = pickRelation(market.events)?.title ?? null;
  const displayName = getMarketDisplayName(market, eventTitle);

  const loadCandles = useCallback(async () => {
    setCandlesLoading(true);
    try {
      const supabase = createBrowserClient();
      const config = OHLCV_SOURCE[ohlcvInterval];
      const { from, to } = ohlcvRangeToWindow(ohlcvInterval);
      let rows = await getCandles(supabase, market.id, config.sourceInterval, from, to);

      if (config.aggregateMs) {
        rows = aggregateCandles(rows, config.aggregateMs);
      }

      setCandles(rows);
      setCandlesResetKey(`${market.id}-${ohlcvInterval}`);
    } catch (err) {
      console.error('[MarketView] getCandles failed:', err);
      setCandles([]);
    } finally {
      setCandlesLoading(false);
    }
  }, [market.id, ohlcvInterval]);

  useEffect(() => {
    setPrice(pickPrice(market.market_prices_latest));
    setIngestionTier(market.ingestion_tier);
  }, [market.id, market.market_prices_latest, market.ingestion_tier]);

  useEffect(() => {
    loadCandles();
  }, [loadCandles]);

  useEffect(() => {
    const supabase = createBrowserClient();

    const unsubscribePrices = subscribeMarketPrices(supabase, market.id, setPrice);
    const unsubscribeTicks = subscribeLiveTicks(supabase, market.id, (tick) => {
      setCandles((prev) => applyLiveTickToCandles(prev, tick, ohlcvBucketMs(ohlcvInterval)));
    });
    const unsubscribeIngestion = subscribeMarketIngestionState(supabase, market.id, (state) => {
      if (state.tier) {
        setIngestionTier(state.tier);
      }
    });

    return () => {
      unsubscribePrices();
      unsubscribeTicks();
      unsubscribeIngestion();
    };
  }, [market.id, ohlcvInterval]);

  const stale = isStale(price?.updated_at);
  const providerName =
    pickProvider(market.providers)?.name ??
    pickProvider(market.providers)?.slug ??
    'Provider';

  return (
    <div>
      <div style={{ marginBottom: '1rem' }}>
        <Link href={market.event_id ? `/events/${market.event_id}` : '/'} className="muted">
          ← Back to event
        </Link>
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.5rem' }}>{displayName}</h1>
            <div className="muted" style={{ fontSize: '0.875rem' }}>
              {providerName}
              {eventTitle ? ` · ${eventTitle}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
            <span className={`badge badge-${ingestionTier}`}>{ingestionTier}</span>
            <span className="badge">{market.status ?? 'unknown'}</span>
          </div>
        </div>

        <div className="price-grid">
          <div className="price-stat">
            <div className="price-stat-label">Last</div>
            <div className="price-stat-value">{formatProbability(price?.last_price)}</div>
          </div>
          <div className="price-stat">
            <div className="price-stat-label">Bid</div>
            <div className="price-stat-value">{formatProbability(price?.bid)}</div>
          </div>
          <div className="price-stat">
            <div className="price-stat-label">Ask</div>
            <div className="price-stat-value">{formatProbability(price?.ask)}</div>
          </div>
          <div className="price-stat">
            <div className="price-stat-label">Mid</div>
            <div className="price-stat-value">{formatProbability(price?.mid)}</div>
          </div>
        </div>

        {stale && (
          <div className="status-banner status-banner-warn">
            Price may be stale
            {price?.updated_at ? ` — last updated ${formatGmtIso(price.updated_at)}` : ''}
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: '1.25rem' }}>
        <div className="chart-toolbar chart-toolbar-compact">
          <span className="mode-btn mode-btn-active">OHLCV</span>
          <div className="timeline-bar">
            {OHLCV_INTERVALS.map((interval) => (
              <button
                key={interval}
                type="button"
                className={`timeline-btn ${ohlcvInterval === interval ? 'timeline-btn-active' : ''}`}
                onClick={() => setOhlcvInterval(interval)}
              >
                {interval}
              </button>
            ))}
          </div>
        </div>

        {candlesLoading && (
          <div className="status-banner status-banner-info">Loading candles…</div>
        )}

        {!candlesLoading && candles.length === 0 && (
          <div className="status-banner status-banner-warn">
            Backfilling… History worker fills candles for hot markets within a few minutes.
          </div>
        )}

        {!candlesLoading && candles.length > 0 && (
          <OhlcvChart candles={candles} resetKey={candlesResetKey} />
        )}
      </div>
    </div>
  );
}
