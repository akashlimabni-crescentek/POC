import type { CandleRow, CandleInterval } from './types';
import type { LiveCandle } from './candle-aggregator';
import type { OhlcvInterval } from './chart-config';
import { bucketStartMs } from './candle-aggregator';
import { candleIntervalMs } from './chart-config';

/**
 * One contiguous slice of the forming candle, tagged with where it came from.
 * Emitted purely so the `[candle] compose` log reads like the worked example
 * ("19:00–19:15 from a 5m block, 19:20–now from live").
 */
export type FormingPiece = {
  /** `db:5m`, `db:1m`, … or `live`. */
  src: string;
  fromMs: number;
  toMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type ComposeResult = {
  /** The merged forming candle, or null when no piece could be built. */
  candle: LiveCandle | null;
  /** Ordered slices that were merged — for logging / manual verification. */
  pieces: FormingPiece[];
};

/** Index rows by their bucket-start epoch (ms), keeping the newest per bucket. */
function indexByBucketStart(rows: CandleRow[], stepMs: number): Map<number, CandleRow> {
  const byStart = new Map<number, CandleRow>();
  for (const row of rows) {
    if (row.open == null || row.high == null || row.low == null || row.close == null) {
      continue;
    }
    const tsMs = Date.parse(row.ts);
    if (Number.isNaN(tsMs)) {
      continue;
    }
    byStart.set(bucketStartMs(tsMs, stepMs), row);
  }
  return byStart;
}

function pieceFromRow(src: string, fromMs: number, stepMs: number, row: CandleRow): FormingPiece {
  return {
    src,
    fromMs,
    toMs: fromMs + stepMs,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume ?? 0),
  };
}

/**
 * Reconstruct the current, still-forming candle for `interval` at `nowMs` by
 * greedily stepping down the finer-interval ladder, then appending the live
 * tail. See `SUB_INTERVAL_LADDER` for why this exists.
 *
 * Walk, coarsest rung first, from the bucket start:
 *   - consume each whole finer block that lies entirely before `nowMs` **and**
 *     exists in `finerRowsByInterval`;
 *   - the moment a block is missing (DB write lag / a genuine gap), stop that
 *     rung and drop to the next finer one to try smaller blocks over the same
 *     remaining span;
 *   - whatever span is still uncovered when the ladder is exhausted is filled
 *     by `liveTail` (the live-tick aggregator's current candle).
 *
 * Merge rule across the collected pieces, in time order:
 *   Open = first piece's open · High = max · Low = min ·
 *   Close = last piece's close · Volume = Σ piece volume.
 *
 * NOTE on volume: only *whole, completed* finer blocks are taken from the DB,
 * and the live tail only ever covers the span past the last block consumed, so
 * a bucket's volume is never counted twice. (The live feed carries volume 0
 * today, so the tail contributes price movement but no volume — documented so
 * the number is trusted during manual verification.)
 */
export function buildFormingCandle(params: {
  marketId: number;
  interval: OhlcvInterval;
  bucketStartMs: number;
  nowMs: number;
  /** Finer stored intervals, coarsest → finest (SUB_INTERVAL_LADDER[interval]). */
  ladder: CandleInterval[];
  /** Rows per ladder interval, already filtered to the current bucket window. */
  finerRowsByInterval: Partial<Record<CandleInterval, CandleRow[]>>;
  /** The live-tick aggregator's current candle (may extend beyond DB blocks). */
  liveTail: LiveCandle | null;
  /** Set false to silence the `[candle] compose` log (e.g. on hot recompute). */
  log?: boolean;
}): ComposeResult {
  const { marketId, interval, bucketStartMs: bucketStart, nowMs, ladder, finerRowsByInterval, liveTail } = params;
  const shouldLog = params.log !== false;

  const pieces: FormingPiece[] = [];
  let cursor = bucketStart;

  for (const rung of ladder) {
    const stepMs = candleIntervalMs(rung);
    const byStart = indexByBucketStart(finerRowsByInterval[rung] ?? [], stepMs);

    // Consume whole, completed blocks contiguously from the cursor.
    while (cursor + stepMs <= nowMs) {
      const row = byStart.get(cursor);
      if (!row) {
        break; // gap / lag at this rung → drop to a finer rung for this span
      }
      pieces.push(pieceFromRow(`db:${rung}`, cursor, stepMs, row));
      cursor += stepMs;
    }
  }

  // Ragged tail: everything the DB blocks did not cover, from the live candle.
  if (liveTail && liveTail.close != null && cursor < nowMs) {
    const tailFrom = Math.max(cursor, Date.parse(liveTail.ts) || cursor);
    pieces.push({
      src: 'live',
      fromMs: tailFrom,
      toMs: nowMs,
      open: Number(liveTail.open ?? liveTail.close),
      high: Number(liveTail.high ?? liveTail.close),
      low: Number(liveTail.low ?? liveTail.close),
      close: Number(liveTail.close),
      volume: Number(liveTail.volume ?? 0),
    });
  }

  if (pieces.length === 0) {
    if (shouldLog) {
      console.log('[candle] compose', {
        interval,
        bucketStart: new Date(bucketStart).toISOString(),
        now: new Date(nowMs).toISOString(),
        result: 'no pieces — forming candle empty',
      });
    }
    return { candle: null, pieces };
  }

  // Merge the slices in time order.
  const first = pieces[0];
  const last = pieces[pieces.length - 1];
  let high = first.high;
  let low = first.low;
  let volume = 0;
  let tradeCount = 0;
  for (const p of pieces) {
    high = Math.max(high, p.high);
    low = Math.min(low, p.low);
    volume += p.volume;
    tradeCount += p.src === 'live' ? 0 : 1;
  }

  const candle: LiveCandle = {
    market_id: marketId,
    interval,
    ts: new Date(bucketStart).toISOString(),
    open: first.open,
    high,
    low,
    close: last.close,
    mid: liveTail?.mid ?? null,
    volume,
    trade_count: tradeCount,
  };

  if (shouldLog) {
    console.log('[candle] compose', {
      interval,
      bucketStart: new Date(bucketStart).toISOString(),
      now: new Date(nowMs).toISOString(),
      ladder,
      pieces: pieces.map((p) => ({
        src: p.src,
        from: new Date(p.fromMs).toISOString(),
        to: new Date(p.toMs).toISOString(),
        o: p.open,
        h: p.high,
        l: p.low,
        c: p.close,
        v: p.volume,
      })),
      merged: { o: candle.open, h: candle.high, l: candle.low, c: candle.close, v: candle.volume },
    });
  }

  return { candle, pieces };
}
