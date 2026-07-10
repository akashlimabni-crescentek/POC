'use strict';

const HOT_TIER = 'hot';
const WARM_TIER = 'warm';
const COLD_TIER = 'cold';

const ACTIVE_STATUSES = ['active', 'open'];
const CLOSED_STATUSES = ['closed', 'settled', 'resolved', 'inactive', 'finalized'];

/**
 * Ingestion tier model:
 * - cold:  default / closed markets — no WebSocket, no history backfill
 * - warm:  metadata synced from events workers
 * - hot:   user opened event (RPC promote_event_to_hot) — live-ws + history only
 *
 * Promotion path: frontend calls Supabase RPC `promote_event_to_hot(p_event_id)`.
 * There is NO backend REST API for tier promotion.
 */

/**
 * Hot markets for a provider — used by live-ws and history workers.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {'polymarket'|'kalshi'} providerSlug
 */
async function getHotMarkets(supabase, providerSlug) {
  const { data: provider, error: providerError } = await supabase
    .from('providers')
    .select('id')
    .eq('slug', providerSlug)
    .maybeSingle();

  if (providerError) {
    console.error(`[tiers] getHotMarkets provider lookup ${providerSlug}: ${providerError.message}`);
    return [];
  }

  if (!provider) {
    return [];
  }

  const { data, error } = await supabase
    .from('markets')
    .select(
      'id, external_id, token_ids, condition_id, series_ticker, event_ticker, event_id, provider_id, ingestion_tier, status'
    )
    .eq('provider_id', provider.id)
    .eq('ingestion_tier', HOT_TIER)
    .in('status', ACTIVE_STATUSES);

  if (error) {
    console.error(`[tiers] getHotMarkets ${providerSlug}: ${error.message}`);
    return [];
  }

  return data ?? [];
}

/**
 * All hot active markets across providers (admin/debug).
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function getAllHotMarkets(supabase) {
  const { data, error } = await supabase
    .from('markets')
    .select(
      'id, external_id, token_ids, series_ticker, event_ticker, event_id, provider_id, ingestion_tier, status, providers!inner(slug)'
    )
    .eq('ingestion_tier', HOT_TIER)
    .in('status', ACTIVE_STATUSES);

  if (error) {
    console.error(`[tiers] getAllHotMarkets: ${error.message}`);
    return [];
  }

  return data ?? [];
}

/**
 * Count hot markets (optionally per provider slug).
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} [providerSlug]
 */
async function getHotMarketCount(supabase, providerSlug) {
  if (providerSlug) {
    const markets = await getHotMarkets(supabase, providerSlug);
    return markets.length;
  }

  const { count, error } = await supabase
    .from('markets')
    .select('id', { count: 'exact', head: true })
    .eq('ingestion_tier', HOT_TIER)
    .in('status', ACTIVE_STATUSES);

  if (error) {
    console.error(`[tiers] getHotMarketCount: ${error.message}`);
    return 0;
  }

  return count ?? 0;
}

/**
 * Demote closed/settled markets to cold. Called from maintenance worker.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
async function demoteStale(supabase) {
  const { data, error } = await supabase
    .from('markets')
    .update({ ingestion_tier: COLD_TIER })
    .in('status', CLOSED_STATUSES)
    .neq('ingestion_tier', COLD_TIER)
    .select('id');

  if (error) {
    console.error(`[tiers] demoteStale: ${error.message}`);
    return 0;
  }

  const demotedIds = (data ?? []).map((m) => m.id);
  if (demotedIds.length === 0) {
    return 0;
  }

  const { error: stateError } = await supabase
    .from('market_ingestion_state')
    .update({ tier: COLD_TIER })
    .in('market_id', demotedIds);

  if (stateError) {
    console.error(`[tiers] demoteStale ingestion_state: ${stateError.message}`);
  }

  console.log(`[tiers] demoteStale: demoted ${demotedIds.length} markets to cold`);
  return demotedIds.length;
}

function isActiveMarketStatus(status) {
  return ACTIVE_STATUSES.includes(status);
}

function shouldReceiveLiveIngestion(market) {
  return market?.ingestion_tier === HOT_TIER && isActiveMarketStatus(market?.status);
}

module.exports = {
  HOT_TIER,
  WARM_TIER,
  COLD_TIER,
  ACTIVE_STATUSES,
  CLOSED_STATUSES,
  getHotMarkets,
  getAllHotMarkets,
  getHotMarketCount,
  demoteStale,
  isActiveMarketStatus,
  shouldReceiveLiveIngestion,
};
