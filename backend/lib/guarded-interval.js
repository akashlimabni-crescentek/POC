'use strict';

const { reportCycle, reportError } = require('./heartbeat');

/**
 * Overlap guard for every setInterval job — skips if previous run still in progress.
 */
function createGuardedInterval(name, fn, intervalMs) {
  let running = false;

  const guarded = async () => {
    if (running) {
      console.warn(`[${name}] previous run still in progress — skipping`);
      return;
    }

    running = true;
    const t0 = Date.now();

    try {
      const rows = await fn();
      await reportCycle(name, rows ?? null);
    } catch (err) {
      console.error(`[${name}] failed:`, err.message);
      await reportError(name, err);
    } finally {
      running = false;
      console.log(`[${name}] cycle done in ${Date.now() - t0}ms`);
    }
  };

  return {
    guarded,
    start() {
      guarded();
      return setInterval(guarded, intervalMs);
    },
  };
}

module.exports = { createGuardedInterval };
