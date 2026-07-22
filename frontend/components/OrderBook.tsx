'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createBrowserClient } from '@/lib/supabase/client';
import { getMarketOrderbook } from '@/lib/queries';
import { subscribeMarketOrderbookWithStatus } from '@/lib/realtime';
import {
  fmtBookPrice,
  fmtBookQty,
  kalshiToNoBook,
  kalshiToYesBook,
  logOrderbookEvent,
  parseBookLevels,
  polyToBook,
  type BookLevel,
  type KalshiBookResponse,
  type NormalizedBook,
  type PolyBookResponse,
} from '@/lib/orderbook';
import type { MarketOrderbookLatest } from '@/lib/types';

const REST_FALLBACK_MS = 30_000;
const LADDER_ROWS = 10;

type OrderBookProps = {
  marketId: number;
  providerSlug: string;
  kalshiTicker?: string | null;
  polyTokenId?: string | null;
  yesPrice?: number | null;
  noPrice?: number | null;
};

function DepthChart({ bids, asks }: NormalizedBook) {
  const model = useMemo(() => {
    if (bids.length === 0 && asks.length === 0) return null;

    const bidPts: { price: number; cum: number }[] = [];
    for (let i = 0, acc = 0; i < bids.length; i++) {
      acc += bids[i].qty;
      bidPts.push({ price: bids[i].price, cum: acc });
    }

    const askPts: { price: number; cum: number }[] = [];
    for (let i = 0, acc = 0; i < asks.length; i++) {
      acc += asks[i].qty;
      askPts.push({ price: asks[i].price, cum: acc });
    }

    const maxCum = Math.max(bidPts.at(-1)?.cum ?? 0, askPts.at(-1)?.cum ?? 0, 1);
    const minP = Math.min(bids.at(-1)?.price ?? 1, asks[0]?.price ?? 0);
    const maxP = Math.max(asks.at(-1)?.price ?? 0, bids[0]?.price ?? 1);
    const span = Math.max(maxP - minP, 0.01);

    return { bidPts, askPts, maxCum, minP, span };
  }, [bids, asks]);

  const [hover, setHover] = useState<{
    x: number;
    side: 'bid' | 'ask';
    price: number;
    cum: number;
  } | null>(null);

  if (!model) {
    return <div className="orderbook-empty">No orderbook data</div>;
  }

  const W = 100;
  const H = 40;
  const x = (p: number) => ((p - model.minP) / model.span) * W;
  const y = (c: number) => H - (c / model.maxCum) * (H - 3);

  const stepPath = (pts: { price: number; cum: number }[], leftward: boolean) => {
    if (pts.length === 0) return null;
    let d = `M ${x(pts[0].price)} ${H}`;
    let prevY = H;
    for (const pt of pts) {
      d += ` L ${x(pt.price)} ${prevY} L ${x(pt.price)} ${y(pt.cum)}`;
      prevY = y(pt.cum);
    }
    const endX = leftward ? 0 : W;
    d += ` L ${endX} ${prevY} L ${endX} ${H} Z`;
    return d;
  };

  const bidPath = stepPath(model.bidPts, true);
  const askPath = stepPath(model.askPts, false);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const price = model.minP + (px / W) * model.span;
    const side: 'bid' | 'ask' =
      model.bidPts[0] && price <= model.bidPts[0].price ? 'bid' : 'ask';
    const pts = side === 'bid' ? model.bidPts : model.askPts;
    const within =
      side === 'bid'
        ? pts.filter((p) => p.price >= price)
        : pts.filter((p) => p.price <= price);
    const cum = within.at(-1)?.cum ?? 0;
    setHover({ x: px, side, price, cum });
  };

  return (
    <div className="orderbook-depth-wrap">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="orderbook-depth-svg"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {bidPath && (
          <path
            d={bidPath}
            className="orderbook-depth-bid"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {askPath && (
          <path
            d={askPath}
            className="orderbook-depth-ask"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {hover && (
          <line
            x1={hover.x}
            y1="0"
            x2={hover.x}
            y2={H}
            className="orderbook-depth-crosshair"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {hover && (
        <div
          className={`orderbook-depth-tooltip orderbook-depth-tooltip-${hover.side}`}
          style={{ left: hover.x > 50 ? '8px' : undefined, right: hover.x > 50 ? undefined : '8px' }}
        >
          {fmtBookPrice(hover.price)} · {fmtBookQty(hover.cum)} cum
        </div>
      )}
    </div>
  );
}

function LadderRow({
  level,
  side,
  maxQty,
}: {
  level: BookLevel;
  side: 'bid' | 'ask';
  maxQty: number;
}) {
  const barPct = maxQty > 0 ? (level.qty / maxQty) * 100 : 0;
  return (
    <div className={`orderbook-ladder-row orderbook-ladder-row-${side}`}>
      <div className="orderbook-ladder-bar" style={{ width: `${barPct}%` }} />
      <span className="orderbook-ladder-price">{fmtBookPrice(level.price)}</span>
      <span className="orderbook-ladder-qty">{fmtBookQty(level.qty)}</span>
      <span className="orderbook-ladder-total">{fmtBookQty(level.qty * level.price)}</span>
    </div>
  );
}

function Ladder({ book, side }: { book: NormalizedBook; side: 'yes' | 'no' }) {
  const bids = book.bids.slice(0, LADDER_ROWS);
  const asks = [...book.asks].slice(0, LADDER_ROWS).reverse();
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = book.asks[0]?.price ?? null;
  const spreadCents =
    bestBid != null && bestAsk != null ? Math.round((bestAsk - bestBid) * 100) : null;
  const maxQty = Math.max(...[...bids, ...book.asks.slice(0, LADDER_ROWS)].map((l) => l.qty), 1);

  return (
    <div className="orderbook-ladder">
      <div className="orderbook-ladder-header">
        <span>Price</span>
        <span>Qty</span>
        <span>Total</span>
      </div>

      {asks.length === 0 ? (
        <div className="orderbook-ladder-empty">No asks</div>
      ) : (
        asks.map((l, i) => (
          <LadderRow key={`ask-${l.price}-${i}`} level={l} side="ask" maxQty={maxQty} />
        ))
      )}

      <div className="orderbook-spread">
        <span />
        <span>{spreadCents != null ? `Spread ${spreadCents}¢` : 'Spread —'}</span>
        <span />
      </div>

      {bids.length === 0 ? (
        <div className="orderbook-ladder-empty">No bids</div>
      ) : (
        bids.map((l, i) => (
          <LadderRow key={`bid-${l.price}-${i}`} level={l} side="bid" maxQty={maxQty} />
        ))
      )}

      <div className="orderbook-side-label">{side === 'yes' ? 'Yes side' : 'No side'}</div>
    </div>
  );
}

function PolyLadder({ book }: { book: NormalizedBook }) {
  const maxQty = Math.max(...[...book.bids, ...book.asks].map((l) => l.qty), 1);
  const bestBid = book.bids[0]?.price ?? null;
  const bestAsk = book.asks[0]?.price ?? null;
  const spreadCents =
    bestBid != null && bestAsk != null ? Math.round((bestAsk - bestBid) * 100) : null;

  return (
    <div className="orderbook-poly-ladder">
      <div className="orderbook-poly-col">
        <div className="orderbook-ladder-header">
          <span>Bid</span>
          <span>Qty</span>
        </div>
        {book.bids.slice(0, LADDER_ROWS).map((l, i) => (
          <div key={i} className="orderbook-poly-row orderbook-poly-row-bid">
            <div
              className="orderbook-ladder-bar"
              style={{ width: `${(l.qty / maxQty) * 100}%` }}
            />
            <span>{fmtBookPrice(l.price)}</span>
            <span>{fmtBookQty(l.qty)}</span>
          </div>
        ))}
        {book.bids.length === 0 && <div className="orderbook-ladder-empty">Empty</div>}
      </div>
      <div className="orderbook-poly-divider" />
      <div className="orderbook-poly-col">
        <div className="orderbook-ladder-header">
          <span>Ask</span>
          <span>Qty</span>
        </div>
        {book.asks.slice(0, LADDER_ROWS).map((l, i) => (
          <div key={i} className="orderbook-poly-row orderbook-poly-row-ask">
            <div
              className="orderbook-ladder-bar"
              style={{ width: `${(l.qty / maxQty) * 100}%` }}
            />
            <span>{fmtBookPrice(l.price)}</span>
            <span>{fmtBookQty(l.qty)}</span>
          </div>
        ))}
        {book.asks.length === 0 && <div className="orderbook-ladder-empty">Empty</div>}
      </div>
      <div className="orderbook-poly-spread">
        {spreadCents != null ? `Spread ${spreadCents}¢` : 'Spread —'}
      </div>
    </div>
  );
}

export default function OrderBook({
  marketId,
  providerSlug,
  kalshiTicker,
  polyTokenId,
  yesPrice,
  noPrice,
}: OrderBookProps) {
  const isKalshi = providerSlug === 'kalshi';
  const isPoly = providerSlug === 'polymarket';
  const canLoad = isKalshi ? !!kalshiTicker : isPoly ? !!polyTokenId : false;

  const [side, setSide] = useState<'yes' | 'no'>('yes');
  const [kalshiRaw, setKalshiRaw] = useState<KalshiBookResponse | null>(null);
  const [polyBook, setPolyBook] = useState<NormalizedBook | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const [realtimeDataReceived, setRealtimeDataReceived] = useState(false);
  const hasBookRef = useRef(false);

  const applyOrderbookRow = useCallback(
    (row: MarketOrderbookLatest, source: 'db' | 'realtime') => {
      logOrderbookEvent(source, marketId, providerSlug, row);
      if (source === 'realtime') {
        setRealtimeDataReceived(true);
      }

      if (isKalshi) {
        const yes_bids = parseBookLevels(row.yes_bids);
        const no_bids = parseBookLevels(row.no_bids);
        if (yes_bids.length === 0 && no_bids.length === 0) return false;
        setKalshiRaw({
          ticker: kalshiTicker ?? '',
          yes_bids,
          no_bids,
        });
      } else if (isPoly) {
        const bids = parseBookLevels(row.bids);
        const asks = parseBookLevels(row.asks);
        if (bids.length === 0 && asks.length === 0) return false;
        setPolyBook(polyToBook(bids, asks));
      } else {
        return false;
      }

      setError(null);
      setLastUpdated(row.updated_at ? new Date(row.updated_at) : new Date());
      hasBookRef.current = true;
      return true;
    },
    [isKalshi, isPoly, kalshiTicker, marketId, providerSlug]
  );

  const fetchRestBook = useCallback(async () => {
    if (!canLoad) return;

    try {
      if (isKalshi && kalshiTicker) {
        const res = await fetch(`/api/orderbook/kalshi/${encodeURIComponent(kalshiTicker)}`, {
          cache: 'no-store',
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as KalshiBookResponse;
        logOrderbookEvent('rest', marketId, providerSlug, {
          yes_bids: data.yes_bids,
          no_bids: data.no_bids,
          updated_at: new Date().toISOString(),
        }, { kalshiTicker });
        setKalshiRaw(data);
        setError(null);
        setLastUpdated(new Date());
        hasBookRef.current = true;
      } else if (isPoly && polyTokenId) {
        const res = await fetch(`/api/orderbook/poly/${encodeURIComponent(polyTokenId)}`, {
          cache: 'no-store',
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as PolyBookResponse;
        logOrderbookEvent('rest', marketId, providerSlug, {
          bids: data.bids,
          asks: data.asks,
          updated_at: new Date().toISOString(),
        }, { polyTokenId });
        setPolyBook(polyToBook(data.bids, data.asks));
        setError(null);
        setLastUpdated(new Date());
        hasBookRef.current = true;
      }
    } catch (e) {
      if (!hasBookRef.current) {
        setError(e instanceof Error ? e.message : 'Failed to load orderbook');
      }
    } finally {
      setLoading(false);
    }
  }, [canLoad, isKalshi, isPoly, kalshiTicker, polyTokenId, marketId, providerSlug]);

  const loadFromDb = useCallback(async () => {
    if (!canLoad || !marketId) return false;
    const supabase = createBrowserClient();
    const row = await getMarketOrderbook(supabase, marketId);
    if (!row) {
      console.log('[OrderBook]', {
        source: 'db',
        table: 'market_orderbook_latest',
        marketId,
        provider: providerSlug,
        receivedAt: new Date().toISOString(),
        summary: null,
        message: 'No row in market_orderbook_latest yet',
      });
      return false;
    }
    const applied = applyOrderbookRow(row, 'db');
    if (applied) setLoading(false);
    return applied;
  }, [applyOrderbookRow, canLoad, marketId, providerSlug]);

  useEffect(() => {
    setLoading(true);
    setKalshiRaw(null);
    setPolyBook(null);
    setError(null);
    setRealtimeConnected(false);
    setRealtimeDataReceived(false);
    hasBookRef.current = false;
  }, [kalshiTicker, polyTokenId, providerSlug, marketId]);

  useEffect(() => {
    if (!canLoad || !marketId) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    const bootstrap = async () => {
      const fromDb = await loadFromDb();
      if (cancelled) return;
      if (!fromDb) {
        await fetchRestBook();
      }
    };

    bootstrap();

    const supabase = createBrowserClient();
    const unsubscribe = subscribeMarketOrderbookWithStatus(
      supabase,
      marketId,
      (row) => {
        if (cancelled) return;
        applyOrderbookRow(row, 'realtime');
        setLoading(false);
      },
      (status) => {
        if (cancelled) return;
        const connected = status === 'SUBSCRIBED';
        setRealtimeConnected(connected);
        console.log('[OrderBook]', {
          source: 'realtime',
          table: 'market_orderbook_latest',
          marketId,
          provider: providerSlug,
          channelStatus: status,
          subscribed: connected,
          receivedAt: new Date().toISOString(),
        });
        if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          void loadFromDb();
        }
      }
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyOrderbookRow, canLoad, fetchRestBook, loadFromDb, marketId]);

  useEffect(() => {
    if (!canLoad) return;
    if (realtimeConnected && hasBookRef.current) return;

    const timer = setInterval(() => {
      void fetchRestBook();
    }, REST_FALLBACK_MS);

    return () => clearInterval(timer);
  }, [canLoad, fetchRestBook, realtimeConnected]);

  const kalshiBook = useMemo(() => {
    if (!kalshiRaw) return null;
    return side === 'yes'
      ? kalshiToYesBook(kalshiRaw.yes_bids, kalshiRaw.no_bids)
      : kalshiToNoBook(kalshiRaw.yes_bids, kalshiRaw.no_bids);
  }, [kalshiRaw, side]);

  const displayBook = isKalshi ? kalshiBook : polyBook;
  const bestBid = displayBook?.bids[0]?.price ?? null;
  const bestAsk = displayBook?.asks[0]?.price ?? null;
  const spread =
    bestBid != null && bestAsk != null ? bestAsk - bestBid : null;

  const yesPct = yesPrice != null ? Math.round(yesPrice * 100) : null;
  const noPct = noPrice != null ? Math.round(noPrice * 100) : null;

  if (!canLoad) {
    return (
      <div className="status-banner status-banner-warn">
        Order book unavailable — missing market identifier for this provider.
      </div>
    );
  }

  return (
    <div className="orderbook-panel">
      <div className="orderbook-toolbar">
        <span className="orderbook-title">Order Book</span>
        <span className="orderbook-meta">
          {loading && !displayBook ? 'Loading…' : null}
          {!loading && lastUpdated ? (
            <span className="orderbook-live">
              <span className="orderbook-live-dot" />
              {realtimeDataReceived
                ? 'Realtime'
                : realtimeConnected
                  ? 'Waiting for live book…'
                  : 'REST fallback'}{' '}
              · {lastUpdated.toLocaleTimeString()}
            </span>
          ) : null}
        </span>
      </div>

      {isKalshi && (
        <div className="orderbook-side-toggle">
          <button
            type="button"
            className={`orderbook-toggle-btn ${side === 'yes' ? 'orderbook-toggle-yes-active' : ''}`}
            onClick={() => setSide('yes')}
          >
            <span>Trade Yes</span>
            <strong>{yesPct != null ? `${yesPct}¢` : '—'}</strong>
          </button>
          <button
            type="button"
            className={`orderbook-toggle-btn ${side === 'no' ? 'orderbook-toggle-no-active' : ''}`}
            onClick={() => setSide('no')}
          >
            <span>Trade No</span>
            <strong>{noPct != null ? `${noPct}¢` : '—'}</strong>
          </button>
        </div>
      )}

      <div className="orderbook-topline">
        <span className="orderbook-top-bid">{bestBid != null ? fmtBookPrice(bestBid) : '—'}</span>
        <span className="orderbook-top-spread">
          {spread != null ? `spread ${fmtBookPrice(spread)}` : 'spread —'}
        </span>
        <span className="orderbook-top-ask">{bestAsk != null ? fmtBookPrice(bestAsk) : '—'}</span>
      </div>

      {error && !displayBook && (
        <div className="status-banner status-banner-warn">{error}</div>
      )}

      {displayBook && (
        <>
          <DepthChart bids={displayBook.bids} asks={displayBook.asks} />
          {isKalshi ? (
            <Ladder book={displayBook} side={side} />
          ) : (
            <PolyLadder book={displayBook} />
          )}
        </>
      )}

      {!displayBook && !error && loading && (
        <div className="status-banner status-banner-info">Loading order book…</div>
      )}
    </div>
  );
}
