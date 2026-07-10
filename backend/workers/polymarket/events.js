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

function parseEventTickersFromEnv() {
  return (
    process.env.POLYMARKET_EVENT_TICKERS?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? []
  );
}

function eventMatchesRef(event, ref) {
  return (
    String(event.slug) === ref ||
    String(event.id) === ref ||
    String(event.ticker) === ref
  );
}

async function fetchEventByRef(ref) {
  const attempts = [{ slug: ref }];
  if (/^\d+$/.test(ref)) {
    attempts.push({ id: ref });
  }

  for (const params of attempts) {
    const url = new URL(`${POLYMARKET.gammaApiBase}/events`);
    url.searchParams.set('active', 'true');
    url.searchParams.set('closed', 'false');
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const response = await fetchWithRetry(url.toString());
    if (!response.ok) {
      throw new Error(`[${WORKER_NAME}] Gamma /events ${response.status} (${ref})`);
    }

    const data = await response.json();
    const page = Array.isArray(data) ? data : data ? [data] : [];
    const match = page.find((event) => eventMatchesRef(event, ref));
    if (match) {
      return match;
    }
  }

  return null;
}

async function fetchConfiguredEvents(eventRefs) {
  const events = [];
  const seen = new Set();

  for (const ref of eventRefs) {
    const event = await fetchEventByRef(ref);
    if (!event) {
      console.warn(`[${WORKER_NAME}] event not found: ${ref}`);
      continue;
    }

    const key = String(event.id);
    if (!seen.has(key)) {
      seen.add(key);
      events.push(event);
    }
  }

  return events;
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

function parseConditionId(market) {
  const raw = market.conditionId ?? market.condition_id;
  return raw != null ? String(raw) : null;
}

function eventCategory(event) {
  const raw = event.category ?? event.tags?.[0];
  if (raw == null) return null;
  if (typeof raw === 'object') {
    const label = raw.label ?? raw.slug;
    return label != null ? String(label) : null;
  }
  return String(raw);
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
    category: eventCategory(event),
    close_time: event.endDate ?? event.end_date_iso ?? null,
    image_url: event.image ?? event.icon ?? null,
    status: mapEventStatus(event),
    raw: event,
    updated_at: event.updatedAt ?? new Date().toISOString(),
  };
}

function mapMarketRow(market, eventId, providerId, existingTier) {
  return {
    event_id: eventId,
    provider_id: providerId,
    external_id: String(market.id),
    title: market.question ?? market.groupItemTitle ?? null,
    outcome_label: Array.isArray(market.outcomes) ? market.outcomes.join(' / ') : null,
    status: mapMarketStatus(market),
    close_time: market.endDate ?? market.end_date_iso ?? null,
    token_ids: parseTokenIds(market),
    condition_id: parseConditionId(market),
    ingestion_tier: resolveIngestionTier(existingTier),
  };
}

function resolveIngestionTier(existingTier) {
  if (existingTier === 'hot') return 'hot';
  return 'warm';
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

async function syncEventsPage(providerId, events) {
  if (!events.length) {
    return 0;
  }

  let rowsWritten = 0;

  const eventRows = events.map((event) => mapEventRow(event, providerId));
  rowsWritten += await upsertWithDeadLetter(
    'events',
    eventRows,
    'provider_id,external_id',
    eventsDeadLetter
  );

  const eventExternalIds = eventRows.map((row) => row.external_id);
  const { data: dbEvents, error: eventsError } = await supabase
    .from('events')
    .select('id, external_id')
    .eq('provider_id', providerId)
    .in('external_id', eventExternalIds);

  if (eventsError) {
    throw new Error(`[${WORKER_NAME}] events id lookup: ${eventsError.message}`);
  }

  const eventIdByExternal = new Map((dbEvents ?? []).map((row) => [row.external_id, row.id]));

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

  const marketRows = marketCandidates.map(({ market, eventId }) =>
    mapMarketRow(market, eventId, providerId, tierByExternal.get(String(market.id)))
  );

  rowsWritten += await upsertWithDeadLetter(
    'markets',
    marketRows,
    'provider_id,external_id',
    marketsDeadLetter
  );

  return rowsWritten;
}

/**
 * Gamma offset pagination is capped at ~2000. Use /events/keyset with after_cursor.
 */
async function fetchAndSyncActiveEvents(providerId, eventRefs = parseEventTickersFromEnv()) {
  if (eventRefs.length > 0) {
    const events = await fetchConfiguredEvents(eventRefs);
    updateWatermark(events);
    const totalWritten = await syncEventsPage(providerId, events);
    return { totalEvents: events.length, totalWritten };
  }

  let afterCursor = null;
  let totalEvents = 0;
  let totalWritten = 0;
  const limit = POLYMARKET.eventsPageSize;

  while (true) {
    const url = new URL(`${POLYMARKET.gammaApiBase}/events/keyset`);
    url.searchParams.set('active', 'true');
    url.searchParams.set('closed', 'false');
    url.searchParams.set('limit', String(limit));
    if (afterCursor) {
      url.searchParams.set('after_cursor', afterCursor);
    }

    const response = await fetchWithRetry(url.toString());
    if (!response.ok) {
      throw new Error(`[${WORKER_NAME}] Gamma /events/keyset ${response.status}`);
    }

    const body = await response.json();
    const page = Array.isArray(body?.events) ? body.events : [];
    if (page.length === 0) {
      break;
    }

    updateWatermark(page);
    totalWritten += await syncEventsPage(providerId, page);
    totalEvents += page.length;

    afterCursor = body.next_cursor ?? null;
    if (!afterCursor) {
      break;
    }
  }

  return { totalEvents, totalWritten };
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
  const eventRefs = parseEventTickersFromEnv();
  let rowsWritten = 0;

  rowsWritten += await retryDeadLetters(providerId);

  const { totalEvents, totalWritten } = await fetchAndSyncActiveEvents(providerId, eventRefs);
  rowsWritten += totalWritten;

  console.log(
    `[${WORKER_NAME}] cycle: events=${totalEvents} written=${rowsWritten} lastSeenTs=${lastSeenTs ?? 'n/a'}${eventRefs.length ? ` filtered=${eventRefs.join(',')}` : ''}`
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

  const eventRefs = parseEventTickersFromEnv();
  console.log(
    `[${WORKER_NAME}] starting — poll every ${POLYMARKET_EVENTS_POLL_MS / 1000}s${eventRefs.length ? ` (filtered: ${eventRefs.join(', ')})` : ' (all active events)'}`
  );
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
