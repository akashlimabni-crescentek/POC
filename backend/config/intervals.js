'use strict';

/**
 * Named timer constants for all workers.
 * Schedule interval must exceed worst-case cycle time at expected scale.
 */

/** HTTP fetch timeout (ms) */
const HTTP_TIMEOUT_MS = 15_000;

/** Default delay between sequential REST API calls (Kalshi history) */
const REQUEST_DELAY_MS = 600;

/** Polymarket Gamma events poll */
const POLYMARKET_EVENTS_POLL_MS = 60_000;

/** Kalshi events poll (cold + warm) */
const KALSHI_EVENTS_POLL_MS = 30 * 60_000;

/** Hot-market WebSocket subscription refresh (diff subscribe/unsubscribe) */
const HOT_SUBSCRIPTION_REFRESH_MS = 5 * 60_000;

/** Live tick + market_prices_latest flush */
const LIVE_FLUSH_MS = 1_000;

/** Close and persist 1m OHLC buckets */
const CANDLE_1M_FLUSH_MS = 60_000;

/** History backfill cycle (hot markets only) */
const HISTORY_POLL_MS = 15 * 60_000;

/** Maintenance / retention fallback worker */
const MAINTENANCE_POLL_MS = 60 * 60_000;

/** Polymarket WS token subscription chunk size */
const POLYMARKET_WS_CHUNK_SIZE = 250;

/** Kalshi history REST batch size (tickers per request) */
const KALSHI_HISTORY_BATCH_SIZE = 4;

/** DB insert retry backoff: 250ms → 500ms → 1s */
const DB_RETRY_BACKOFF_MS = [250, 500, 1000];

/** HTTP retry count (in addition to first attempt) */
const HTTP_MAX_RETRIES = 3;

/** Frontend fallback poll when Realtime unavailable */
const FRONTEND_PRICE_POLL_MS = 2_000;

/** Polymarket WebSocket PING interval */
const POLYMARKET_WS_PING_MS = 10_000;

/** Polymarket WebSocket PONG timeout before reconnect */
const POLYMARKET_WS_PONG_TIMEOUT_MS = 15_000;

/** Live-ws worker heartbeat / candle flush reporting */
const LIVE_WS_REPORT_MS = 60_000;

module.exports = {
  HTTP_TIMEOUT_MS,
  REQUEST_DELAY_MS,
  POLYMARKET_EVENTS_POLL_MS,
  KALSHI_EVENTS_POLL_MS,
  HOT_SUBSCRIPTION_REFRESH_MS,
  LIVE_FLUSH_MS,
  CANDLE_1M_FLUSH_MS,
  HISTORY_POLL_MS,
  MAINTENANCE_POLL_MS,
  POLYMARKET_WS_CHUNK_SIZE,
  KALSHI_HISTORY_BATCH_SIZE,
  DB_RETRY_BACKOFF_MS,
  HTTP_MAX_RETRIES,
  FRONTEND_PRICE_POLL_MS,
  POLYMARKET_WS_PING_MS,
  POLYMARKET_WS_PONG_TIMEOUT_MS,
  LIVE_WS_REPORT_MS,
};
