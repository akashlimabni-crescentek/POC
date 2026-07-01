'use strict';

/** Provider slugs and external API base URLs — no hardcoded tournament/series names in workers */

const POLYMARKET = {
  slug: 'polymarket',
  gammaApiBase: 'https://gamma-api.polymarket.com',
  clobApiBase: 'https://clob.polymarket.com',
  dataApiBase: 'https://data-api.polymarket.com',
  eventsPageSize: 50,
  wsMarketUrl: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
};

const KALSHI = {
  slug: 'kalshi',
  apiBase: 'https://api.elections.kalshi.com/trade-api/v2',
  wsUrl: 'wss://api.elections.kalshi.com/trade-api/ws/v2',
  /** Configurable series tickers — replace with your target series */
  seriesTickers: [],
};

module.exports = {
  POLYMARKET,
  KALSHI,
};
