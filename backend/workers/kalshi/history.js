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
  getFetchWindow,
  toCandleRows,
  maxCandleTs,
  mergeLastCandleTs,
  chunkArray,
  splitTimeWindowsForCandles,
} = require('../../lib/history-common');
const { aggregateToInterval } = require('../../lib/ohlc');

const WORKER_NAME = 'kalshi/history';

const KALSHI_PERIOD_MINUTES = {
  '1m': 1,
  '1h': 60,
  '1d': 1440,
};

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

async function backfillMarketGroup(markets, stateByMarket) {
  const tickers = markets.map((m) => m.external_id);
  const isFirstBackfill = markets.some((m) => !stateByMarket.get(m.id)?.last_backfill_at);

  const window1m = getFetchWindow(isFirstBackfill, '1m');
  const candles1mByTicker = await fetchCandlesForTickers(
    tickers,
    window1m.startTs,
    window1m.endTs,
    KALSHI_PERIOD_MINUTES['1m']
  );

  let rowsWritten = 0;

  for (const market of markets) {
    const ingestionState = stateByMarket.get(market.id);
    const marketFirst = !ingestionState?.last_backfill_at;
    const candles1m = candles1mByTicker.get(market.external_id) ?? [];
    const candleRowsByInterval = {
      '1m': toCandleRows(market.id, '1m', candles1m),
    };

    // Source candle arrays (pre-row shape) per interval, so the coarser
    // intervals (15m/4h/1w) can be rolled up from the nearest finer source.
    let candles5m = [];
    let candles1h = [];
    let candles1d = [];

    if (candles1m.length > 0) {
      candles5m = aggregateToInterval(candles1m, '1m', '5m');
      candleRowsByInterval['5m'] = toCandleRows(market.id, '5m', candles5m);
      candleRowsByInterval['15m'] = toCandleRows(
        market.id,
        '15m',
        aggregateToInterval(candles1m, '1m', '15m')
      );
    }

    if (marketFirst) {
      const window1h = getFetchWindow(true, '1h');
      const candles1hMap = await fetchCandlesForTickers(
        [market.external_id],
        window1h.startTs,
        window1h.endTs,
        KALSHI_PERIOD_MINUTES['1h']
      );
      candles1h = candles1hMap.get(market.external_id) ?? [];
      candleRowsByInterval['1h'] = toCandleRows(market.id, '1h', candles1h);

      const window1d = getFetchWindow(true, '1d');
      const candles1dMap = await fetchCandlesForTickers(
        [market.external_id],
        window1d.startTs,
        window1d.endTs,
        KALSHI_PERIOD_MINUTES['1d']
      );
      candles1d = candles1dMap.get(market.external_id) ?? [];
      candleRowsByInterval['1d'] = toCandleRows(market.id, '1d', candles1d);
    } else if (candles1m.length > 0) {
      candles1h = aggregateToInterval(candles1m, '1m', '1h');
      candleRowsByInterval['1h'] = toCandleRows(market.id, '1h', candles1h);
      candles1d = aggregateToInterval(candles1m, '1m', '1d');
      candleRowsByInterval['1d'] = toCandleRows(market.id, '1d', candles1d);
    }

    // 4h rolls up from 1h, 1w from 1d — whichever source (fetched or derived)
    // we ended up with above.
    if (candles1h.length > 0) {
      candleRowsByInterval['4h'] = toCandleRows(
        market.id,
        '4h',
        aggregateToInterval(candles1h, '1h', '4h')
      );
    }
    if (candles1d.length > 0) {
      candleRowsByInterval['1w'] = toCandleRows(
        market.id,
        '1w',
        aggregateToInterval(candles1d, '1d', '1w')
      );
    }

    rowsWritten += await persistCandlesAndState(
      market.id,
      candleRowsByInterval,
      ingestionState
    );
  }

  return rowsWritten;
}

async function poll() {
  const hotMarkets = await getHotMarkets(supabase, KALSHI.slug);
  if (hotMarkets.length === 0) {
    console.log(`[${WORKER_NAME}] cycle: no hot markets`);
    return 0;
  }

  const stateByMarket = await loadIngestionState(hotMarkets.map((m) => m.id));
  let rowsWritten = 0;

  for (const batch of chunkArray(hotMarkets, 1)) {
    try {
      rowsWritten += await backfillMarketGroup(batch, stateByMarket);
    } catch (err) {
      console.error(`[${WORKER_NAME}] batch backfill: ${err.message}`);
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

  console.log(`[${WORKER_NAME}] starting — poll every ${HISTORY_POLL_MS / 60_000}m (hot only)`);
  return startInterval();
}

if (require.main === module) {
  start();
}

module.exports = {
  start,
  poll,
  mapKalshiCandlestick,
  probFromDollars,
};
