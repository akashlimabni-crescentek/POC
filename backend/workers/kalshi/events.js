'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { supabase } = require('../../config/supabase');
const { KALSHI } = require('../../config/providers');
const { KALSHI_EVENTS_POLL_MS } = require('../../config/intervals');
const { loadKalshiCredentials } = require('../../config/kalshi-key');
const { fetchMarketsPaginated } = require('../../lib/kalshi-client');
const { upsertBatched } = require('../../lib/bulk-upsert');
const { DeadLetterQueue } = require('../../lib/dead-letter');
const { createGuardedInterval } = require('../../lib/guarded-interval');

const WORKER_NAME = 'kalshi/events';

const eventsDeadLetter = new DeadLetterQueue(`${WORKER_NAME}:events`);
const marketsDeadLetter = new DeadLetterQueue(`${WORKER_NAME}:markets`);

let isFirstPoll = true;
/** Unix seconds — watermark for warm poll min_updated_ts */
let lastPollTs = null;

let cachedProviderId = null;

function validateEnv() {
  if (!process.env.SUPABASE_URL?.trim()) {
    throw new Error(`[${WORKER_NAME}] SUPABASE_URL is required`);
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    throw new Error(`[${WORKER_NAME}] SUPABASE_SERVICE_ROLE_KEY is required`);
  }
  loadKalshiCredentials();
}

function getSeriesTickers() {
  const fromEnv = process.env.KALSHI_SERIES_TICKERS?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromEnv?.length) {
    return fromEnv;
  }
  return KALSHI.seriesTickers ?? [];
}

function filterByConfiguredSeries(markets, seriesTickers) {
  if (!seriesTickers.length) {
    return markets;
  }
  const allowed = new Set(seriesTickers);
  return markets.filter((m) => allowed.has(m.series_ticker));
}

function mapMarketStatus(status) {
  if (status === 'open' || status === 'active') return 'open';
  if (status === 'closed') return 'closed';
  if (status === 'settled' || status === 'finalized') return 'settled';
  return status ?? 'inactive';
}

function mapEventStatus(markets) {
  if (markets.some((m) => m.status === 'open' || m.status === 'active')) {
    return 'active';
  }
  if (markets.every((m) => m.status === 'settled' || m.status === 'finalized')) {
    return 'settled';
  }
  if (markets.every((m) => m.status === 'closed')) {
    return 'closed';
  }
  return 'inactive';
}

function resolveIngestionTier(existingTier) {
  if (existingTier === 'hot') return 'hot';
  return 'warm';
}

function groupMarketsByEvent(markets) {
  const grouped = new Map();
  for (const market of markets) {
    const eventTicker = market.event_ticker;
    if (!eventTicker) continue;
    if (!grouped.has(eventTicker)) {
      grouped.set(eventTicker, []);
    }
    grouped.get(eventTicker).push(market);
  }
  return grouped;
}

function mapEventRow(eventTicker, markets, providerId) {
  const primary = markets[0];
  const closeTimes = markets
    .map((m) => m.close_time)
    .filter(Boolean)
    .map((t) => new Date(t).getTime());
  const maxClose = closeTimes.length ? new Date(Math.max(...closeTimes)).toISOString() : null;

  return {
    provider_id: providerId,
    external_id: eventTicker,
    title: primary.title ?? eventTicker,
    slug: eventTicker,
    category: primary.series_ticker ?? null,
    close_time: maxClose,
    image_url: null,
    status: mapEventStatus(markets),
    raw: {
      event_ticker: eventTicker,
      series_ticker: primary.series_ticker,
      market_tickers: markets.map((m) => m.ticker),
    },
    updated_at: new Date().toISOString(),
  };
}

function mapMarketRow(market, eventId, providerId, ingestionTier) {
  return {
    event_id: eventId,
    provider_id: providerId,
    external_id: market.ticker,
    title: market.subtitle ?? market.title ?? null,
    outcome_label: market.yes_sub_title ?? market.no_sub_title ?? null,
    status: mapMarketStatus(market.status),
    close_time: market.close_time ?? null,
    token_ids: null,
    series_ticker: market.series_ticker ?? null,
    event_ticker: market.event_ticker ?? null,
    ingestion_tier: ingestionTier,
  };
}

