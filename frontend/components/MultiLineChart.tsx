'use client';

import { useEffect, useRef } from 'react';
import { createMultiLineChart, type LineSeriesInput } from '@/lib/chart';

type MultiLineChartProps = {
  lines: LineSeriesInput[];
  height?: number;
};

export default function MultiLineChart({ lines, height = 420 }: MultiLineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const handle = createMultiLineChart(container, height);
    handle.setLines(lines);

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
  }, [lines, height]);

  return <div ref={containerRef} className="chart-shell" style={{ minHeight: height }} />;
}
