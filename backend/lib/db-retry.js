'use strict';

const { DB_RETRY_BACKOFF_MS } = require('../config/intervals');
const { sleep } = require('./http-client');

/**
 * Insert rows with bounded retry. Never throws — logs dropped rows.
 * @returns {{ inserted: number, dropped: number }}
 */
async function insertWithRetry(supabase, table, rows, options = {}) {
  if (!rows || rows.length === 0) {
    return { inserted: 0, dropped: 0 };
  }

  const maxAttempts = options.maxAttempts ?? 3;
  let pending = rows;
  let inserted = 0;

  for (let attempt = 0; attempt < maxAttempts && pending.length > 0; attempt++) {
    if (attempt > 0) {
      const backoff = DB_RETRY_BACKOFF_MS[Math.min(attempt - 1, DB_RETRY_BACKOFF_MS.length - 1)];
      await sleep(backoff);
    }

    const { error } = await supabase.from(table).insert(pending);
    if (!error) {
      inserted += pending.length;
      pending = [];
      break;
    }

    if (attempt === maxAttempts - 1) {
      console.error(
        `[db-retry] ${table} insert failed after ${maxAttempts} attempts: ${error.message}`
      );
    }
  }

  const dropped = pending.length;
  if (dropped > 0) {
    console.error(`[db-retry] ${table} dropped ${dropped} rows`);
  }

  return { inserted, dropped };
}

module.exports = { insertWithRetry };
