'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createBrowserClient } from '@/lib/supabase/client';
import { getCandles, getFinerCandlesForBucket } from '@/lib/queries';
import { aggregateCandles } from '@/lib/candle-aggregate';
import { createOhlcvChart, type OhlcvChartHandle } from '@/lib/chart';
import { CandleAggregator, bucketStartMs, marketPriceToEvent } from '@/lib/candle-aggregator';
import { buildFormingCandle } from '@/lib/candle-composer';
import { subscribeMarketPricesWithStatus } from '@/lib/realtime';
import {
  OHLCV_SOURCE,
  SUB_INTERVAL_LADDER,
  ohlcvBucketMs,
  ohlcvRangeToWindow,
  type OhlcvInterval,
} from '@/lib/chart-config';
import type { CandleInterval, CandleRow } from '@/lib/types';

/** How often to refetch the finer sub-candles so newly-closed blocks fold into
 *  the forming candle and the live tail shrinks. */
const FINER_REFETCH_MS = 15_000;

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

  // ---- forming-candle refs ----
  // Finer stored candles (5m/1m/…) covering the current bucket, grouped by
  // interval. The forming right-edge candle is composed from these + the live
  // tail, so it stays accurate before its own coarse row is ever written.
  const finerRowsRef = useRef<Record<string, CandleRow[]>>({});
  const formingBucketStartRef = useRef<number | null>(null);
  // Snapshot of the active key so the []-deps paint callback reads live config.
  const configRef = useRef<{
    marketId: number;
    interval: OhlcvInterval;
    bucketMs: number;
    ladder: CandleInterval[];
  } | null>(null);

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

  // Compose the forming right-edge candle (finer DB blocks + live tail) and
  // paint it. `log` is true for coarse events (load, bucket roll, refetch) and
  // false on the hot per-frame path to keep the console readable.
  const paintForming = useCallback((log: boolean) => {
    const handle = handleRef.current;
    const cfg = configRef.current;
    if (!handle || !historyReadyRef.current || !cfg) {
      return;
    }
    const now = Date.now();
    const bucket = bucketStartMs(now, cfg.bucketMs);
    const { candle } = buildFormingCandle({
      marketId: cfg.marketId,
      interval: cfg.interval,
      bucketStartMs: bucket,
      nowMs: now,
      ladder: cfg.ladder,
      finerRowsByInterval: finerRowsRef.current,
      liveTail: aggregatorRef.current?.current ?? null,
      log,
    });
    if (!candle) {
      return;
    }
    handle.updateLive(candle);
    if (log) {
      console.log('[candle] chart update', {
        interval: cfg.interval,
        ts: candle.ts,
        o: candle.open,
        h: candle.high,
        l: candle.low,
        c: candle.close,
        v: candle.volume,
      });
    }
  }, []);

  // Coalesce paints to at most one per animation frame. Every event is folded
  // into the aggregator immediately (so high/low/close stay exact); only the
  // draw is throttled, which keeps a hot market off the main thread.
  const scheduleFlush = useCallback(() => {
    if (rafRef.current != null) {
      return;
    }
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      paintForming(false);
    });
  }, [paintForming]);

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
    const bucketMs = ohlcvBucketMs(interval);
    const ladder = SUB_INTERVAL_LADDER[interval];
    aggregatorRef.current = new CandleAggregator(marketId, interval, bucketMs);
    configRef.current = { marketId, interval, bucketMs, ladder };
    finerRowsRef.current = {};
    formingBucketStartRef.current = null;

    // Fetch immutable history for the active key and hand it to the chart once.
    // Any row at/after the current bucket start is dropped — that bucket is the
    // forming candle, which we own via composition, so history stays strictly
    // in the past and never collides with the live right edge.
    const loadHistory = async (fit: boolean) => {
      const config = OHLCV_SOURCE[interval];
      const { from, to } = ohlcvRangeToWindow(interval);
      let rows = await getCandles(supabase, marketId, config.sourceInterval, from, to);
      if (config.aggregateMs) {
        console.log('[candle] before aggregate', {
          interval,
          sourceInterval: config.sourceInterval,
          rowCount: rows.length,
        });
        rows = aggregateCandles(rows, config.aggregateMs);
        console.log('[candle] after aggregate', { interval, rowCount: rows.length });
      }
      const bucketStart = bucketStartMs(Date.now(), bucketMs);
      const completed = rows.filter((r: CandleRow) => (Date.parse(r.ts) || 0) < bucketStart);
      console.log('[candle] history rows', {
        interval,
        completed: completed.length,
        droppedFormingBucket: rows.length - completed.length,
        firstTs: completed[0]?.ts ?? null,
        lastTs: completed[completed.length - 1]?.ts ?? null,
      });
      if (token !== tokenRef.current) {
        return null; // superseded by a newer key — drop
      }
      handleRef.current?.setHistory(completed, { fit });
      return completed;
    };

    // Refetch the finer sub-candles for the current bucket, then recompose the
    // forming candle. Called on load, on bucket roll, on a timer, and on resync.
    const refetchFiner = async (reason: string) => {
      const now = Date.now();
      const bucket = bucketStartMs(now, bucketMs);
      formingBucketStartRef.current = bucket;
      if (ladder.length === 0) {
        finerRowsRef.current = {};
        paintForming(true);
        return;
      }
      try {
        const rows = await getFinerCandlesForBucket(
          supabase,
          marketId,
          ladder,
          new Date(bucket).toISOString(),
          new Date(now).toISOString()
        );
        if (token !== tokenRef.current) {
          return;
        }
        finerRowsRef.current = rows;
        console.log('[candle] finer refetch', {
          reason,
          interval,
          bucketStart: new Date(bucket).toISOString(),
          rowCounts: Object.fromEntries(ladder.map((iv) => [iv, rows[iv]?.length ?? 0])),
        });
        paintForming(true);
      } catch (err) {
        console.error('[candle] finer refetch failed:', err);
      }
    };

    loadHistory(true)
      .then((rows) => {
        if (rows == null) {
          return;
        }
        historyReadyRef.current = true;
        setStatus(rows.length ? 'ready' : 'empty');
        void refetchFiner('initial'); // seed + paint the forming candle
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
          await refetchFiner('resync');
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
          return; // duplicate / late / out-of-order — dropped by the aggregator
        }
        console.log('[candle] live tick', {
          interval,
          ts: new Date(event.tsMs).toISOString(),
          close: event.close,
          volume: event.volume,
        });
        // Boundary crossed: the selected-interval bucket rolled. The just-closed
        // bucket keeps its last-composed value (frozen on the chart); refetch the
        // finer blocks for the new bucket and recompose from scratch.
        const eventBucket = bucketStartMs(event.tsMs, bucketMs);
        if (eventBucket !== formingBucketStartRef.current) {
          void refetchFiner('bucket-roll');
        } else {
          scheduleFlush();
        }
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

    // Periodically pull in freshly-closed finer blocks so the forming candle
    // keeps folding them in (and the live tail shrinks) even in a quiet market.
    const finerTimer = setInterval(() => void refetchFiner('periodic'), FINER_REFETCH_MS);

    return () => {
      unsubscribe();
      clearInterval(finerTimer);
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [marketId, interval, scheduleFlush, paintForming]);

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
