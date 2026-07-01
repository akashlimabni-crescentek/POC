'use strict';

const { supabase } = require('../config/supabase');

/**
 * Fire-and-forget worker health upsert. Never throws.
 */
async function reportCycle(worker, rows = null) {
  try {
    const { error } = await supabase.from('worker_health').upsert(
      {
        worker,
        last_cycle_at: new Date().toISOString(),
        last_cycle_rows: rows,
        last_error: null,
        last_error_at: null,
      },
      { onConflict: 'worker' }
    );
    if (error) {
      console.error(`[heartbeat] reportCycle ${worker}: ${error.message}`);
    }
  } catch (err) {
    console.error(`[heartbeat] reportCycle ${worker}: ${err.message}`);
  }
}

async function reportError(worker, err) {
  try {
    const message = err?.message ?? String(err);
    const { error } = await supabase.from('worker_health').upsert(
      {
        worker,
        last_cycle_at: new Date().toISOString(),
        last_error: message,
        last_error_at: new Date().toISOString(),
      },
      { onConflict: 'worker' }
    );
    if (error) {
      console.error(`[heartbeat] reportError ${worker}: ${error.message}`);
    }
  } catch (e) {
    console.error(`[heartbeat] reportError ${worker}: ${e.message}`);
  }
}

module.exports = { reportCycle, reportError };
