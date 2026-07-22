import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const SIGN_PATH_PREFIX = '/trade-api/v2';

type KalshiCredentials = {
  apiKeyId: string;
  privateKeyPem: string;
};

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }
  const eq = trimmed.indexOf('=');
  if (eq <= 0) {
    return null;
  }
  return [trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim()];
}

/** Load Kalshi credentials from frontend env, with backend/.env fallback for local dev. */
export function loadKalshiCredentials(): KalshiCredentials {
  let apiKeyId = process.env.KALSHI_API_KEY_ID?.trim() ?? '';
  let b64 = process.env.KALSHI_PRIVATE_KEY_B64?.trim() ?? '';
  let pem = process.env.KALSHI_PRIVATE_KEY_PEM?.trim() ?? '';

  if (!apiKeyId || (!b64 && !pem)) {
    const backendEnv = path.join(process.cwd(), '..', 'backend', '.env');
    if (fs.existsSync(backendEnv)) {
      const content = fs.readFileSync(backendEnv, 'utf8');
      for (const line of content.split('\n')) {
        const parsed = parseEnvLine(line);
        if (!parsed) continue;
        const [key, val] = parsed;
        if (key === 'KALSHI_API_KEY_ID' && !apiKeyId) apiKeyId = val;
        if (key === 'KALSHI_PRIVATE_KEY_B64' && !b64) b64 = val;
        if (key === 'KALSHI_PRIVATE_KEY_PEM' && !pem) pem = val;
      }
    }
  }

  if (!apiKeyId) {
    throw new Error('KALSHI_API_KEY_ID is required for Kalshi orderbook API');
  }

  let privateKeyPem: string;
  if (b64) {
    privateKeyPem = Buffer.from(b64, 'base64').toString('utf8');
  } else if (pem) {
    privateKeyPem = pem.replace(/\\n/g, '\n');
  } else {
    throw new Error('KALSHI_PRIVATE_KEY_B64 or KALSHI_PRIVATE_KEY_PEM is required');
  }

  if (!privateKeyPem.includes('BEGIN')) {
    throw new Error('Kalshi private key does not look like PEM format');
  }

  return { apiKeyId, privateKeyPem };
}

/** Build signed Kalshi REST headers (RSA-PSS SHA256, millisecond timestamp). */
export function buildKalshiAuthHeaders(method: string, endpoint: string): Record<string, string> {
  const { apiKeyId, privateKeyPem } = loadKalshiCredentials();
  const timestamp = String(Date.now());
  const pathWithoutQuery = `${SIGN_PATH_PREFIX}${endpoint}`.split('?')[0];
  const message = `${timestamp}${method}${pathWithoutQuery}`;

  const signature = crypto.sign('sha256', Buffer.from(message), {
    key: privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });

  return {
    'KALSHI-ACCESS-KEY': apiKeyId,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
    Accept: 'application/json',
  };
}
