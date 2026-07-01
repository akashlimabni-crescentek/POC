'use strict';

const crypto = require('crypto');
const { loadKalshiCredentials } = require('../config/kalshi-key');
const { KALSHI } = require('../config/providers');
const { fetchWithRetry } = require('./http-client');

const SIGN_PATH_PREFIX = '/trade-api/v2';
const WS_SIGN_PATH = '/trade-api/ws/v2';

/**
 * Build Kalshi signed request headers (RSA-PSS SHA256).
 * @param {string} method HTTP method
 * @param {string} signPath Path from API root, e.g. /trade-api/v2/markets (no query string)
 */
function buildAuthHeaders(method, signPath) {
  const { apiKeyId, privateKeyPem } = loadKalshiCredentials();
  const timestamp = String(Date.now());
  const pathWithoutQuery = signPath.split('?')[0];
  const message = `${timestamp}${method}${pathWithoutQuery}`;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(message);
  sign.end();

  const signature = sign.sign({
    key: privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });

  return {
    'KALSHI-ACCESS-KEY': apiKeyId,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
    Accept: 'application/json',
  };
}

/**
 * Authenticated GET to Kalshi trade API v2.
 * @param {string} endpoint e.g. '/markets'
 * @param {Record<string, string|number|boolean>} [queryParams]
 */
async function kalshiGet(endpoint, queryParams = {}) {
  const params = Object.fromEntries(
    Object.entries(queryParams).filter(([, value]) => value != null && value !== '')
  );
  const queryString = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ).toString();

  const url = `${KALSHI.apiBase}${endpoint}${queryString ? `?${queryString}` : ''}`;
  const signPath = `${SIGN_PATH_PREFIX}${endpoint}`;

  const response = await fetchWithRetry(url, {
    headers: buildAuthHeaders('GET', signPath),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `[kalshi-client] GET ${endpoint} ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`
    );
  }

  return response.json();
}

/**
 * Paginate GET /markets until cursor exhausted.
 */
async function fetchMarketsPaginated(queryParams = {}) {
  const markets = [];
  let cursor = null;

  do {
    const pageParams = { limit: 200, ...queryParams };
    if (cursor) {
      pageParams.cursor = cursor;
    }

    const data = await kalshiGet('/markets', pageParams);
    if (Array.isArray(data.markets)) {
      markets.push(...data.markets);
    }
    cursor = data.cursor || null;
  } while (cursor);

  return markets;
}

/**
 * Batch GET /markets/candlesticks (up to 100 tickers per request).
 */
async function fetchBatchCandlesticks({ marketTickers, startTs, endTs, periodInterval }) {
  if (!marketTickers.length) {
    return [];
  }

  const tickers = marketTickers.join(',');
  const data = await kalshiGet('/markets/candlesticks', {
    market_tickers: tickers,
    start_ts: startTs,
    end_ts: endTs,
    period_interval: periodInterval,
  });

  return data.markets ?? [];
}

/** Signed headers for WebSocket handshake */
function buildWsAuthHeaders() {
  return buildAuthHeaders('GET', WS_SIGN_PATH);
}

module.exports = {
  buildAuthHeaders,
  buildWsAuthHeaders,
  kalshiGet,
  fetchMarketsPaginated,
  fetchBatchCandlesticks,
  WS_SIGN_PATH,
};
