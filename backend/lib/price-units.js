'use strict';

/**
 * All DB price columns store probability 0–1.
 * Polymarket: native 0–1. Kalshi: cents 0–100 (or dollars) → normalize on write.
 */

/** Kalshi cents (0–100) → probability 0–1 */
function kalshiCentsToProb(cents) {
  if (cents == null || Number.isNaN(Number(cents))) return null;
  return Number(cents) / 100;
}

/** Kalshi dollars (0–1) when API returns dollar fields */
function kalshiDollarsToProb(dollars) {
  if (dollars == null || Number.isNaN(Number(dollars))) return null;
  const n = Number(dollars);
  if (n > 1) return n / 100;
  return n;
}

/**
 * Normalize a raw price to 0–1 probability at provider boundary.
 * @param {'polymarket'|'kalshi'} provider
 * @param {number} raw
 * @param {{ unit?: 'cents'|'dollars'|'prob' }} [opts]
 */
function normalizePrice(provider, raw, opts = {}) {
  if (raw == null || Number.isNaN(Number(raw))) return null;
  const n = Number(raw);

  if (provider === 'polymarket') {
    return n;
  }

  if (provider === 'kalshi') {
    const unit = opts.unit ?? (n > 1 ? 'cents' : 'prob');
    if (unit === 'cents') return kalshiCentsToProb(n);
    if (unit === 'dollars') return kalshiDollarsToProb(n);
    return n;
  }

  throw new Error(`[price-units] unknown provider: ${provider}`);
}

module.exports = {
  kalshiCentsToProb,
  kalshiDollarsToProb,
  normalizePrice,
};
