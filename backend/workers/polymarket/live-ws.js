'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const WebSocket = require('ws');
const { supabase } = require('../../config/supabase');
const { POLYMARKET } = require('../../config/providers');
const {
  HOT_SUBSCRIPTION_REFRESH_MS,
  LIVE_FLUSH_MS,
  CANDLE_1M_FLUSH_MS,
  POLYMARKET_WS_CHUNK_SIZE,
  POLYMARKET_WS_PING_MS,
  POLYMARKET_WS_PONG_TIMEOUT_MS,
  LIVE_WS_REPORT_MS,
} = require('../../config/intervals');
const { getHotMarkets } = require('../../lib/tiers');
const { insertWithRetry } = require('../../lib/db-retry');
const { upsertBatched } = require('../../lib/bulk-upsert');
const { reportCycle, reportError } = require('../../lib/heartbeat');
const {
  getBucketMs,
  floorToBucket,
  createBucket,
  applyTick,
  applyTrade,
  computeGapFills,
  shouldEvict,
  advanceThroughBuckets,
} = require('../../lib/ohlc');

const WORKER_NAME = 'polymarket/live-ws';
const INTERVAL_1M_MS = getBucketMs('1m');

let cachedProviderId = null;

async function getProviderId() {
  if (cachedProviderId) {
    return cachedProviderId;
  }

  const { data, error } = await supabase
    .from('providers')
    .select('id')
    .eq('slug', POLYMARKET.slug)
    .maybeSingle();

  if (error) {
    throw new Error(`[${WORKER_NAME}] provider lookup: ${error.message}`);
  }
  if (!data) {
    throw new Error(`[${WORKER_NAME}] provider "${POLYMARKET.slug}" not found — run seed.sql`);
  }

  cachedProviderId = data.id;
  return cachedProviderId;
}

/** Polymarket prices are 0–1 probability at storage boundary */
function parseProbPrice(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isNaN(n) ? null : n;
}

function midPrice(bid, ask, last) {
  if (bid != null && ask != null) return (bid + ask) / 2;
  if (last != null) return last;
  return bid ?? ask ?? null;
}

function bestFromBook(bids, asks) {
  const bid = bids?.length ? parseProbPrice(bids[0].price) : null;
  const ask = asks?.length ? parseProbPrice(asks[0].price) : null;
  return { bid, ask };
}

function buildTokenToMarketMap(markets) {
  const map = new Map();
  for (const market of markets) {
    const tokens = Array.isArray(market.token_ids) ? market.token_ids : [];
    for (const tokenId of tokens) {
      map.set(String(tokenId), market.id);
    }
  }
  return map;
}

/** First clob token per market — same source as polymarket/history getPrimaryTokenId. */
function buildPrimaryTokenSet(markets) {
  const primary = new Set();
  for (const market of markets) {
    const tokens = Array.isArray(market.token_ids) ? market.token_ids : [];
    if (tokens.length > 0) {
      primary.add(String(tokens[0]));
    }
  }
  return primary;
}

function shouldEmitCandleRows(tokenId, primaryTokens) {
  if (primaryTokens === undefined) {
    return true;
  }
  if (primaryTokens.size === 0) {
    return false;
  }
  return primaryTokens.has(tokenId);
}

