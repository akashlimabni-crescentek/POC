'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const WebSocket = require('ws');
const { supabase } = require('../../config/supabase');
const { KALSHI } = require('../../config/providers');
const {
  HOT_SUBSCRIPTION_REFRESH_MS,
  LIVE_FLUSH_MS,
  CANDLE_1M_FLUSH_MS,
  LIVE_WS_REPORT_MS,
} = require('../../config/intervals');
const { buildWsAuthHeaders } = require('../../lib/kalshi-client');
const { loadKalshiCredentials } = require('../../config/kalshi-key');
const { getHotMarkets } = require('../../lib/tiers');
const { insertWithRetry } = require('../../lib/db-retry');
const { upsertBatched } = require('../../lib/bulk-upsert');
const { reportCycle, reportError } = require('../../lib/heartbeat');
const { normalizePrice } = require('../../lib/price-units');
const {
  getBucketMs,
  floorToBucket,
  createBucket,
  applyTick,
  applyQuote,
  applyTrade,
  shouldEvict,
  normalizeEpochMs,
} = require('../../lib/ohlc');

const WORKER_NAME = 'kalshi/live-ws';
const INTERVAL_1M_MS = getBucketMs('1m');
const SUBSCRIBE_CHANNELS = ['ticker', 'trade'];
const TICKER_CHUNK_SIZE = 100;
/** Safety cap — max 1m buckets closed per ticker per flush (2h catch-up) */
const MAX_BUCKETS_PER_FLUSH = 120;

/** Kalshi WS prices normalized to 0–1 probability on write */
function extractKalshiPrices(payload) {
  const bid =
    payload.yes_bid_dollars != null
      ? normalizePrice('kalshi', payload.yes_bid_dollars, { unit: 'dollars' })
      : normalizePrice('kalshi', payload.yes_bid, { unit: 'cents' });

  const ask =
    payload.yes_ask_dollars != null
      ? normalizePrice('kalshi', payload.yes_ask_dollars, { unit: 'dollars' })
      : normalizePrice('kalshi', payload.yes_ask, { unit: 'cents' });

  const last =
    payload.price_dollars != null
      ? normalizePrice('kalshi', payload.price_dollars, { unit: 'dollars' })
      : normalizePrice('kalshi', payload.price ?? payload.yes_price, { unit: 'cents' });

  return { bid, ask, last };
}

function midPrice(bid, ask, last) {
  if (bid != null && ask != null) return (bid + ask) / 2;
  if (last != null) return last;
  return bid ?? ask ?? null;
}

function buildTickerToMarketMap(markets) {
  const map = new Map();
  for (const market of markets) {
    if (market.external_id) {
      map.set(String(market.external_id), market.id);
    }
  }
  return map;
}

