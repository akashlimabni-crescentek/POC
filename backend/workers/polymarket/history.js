'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { supabase } = require('../../config/supabase');
const { POLYMARKET } = require('../../config/providers');
const { HISTORY_POLL_MS, REQUEST_DELAY_MS } = require('../../config/intervals');
const { fetchWithRetry, sleep } = require('../../lib/http-client');
const { upsertBatched } = require('../../lib/bulk-upsert');
const { createGuardedInterval } = require('../../lib/guarded-interval');
const { getHotMarkets } = require('../../lib/tiers');
const {
  getFetchWindow,
  toCandleRows,
  maxCandleTs,
  mergeLastCandleTs,
  LOOKBACK_SECONDS,
} = require('../../lib/history-common');
const {
  getBucketMs,
  floorToBucket,
  createBucket,
  applyTrade,
  aggregateToInterval,
} = require('../../lib/ohlc');

const WORKER_NAME = 'polymarket/history';
const INTERVAL_1M_MS = getBucketMs('1m');

function validateEnv() {
  if (!process.env.SUPABASE_URL?.trim()) {
    throw new Error(`[${WORKER_NAME}] SUPABASE_URL is required`);
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    throw new Error(`[${WORKER_NAME}] SUPABASE_SERVICE_ROLE_KEY is required`);
  }
}

function getPrimaryTokenId(market) {
  if (!Array.isArray(market.token_ids) || market.token_ids.length === 0) {
    return null;
  }
  return String(market.token_ids[0]);
}

function parseTradeTimestampMs(trade) {
  const raw = trade.timestamp ?? trade.match_time ?? trade.created_at;
  if (raw == null) return null;
  if (typeof raw === 'number') {
    return raw < 1e12 ? raw * 1000 : raw;
  }
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

/** Build 1m OHLC from Data API trades — prices are 0–1 probability */
function tradesTo1mCandles(trades) {
  const buckets = new Map();

  for (const trade of trades) {
    const price = Number(trade.price);
    if (Number.isNaN(price)) continue;

    const tsMs = parseTradeTimestampMs(trade);
    if (tsMs == null) continue;

    const size = Number(trade.size ?? 0);
    const bucketStart = floorToBucket(tsMs, INTERVAL_1M_MS);
    let bucket = buckets.get(bucketStart);
    if (!bucket) {
      bucket = createBucket(bucketStart, price);
      buckets.set(bucketStart, bucket);
    }
    applyTrade(bucket, price, size);
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([, bucket]) => ({ ...bucket }));
}

function clobPointsToCandles(points) {
  const list = Array.isArray(points) ? points : [];
  return list
    .filter((pt) => pt?.t != null && pt?.p != null)
    .map((pt) => ({
      ts: new Date(Number(pt.t) * 1000).toISOString(),
      open: Number(pt.p),
      high: Number(pt.p),
      low: Number(pt.p),
      close: Number(pt.p),
      volume: 0,
      trade_count: 0,
    }));
}

async function fetchTrades(tokenId, startSec, endSec) {
  const trades = [];
  let offset = 0;
  const limit = 500;
  const startMs = startSec * 1000;
  const endMs = endSec * 1000;

  while (true) {
    const url = new URL(`${POLYMARKET.dataApiBase}/trades`);
    url.searchParams.set('asset_id', tokenId);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));

    const response = await fetchWithRetry(url.toString());
    if (!response.ok) {
      throw new Error(`[${WORKER_NAME}] Data API /trades ${response.status}`);
    }

    const page = await response.json();
    if (!Array.isArray(page) || page.length === 0) {
      break;
    }

    let reachedPastWindow = false;
    for (const trade of page) {
      const tsMs = parseTradeTimestampMs(trade);
      if (tsMs == null) continue;
      if (tsMs < startMs) {
        reachedPastWindow = true;
        continue;
      }
      if (tsMs > endMs) continue;
      trades.push(trade);
    }

    if (page.length < limit || reachedPastWindow) {
      break;
    }
    offset += limit;
    await sleep(REQUEST_DELAY_MS);
  }

  return trades;
}

