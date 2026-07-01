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

/** Map Kalshi candlestick — normalize all prices to 0–1 on write */
function mapKalshiCandlestick(candle) {
  const price = candle.price ?? {};
  const open = probFromDollars(price.open_dollars ?? price.previous_dollars);
  const high = probFromDollars(price.high_dollars ?? price.max_dollars ?? price.open_dollars);
  const low = probFromDollars(price.low_dollars ?? price.min_dollars ?? price.open_dollars);
  const close = probFromDollars(price.close_dollars ?? price.open_dollars);

  if (close == null && open == null) {
    return null;
  }

  const volume = Number(candle.volume_fp ?? 0);
  const ts = new Date(Number(candle.end_period_ts) * 1000).toISOString();

  return {
    ts,
    open: open ?? close,
    high: high ?? close ?? open,
    low: low ?? close ?? open,
    close: close ?? open,
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

  for (const batch of chunkArray(tickers, KALSHI_HISTORY_BATCH_SIZE)) {
    const markets = await fetchBatchCandlesticks({
      marketTickers: batch,
      startTs,
      endTs,
      periodInterval,
    });

    for (const entry of markets) {
      const mapped = (entry.candlesticks ?? [])
        .map(mapKalshiCandlestick)
        .filter(Boolean);
      results.set(entry.market_ticker, mapped);
    }

    await sleep(REQUEST_DELAY_MS);
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

    if (candles1m.length > 0) {
      candleRowsByInterval['5m'] = toCandleRows(
        market.id,
        '5m',
        aggregateToInterval(candles1m, '1m', '5m')
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
      candleRowsByInterval['1h'] = toCandleRows(
        market.id,
        '1h',
        candles1hMap.get(market.external_id) ?? []
      );

      const window1d = getFetchWindow(true, '1d');
      const candles1dMap = await fetchCandlesForTickers(
        [market.external_id],
        window1d.startTs,
        window1d.endTs,
        KALSHI_PERIOD_MINUTES['1d']
      );
      candleRowsByInterval['1d'] = toCandleRows(
        market.id,
        '1d',
        candles1dMap.get(market.external_id) ?? []
      );
    } else if (candles1m.length > 0) {
      candleRowsByInterval['1h'] = toCandleRows(
        market.id,
        '1h',
        aggregateToInterval(candles1m, '1m', '1h')
      );
      candleRowsByInterval['1d'] = toCandleRows(
        market.id,
        '1d',
        aggregateToInterval(candles1m, '1m', '1d')
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

  for (const batch of chunkArray(hotMarkets, KALSHI_HISTORY_BATCH_SIZE)) {
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