function diffTickerSets(current, next) {
  const toSubscribe = [...next].filter((t) => !current.has(t));
  const toUnsubscribe = [...current].filter((t) => !next.has(t));
  return { toSubscribe, toUnsubscribe };
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function createTickerState(marketId) {
  return {
    marketId,
    bucket: null,
    bucketStartMs: null,
    bucketHadActivity: false,
    lastKnownClose: null,
    lastRealTickAt: null,
    lastWrittenBucketMs: null,
    lastPrice: null,
    pendingSnapshot: null,
  };
}

function ensureBucket(state, price, nowMs = Date.now()) {
  const bucketStart = floorToBucket(nowMs, INTERVAL_1M_MS);
  const p = price ?? state.lastKnownClose;
  if (p == null) return;

  if (!state.bucket || state.bucketStartMs !== bucketStart) {
    state.bucket = createBucket(bucketStart, p);
    state.bucketStartMs = bucketStart;
    state.bucketHadActivity = false;
  }
}

function updateSnapshot(state, { bid, ask, last, ts }) {
  const mid = midPrice(bid, ask, last);
  const price = mid ?? last ?? bid ?? ask;
  if (price == null) return;

  const tickMs = normalizeEpochMs(ts);
  state.lastRealTickAt = tickMs;
  state.lastKnownClose = price;
  state.lastPrice = last ?? price;

  ensureBucket(state, price, tickMs);
  applyTick(state.bucket, price);
  applyQuote(state.bucket, bid, ask);
  state.bucketHadActivity = true;

  state.pendingSnapshot = {
    market_id: state.marketId,
    ts: new Date(tickMs).toISOString(),
    bid,
    ask,
    mid,
    last_price: last ?? price,
    volume: null,
  };
}

function collectCompletedCandles(tickerStates, nowMs = Date.now()) {
  const rows = [];

  for (const state of tickerStates.values()) {
    if (!state.bucket || state.bucketStartMs == null) continue;

    let iterations = 0;
    while (
      state.bucketStartMs + INTERVAL_1M_MS <= nowMs &&
      iterations < MAX_BUCKETS_PER_FLUSH
    ) {
      iterations += 1;

      if (state.bucketHadActivity) {
        rows.push({
          market_id: state.marketId,
          interval: '1m',
          ts: state.bucket.ts,
          open: state.bucket.open,
          high: state.bucket.high,
          low: state.bucket.low,
          close: state.bucket.close,
          volume: state.bucket.volume,
          trade_count: state.bucket.trade_count,
        });
      }

      state.lastWrittenBucketMs = state.bucketStartMs;
      state.bucketHadActivity = false;
      const nextStart = state.bucketStartMs + INTERVAL_1M_MS;
      const carry = state.bucket.close;
      state.lastKnownClose = carry;
      state.bucket = createBucket(nextStart, carry);
      state.bucketStartMs = nextStart;
    }

    if (iterations >= MAX_BUCKETS_PER_FLUSH) {
      console.warn(
        `[${WORKER_NAME}] candle catch-up capped for market=${state.marketId} (${MAX_BUCKETS_PER_FLUSH} buckets)`
      );
    }
  }

  return rows;
}

function evictIdleTickerState(tickerStates, subscribedTickers) {
  let evicted = 0;
  for (const [ticker, state] of tickerStates) {
    if (shouldEvict(state.lastRealTickAt)) {
      tickerStates.delete(ticker);
      subscribedTickers.delete(ticker);
      evicted += 1;
    }
  }
  return evicted;
}

function checkSequenceGap(lastSeqBySid, sid, seq) {
  if (sid == null || seq == null) {
    return false;
  }
  const last = lastSeqBySid.get(sid);
  if (last != null && seq !== last + 1) {
    return true;
  }
  lastSeqBySid.set(sid, seq);
  return false;
}

class KalshiLiveWorker {
  constructor() {
    this.ws = null;
    this.subscribedTickers = new Set();
    this.tickerToMarket = new Map();
    this.tickerStates = new Map();
    this.channelSids = new Map();
    this.lastSeqBySid = new Map();
    this.nextMsgId = 1;
    this.reconnectAttempts = 0;
    this.flushTimer = null;
    this.candleTimer = null;
    this.refreshTimer = null;
    this.reportTimer = null;
    this.cycleRows = 0;
    this.running = false;
  }

  validateEnv() {
    if (!process.env.SUPABASE_URL?.trim()) {
      throw new Error(`[${WORKER_NAME}] SUPABASE_URL is required`);
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
      throw new Error(`[${WORKER_NAME}] SUPABASE_SERVICE_ROLE_KEY is required`);
    }
    loadKalshiCredentials();
  }

  sendCmd(payload) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ id: this.nextMsgId++, ...payload }));
  }

  getOrCreateState(ticker) {
    const marketId = this.tickerToMarket.get(ticker);
    if (!marketId) return null;

    if (!this.tickerStates.has(ticker)) {
      this.tickerStates.set(ticker, createTickerState(marketId));
    }
    return this.tickerStates.get(ticker);
  }

  subscribeTickers(tickers) {
    if (!tickers.length) return;
    for (const chunk of chunkArray(tickers, TICKER_CHUNK_SIZE)) {
      this.sendCmd({
        cmd: 'subscribe',
        params: {
          channels: SUBSCRIBE_CHANNELS,
          market_tickers: chunk,
        },
      });
    }
  }

  updateSubscription(action, tickers) {
    if (!tickers.length || this.channelSids.size === 0) return;

    for (const sid of this.channelSids.values()) {
      for (const chunk of chunkArray(tickers, TICKER_CHUNK_SIZE)) {
        this.sendCmd({
          cmd: 'update_subscription',
          params: {
            sids: [sid],
            action,
            market_tickers: chunk,
          },
        });
      }
    }
  }

  async refreshHotSubscriptions(options = {}) {
    const isInitial = options.initial === true;
    const hotMarkets = await getHotMarkets(supabase, KALSHI.slug);
    const nextMap = buildTickerToMarketMap(hotMarkets);
    const nextTickers = new Set(nextMap.keys());
    const { toSubscribe, toUnsubscribe } = diffTickerSets(this.subscribedTickers, nextTickers);

    this.tickerToMarket = nextMap;

    for (const ticker of this.tickerStates.keys()) {
      if (!nextTickers.has(ticker)) {
        this.tickerStates.delete(ticker);
      }
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      if (isInitial) {
        this.subscribeTickers([...nextTickers]);
      } else {
        this.updateSubscription('add_markets', toSubscribe);
        this.updateSubscription('delete_markets', toUnsubscribe);
      }
    }

    this.subscribedTickers = nextTickers;
    console.log(
      `[${WORKER_NAME}] subscription refresh: hot=${hotMarkets.length} tickers=${nextTickers.size} +${toSubscribe.length} -${toUnsubscribe.length}${isInitial ? ' (initial)' : ''}`
    );
  }

  handleSubscribed(msg) {
    const channel = msg.msg?.channel ?? msg.channel;
    const sid = msg.msg?.sid ?? msg.sid;
    if (channel && sid != null) {
      this.channelSids.set(channel, sid);
      if (!this.lastSeqBySid.has(sid)) {
        this.lastSeqBySid.set(sid, 0);
      }
    }
  }

  handleTicker(msg) {
    const payload = msg.msg ?? msg;
    const ticker = String(payload.market_ticker);
    const state = this.getOrCreateState(ticker);
    if (!state) return;

    const { bid, ask, last } = extractKalshiPrices(payload);
    const ts = normalizeEpochMs(payload.ts);

    console.log(`[${WORKER_NAME}] socket received (ticker)`, {
      market_ticker: ticker,
      market_id: state.marketId,
      bid,
      ask,
      last,
      ts: new Date(ts).toISOString(),
    });

    updateSnapshot(state, { bid, ask, last, ts });
  }

  handleTrade(msg) {
    const payload = msg.msg ?? msg;
    const ticker = String(payload.market_ticker);
    const state = this.getOrCreateState(ticker);
    if (!state) return;

    const { last: price } = extractKalshiPrices(payload);
    const size = payload.count ?? payload.size ?? 0;
    const ts = normalizeEpochMs(payload.ts);

    if (price == null) return;

    console.log(`[${WORKER_NAME}] socket received (trade)`, {
      market_ticker: ticker,
      market_id: state.marketId,
      last_price: price,
      size,
      ts: new Date(ts).toISOString(),
    });

    state.lastRealTickAt = ts;
    state.lastKnownClose = price;
    state.lastPrice = price;
    ensureBucket(state, price, ts);
    applyTrade(state.bucket, price, size);

    const { bid, ask } = extractKalshiPrices(payload);
    updateSnapshot(state, {
      bid: bid ?? state.pendingSnapshot?.bid ?? null,
      ask: ask ?? state.pendingSnapshot?.ask ?? null,
      last: price,
      ts,
    });
  }

  resubscribeOnSequenceGap(sid, seq) {
    const last = this.lastSeqBySid.get(sid);
    console.warn(
      `[${WORKER_NAME}] sequence gap sid=${sid} expected=${(last ?? 0) + 1} got=${seq} — reconnecting`
    );
    this.channelSids.clear();
    this.lastSeqBySid.clear();
    this.connect();
  }

  handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.sid != null && msg.seq != null) {
      if (checkSequenceGap(this.lastSeqBySid, msg.sid, msg.seq)) {
        this.resubscribeOnSequenceGap(msg.sid, msg.seq);
        return;
      }
    }

    switch (msg.type) {
      case 'subscribed':
        this.handleSubscribed(msg);
        break;
      case 'ticker':
        this.handleTicker(msg);
        break;
      case 'trade':
        this.handleTrade(msg);
        break;
      case 'error':
        console.error(
          `[${WORKER_NAME}] ws error code=${msg.msg?.code}: ${msg.msg?.msg ?? 'unknown'}`
        );
        break;
      default:
        break;
    }
  }

  async flushLive() {
    const latestByMarket = new Map();
    const tickRows = [];

    for (const state of this.tickerStates.values()) {
      if (!state.pendingSnapshot) continue;
      const snap = state.pendingSnapshot;
      latestByMarket.set(snap.market_id, snap);
      tickRows.push(snap);
      state.pendingSnapshot = null;
    }

    if (tickRows.length === 0) return 0;

    const latestRows = [...latestByMarket.values()].map((snap) => ({
      market_id: snap.market_id,
      bid: snap.bid,
      ask: snap.ask,
      mid: snap.mid,
      last_price: snap.last_price,
      updated_at: snap.ts,
    }));

    console.log(`[${WORKER_NAME}] pushing to Supabase (triggers Realtime)`, {
      live_ticks: tickRows,
      market_prices_latest: latestRows,
    });

    const { inserted } = await insertWithRetry(supabase, 'live_ticks', tickRows);

    if (latestRows.length > 0) {
      const { error } = await supabase.from('market_prices_latest').upsert(latestRows, {
        onConflict: 'market_id',
      });
      if (error) {
        console.error(`[${WORKER_NAME}] market_prices_latest upsert: ${error.message}`);
      }
    }

    return inserted;
  }

  async flushCandles() {
    const candleRows = collectCompletedCandles(this.tickerStates);
    if (candleRows.length === 0) return 0;

    console.log(`[${WORKER_NAME}] pushing to Supabase (candles)`, {
      count: candleRows.length,
      candles: candleRows,
    });

    const { written } = await upsertBatched(supabase, 'candles', candleRows, {
      onConflict: 'market_id,interval,ts',
    });
    return written;
  }

  connect() {
    if (this.ws) {
      const stale = this.ws;
      stale.on('error', () => {});
      stale.removeAllListeners('open');
      stale.removeAllListeners('message');
      stale.removeAllListeners('close');
      try {
        stale.terminate();
      } catch {
        // ignore
      }
      this.ws = null;
    }

    const headers = buildWsAuthHeaders();
    console.log(`[${WORKER_NAME}] connecting to API: ${KALSHI.wsUrl}`);
    this.ws = new WebSocket(KALSHI.wsUrl, { headers });

    this.ws.on('open', async () => {
      this.reconnectAttempts = 0;
      console.log(`[${WORKER_NAME}] WebSocket connected — API: ${KALSHI.wsUrl}`);

      try {
        await this.refreshHotSubscriptions({ initial: true });
      } catch (err) {
        console.error(`[${WORKER_NAME}] initial subscription: ${err.message}`);
        await reportError(WORKER_NAME, err);
      }
    });

    this.ws.on('message', (data) => {
      this.handleMessage(data.toString());
    });

    this.ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        console.error(
          `[${WORKER_NAME}] WebSocket failed — API: ${KALSHI.wsUrl} status=${res.statusCode} ${body}`
        );
      });
    });

    this.ws.on('close', (code) => {
      console.warn(`[${WORKER_NAME}] WebSocket closed — API: ${KALSHI.wsUrl} code=${code}`);
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error(`[${WORKER_NAME}] WebSocket error — API: ${KALSHI.wsUrl}: ${err.message}`);
    });
  }

  scheduleReconnect() {
    if (!this.running) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempts, 5));
    console.log(`[${WORKER_NAME}] reconnecting in ${delay}ms`);
    setTimeout(() => this.connect(), delay);
  }

  startLoops() {
    this.flushTimer = setInterval(async () => {
      try {
        const rows = await this.flushLive();
        this.cycleRows += rows;
      } catch (err) {
        console.error(`[${WORKER_NAME}] flushLive: ${err.message}`);
      }
    }, LIVE_FLUSH_MS);

    this.candleTimer = setInterval(async () => {
      try {
        const rows = await this.flushCandles();
        this.cycleRows += rows;
        const evicted = evictIdleTickerState(this.tickerStates, this.subscribedTickers);
        if (evicted > 0) {
          console.log(`[${WORKER_NAME}] evicted ${evicted} idle ticker states`);
        }
      } catch (err) {
        console.error(`[${WORKER_NAME}] flushCandles: ${err.message}`);
      }
    }, CANDLE_1M_FLUSH_MS);

    this.refreshTimer = setInterval(async () => {
      try {
        await this.refreshHotSubscriptions();
      } catch (err) {
        console.error(`[${WORKER_NAME}] refreshHotSubscriptions: ${err.message}`);
        await reportError(WORKER_NAME, err);
      }
    }, HOT_SUBSCRIPTION_REFRESH_MS);

    this.reportTimer = setInterval(async () => {
      try {
        await reportCycle(WORKER_NAME, this.cycleRows);
        this.cycleRows = 0;
      } catch (err) {
        console.error(`[${WORKER_NAME}] reportCycle: ${err.message}`);
      }
    }, LIVE_WS_REPORT_MS);
  }

  stop() {
    this.running = false;
    clearInterval(this.flushTimer);
    clearInterval(this.candleTimer);
    clearInterval(this.refreshTimer);
    clearInterval(this.reportTimer);
    if (this.ws) {
      this.ws.close();
    }
  }

  async start() {
    this.validateEnv();
    this.running = true;
    this.connect();
    this.startLoops();
    console.log(`[${WORKER_NAME}] started`);
  }
}

function start() {
  const worker = new KalshiLiveWorker();
  worker.start().catch((err) => {
    console.error(`[${WORKER_NAME}] fatal: ${err.message}`);
    process.exit(1);
  });
  return worker;
}

if (require.main === module) {
  start();
}

module.exports = {
  start,
  KalshiLiveWorker,
  extractKalshiPrices,
  buildTickerToMarketMap,
  diffTickerSets,
  checkSequenceGap,
  collectCompletedCandles,
  updateSnapshot,
  createTickerState,
};
