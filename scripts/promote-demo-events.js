#!/usr/bin/env node
'use strict';

/**
 * Promote the first N events per provider to hot so live-ws + history workers ingest data.
 * Usage: node scripts/promote-demo-events.js [--limit=15] [--provider=kalshi|polymarket|all]
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });

const { createClient } = require('@supabase/supabase-js');

const limit = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 15);
const providerArg =
  process.argv.find((a) => a.startsWith('--provider='))?.split('=')[1] ?? 'all';

async function main() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required in backend/.env');
  }

  const supabase = createClient(url, key);

  let query = supabase.from('providers').select('id, slug');
  if (providerArg !== 'all') {
    query = query.eq('slug', providerArg);
  }

  const { data: providers, error } = await query;
  if (error) {
    throw error;
  }

  for (const provider of providers ?? []) {
    const { data: events, error: eventsError } = await supabase
      .from('events')
      .select('id, title')
      .eq('provider_id', provider.id)
      .order('id', { ascending: true })
      .limit(limit);

    if (eventsError) {
      throw eventsError;
    }

    let promoted = 0;
    for (const event of events ?? []) {
      const { error: rpcError } = await supabase.rpc('promote_event_to_hot', {
        p_event_id: event.id,
      });
      if (rpcError) {
        console.error(`[promote-demo] ${provider.slug} event ${event.id}: ${rpcError.message}`);
        continue;
      }
      promoted += 1;
      console.log(`[promote-demo] ${provider.slug} event ${event.id}: ${event.title?.slice(0, 60)}`);
    }

    console.log(`[promote-demo] ${provider.slug}: promoted ${promoted}/${events?.length ?? 0} events`);
  }
}

main().catch((err) => {
  console.error('[promote-demo] failed:', err.message);
  process.exit(1);
});
