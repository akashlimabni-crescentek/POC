'use strict';

const { kalshiGet } = require('./kalshi-client');
const { sleep } = require('./http-client');

const EXCLUDED_PREFIXES = ['KXEWC', 'KXT20', 'KXWT20', 'KXW20'];
const EXCLUDED_TICKERS = [
  'KXCLUBWC',
  'KXWOSTKO',
  'KXAUSTINMAJOR',
  'KXTORONTOULTRACHAMPIONSHIP',
];
const EXCLUDED_KEYWORDS = [
  'esport',
  'e-sport',
  'cricket',
  't20',
  'club world cup',
  'women',
  "women's",
  'league of legends',
  'dota',
  'valorant',
  'chess',
  'pubg',
  'call of duty',
  'rainbow',
  'starcraft',
  'honor of kings',
  'free fire',
  'mobile legends',
  'ea sports',
  'apex',
  'warzone',
  'dota2',
];
const WC_KEYWORDS = [
  'world cup',
  'worldcup',
  'menworldcup',
  'kxwc',
  'kxmenworldcup',
  'kxfifa',
  'kxmworldcup',
  "men's world cup",
  'fifa world cup',
];

function isWorldCupSeries(series) {
  const title = (series.title ?? '').toLowerCase();
  const ticker = (series.ticker ?? '').toUpperCase();
  const tags = (series.tags ?? []).map((t) => String(t).toLowerCase());

  if (EXCLUDED_PREFIXES.some((p) => ticker.startsWith(p))) return false;
  if (EXCLUDED_TICKERS.includes(ticker)) return false;
  if (EXCLUDED_KEYWORDS.some((kw) => title.includes(kw))) return false;
  if (tags.some((t) => EXCLUDED_KEYWORDS.some((kw) => t.includes(kw)))) return false;

  return WC_KEYWORDS.some(
    (kw) =>
      title.includes(kw) ||
      ticker.toLowerCase().includes(kw) ||
      tags.some((t) => t.includes(kw))
  );
}

async function fetchSeriesPage(queryParams = {}) {
  const data = await kalshiGet('/series', { limit: 200, ...queryParams });
  return {
    series: data.series ?? [],
    cursor: data.cursor ?? null,
  };
}

/**
 * Discover FIFA men's World Cup series tickers from Kalshi /series API.
 * Mirrors legacy worker3-kalshi-rest.js discovery logic.
 */
async function discoverWorldCupSeries() {
  const discovered = new Set();

  for (const category of ['Sports', null]) {
    let cursor = null;
    do {
      const params = {};
      if (category) params.category = category;
      if (cursor) params.cursor = cursor;

      const { series, cursor: nextCursor } = await fetchSeriesPage(params);
      for (const s of series) {
        if (isWorldCupSeries(s)) {
          discovered.add(s.ticker);
        }
      }

      cursor = nextCursor;
      if (series.length === 0) break;
      await sleep(200);
    } while (cursor);
  }

  return [...discovered].sort();
}

module.exports = {
  isWorldCupSeries,
  discoverWorldCupSeries,
};
