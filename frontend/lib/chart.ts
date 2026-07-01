import {
  createChart,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type HistogramData,
  type LineData,
  type MouseEventParams,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { CandleRow } from './types';

export type ChartCandle = CandlestickData<UTCTimestamp>;
export type ChartLinePoint = LineData<UTCTimestamp>;
export type ChartVolumeBar = HistogramData<UTCTimestamp>;

const CHART_LAYOUT = {
  background: { type: ColorType.Solid, color: '#0d1117' },
  textColor: '#c9d1d9',
} as const;

const CHART_GRID = {
  vertLines: { color: '#21262d' },
  horzLines: { color: '#21262d' },
} as const;

const PRICE_FORMATTER = (price: number) => `${(price * 100).toFixed(1)}%`;

function formatChartTime(time: number): string {
  return new Date(time * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatChartPriceDetailed(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatVolume(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(2)}K`;
  }
  return value.toFixed(2);
}

function createOhlcvTooltip(wrapper: HTMLElement): HTMLDivElement {
  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.style.display = 'none';
  wrapper.appendChild(tooltip);
  return tooltip;
}

function positionTooltip(
  tooltip: HTMLDivElement,
  wrapper: HTMLElement,
  pointX: number,
  pointY: number
) {
  tooltip.style.display = 'block';
  const pad = 8;
  const maxLeft = wrapper.clientWidth - tooltip.offsetWidth - pad;
  const maxTop = wrapper.clientHeight - tooltip.offsetHeight - pad;
  const left = Math.max(pad, Math.min(pointX + 14, maxLeft));
  const top = Math.max(pad, Math.min(pointY - tooltip.offsetHeight - 10, maxTop));
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function renderOhlcvTooltip(
  tooltip: HTMLDivElement,
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
  tradeCount: number | null | undefined
) {
  const up = close >= open;
  const change = close - open;
  const changePct = open !== 0 ? (change / open) * 100 : 0;
  const changeClass = up ? 'chart-tooltip-up' : 'chart-tooltip-down';
  const trades =
    tradeCount != null && tradeCount > 0
      ? `<div class="chart-tooltip-row"><span class="chart-tooltip-key">Trades</span><span class="chart-tooltip-val">${tradeCount}</span></div>`
      : '';

  tooltip.innerHTML = `
    <div class="chart-tooltip-time">${formatChartTime(time)}</div>
    <div class="chart-tooltip-grid">
      <div class="chart-tooltip-row"><span class="chart-tooltip-key">O</span><span class="chart-tooltip-val">${formatChartPriceDetailed(open)}</span></div>
      <div class="chart-tooltip-row"><span class="chart-tooltip-key">H</span><span class="chart-tooltip-val">${formatChartPriceDetailed(high)}</span></div>
      <div class="chart-tooltip-row"><span class="chart-tooltip-key">L</span><span class="chart-tooltip-val">${formatChartPriceDetailed(low)}</span></div>
      <div class="chart-tooltip-row"><span class="chart-tooltip-key">C</span><span class="chart-tooltip-val ${changeClass}">${formatChartPriceDetailed(close)}</span></div>
      <div class="chart-tooltip-row"><span class="chart-tooltip-key">V</span><span class="chart-tooltip-val">${formatVolume(volume)}</span></div>
      ${trades}
    </div>
    <div class="chart-tooltip-change ${changeClass}">
      ${up ? '+' : ''}${formatChartPriceDetailed(change)} (${up ? '+' : ''}${changePct.toFixed(2)}%)
    </div>
  `;
}

function baseChartOptions(width: number, height: number) {
  return {
    width,
    height,
    layout: CHART_LAYOUT,
    grid: CHART_GRID,
    rightPriceScale: { borderColor: '#30363d' },
    localization: { priceFormatter: PRICE_FORMATTER },
    timeScale: {
      borderColor: '#30363d',
      timeVisible: true,
      secondsVisible: false,
    },
    crosshair: {
      mode: CrosshairMode.Magnet,
      vertLine: {
        color: '#58a6ff88',
        style: 2,
        labelVisible: true,
        labelBackgroundColor: '#21262d',
      },
      horzLine: {
        color: '#58a6ff88',
        style: 2,
        labelVisible: true,
        labelBackgroundColor: '#21262d',
      },
    },
  };
}

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

export function toLinePoints(rows: CandleRow[]): ChartLinePoint[] {
  const byTime = new Map<number, ChartLinePoint>();

  for (const row of rows) {
    if (row.close == null) continue;
    const time = Math.floor(Date.parse(row.ts) / 1000);
    if (Number.isNaN(time)) continue;
    byTime.set(time, { time: time as UTCTimestamp, value: Number(row.close) });
  }

  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

export function toVolumeBars(rows: CandleRow[]): ChartVolumeBar[] {
  return rows
    .filter((row) => row.close != null)
    .map((row) => {
      const time = Math.floor(Date.parse(row.ts) / 1000) as UTCTimestamp;
      const up = Number(row.close) >= Number(row.open ?? row.close);
      return {
        time,
        value: Number(row.volume ?? 0),
        color: up ? '#3fb95044' : '#f8514944',
      };
    })
    .sort((a, b) => a.time - b.time);
}

export type LineSeriesInput = {
  id: number;
  label: string;
  color: string;
  points: ChartLinePoint[];
};

export type MultiLineChartHandle = {
  setLines: (lines: LineSeriesInput[]) => void;
  resize: (width: number, height: number) => void;
  destroy: () => void;
};

export function createMultiLineChart(
  container: HTMLElement,
  height = 420
): MultiLineChartHandle {
  const chart = createChart(container, baseChartOptions(container.clientWidth, height));
  const seriesById = new Map<number, ISeriesApi<'Line'>>();

  return {
    setLines(lines) {
      const nextIds = new Set(lines.map((line) => line.id));

      for (const [id, series] of seriesById) {
        if (!nextIds.has(id)) {
          chart.removeSeries(series);
          seriesById.delete(id);
        }
      }

      for (const line of lines) {
        let series = seriesById.get(line.id);
        if (!series) {
          series = chart.addLineSeries({
            color: line.color,
            lineWidth: 2,
            title: line.label,
            priceLineVisible: false,
            lastValueVisible: true,
          });
          seriesById.set(line.id, series);
        } else {
          series.applyOptions({ color: line.color, title: line.label });
        }
        series.setData(line.points);
      }

      chart.timeScale().fitContent();
    },
    resize(width, nextHeight) {
      chart.applyOptions({ width, height: nextHeight });
    },
    destroy() {
      chart.remove();
    },
  };
}

export type OhlcvChartHandle = {
  setCandles: (rows: CandleRow[]) => void;
  resize: (width: number, height: number) => void;
  destroy: () => void;
};

export function createOhlcvChart(
  container: HTMLElement,
  height = 480,
  wrapper?: HTMLElement
): OhlcvChartHandle {
  const chart = createChart(container, baseChartOptions(container.clientWidth, height));
  const tooltipHost = wrapper ?? container;
  if (getComputedStyle(tooltipHost).position === 'static') {
    tooltipHost.style.position = 'relative';
  }
  const tooltip = createOhlcvTooltip(tooltipHost);
  let candleByTime = new Map<number, CandleRow>();

  const candleSeries = chart.addCandlestickSeries({
    upColor: '#3fb950',
    downColor: '#f85149',
    borderUpColor: '#3fb950',
    borderDownColor: '#f85149',
    wickUpColor: '#3fb950',
    wickDownColor: '#f85149',
  });

  const volumeSeries = chart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: 'volume',
  });

  chart.priceScale('volume').applyOptions({
    scaleMargins: { top: 0.82, bottom: 0 },
  });

  const crosshairHandler = (param: MouseEventParams) => {
    if (!param.time || !param.point || param.point.x < 0 || param.point.y < 0) {
      tooltip.style.display = 'none';
      return;
    }

    const time = param.time as number;
    const candleData = param.seriesData.get(candleSeries) as ChartCandle | undefined;
    if (!candleData) {
      tooltip.style.display = 'none';
      return;
    }

    const volData = param.seriesData.get(volumeSeries) as ChartVolumeBar | undefined;
    const row = candleByTime.get(time);

    renderOhlcvTooltip(
      tooltip,
      time,
      candleData.open,
      candleData.high,
      candleData.low,
      candleData.close,
      volData?.value ?? row?.volume ?? 0,
      row?.trade_count
    );
    positionTooltip(tooltip, tooltipHost, param.point.x, param.point.y);
  };

  chart.subscribeCrosshairMove(crosshairHandler);

  return {
    setCandles(rows) {
      candleByTime = new Map();
      for (const row of rows) {
        const t = Math.floor(Date.parse(row.ts) / 1000);
        if (!Number.isNaN(t)) {
          candleByTime.set(t, row);
        }
      }
      candleSeries.setData(toChartCandles(rows));
      volumeSeries.setData(toVolumeBars(rows));
      chart.timeScale().fitContent();
    },
    resize(width, nextHeight) {
      chart.applyOptions({ width, height: nextHeight });
    },
    destroy() {
      chart.unsubscribeCrosshairMove(crosshairHandler);
      tooltip.remove();
      chart.remove();
    },
  };
}

/** @deprecated Use createOhlcvChart — kept for simple single-market pages */
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
  const chart = createChart(container, baseChartOptions(container.clientWidth, height));
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
    setCandles(rows) {
      series.setData(toChartCandles(rows));
      chart.timeScale().fitContent();
    },
    resize(width, nextHeight) {
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
