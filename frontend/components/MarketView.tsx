'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { createBrowserClient } from '@/lib/supabase/client';
import { getCandles } from '@/lib/queries';
import { formatProbability } from '@/lib/chart';
import { pickProvider, pickRelation } from '@/lib/utils';
import CandlestickChart from '@/components/CandlestickChart';
import type { CandleInterval, MarketPriceLatest, MarketRow } from '@/lib/types';

const INTERVALS: CandleInterval[] = ['1m', '5m', '1h', '1d'];
const POLL_MS = 2_000;
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
  const [interval, setInterval] = useState<CandleInterval>('1m');
  const [candles, setCandles] = useState<Awaited<ReturnType<typeof getCandles>>>([]);
  const [candlesLoading, setCandlesLoading] = useState(true);
  const [price, setPrice] = useState<MarketPriceLatest | null>(pickPrice(market.market_prices_latest));

  const loadCandles = useCallback(async () => {
    setCandlesLoading(true);
    try {
      const supabase = createBrowserClient();
      const rows = await getCandles(supabase, market.id, interval);
      setCandles(rows);
    } catch (err) {
      console.error('[MarketView] getCandles failed:', err);
      setCandles([]);
    } finally {
      setCandlesLoading(false);
    }
  }, [market.id, interval]);

  const loadPrice = useCallback(async () => {
    const supabase = createBrowserClient();
    const { data, error } = await supabase
      .from('market_prices_latest')
      .select('market_id, bid, ask, mid, last_price, updated_at')
      .eq('market_id', market.id)
      .maybeSingle();

    if (!error && data) {
      setPrice(data);
    }
  }, [market.id]);

  useEffect(() => {
    loadCandles();
  }, [loadCandles]);

  useEffect(() => {
    const supabase = createBrowserClient();

    loadPrice();

    const channel = supabase
      .channel(`market-price-${market.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'market_prices_latest',
          filter: `market_id=eq.${market.id}`,
        },
        (payload) => {
          if (payload.new && typeof payload.new === 'object') {
            setPrice(payload.new as MarketPriceLatest);
          }
        }
      )
      .subscribe();

    const pollId = window.setInterval(loadPrice, POLL_MS);

    return () => {
      window.clearInterval(pollId);
      supabase.removeChannel(channel);
    };
  }, [market.id, loadPrice]);

  const stale = isStale(price?.updated_at);
  const providerName =
    pickProvider(market.providers)?.name ??
    pickProvider(market.providers)?.slug ??
    'Provider';
  const eventTitle = pickRelation(market.events)?.title;

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
            <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.5rem' }}>
              {market.title ?? market.outcome_label ?? `Market #${market.id}`}
            </h1>
            <div className="muted" style={{ fontSize: '0.875rem' }}>
              {providerName}
              {eventTitle ? ` · ${eventTitle}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
            <span className={`badge badge-${market.ingestion_tier}`}>{market.ingestion_tier}</span>
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
            {price?.updated_at ? ` — last updated ${new Date(price.updated_at).toLocaleString()}` : ''}
          </div>
        )}
      </div>

      <div style={{ marginTop: '1.25rem' }}>
        <div className="interval-bar">
          {INTERVALS.map((value) => (
            <button
              key={value}
              type="button"
              className={`btn ${interval === value ? 'btn-primary' : ''}`}
              onClick={() => setInterval(value)}
            >
              {value}
            </button>
          ))}
        </div>

        {candlesLoading && (
          <div className="status-banner status-banner-info">Loading candles…</div>
        )}

        {!candlesLoading && candles.length === 0 && (
          <div className="status-banner status-banner-warn">
            Backfilling… History worker fills candles for hot markets within a few minutes.
          </div>
        )}

        {!candlesLoading && candles.length > 0 && <CandlestickChart candles={candles} />}
      </div>
    </div>
  );
}
