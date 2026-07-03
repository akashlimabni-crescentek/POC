'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createBrowserClient } from '@/lib/supabase/client';
import { getCandles, pickLatestPrice } from '@/lib/queries';
import { getMarketDisplayName } from '@/lib/market-label';
import { aggregateCandles } from '@/lib/candle-aggregate';
import { applyLiveTickToCandles } from '@/lib/live-tick-candles';
import { subscribeLiveTicks, subscribeMarketPricesMany } from '@/lib/realtime';
import {
  LINE_TIME_RANGES,
  OHLCV_INTERVALS,
  OHLCV_SOURCE,
  lineRangeToWindow,
  lineSourceInterval,
  ohlcvBucketMs,
  ohlcvRangeToWindow,
  outcomeColor,
  type ChartMode,
  type LineTimeRange,
  type OhlcvInterval,
} from '@/lib/chart-config';
import { toLinePoints, type ChartLinePoint, type LineSeriesInput } from '@/lib/chart';
import MultiLineChart from '@/components/MultiLineChart';
import OhlcvChart from '@/components/OhlcvChart';
import type { CandleRow, MarketPriceLatest, MarketRow } from '@/lib/types';

const DEFAULT_LINE_VISIBLE = 4;

function applyPriceToLineSeries(
  series: LineSeriesInput[],
  row: MarketPriceLatest
): LineSeriesInput[] {
  const value = row.last_price ?? row.mid;
  if (value == null || !row.updated_at) {
    return series;
  }

  const timeSec = Math.floor(Date.parse(row.updated_at) / 1000);
  if (Number.isNaN(timeSec)) {
    return series;
  }

  return series.map((item) => {
    if (item.id !== row.market_id || !item.points.length) {
      return item;
    }

    const points = [...item.points];
    const last = points[points.length - 1];

    if (timeSec > last.time) {
      points.push({ time: timeSec as ChartLinePoint['time'], value });
    } else if (timeSec === last.time) {
      points[points.length - 1] = { time: last.time, value };
    } else {
      points[points.length - 1] = { ...last, value };
    }

    return { ...item, points };
  });
}

function sortMarketsByPrice(markets: MarketRow[]): MarketRow[] {
  return [...markets].sort((a, b) => {
    const pa = pickLatestPrice(a)?.last_price ?? pickLatestPrice(a)?.mid ?? -1;
    const pb = pickLatestPrice(b)?.last_price ?? pickLatestPrice(b)?.mid ?? -1;
    return pb - pa;
  });
}

type EventChartProps = {
  eventTitle: string | null;
  markets: MarketRow[];
};

