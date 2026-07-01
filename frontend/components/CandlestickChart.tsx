'use client';

import { useEffect, useRef } from 'react';
import { createCandlestickChart } from '@/lib/chart';
import type { CandleRow } from '@/lib/types';

export default function CandlestickChart({ candles }: { candles: CandleRow[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const handle = createCandlestickChart(container);
    handle.setCandles(candles);

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      handle.resize(entry.contentRect.width, 420);
    });

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      handle.destroy();
    };
  }, [candles]);

  return <div ref={containerRef} className="chart-shell" />;
}
