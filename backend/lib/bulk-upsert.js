'use strict';

/**
 * Chunked upsert with explicit onConflict. Failed batches returned for dead-letter retry.
 */
async function upsertBatched(supabase, table, rows, options = {}) {
  const { onConflict, batchSize = 200 } = options;

  if (!onConflict) {
    throw new Error(`[bulk-upsert] onConflict is required for table ${table}`);
  }

  if (!rows || rows.length === 0) {
    return { written: 0, failed: [] };
  }

  let written = 0;
  const failed = [];

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase.from(table).upsert(batch, {
      onConflict,
      ignoreDuplicates: false,
    });

    if (error) {
      failed.push(...batch);
      console.error(`[bulk-upsert] ${table} batch failed: ${error.message}`);
    } else {
      written += batch.length;
    }
  }

  return { written, failed };
}

module.exports = { upsertBatched };
