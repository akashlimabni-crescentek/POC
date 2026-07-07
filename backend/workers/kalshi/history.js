'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { supabase } = require('../../config/supabase');
const { KALSHI } = require('../../config/providers');
const { HISTORY_POLL_MS, REQUEST_DELAY_MS, KALSHI_HISTORY_BATCH_SIZE } = require('../../config/intervals');
const { loadKalshiCredentials } = require('../../config/kalshi-key');
const { fetchBatchCandlesticks } = require('../../lib/kalshi-client');
const { sleep } = require('../../lib/http-client');
const { upsertBatched } = require('../../lib/bulk-upsert');
const { createGuardedInterval } = require('../../lib/guarded-interval');
const { getHotMarkets } = require('../../lib/tiers');
const { normalizePrice } = require('../../lib/price-units');

const {
  STORED_INTERVALS,
  getFirstBackfillWindow,
  getLastClosedBucketWindowSec,
  isIntervalDue,
  toCandleRows,
  maxCandleTs,
  mergeLastCandleTs,
  chunkArray,
  splitTimeWindowsForCandles,
} = require('../../lib/history-common');
const { aggregateToInterval, getBucketMs } = require('../../lib/ohlc');

const WORKER_NAME = 'kalshi/history';

/**
 * Per-interval fetch pipeline. Kalshi REST only exposes 1m / 1h / 1d candles;
 * finer intervals are aggregated transiently and never stored as 1m.
 *
 * Incremental: only the last closed bucket window is requested.
 * First backfill: full lookback per interval (see LOOKBACK_SECONDS).
 */
const INTERVAL_PIPELINE = {
  '5m': { kalshiPeriodMinutes: 1, aggregateFrom: '1m' },
  '15m': { kalshiPeriodMinutes: 1, aggregateFrom: '1m' },
  '1h': { kalshiPeriodMinutes: 60, aggregateFrom: null },
  '4h': { kalshiPeriodMinutes: 60, aggregateFrom: '1h' },
  '1d': { kalshiPeriodMinutes: 1440, aggregateFrom: null },
  '1w': { kalshiPeriodMinutes: 1440, aggregateFrom: '1d' },
};

/** Kalshi native candles use end-of-period ts; we store bucket-start to match rollups. */
function normalizeCandleTsToBucketStart(candles, interval) {
  const bucketMs = getBucketMs(interval);
  return candles.map((c) => {
    const tsMs = Date.parse(c.ts);
    const bucketStart = Math.floor((tsMs - 1) / bucketMs) * bucketMs;
    return { ...c, ts: new Date(bucketStart).toISOString() };
  });
}

function validateEnv() {
  if (!process.env.SUPABASE_URL?.trim()) {
    throw new Error(`[${WORKER_NAME}] SUPABASE_URL is required`);
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    throw new Error(`[${WORKER_NAME}] SUPABASE_SERVICE_ROLE_KEY is required`);
  }
  loadKalshiCredentials();
}

function probFromDollars(value) {
  if (value == null || value === '') return null;
  return normalizePrice('kalshi', value, { unit: 'dollars' });
}

function probFromSide(side, field) {
  if (!side) return null;
  return probFromDollars(side[field]);
}

function midOr(left, right) {
  if (left != null && right != null) return (left + right) / 2;
  return left ?? right ?? null;
}

