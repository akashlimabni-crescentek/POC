'use client';

import { useEffect, useRef } from 'react';
import { createOhlcvChart } from '@/lib/chart';
import type { CandleRow } from '@/lib/types';

type OhlcvChartProps = {
  candles: CandleRow[];
  height?: number;
};

export default function OhlcvChart({ candles, height = 480 }: OhlcvChartProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const wrapper = wrapperRef.current;
    if (!container || !wrapper) {
      return;
    }

    const handle = createOhlcvChart(container, height, wrapper);
    handle.setCandles(candles);

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      handle.resize(entry.contentRect.width, height);
    });

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      handle.destroy();
    };
  }, [candles, height]);

  return (
    <div ref={wrapperRef} className="chart-wrap">
      <div ref={containerRef} className="chart-shell" style={{ minHeight: height }} />
    </div>
  );
}