async function getProviderId() {
  if (cachedProviderId) {
    return cachedProviderId;
  }

  const { data, error } = await supabase
    .from('providers')
    .select('id')
    .eq('slug', KALSHI.slug)
    .maybeSingle();

  if (error) {
    throw new Error(`[${WORKER_NAME}] provider lookup: ${error.message}`);
  }
  if (!data) {
    throw new Error(`[${WORKER_NAME}] provider "${KALSHI.slug}" not found — run seed.sql`);
  }

  cachedProviderId = data.id;
  return cachedProviderId;
}

async function fetchMarketsCold(seriesTickers) {
  console.log('fetching markets cold', seriesTickers, Date.now());
  if (seriesTickers.length === 0) {
    return fetchMarketsPaginated({ status: 'open' });
  }

  const all = [];
  for (const seriesTicker of seriesTickers) {
    const batch = await fetchMarketsPaginated({
      series_ticker: seriesTicker,
      status: 'open',
    });
    all.push(...batch);
  }
  return all;
}

/**
 * Warm poll — min_updated_ts ONLY (P2-5). Series filter applied in app code.
 */
async function fetchUpdatedMarkets(minUpdatedTs) {
  return fetchMarketsPaginated({ min_updated_ts: minUpdatedTs });
}

async function loadExistingMarketTiers(providerId, externalIds) {
  if (externalIds.length === 0) {
    return new Map();
  }

  const tiers = new Map();
  const chunkSize = 200;

  for (let i = 0; i < externalIds.length; i += chunkSize) {
    const chunk = externalIds.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('markets')
      .select('external_id, ingestion_tier')
      .eq('provider_id', providerId)
      .in('external_id', chunk);

    if (error) {
      console.error(`[${WORKER_NAME}] loadExistingMarketTiers: ${error.message}`);
      continue;
    }

    for (const row of data ?? []) {
      tiers.set(row.external_id, row.ingestion_tier);
    }
  }

  return tiers;
}

async function upsertWithDeadLetter(table, rows, onConflict, deadLetter) {
  if (rows.length === 0) {
    return 0;
  }

  const { written, failed } = await upsertBatched(supabase, table, rows, { onConflict });
  if (failed.length > 0) {
    deadLetter.enqueue(failed);
  }
  return written;
}

async function retryDeadLetters() {
  let written = 0;

  const pendingEvents = eventsDeadLetter.drain();
  if (pendingEvents.length > 0) {
    written += await upsertWithDeadLetter(
      'events',
      pendingEvents,
      'provider_id,external_id',
      eventsDeadLetter
    );
  }

  const pendingMarkets = marketsDeadLetter.drain();
  if (pendingMarkets.length > 0) {
    written += await upsertWithDeadLetter(
      'markets',
      pendingMarkets,
      'provider_id,external_id',
      marketsDeadLetter
    );
  }

  if (pendingEvents.length > 0 || pendingMarkets.length > 0) {
    console.log(
      `[${WORKER_NAME}] dead-letter retry: events=${pendingEvents.length} markets=${pendingMarkets.length} written=${written}`
    );
  }

  return written;
}

async function persistPollWatermark(providerId, marketRows, pollStartedAtSec) {
  if (marketRows.length === 0) {
    return;
  }

  const { data: dbMarkets, error } = await supabase
    .from('markets')
    .select('id, external_id')
    .eq('provider_id', providerId)
    .in(
      'external_id',
      marketRows.map((m) => m.external_id)
    );

  if (error) {
    console.error(`[${WORKER_NAME}] persistPollWatermark lookup: ${error.message}`);
    return;
  }

  const pollIso = new Date(pollStartedAtSec * 1000).toISOString();
  const stateRows = (dbMarkets ?? []).map((m) => ({
    market_id: m.id,
    tier: marketRows.find((r) => r.external_id === m.external_id)?.ingestion_tier ?? 'warm',
    last_poll_ts: pollIso,
  }));

  const { error: upsertError } = await supabase
    .from('market_ingestion_state')
    .upsert(stateRows, { onConflict: 'market_id' });

  if (upsertError) {
    console.error(`[${WORKER_NAME}] persistPollWatermark: ${upsertError.message}`);
  }
}