/** Map Kalshi candlestick — normalize all prices to 0–1 on write */
function mapKalshiCandlestick(candle) {
  const price = candle.price ?? {};
  const yesBid = candle.yes_bid ?? {};
  const yesAsk = candle.yes_ask ?? {};

  const priceOpen = probFromDollars(price.open_dollars);
  const priceHigh = probFromDollars(price.high_dollars ?? price.max_dollars);
  const priceLow = probFromDollars(price.low_dollars ?? price.min_dollars);
  const priceClose = probFromDollars(price.close_dollars);
  const previous = probFromDollars(price.previous_dollars);

  const bidOpen = probFromSide(yesBid, 'open_dollars');
  const bidHigh = probFromSide(yesBid, 'high_dollars');
  const bidLow = probFromSide(yesBid, 'low_dollars');
  const bidClose = probFromSide(yesBid, 'close_dollars');

  const askOpen = probFromSide(yesAsk, 'open_dollars');
  const askHigh = probFromSide(yesAsk, 'high_dollars');
  const askLow = probFromSide(yesAsk, 'low_dollars');
  const askClose = probFromSide(yesAsk, 'close_dollars');

  const close = priceClose ?? midOr(bidClose, askClose) ?? previous;
  const open = priceOpen ?? midOr(bidOpen, askOpen) ?? previous ?? close;

  if (close == null && open == null) {
    return null;
  }

  const highs = [priceHigh, bidHigh, askHigh].filter((v) => v != null);
  const lows = [priceLow, bidLow, askLow].filter((v) => v != null);

  const finalOpen = open ?? close;
  const finalClose = close ?? open;
  const high = highs.length
    ? Math.max(...highs, finalOpen, finalClose)
    : Math.max(finalOpen, finalClose);
  const low = lows.length
    ? Math.min(...lows, finalOpen, finalClose)
    : Math.min(finalOpen, finalClose);

  const volume = Number(candle.volume_fp ?? 0);
  const ts = new Date(Number(candle.end_period_ts) * 1000).toISOString();

  return {
    ts,
    open: finalOpen,
    high,
    low,
    close: finalClose,
    volume: Number.isNaN(volume) ? 0 : volume,
    trade_count: 0,
  };
}

async function loadIngestionState(marketIds) {
  if (!marketIds.length) return new Map();

  const { data, error } = await supabase
    .from('market_ingestion_state')
    .select('market_id, last_backfill_at, last_candle_ts')
    .in('market_id', marketIds);

  if (error) {
    throw new Error(`[${WORKER_NAME}] loadIngestionState: ${error.message}`);
  }

  return new Map((data ?? []).map((row) => [row.market_id, row]));
}

async function fetchCandlesForTickers(tickers, startTs, endTs, periodInterval) {
  const results = new Map();
  for (const ticker of tickers) {
    results.set(ticker, []);
  }

  const timeWindows = splitTimeWindowsForCandles(
    startTs,
    endTs,
    periodInterval,
    tickers.length
  );

  for (const batch of chunkArray(tickers, KALSHI_HISTORY_BATCH_SIZE)) {
    for (const { startTs: windowStart, endTs: windowEnd } of timeWindows) {
      const markets = await fetchBatchCandlesticks({
        marketTickers: batch,
        startTs: windowStart,
        endTs: windowEnd,
        periodInterval,
      });

      for (const entry of markets) {
        const mapped = (entry.candlesticks ?? [])
          .map(mapKalshiCandlestick)
          .filter(Boolean);
        const existing = results.get(entry.market_ticker) ?? [];
        results.set(entry.market_ticker, existing.concat(mapped));
      }

      await sleep(REQUEST_DELAY_MS);
    }
  }

  return results;
}

/**
 * Fetch Kalshi candles for one stored interval and return rows ready to persist.
 * On incremental polls only the last closed bucket is returned.
 */
async function fetchStoredIntervalCandles(ticker, interval, isFirstBackfill) {
  const pipeline = INTERVAL_PIPELINE[interval];
  if (!pipeline) {
    throw new Error(`[${WORKER_NAME}] unknown interval pipeline: ${interval}`);
  }

  const window = isFirstBackfill
    ? getFirstBackfillWindow(interval)
    : getLastClosedBucketWindowSec(interval);

  const byTicker = await fetchCandlesForTickers(
    [ticker],
    window.startTs,
    window.endTs,
    pipeline.kalshiPeriodMinutes
  );
  const raw = byTicker.get(ticker) ?? [];

  if (!raw.length) {
    return [];
  }

  let candles;
  if (!pipeline.aggregateFrom) {
    candles = raw;
  } else {
    candles = aggregateToInterval(raw, pipeline.aggregateFrom, interval);
  }

  if (!isFirstBackfill) {
    candles = candles.slice(-1);
  }

  return normalizeCandleTsToBucketStart(candles, interval);
}

