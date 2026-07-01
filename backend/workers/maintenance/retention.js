'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { supabase } = require('../../config/supabase');
const { MAINTENANCE_POLL_MS } = require('../../config/intervals');
const { createGuardedInterval } = require('../../lib/guarded-interval');
const { demoteStale } = require('../../lib/tiers');
const { runRetentionCycle } = require('../../lib/retention');

const WORKER_NAME = 'maintenance/retention';

function validateEnv() {
  if (!process.env.SUPABASE_URL?.trim()) {
    throw new Error(`[${WORKER_NAME}] SUPABASE_URL is required`);
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    throw new Error(`[${WORKER_NAME}] SUPABASE_SERVICE_ROLE_KEY is required`);
  }
}

async function poll() {
  const result = await runRetentionCycle(supabase, demoteStale);

  console.log(
    `[${WORKER_NAME}] cycle: deleted=${result.total} ` +
      `(live_ticks=${result.deleted.live_ticks} ` +
      `1m=${result.deleted.candles_1m} 5m=${result.deleted.candles_5m} ` +
      `1h=${result.deleted.candles_1h} 1d=${result.deleted.candles_1d} ` +
      `closed=${result.deleted.closed_markets}) demoted=${result.demoted}`
  );

  return result.total + result.demoted;
}

function start() {
  validateEnv();

  const { start: startInterval } = createGuardedInterval(
    WORKER_NAME,
    poll,
    MAINTENANCE_POLL_MS
  );

  console.log(
    `[${WORKER_NAME}] starting — poll every ${MAINTENANCE_POLL_MS / 60_000}m ` +
      '(pg_cron primary; this worker is fallback)'
  );
  return startInterval();
}

if (require.main === module) {
  start();
}

module.exports = { start, poll };
