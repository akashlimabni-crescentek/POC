'use client';

import { useEffect, useRef } from 'react';
import { createOhlcvChart, type OhlcvChartHandle } from '@/lib/chart';
import type { CandleRow } from '@/lib/types';

type OhlcvChartProps = {
  candles: CandleRow[];
  height?: number;
  /** Changes when market/range reloads — triggers fit-to-content once. */
  resetKey?: string;
};

export default function OhlcvChart({ candles, height = 480, resetKey = '' }: OhlcvChartProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<OhlcvChartHandle | null>(null);
  const lastResetKeyRef = useRef<string | null>(null);

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
      if (!entry) return;
      handle.resize(entry.contentRect.width, height);
    });

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      handle.destroy();
      handleRef.current = null;
      lastResetKeyRef.current = null;
    };
  }, [height]);

  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) {
      return;
    }

    const fit = lastResetKeyRef.current !== resetKey;
    lastResetKeyRef.current = resetKey;
    handle.setCandles(candles, { fit });
  }, [candles, resetKey]);

  return (
    <div ref={wrapperRef} className="chart-wrap">
      <div ref={containerRef} className="chart-shell" style={{ minHeight: height }} />
    </div>
  );
}