async function fetchClobHistory(tokenId, startSec, endSec, options = {}) {
  const url = new URL(`${POLYMARKET.clobApiBase}/prices-history`);
  url.searchParams.set('market', tokenId);
  url.searchParams.set('startTs', String(startSec));
  url.searchParams.set('endTs', String(endSec));

  if (options.interval) {
    url.searchParams.set('interval', options.interval);
  }
  if (options.fidelity != null) {
    url.searchParams.set('fidelity', String(options.fidelity));
  }

  const response = await fetchWithRetry(url.toString());
  if (!response.ok) {
    throw new Error(`[${WORKER_NAME}] CLOB /prices-history ${response.status}`);
  }

  const data = await response.json();
  return data.history ?? [];
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

async function persistCandlesAndState(marketId, candleRowsByInterval, existingState) {
  let written = 0;

  for (const [interval, rows] of Object.entries(candleRowsByInterval)) {
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

async function backfillMarket(market, ingestionState) {
  const tokenId = getPrimaryTokenId(market);
  if (!tokenId) {
    return 0;
  }

  const isFirstBackfill = !ingestionState?.last_backfill_at;
  const candleRowsByInterval = {};

  const window1m = getFetchWindow(isFirstBackfill, '1m');
  const trades = await fetchTrades(tokenId, window1m.startTs, window1m.endTs);
  const candles1m = tradesTo1mCandles(trades);

  if (candles1m.length === 0 && isFirstBackfill) {
    const points = await fetchClobHistory(tokenId, window1m.startTs, window1m.endTs, {
      fidelity: 1,
    });
    candleRowsByInterval['1m'] = toCandleRows(market.id, '1m', clobPointsToCandles(points));
  } else {
    candleRowsByInterval['1m'] = toCandleRows(market.id, '1m', candles1m);
  }

  const source1m = candleRowsByInterval['1m'].map((row) => ({
    ts: row.ts,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    trade_count: row.trade_count,
  }));

  // Source candle arrays (aggregate shape) so 15m/4h/1w can be rolled up from
  // the nearest finer source, whichever way 1h/1d were obtained.
  let source1h = [];
  let source1d = [];

  if (source1m.length > 0) {
    candleRowsByInterval['5m'] = toCandleRows(
      market.id,
      '5m',
      aggregateToInterval(source1m, '1m', '5m')
    );
    candleRowsByInterval['15m'] = toCandleRows(
      market.id,
      '15m',
      aggregateToInterval(source1m, '1m', '15m')
    );
  }

  if (isFirstBackfill) {
    const window1h = getFetchWindow(true, '1h');
    const points1h = await fetchClobHistory(tokenId, window1h.startTs, window1h.endTs, {
      interval: '1h',
      fidelity: 60,
    });
    source1h = clobPointsToCandles(points1h);
    candleRowsByInterval['1h'] = toCandleRows(market.id, '1h', source1h);

    const window1d = getFetchWindow(true, '1d');
    const points1d = await fetchClobHistory(tokenId, window1d.startTs, window1d.endTs, {
      interval: '1d',
      fidelity: 1440,
    });
    source1d = clobPointsToCandles(points1d);
    candleRowsByInterval['1d'] = toCandleRows(market.id, '1d', source1d);
  } else if (source1m.length > 0) {
    source1h = aggregateToInterval(source1m, '1m', '1h');
    candleRowsByInterval['1h'] = toCandleRows(market.id, '1h', source1h);
    source1d = aggregateToInterval(source1m, '1m', '1d');
    candleRowsByInterval['1d'] = toCandleRows(market.id, '1d', source1d);
  }

  // 4h rolls up from 1h, 1w from 1d.
  if (source1h.length > 0) {
    candleRowsByInterval['4h'] = toCandleRows(
      market.id,
      '4h',
      aggregateToInterval(source1h, '1h', '4h')
    );
  }
  if (source1d.length > 0) {
    candleRowsByInterval['1w'] = toCandleRows(
      market.id,
      '1w',
      aggregateToInterval(source1d, '1d', '1w')
    );
  }

  return persistCandlesAndState(market.id, candleRowsByInterval, ingestionState);
}

async function poll() {
  const hotMarkets = await getHotMarkets(supabase, POLYMARKET.slug);
  if (hotMarkets.length === 0) {
    console.log(`[${WORKER_NAME}] cycle: no hot markets`);
    return 0;
  }

  const stateByMarket = await loadIngestionState(hotMarkets.map((m) => m.id));
  let rowsWritten = 0;

  for (const market of hotMarkets) {
    try {
      const written = await backfillMarket(market, stateByMarket.get(market.id));
      rowsWritten += written;
    } catch (err) {
      console.error(`[${WORKER_NAME}] market ${market.id} backfill: ${err.message}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(
    `[${WORKER_NAME}] cycle: hot=${hotMarkets.length} written=${rowsWritten} lookback_1m=${LOOKBACK_SECONDS['1m']}s`
  );
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
  getPrimaryTokenId,
  tradesTo1mCandles,
  clobPointsToCandles,
  parseTradeTimestampMs,
};
