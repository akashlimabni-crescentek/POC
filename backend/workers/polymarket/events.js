'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { supabase } = require('../../config/supabase');
const { POLYMARKET } = require('../../config/providers');
const { POLYMARKET_EVENTS_POLL_MS } = require('../../config/intervals');
const { fetchWithRetry } = require('../../lib/http-client');
const { upsertBatched } = require('../../lib/bulk-upsert');
const { DeadLetterQueue } = require('../../lib/dead-letter');
const { createGuardedInterval } = require('../../lib/guarded-interval');

const WORKER_NAME = 'polymarket/events';

const eventsDeadLetter = new DeadLetterQueue(`${WORKER_NAME}:events`);
const marketsDeadLetter = new DeadLetterQueue(`${WORKER_NAME}:markets`);

/** Max updatedAt seen — for future incremental polling */
let lastSeenTs = null;

let cachedProviderId = null;

function validateEnv() {
  if (!process.env.SUPABASE_URL?.trim()) {
    throw new Error(`[${WORKER_NAME}] SUPABASE_URL is required`);
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    throw new Error(`[${WORKER_NAME}] SUPABASE_SERVICE_ROLE_KEY is required`);
  }
}

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

function parseTokenIds(market) {
  const raw = market.clobTokenIds ?? market.clob_token_ids;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return raw ? [raw] : [];
    }
  }
  return [];
}

function mapEventStatus(event) {
  if (event.closed) return 'closed';
  if (event.active) return 'active';
  return 'inactive';
}

function mapMarketStatus(market) {
  if (market.closed) return 'closed';
  if (market.active) return 'open';
  return 'inactive';
}

function mapEventRow(event, providerId) {
  return {
    provider_id: providerId,
    external_id: String(event.id),
    title: event.title ?? null,
    slug: event.slug ?? null,
    category: event.category ?? event.tags?.[0] ?? null,
    close_time: event.endDate ?? event.end_date_iso ?? null,
    image_url: event.image ?? event.icon ?? null,
    status: mapEventStatus(event),
    raw: event,
    updated_at: event.updatedAt ?? new Date().toISOString(),
  };
}

function resolveIngestionTier(existingTier) {
  if (existingTier === 'hot') return 'hot';
  return 'warm';
}

async function fetchActiveEvents() {
  const all = [];
  let offset = 0;
  const limit = POLYMARKET.eventsPageSize;

  while (true) {
    const url = new URL(`${POLYMARKET.gammaApiBase}/events`);
    url.searchParams.set('active', 'true');
    url.searchParams.set('closed', 'false');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));

    const response = await fetchWithRetry(url.toString());
    if (!response.ok) {
      throw new Error(`[${WORKER_NAME}] Gamma /events ${response.status}`);
    }

    const page = await response.json();
    if (!Array.isArray(page) || page.length === 0) {
      break;
    }

    all.push(...page);
    if (page.length < limit) {
      break;
    }
    offset += limit;
  }

  return all;
}

function updateWatermark(events) {
  for (const event of events) {
    const ts = event.updatedAt ? new Date(event.updatedAt).getTime() : 0;
    if (ts && (lastSeenTs === null || ts > lastSeenTs)) {
      lastSeenTs = ts;
    }
  }
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

async function retryDeadLetters(providerId) {
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
    // Re-resolve event_id if missing (rows from dead letter should already have event_id)
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

async function poll() {
  const providerId = await getProviderId();
  let rowsWritten = 0;

  rowsWritten += await retryDeadLetters(providerId);

  const events = await fetchActiveEvents();
  updateWatermark(events);

  const eventRows = events.map((e) => mapEventRow(e, providerId));
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

  const marketCandidates = [];
  for (const event of events) {
    const eventId = eventIdByExternal.get(String(event.id));
    if (!eventId || !Array.isArray(event.markets)) {
      continue;
    }

    for (const market of event.markets) {
      marketCandidates.push({ market, eventId });
    }
  }

  const marketExternalIds = marketCandidates.map(({ market }) => String(market.id));
  const tierByExternal = await loadExistingMarketTiers(providerId, marketExternalIds);

  const marketRows = marketCandidates.map(({ market, eventId }) => ({
    event_id: eventId,
    provider_id: providerId,
    external_id: String(market.id),
    title: market.question ?? market.groupItemTitle ?? null,
    outcome_label: Array.isArray(market.outcomes) ? market.outcomes.join(' / ') : null,
    status: mapMarketStatus(market),
    close_time: market.endDate ?? market.end_date_iso ?? null,
    token_ids: parseTokenIds(market),
    ingestion_tier: resolveIngestionTier(tierByExternal.get(String(market.id))),
  }));

  rowsWritten += await upsertWithDeadLetter(
    'markets',
    marketRows,
    'provider_id,external_id',
    marketsDeadLetter
  );

  console.log(
    `[${WORKER_NAME}] cycle: events=${events.length} markets=${marketRows.length} written=${rowsWritten} lastSeenTs=${lastSeenTs ?? 'n/a'}`
  );

  return rowsWritten;
}

function start() {
  validateEnv();

  const { start: startInterval } = createGuardedInterval(
    WORKER_NAME,
    poll,
    POLYMARKET_EVENTS_POLL_MS
  );

  console.log(`[${WORKER_NAME}] starting — poll every ${POLYMARKET_EVENTS_POLL_MS / 1000}s`);
  return startInterval();
}

if (require.main === module) {
  start();
}

module.exports = {
  start,
  poll,
  parseTokenIds,
  mapEventRow,
  resolveIngestionTier,
  getLastSeenTs: () => lastSeenTs,
};