/** Last row wins — guards against duplicate (market_id, interval, ts) in one upsert batch. */
function dedupeCandleRows(rows) {
  const byKey = new Map();
  for (const row of rows) {
    byKey.set(`${row.market_id}|${row.interval}|${row.ts}`, row);
  }
  return [...byKey.values()];
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function diffTokenSets(current, next) {
  const toSubscribe = [...next].filter((t) => !current.has(t));
  const toUnsubscribe = [...current].filter((t) => !next.has(t));
  return { toSubscribe, toUnsubscribe };
}

function createTokenState(marketId) {
  return {
    marketId,
    orderBook: { bids: [], asks: [] },
    bucket: null,
    bucketStartMs: null,
    lastKnownClose: null,
    lastRealTickAt: null,
    lastWrittenBucketMs: null,
    lastPrice: null,
    pendingSnapshot: null,
  };
}

function queueClosedCandles(state, closedRows) {
  if (closedRows.length === 0) return;
  if (!state.pendingCandleRows) state.pendingCandleRows = [];
  for (const row of closedRows) {
    state.pendingCandleRows.push({
      market_id: state.marketId,
      interval: '1m',
      ...row,
    });
  }
}

function ensureBucket(state, price, nowMs = Date.now()) {
  const bucketStart = floorToBucket(nowMs, INTERVAL_1M_MS);
  const p = price ?? state.lastKnownClose;
  if (p == null) return;

  if (state.bucket && state.bucketStartMs != null && bucketStart > state.bucketStartMs) {
    queueClosedCandles(
      state,
      advanceThroughBuckets(state, bucketStart, INTERVAL_1M_MS)
    );
  }

  if (!state.bucket || state.bucketStartMs !== bucketStart) {
    state.bucket = createBucket(bucketStart, p);
    state.bucketStartMs = bucketStart;
  }
}

function updateSnapshot(state, { bid, ask, last, ts }) {
  const mid = midPrice(bid, ask, last);
  const price = mid ?? last ?? bid ?? ask;
  if (price == null) return;

  state.lastRealTickAt = ts ?? Date.now();
  state.lastKnownClose = price;
  state.lastPrice = last ?? price;

  ensureBucket(state, price, state.lastRealTickAt);
  applyTick(state.bucket, price);

  state.pendingSnapshot = {
    market_id: state.marketId,
    ts: new Date(state.lastRealTickAt).toISOString(),
    bid,
    ask,
    mid,
    last_price: last ?? price,
    volume: null,
  };
}

function collectCompletedCandles(tokenStates, nowMs = Date.now(), options = {}) {
  const primaryTokens = options.primaryTokens;
  const rows = [];

  for (const [tokenId, state] of tokenStates) {
    if (state.pendingCandleRows?.length) {
      if (shouldEmitCandleRows(tokenId, primaryTokens)) {
        rows.push(...state.pendingCandleRows);
      }
      state.pendingCandleRows = [];
    }

    if (!state.bucket || state.bucketStartMs == null) continue;

    const emitRows = shouldEmitCandleRows(tokenId, primaryTokens);

    while (state.bucketStartMs + INTERVAL_1M_MS <= nowMs) {
      if (emitRows) {
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

        const { fills } = computeGapFills(
          state.lastWrittenBucketMs,
          state.bucketStartMs,
          state.lastKnownClose,
          INTERVAL_1M_MS
        );

        for (const fill of fills) {
          rows.push({
            market_id: state.marketId,
            interval: '1m',
            ...fill,
          });
        }
      }

      state.lastWrittenBucketMs = state.bucketStartMs;
      const nextStart = state.bucketStartMs + INTERVAL_1M_MS;
      const carry = state.bucket.close;
      state.lastKnownClose = carry;
      state.bucket = createBucket(nextStart, carry);
      state.bucketStartMs = nextStart;
    }
  }

  return rows;
}

function evictIdleTokenState(tokenStates, subscribedTokens) {
  let evicted = 0;
  for (const [tokenId, state] of tokenStates) {
    if (shouldEvict(state.lastRealTickAt)) {
      tokenStates.delete(tokenId);
      subscribedTokens.delete(tokenId);
      evicted += 1;
    }
  }
  return evicted;
}

class PolymarketLiveWorker {
  constructor() {
    this.ws = null;
    this.subscribedTokens = new Set();
    this.tokenToMarket = new Map();
    this.primaryTokens = new Set();
    this.tokenStates = new Map();
    this.pendingNewTokens = new Set();
    this.reconnectAttempts = 0;
    this.lastPongAt = Date.now();
    this.pingTimer = null;
    this.pongTimer = null;
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
  }

  getOrCreateState(tokenId) {
    const marketId = this.tokenToMarket.get(tokenId);
    if (!marketId) return null;

    if (!this.tokenStates.has(tokenId)) {
      this.tokenStates.set(tokenId, createTokenState(marketId));
    }
    return this.tokenStates.get(tokenId);
  }

  sendWs(payload) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  sendTokenOperation(tokenIds, operation) {
    if (!tokenIds.length) return;
    for (const chunk of chunkArray(tokenIds, POLYMARKET_WS_CHUNK_SIZE)) {
      this.sendWs({
        assets_ids: chunk,
        operation,
        custom_feature_enabled: true,
      });
    }
  }

  async refreshHotSubscriptions(options = {}) {
    const isInitial = options.initial === true;
    const hotMarkets = await getHotMarkets(supabase, POLYMARKET.slug);
    const nextMap = buildTokenToMarketMap(hotMarkets);

    for (const tokenId of this.pendingNewTokens) {
      if (!nextMap.has(tokenId) && this.tokenToMarket.has(tokenId)) {
        nextMap.set(tokenId, this.tokenToMarket.get(tokenId));
      }
    }
    this.pendingNewTokens.clear();

    const nextTokens = new Set(nextMap.keys());
    const { toSubscribe, toUnsubscribe } = diffTokenSets(this.subscribedTokens, nextTokens);

    this.tokenToMarket = nextMap;
    this.primaryTokens = buildPrimaryTokenSet(hotMarkets);

    if (this.ws?.readyState === WebSocket.OPEN) {
      if (isInitial) {
        const tokens = [...nextTokens];
        for (const chunk of chunkArray(tokens, POLYMARKET_WS_CHUNK_SIZE)) {
          this.sendWs({
            type: 'market',
            assets_ids: chunk,
            custom_feature_enabled: true,
          });
        }
      } else {
        this.sendTokenOperation(toSubscribe, 'subscribe');
        this.sendTokenOperation(toUnsubscribe, 'unsubscribe');
      }
    }

    this.subscribedTokens = nextTokens;
    console.log(
      `[${WORKER_NAME}] subscription refresh: hot=${hotMarkets.length} tokens=${nextTokens.size} +${toSubscribe.length} -${toUnsubscribe.length}${isInitial ? ' (initial)' : ''}`
    );
  }

  handleBook(msg) {
    const tokenId = String(msg.asset_id);
    const state = this.getOrCreateState(tokenId);
    if (!state) return;

    state.orderBook = {
      bids: msg.bids ?? [],
      asks: msg.asks ?? [],
    };

    const { bid, ask } = bestFromBook(state.orderBook.bids, state.orderBook.asks);
    const ts = msg.timestamp ? Number(msg.timestamp) : Date.now();
    updateSnapshot(state, { bid, ask, last: state.lastPrice, ts });
  }

  handleBestBidAsk(msg) {
    const tokenId = String(msg.asset_id);
    const state = this.getOrCreateState(tokenId);
    if (!state) return;

    const bid = parseProbPrice(msg.best_bid);
    const ask = parseProbPrice(msg.best_ask);
    const ts = msg.timestamp ? Number(msg.timestamp) : Date.now();
    updateSnapshot(state, { bid, ask, last: state.lastPrice, ts });
  }

  handleLastTrade(msg) {
    const tokenId = String(msg.asset_id);
    const state = this.getOrCreateState(tokenId);
    if (!state) return;

    const price = parseProbPrice(msg.price);
    const size = parseProbPrice(msg.size);
    const ts = msg.timestamp ? Number(msg.timestamp) : Date.now();

    if (price == null) return;

    state.lastRealTickAt = ts;
    state.lastKnownClose = price;
    state.lastPrice = price;
    ensureBucket(state, price, ts);
    applyTrade(state.bucket, price, size);
    updateSnapshot(state, {
      bid: state.pendingSnapshot?.bid ?? null,
      ask: state.pendingSnapshot?.ask ?? null,
      last: price,
      ts,
    });
  }

  handlePriceChange(msg) {
    const changes = msg.price_changes ?? [];
    for (const change of changes) {
      const tokenId = String(change.asset_id);
      const state = this.getOrCreateState(tokenId);
      if (!state) continue;

      const bid = parseProbPrice(change.best_bid);
      const ask = parseProbPrice(change.best_ask);
      const ts = msg.timestamp ? Number(msg.timestamp) : Date.now();
      updateSnapshot(state, { bid, ask, last: state.lastPrice, ts });
    }
  }

  handleNewMarket(msg) {
    const tokens = msg.assets_ids ?? msg.clob_token_ids ?? [];
    for (const tokenId of tokens) {
      this.pendingNewTokens.add(String(tokenId));
    }
    if (msg.id) {
      console.log(`[${WORKER_NAME}] new_market queued: id=${msg.id} tokens=${tokens.length}`);
    }
  }

  async handleMarketResolved(msg) {
    const providerId = await getProviderId();
    const externalId = msg.id != null ? String(msg.id) : null;
    const conditionId = msg.market != null ? String(msg.market) : null;

    if (externalId) {
      const { error } = await supabase
        .from('markets')
        .update({ status: 'closed' })
        .eq('provider_id', providerId)
        .eq('external_id', externalId);
      if (error) {
        console.error(`[${WORKER_NAME}] market_resolved external_id update: ${error.message}`);
      }
    }

    if (conditionId) {
      const { error } = await supabase
        .from('markets')
        .update({ status: 'closed' })
        .eq('provider_id', providerId)
        .eq('condition_id', conditionId);
      if (error) {
        console.error(`[${WORKER_NAME}] market_resolved condition_id update: ${error.message}`);
      }
    }

    const tokens = msg.assets_ids ?? [];
    for (const tokenId of tokens) {
      this.subscribedTokens.delete(String(tokenId));
      this.tokenStates.delete(String(tokenId));
    }
  }

  handleMessage(raw) {
    if (raw === 'PONG') {
      this.lastPongAt = Date.now();
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (Array.isArray(msg)) {
      for (const item of msg) {
        this.handleMessage(JSON.stringify(item));
      }
      return;
    }

    const eventType = msg.event_type ?? msg.type;
    switch (eventType) {
      case 'book':
        this.handleBook(msg);
        break;
      case 'best_bid_ask':
        this.handleBestBidAsk(msg);
        break;
      case 'last_trade_price':
        this.handleLastTrade(msg);
        break;
      case 'price_change':
        this.handlePriceChange(msg);
        break;
      case 'new_market':
        this.handleNewMarket(msg);
        break;
      case 'market_resolved':
        this.handleMarketResolved(msg).catch((err) => {
          console.error(`[${WORKER_NAME}] market_resolved: ${err.message}`);
        });
        break;
      default:
        break;
    }
  }

  async flushLive() {
    const latestByMarket = new Map();
    const tickRows = [];

    for (const state of this.tokenStates.values()) {
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
    const candleRows = dedupeCandleRows(
      collectCompletedCandles(this.tokenStates, Date.now(), {
        primaryTokens: this.primaryTokens,
      })
    );
    if (candleRows.length === 0) return 0;

    const { written } = await upsertBatched(supabase, 'candles', candleRows, {
      onConflict: 'market_id,interval,ts',
    });
    return written;
  }

  connect() {
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.terminate();
      } catch {
        // ignore
      }
    }

    this.ws = new WebSocket(POLYMARKET.wsMarketUrl);

    this.ws.on('open', async () => {
      this.reconnectAttempts = 0;
      this.lastPongAt = Date.now();
      console.log(`[${WORKER_NAME}] WebSocket connected`);

      try {
        await this.refreshHotSubscriptions({ initial: true });
      } catch (err) {
        console.error(`[${WORKER_NAME}] initial subscription: ${err.message}`);
      }
    });

    this.ws.on('message', (data) => {
      this.handleMessage(data.toString());
    });

    this.ws.on('close', (code) => {
      console.warn(`[${WORKER_NAME}] WebSocket closed code=${code}`);
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error(`[${WORKER_NAME}] WebSocket error: ${err.message}`);
    });
  }

  scheduleReconnect() {
    if (!this.running) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempts, 5));
    console.log(`[${WORKER_NAME}] reconnecting in ${delay}ms`);
    setTimeout(() => this.connect(), delay);
  }

  startPingLoop() {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send('PING');
      }

      if (Date.now() - this.lastPongAt > POLYMARKET_WS_PONG_TIMEOUT_MS) {
        console.warn(`[${WORKER_NAME}] PONG timeout — reconnecting`);
        this.connect();
      }
    }, POLYMARKET_WS_PING_MS);
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
        const evicted = evictIdleTokenState(this.tokenStates, this.subscribedTokens);
        if (evicted > 0) {
          console.log(`[${WORKER_NAME}] evicted ${evicted} idle token states`);
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
    clearInterval(this.pingTimer);
    clearInterval(this.pongTimer);
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
    this.startPingLoop();
    this.startLoops();
    console.log(`[${WORKER_NAME}] started`);
  }
}

function start() {
  const worker = new PolymarketLiveWorker();
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
  PolymarketLiveWorker,
  parseProbPrice,
  midPrice,
  buildTokenToMarketMap,
  buildPrimaryTokenSet,
  shouldEmitCandleRows,
  dedupeCandleRows,
  diffTokenSets,
  collectCompletedCandles,
  updateSnapshot,
  createTokenState,
};
