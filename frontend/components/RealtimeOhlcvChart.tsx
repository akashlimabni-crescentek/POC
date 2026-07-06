'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createBrowserClient } from '@/lib/supabase/client';
import { getCandles } from '@/lib/queries';
import { aggregateCandles } from '@/lib/candle-aggregate';
import { createOhlcvChart, type OhlcvChartHandle } from '@/lib/chart';
import { CandleAggregator, marketPriceToEvent } from '@/lib/candle-aggregator';
import { subscribeMarketPricesWithStatus } from '@/lib/realtime';
import {
  OHLCV_SOURCE,
  ohlcvBucketMs,
  ohlcvRangeToWindow,
  type OhlcvInterval,
} from '@/lib/chart-config';

type Status = 'loading' | 'ready' | 'empty' | 'error';

type RealtimeOhlcvChartProps = {
  marketId: number | null;
  interval: OhlcvInterval;
  height?: number;
};

/**
 * Realtime OHLCV chart built on a two-lane model:
 *
 *  - Slow lane (React state): only `status` — flips a handful of times a session
 *    on load / error / market / interval changes.
 *  - Fast lane (refs + imperative chart API): every realtime tick is folded into
 *    the aggregator and painted straight to Lightweight Charts, bypassing React
 *    entirely. Thousands of updates/sec cause zero re-renders.
 *
 * Historical candles are loaded once per (market, interval) and never mutated;
 * only the trailing live candle is updated.
 */
export default function RealtimeOhlcvChart({
  marketId,
  interval,
  height = 480,
}: RealtimeOhlcvChartProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // ---- fast-lane refs (mutating these never triggers a render) ----
  const handleRef = useRef<OhlcvChartHandle | null>(null);
  const aggregatorRef = useRef<CandleAggregator | null>(null);
  const historyReadyRef = useRef(false); // has setHistory run for the active key?
  const rafRef = useRef<number | null>(null); // pending throttled paint
  const tokenRef = useRef(0); // invalidates stale async loads / late events
  const resyncingRef = useRef(false); // guards concurrent resyncs
  const reconnectRef = useRef(false); // saw a dropped/errored connection?

  // ---- slow-lane state (coarse, low frequency) ----
  const [status, setStatus] = useState<Status>('loading');

  // Create the Lightweight Charts instance exactly once. It survives every
  // market/interval change — we only feed it new data, never rebuild it.
  useEffect(() => {
    const container = containerRef.current;
    const wrapper = wrapperRef.current;
    if (!container || !wrapper) {
      return;
    }

    const handle = createOhlcvChart(container, height, wrapper);
    handleRef.current = handle;

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        handle.resize(entry.contentRect.width, height);
      }
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      handle.destroy();
      handleRef.current = null;
    };
  }, [height]);

  // Coalesce live-candle paints to at most one per animation frame. Every event
  // is folded into the aggregator immediately (so high/low/volume stay exact);
  // only the draw is throttled, which keeps a hot market off the main thread.
  const scheduleFlush = useCallback(() => {
    if (rafRef.current != null) {
      return;
    }
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const handle = handleRef.current;
      const live = aggregatorRef.current?.current;
      if (handle && historyReadyRef.current && live) {
        handle.updateLive(live);
      }
    });
  }, []);

  // Load history + subscribe. Re-runs whenever the (market, interval) key
  // changes — this single path covers both market switching and interval
  // switching (freeze previous, load fresh, resume aggregation).
  useEffect(() => {
    if (marketId == null) {
      return;
    }

    // Bump the token so any in-flight load or late event from the previous key
    // is discarded, and start a fresh aggregator for this key.
    const token = ++tokenRef.current;
    historyReadyRef.current = false;
    reconnectRef.current = false;
    setStatus('loading');

    const supabase = createBrowserClient();
    aggregatorRef.current = new CandleAggregator(marketId, interval, ohlcvBucketMs(interval));

    // Fetch immutable history for the active key and hand it to the chart once.
    const loadHistory = async (fit: boolean) => {
      const config = OHLCV_SOURCE[interval];
      const { from, to } = ohlcvRangeToWindow(interval);
      let rows = await getCandles(supabase, marketId, config.sourceInterval, from, to);
      if (config.aggregateMs) {
        rows = aggregateCandles(rows, config.aggregateMs);
      }
      if (token !== tokenRef.current) {
        return null; // superseded by a newer key — drop
      }
      handleRef.current?.setHistory(rows, { fit });
      return rows;
    };

    loadHistory(true)
      .then((rows) => {
        if (rows == null) {
          return;
        }
        historyReadyRef.current = true;
        setStatus(rows.length ? 'ready' : 'empty');
        scheduleFlush(); // paint any candle that formed while history loaded
      })
      .catch((err) => {
        if (token !== tokenRef.current) {
          return;
        }
        console.error('[RealtimeOhlcvChart] history load failed:', err);
        setStatus('error');
      });

    // On reconnect, refetch history and reset the aggregator so the current
    // bucket rebuilds cleanly. Dedupe-by-id makes this safe — replayed events
    // can never double-count.
    const resync = async () => {
      if (resyncingRef.current) {
        return;
      }
      resyncingRef.current = true;
      try {
        aggregatorRef.current?.reset();
        const rows = await loadHistory(false);
        if (rows != null) {
          setStatus(rows.length ? 'ready' : 'empty');
        }
      } catch (err) {
        console.error('[RealtimeOhlcvChart] resync failed:', err);
      } finally {
        resyncingRef.current = false;
      }
    };

    const unsubscribe = subscribeMarketPricesWithStatus(
      supabase,
      marketId,
      (row) => {
        if (token !== tokenRef.current) {
          return; // late event from a superseded market/interval
        }
        const aggregator = aggregatorRef.current;
        if (!aggregator) {
          return;
        }
        const event = marketPriceToEvent(row);
        if (!event) {
          return;
        }
        const result = aggregator.ingest(event);
        if (!result) {
          return;
        }
        // On a boundary crossing, paint the just-closed candle immediately with
        // its final aggregated values — rAF coalescing would otherwise skip it
        // (the next frame paints only the new live candle). Rollovers are rare
        // (once per bucket), so a direct update here is cheap.
        if (result.sealed && historyReadyRef.current) {
          handleRef.current?.updateLive(result.sealed);
        }
        scheduleFlush();
      },
      (connStatus) => {
        if (
          connStatus === 'CHANNEL_ERROR' ||
          connStatus === 'TIMED_OUT' ||
          connStatus === 'CLOSED'
        ) {
          reconnectRef.current = true;
        } else if (connStatus === 'SUBSCRIBED' && reconnectRef.current) {
          reconnectRef.current = false;
          void resync();
        }
      }
    );

    return () => {
      unsubscribe();
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [marketId, interval, scheduleFlush]);

  return (
    <div ref={wrapperRef} className="chart-wrap">
      {status === 'loading' && (
        <div className="status-banner status-banner-info">Loading chart…</div>
      )}
      {status === 'error' && (
        <div className="status-banner status-banner-warn">Failed to load chart data</div>
      )}
      {status === 'empty' && (
        <div className="status-banner status-banner-warn">
          No OHLCV data yet — promote this event to hot and wait for history backfill.
        </div>
      )}
      <div ref={containerRef} className="chart-shell" style={{ minHeight: height }} />
    </div>
  );
}
