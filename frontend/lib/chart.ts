import {
  createChart,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { CandleRow } from './types';

export type ChartCandle = CandlestickData<UTCTimestamp>;

export function toChartCandles(rows: CandleRow[]): ChartCandle[] {
  const byTime = new Map<number, ChartCandle>();

  for (const row of rows) {
    if (row.open == null || row.high == null || row.low == null || row.close == null) {
      continue;
    }

    const time = Math.floor(Date.parse(row.ts) / 1000);
    if (Number.isNaN(time)) continue;

    byTime.set(time, {
      time: time as UTCTimestamp,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
    });
  }

  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

export type CandlestickChartHandle = {
  chart: IChartApi;
  series: ISeriesApi<'Candlestick'>;
  setCandles: (rows: CandleRow[]) => void;
  resize: (width: number, height: number) => void;
  destroy: () => void;
};

export function createCandlestickChart(
  container: HTMLElement,
  height = 420
): CandlestickChartHandle {
  const chart = createChart(container, {
    width: container.clientWidth,
    height,
    layout: {
      background: { type: ColorType.Solid, color: '#0d1117' },
      textColor: '#c9d1d9',
    },
    grid: {
      vertLines: { color: '#21262d' },
      horzLines: { color: '#21262d' },
    },
    rightPriceScale: {
      borderColor: '#30363d',
    },
    localization: {
      priceFormatter: (price: number) => `${(price * 100).toFixed(1)}%`,
    },
    timeScale: {
      borderColor: '#30363d',
      timeVisible: true,
      secondsVisible: false,
    },
    crosshair: {
      vertLine: { color: '#58a6ff55' },
      horzLine: { color: '#58a6ff55' },
    },
  });

  const series = chart.addCandlestickSeries({
    upColor: '#3fb950',
    downColor: '#f85149',
    borderUpColor: '#3fb950',
    borderDownColor: '#f85149',
    wickUpColor: '#3fb950',
    wickDownColor: '#f85149',
  });

  return {
    chart,
    series,
    setCandles(rows: CandleRow[]) {
      series.setData(toChartCandles(rows));
      chart.timeScale().fitContent();
    },
    resize(width: number, nextHeight: number) {
      chart.applyOptions({ width, height: nextHeight });
    },
    destroy() {
      chart.remove();
    },
  };
}

/** Format 0–1 probability for display */
export function formatProbability(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) {
    return '—';
  }
  return `${(value * 100).toFixed(1)}%`;
}