export default function EventChart({ eventTitle, markets }: EventChartProps) {
  const initializedRef = useRef(false);
  const [mode, setMode] = useState<ChartMode>('line');
  const [lineRange, setLineRange] = useState<LineTimeRange>('1D');
  const [ohlcvInterval, setOhlcvInterval] = useState<OhlcvInterval>('5m');
  const [visibleIds, setVisibleIds] = useState<Set<number>>(new Set());
  const [selectedMarketId, setSelectedMarketId] = useState<number | null>(null);
  const [lineSeries, setLineSeries] = useState<LineSeriesInput[]>([]);
  const [ohlcvCandles, setOhlcvCandles] = useState<CandleRow[]>([]);
  const [lineResetKey, setLineResetKey] = useState('');
  const [ohlcvResetKey, setOhlcvResetKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const marketById = useMemo(() => new Map(markets.map((m) => [m.id, m])), [markets]);
  const colorById = useMemo(
    () => new Map(markets.map((m, i) => [m.id, outcomeColor(i)])),
    [markets]
  );

  useEffect(() => {
    if (initializedRef.current || !markets.length) {
      return;
    }
    initializedRef.current = true;
    const sorted = sortMarketsByPrice(markets);
    setVisibleIds(new Set(sorted.slice(0, DEFAULT_LINE_VISIBLE).map((m) => m.id)));
    setSelectedMarketId(sorted[0]?.id ?? markets[0].id);
  }, [markets]);

  const toggleMarket = (id: number) => {
    setVisibleIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        if (next.size > 1) {
          next.delete(id);
        }
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const loadLineData = useCallback(async () => {
    if (!visibleIds.size) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const supabase = createBrowserClient();
      const { from, to } = lineRangeToWindow(lineRange);
      const sourceInterval = lineSourceInterval(lineRange);
      const ids = [...visibleIds];

      const results = await Promise.all(
        ids.map(async (id) => {
          const rows = await getCandles(supabase, id, sourceInterval, from, to);
          const market = marketById.get(id);
          if (!market) {
            return null;
          }
          return {
            id,
            label: getMarketDisplayName(market, eventTitle),
            color: colorById.get(id) ?? outcomeColor(id),
            points: toLinePoints(rows),
          };
        })
      );

      setLineSeries(results.filter((r): r is LineSeriesInput => r != null && r.points.length > 0));
      setLineResetKey(`${lineRange}-${[...visibleIds].sort((a, b) => a - b).join(',')}`);
    } catch (err) {
      console.error('[EventChart] line load failed:', err);
      setError('Failed to load chart data');
      setLineSeries([]);
    } finally {
      setLoading(false);
    }
  }, [visibleIds, lineRange, marketById, colorById, eventTitle]);

  const loadOhlcvData = useCallback(async () => {
    if (selectedMarketId == null) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const supabase = createBrowserClient();
      const config = OHLCV_SOURCE[ohlcvInterval];
      const { from, to } = ohlcvRangeToWindow(ohlcvInterval);
      let rows = await getCandles(supabase, selectedMarketId, config.sourceInterval, from, to);

      if (config.aggregateMs) {
        rows = aggregateCandles(rows, config.aggregateMs);
      }

      setOhlcvCandles(rows);
      setOhlcvResetKey(`${selectedMarketId}-${ohlcvInterval}`);
    } catch (err) {
      console.error('[EventChart] ohlcv load failed:', err);
      setError('Failed to load chart data');
      setOhlcvCandles([]);
    } finally {
      setLoading(false);
    }
  }, [selectedMarketId, ohlcvInterval]);

  useEffect(() => {
    if (mode === 'line' && visibleIds.size > 0) {
      loadLineData();
    }
  }, [mode, loadLineData, visibleIds.size]);

  useEffect(() => {
    if (mode === 'ohlcv' && selectedMarketId != null) {
      loadOhlcvData();
    }
  }, [mode, loadOhlcvData, selectedMarketId]);

  useEffect(() => {
    if (mode !== 'line' || visibleIds.size === 0) {
      return;
    }

    const supabase = createBrowserClient();
    const ids = [...visibleIds];

    return subscribeMarketPricesMany(
      supabase,
      `event-chart-prices-${ids.join('-')}`,
      ids,
      (row) => {
        setLineSeries((prev) => applyPriceToLineSeries(prev, row));
      }
    );
  }, [mode, visibleIds]);

  useEffect(() => {
    if (mode !== 'ohlcv' || selectedMarketId == null) {
      return;
    }

    const supabase = createBrowserClient();

    return subscribeLiveTicks(supabase, selectedMarketId, (tick) => {
      const bucketMs = ohlcvBucketMs(ohlcvInterval);
      setOhlcvCandles((prev) => applyLiveTickToCandles(prev, tick, bucketMs));
    });
  }, [mode, selectedMarketId, ohlcvInterval]);

  if (!markets.length) {
    return null;
  }

  return (
    <div className="event-chart card">
      <div className="event-chart-header">
        <span className="muted" style={{ fontSize: '0.8125rem' }}>
          {markets.length} outcome{markets.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="outcome-chips">
        {markets.map((market, index) => {
          const label = getMarketDisplayName(market, eventTitle);
          const color = outcomeColor(index);
          const active =
            mode === 'line' ? visibleIds.has(market.id) : selectedMarketId === market.id;

          return (
            <button
              key={market.id}
              type="button"
              className={`outcome-chip ${active ? 'outcome-chip-active' : ''}`}
              onClick={() => {
                if (mode === 'line') {
                  toggleMarket(market.id);
                } else {
                  setSelectedMarketId(market.id);
                }
              }}
            >
              <span className="outcome-dot" style={{ background: color }} />
              {label}
            </button>
          );
        })}
      </div>

      <div className="chart-toolbar">
        <div className="mode-toggle">
          <button
            type="button"
            className={`mode-btn ${mode === 'line' ? 'mode-btn-active' : ''}`}
            onClick={() => setMode('line')}
          >
            LINE
          </button>
          <button
            type="button"
            className={`mode-btn ${mode === 'ohlcv' ? 'mode-btn-active' : ''}`}
            onClick={() => setMode('ohlcv')}
          >
            OHLCV
          </button>
        </div>

        <div className="timeline-bar">
          {mode === 'line'
            ? LINE_TIME_RANGES.map((range) => (
                <button
                  key={range}
                  type="button"
                  className={`timeline-btn ${lineRange === range ? 'timeline-btn-active' : ''}`}
                  onClick={() => setLineRange(range)}
                >
                  {range}
                </button>
              ))
            : OHLCV_INTERVALS.map((interval) => (
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

        {mode === 'ohlcv' && (
          <label className="outcome-select-wrap">
            <span className="outcome-select-label">Outcome</span>
            <select
              className="outcome-select"
              value={selectedMarketId ?? ''}
              onChange={(e) => setSelectedMarketId(Number(e.target.value))}
            >
              {markets.map((market) => (
                <option key={market.id} value={market.id}>
                  {getMarketDisplayName(market, eventTitle)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {loading && <div className="status-banner status-banner-info">Loading chart…</div>}
      {error && <div className="status-banner status-banner-warn">{error}</div>}

      {!loading && !error && mode === 'line' && lineSeries.length === 0 && (
        <div className="status-banner status-banner-warn">
          No chart data yet — promote this event to hot and wait for history backfill.
        </div>
      )}

      {!loading && !error && mode === 'ohlcv' && ohlcvCandles.length === 0 && (
        <div className="status-banner status-banner-warn">
          No OHLCV data yet — promote this event to hot and wait for history backfill.
        </div>
      )}

      {!loading && mode === 'line' && lineSeries.length > 0 && (
        <MultiLineChart lines={lineSeries} resetKey={lineResetKey} />
      )}

      {!loading && mode === 'ohlcv' && ohlcvCandles.length > 0 && (
        <OhlcvChart candles={ohlcvCandles} resetKey={ohlcvResetKey} />
      )}
    </div>
  );
}
