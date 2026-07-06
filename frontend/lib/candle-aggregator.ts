import type { CandleRow, LiveTickRow, MarketPriceLatest } from './types';

/**
 * A single normalized realtime observation, already in the chart's 0–1
 * probability space. `id` must be monotonic per market so the aggregator can
 * drop duplicates and replays (e.g. the burst a websocket delivers on
 * reconnect) without double-counting volume.
 */
export type CandleEvent = {
  id: number;
  tsMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/**
 * Floor a timestamp to the start of its bucket. Pure epoch math keeps live
 * candles aligned with historical candles — which are bucketed identically in
 * `aggregateCandles` and by the backend — including the 1d bucket at UTC
 * midnight, matching the chart's GMT axis. Changing the trading-day timezone
 * means changing the backend rollup and this function together, or the live
 * candle will sit on a different midnight than history.
 */
export function bucketStartMs(tsMs: number, bucketMs: number): number {
  return Math.floor(tsMs / bucketMs) * bucketMs;
}

/**
 * Adapt a `market_prices_latest` row into a normalized event. A price snapshot
 * is a single point, so O=H=L=C=price. This feed carries no volume; its
 * `updated_at` is monotonic per market (one upsert per backend flush) so it
 * doubles as the dedupe id.
 */
export function marketPriceToEvent(row: MarketPriceLatest): CandleEvent | null {
  const price = row.last_price ?? row.mid;
  if (price == null || !Number.isFinite(price) || !row.updated_at) {
    return null;
  }
  const tsMs = Date.parse(row.updated_at);
  if (Number.isNaN(tsMs)) {
    return null;
  }
  return { id: tsMs, tsMs, open: price, high: price, low: price, close: price, volume: 0 };
}

/**
 * Adapt a `live_ticks` row (append-only, carries a monotonic `id` and volume)
 * into an event. Prefer this feed once the backend populates per-tick volume —
 * the `id` gives exact dedupe and the volume makes the summed candle correct.
 */
export function liveTickToEvent(row: LiveTickRow): CandleEvent | null {
  const price = row.mid ?? row.last_price ?? row.ask ?? row.bid;
  if (price == null || !Number.isFinite(price)) {
    return null;
  }
  const tsMs = Date.parse(row.ts);
  if (Number.isNaN(tsMs)) {
    return null;
  }
  const id = row.id ?? tsMs;
  return { id, tsMs, open: price, high: price, low: price, close: price, volume: row.volume ?? 0 };
}

export type IngestResult = {
  /** The current, still-forming candle after applying the event. */
  live: CandleRow;
  /** Non-null only when this event crossed a boundary — the just-closed candle. */
  sealed: CandleRow | null;
};

/**
 * Folds a stream of realtime events into a single forming candle for one
 * (market, interval). It never holds history — only the current bucket — which
 * is what structurally guarantees historical candles are never modified.
 *
 *   Open   = first event's open in the bucket   (first-write-wins)
 *   High   = max of event highs
 *   Low    = min of event lows
 *   Close  = latest event's close
 *   Volume = sum of event volumes
 *
 * All O(1) per event, so it scales to thousands of updates per second.
 */
export class CandleAggregator {
  private readonly marketId: number;
  private readonly interval: string;
  private readonly bucketMs: number;

  private live: CandleRow | null = null;
  private liveBucketStart: number | null = null;
  private lastEventId = Number.NEGATIVE_INFINITY;

  constructor(marketId: number, interval: string, bucketMs: number) {
    this.marketId = marketId;
    this.interval = interval;
    this.bucketMs = bucketMs;
  }

  /** The current forming candle, or null before the first event arrives. */
  get current(): CandleRow | null {
    return this.live;
  }

  /** Drop all state so the current bucket rebuilds from scratch (used on resync). */
  reset(): void {
    this.live = null;
    this.liveBucketStart = null;
    this.lastEventId = Number.NEGATIVE_INFINITY;
  }

  ingest(event: CandleEvent): IngestResult | null {
    // 1. Dedupe: ids are monotonic per market, so anything already seen is a
    //    duplicate or a reconnect replay — drop it (never re-add its volume).
    if (event.id <= this.lastEventId) {
      return null;
    }
    this.lastEventId = event.id;

    const bucket = bucketStartMs(event.tsMs, this.bucketMs);

    // 2. First event → open the first candle.
    if (this.live == null || this.liveBucketStart == null) {
      this.live = this.startCandle(bucket, event);
      this.liveBucketStart = bucket;
      return { live: this.live, sealed: null };
    }

    // 3. Late / out-of-order event for an already-closed bucket → ignore, so we
    //    never rewrite a sealed candle.
    if (bucket < this.liveBucketStart) {
      return null;
    }

    // 4. Boundary crossed → seal the current candle and open a fresh one. A jump
    //    of more than one bucket simply leaves the idle buckets as a gap.
    if (bucket > this.liveBucketStart) {
      const sealed = this.live;
      this.live = this.startCandle(bucket, event);
      this.liveBucketStart = bucket;
      return { live: this.live, sealed };
    }

    // 5. Same bucket → fold the event in. Open is left untouched (first-write-wins).
    this.live = {
      ...this.live,
      high: Math.max(this.live.high ?? event.high, event.high),
      low: Math.min(this.live.low ?? event.low, event.low),
      close: event.close,
      volume: (this.live.volume ?? 0) + event.volume,
      trade_count: (this.live.trade_count ?? 0) + 1,
    };
    return { live: this.live, sealed: null };
  }

  private startCandle(bucketStart: number, event: CandleEvent): CandleRow {
    return {
      market_id: this.marketId,
      interval: this.interval,
      ts: new Date(bucketStart).toISOString(),
      open: event.open,
      high: event.high,
      low: event.low,
      close: event.close,
      volume: event.volume,
      trade_count: 1,
    };
  }
}