async function persistCandlesAndState(marketId, candleRowsByInterval, existingState) {
  let written = 0;

  for (const rows of Object.values(candleRowsByInterval)) {
    if (!rows.length) continue;
    const { written: count } = await upsertBatched(supabase, 'candles', rows, {
      onConflict: 'market_id,interval,ts',
      batchSize: 200,
    });
    written += count;
  }

  const lastCandleTs = mergeLastCandleTs(
    existingState?.last_candle_ts,
    Object.fromEntries(
      Object.entries(candleRowsByInterval).map(([interval, rows]) => [
        interval,
        maxCandleTs(rows),
      ])
    )
  );

  const { error } = await supabase.from('market_ingestion_state').upsert(
    {
      market_id: marketId,
      tier: 'hot',
      last_backfill_at: new Date().toISOString(),
      last_candle_ts: lastCandleTs,
    },
    { onConflict: 'market_id' }
  );

  if (error) {
    console.error(`[${WORKER_NAME}] persist state market=${marketId}: ${error.message}`);
  }

  return written;
}

async function syncMarket(market, ingestionState) {
  const isFirstBackfill = !ingestionState?.last_backfill_at;
  const lastCandleTs = ingestionState?.last_candle_ts ?? {};
  const nowSec = Math.floor(Date.now() / 1000);
  const candleRowsByInterval = {};
  const fetched = [];

  for (const interval of STORED_INTERVALS) {
    if (!isFirstBackfill && !isIntervalDue(interval, lastCandleTs[interval], nowSec)) {
      continue;
    }

    const window = isFirstBackfill
      ? getFirstBackfillWindow(interval)
      : getLastClosedBucketWindowSec(interval, nowSec);

    const candles = await fetchStoredIntervalCandles(
      market.external_id,
      interval,
      isFirstBackfill
    );

    if (candles.length) {
      candleRowsByInterval[interval] = toCandleRows(market.id, interval, candles);
      fetched.push({
        interval,
        mode: isFirstBackfill ? 'backfill' : 'incremental',
        window,
        rows: candles.length,
        lastTs: candles[candles.length - 1]?.ts ?? null,
      });
    }

    await sleep(REQUEST_DELAY_MS);
  }

  if (fetched.length) {
    console.log(
      `[${WORKER_NAME}] market=${market.id} ticker=${market.external_id}`,
      JSON.stringify(fetched)
    );
  }

  return persistCandlesAndState(market.id, candleRowsByInterval, ingestionState);
}

async function poll() {
  const hotMarkets = await getHotMarkets(supabase, KALSHI.slug);
  if (hotMarkets.length === 0) {
    console.log(`[${WORKER_NAME}] cycle: no hot markets`);
    return 0;
  }

  const stateByMarket = await loadIngestionState(hotMarkets.map((m) => m.id));
  let rowsWritten = 0;

  for (const market of hotMarkets) {
    try {
      rowsWritten += await syncMarket(market, stateByMarket.get(market.id));
    } catch (err) {
      console.error(`[${WORKER_NAME}] sync market=${market.id}: ${err.message}`);
    }
  }

  console.log(`[${WORKER_NAME}] cycle: hot=${hotMarkets.length} written=${rowsWritten}`);
  return rowsWritten;
}

function start() {
  validateEnv();

  const { start: startInterval } = createGuardedInterval(
    WORKER_NAME,
    poll,
    HISTORY_POLL_MS
  );

  console.log(
    `[${WORKER_NAME}] starting — tick every ${HISTORY_POLL_MS / 1000}s; ` +
      `intervals=${STORED_INTERVALS.join(',')} (no 1m stored); ` +
      `incremental=last closed bucket only`
  );
  return startInterval();
}

if (require.main === module) {
  start();
}

module.exports = {
  start,
  poll,
  syncMarket,
  fetchStoredIntervalCandles,
  mapKalshiCandlestick,
  probFromDollars,
  INTERVAL_PIPELINE,
  STORED_INTERVALS,
};
