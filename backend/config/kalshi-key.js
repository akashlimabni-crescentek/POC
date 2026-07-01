'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

/**
 * Load Kalshi API credentials from env only — never from tracked PEM files.
 */
function loadKalshiCredentials() {
  const apiKeyId = process.env.KALSHI_API_KEY_ID?.trim();
  if (!apiKeyId) {
    throw new Error('[config/kalshi-key] KALSHI_API_KEY_ID is required');
  }

  const b64 = process.env.KALSHI_PRIVATE_KEY_B64?.trim();
  const pem = process.env.KALSHI_PRIVATE_KEY_PEM?.trim();

  let privateKeyPem;
  if (b64) {
    privateKeyPem = Buffer.from(b64, 'base64').toString('utf8');
  } else if (pem) {
    privateKeyPem = pem.replace(/\\n/g, '\n');
  } else {
    throw new Error(
      '[config/kalshi-key] KALSHI_PRIVATE_KEY_B64 or KALSHI_PRIVATE_KEY_PEM is required'
    );
  }

  if (!privateKeyPem.includes('BEGIN')) {
    throw new Error('[config/kalshi-key] private key does not look like PEM format');
  }

  return { apiKeyId, privateKeyPem };
}

module.exports = { loadKalshiCredentials };