async function poll() {
  console.log('poll executed', Date.now());
  const providerId = await getProviderId();
  const seriesTickers = getSeriesTickers();
  console.log('seriesTickers', seriesTickers, Date.now());
  const pollStartedAtSec = Math.floor(Date.now() / 1000);
  let rowsWritten = 0;

  rowsWritten += await retryDeadLetters();

  const pollMode = isFirstPoll ? 'cold' : 'warm';
  let markets;

  if (isFirstPoll) {
    console.log('fetching markets cold', Date.now());
    markets = await fetchMarketsCold(seriesTickers);
  } else {
    if (lastPollTs == null) {
      throw new Error(`[${WORKER_NAME}] warm poll requires lastPollTs`);
    }
    markets = await fetchUpdatedMarkets(lastPollTs);
    console.log('markets fetched', markets.length, Date.now());
    markets = filterByConfiguredSeries(markets, seriesTickers);
    console.log('markets filtered', markets.length, Date.now());
  }

  const grouped = groupMarketsByEvent(markets);
  const eventRows = [];
  for (const [eventTicker, eventMarkets] of grouped) {
    eventRows.push(mapEventRow(eventTicker, eventMarkets, providerId));
  }

  rowsWritten += await upsertWithDeadLetter(
    'events',
    eventRows,
    'provider_id,external_id',
    eventsDeadLetter
  );

  const eventExternalIds = eventRows.map((e) => e.external_id);
  const { data: dbEvents, error: eventsError } = await supabase
    .from('events')
    .select('id, external_id')
    .eq('provider_id', providerId)
    .in('external_id', eventExternalIds);

  if (eventsError) {
    throw new Error(`[${WORKER_NAME}] events id lookup: ${eventsError.message}`);
  }

  const eventIdByExternal = new Map((dbEvents ?? []).map((e) => [e.external_id, e.id]));
  const marketExternalIds = markets.map((m) => m.ticker);
  const tierByExternal = await loadExistingMarketTiers(providerId, marketExternalIds);

  const marketRows = [];
  for (const market of markets) {
    const eventId = eventIdByExternal.get(market.event_ticker);
    if (!eventId) {
      continue;
    }
    marketRows.push(
      mapMarketRow(
        market,
        eventId,
        providerId,
        resolveIngestionTier(tierByExternal.get(market.ticker))
      )
    );
  }

  rowsWritten += await upsertWithDeadLetter(
    'markets',
    marketRows,
    'provider_id,external_id',
    marketsDeadLetter
  );

  await persistPollWatermark(providerId, marketRows, pollStartedAtSec);

  lastPollTs = pollStartedAtSec;
  isFirstPoll = false;

  console.log(
    `[${WORKER_NAME}] cycle: mode=${pollMode} series=${seriesTickers.length || 'all'} events=${eventRows.length} markets=${marketRows.length} written=${rowsWritten} lastPollTs=${lastPollTs}`
  );

  return rowsWritten;
}

function start() {
  validateEnv();

  const { start: startInterval } = createGuardedInterval(
    WORKER_NAME,
    poll,
    KALSHI_EVENTS_POLL_MS
  );

  console.log(
    `[${WORKER_NAME}] starting — poll every ${KALSHI_EVENTS_POLL_MS / 60_000}m (cold then warm)`
  );
  return startInterval();
}

if (require.main === module) {
  start();
}

module.exports = {
  start,
  poll,
  getSeriesTickers,
  filterByConfiguredSeries,
  mapMarketStatus,
  mapEventStatus,
  mapEventRow,
  mapMarketRow,
  groupMarketsByEvent,
  resolveIngestionTier,
  getLastPollTs: () => lastPollTs,
  getIsFirstPoll: () => isFirstPoll,
  _resetPollState: () => {
    isFirstPoll = true;
    lastPollTs = null;
  },
};
