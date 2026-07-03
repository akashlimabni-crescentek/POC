'use client';

import { useEffect, useRef } from 'react';
import { createMultiLineChart, type LineSeriesInput, type MultiLineChartHandle } from '@/lib/chart';

type MultiLineChartProps = {
  lines: LineSeriesInput[];
  height?: number;
  /** Changes when range/markets reload — triggers fit-to-content once. */
  resetKey?: string;
};

export default function MultiLineChart({ lines, height = 420, resetKey = '' }: MultiLineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<MultiLineChartHandle | null>(null);
  const lastResetKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const handle = createMultiLineChart(container, height);
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
    handle.setLines(lines, { fit });
  }, [lines, resetKey]);

  return <div ref={containerRef} className="chart-shell" style={{ minHeight: height }} />;
}
