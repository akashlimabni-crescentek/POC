'use strict';

/**
 * Shared environment validation for workers and startup scripts.
 * Fail fast with actionable messages (P1-10: no leading/trailing whitespace).
 */

function readEnv(name) {
  const raw = process.env[name];
  if (raw == null) {
    return '';
  }
  return raw.trim();
}

function assertNonEmpty(name, value) {
  if (!value) {
    throw new Error(`[validate-env] ${name} is required`);
  }
}

function assertEnvTrimmed(name) {
  const raw = process.env[name];
  if (raw == null) {
    return;
  }
  if (raw !== raw.trim()) {
    throw new Error(
      `[validate-env] ${name} has leading/trailing whitespace — remove spaces around the value`
    );
  }
}

function assertSupabaseUrl(name, value) {
  assertNonEmpty(name, value);
  if (value.includes('/rest/v1')) {
    throw new Error(
      `[validate-env] ${name} must be the project root (https://<ref>.supabase.co), not .../rest/v1/`
    );
  }
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(value)) {
    throw new Error(
      `[validate-env] ${name} must look like https://<project-ref>.supabase.co`
    );
  }
}

/**
 * Validate backend worker env (service role).
 * @param {{ requireKalshi?: boolean }} [options]
 */
function validateBackendEnv(options = {}) {
  const requireKalshi = options.requireKalshi ?? false;

  assertEnvTrimmed('SUPABASE_URL');
  assertEnvTrimmed('SUPABASE_SERVICE_ROLE_KEY');

  assertSupabaseUrl('SUPABASE_URL', readEnv('SUPABASE_URL'));
  assertNonEmpty('SUPABASE_SERVICE_ROLE_KEY', readEnv('SUPABASE_SERVICE_ROLE_KEY'));

  if (requireKalshi) {
    assertEnvTrimmed('KALSHI_API_KEY_ID');
    assertNonEmpty('KALSHI_API_KEY_ID', readEnv('KALSHI_API_KEY_ID'));
    const b64 = readEnv('KALSHI_PRIVATE_KEY_B64');
    const pem = readEnv('KALSHI_PRIVATE_KEY_PEM');
    if (!b64 && !pem) {
      throw new Error(
        '[validate-env] KALSHI_PRIVATE_KEY_B64 or KALSHI_PRIVATE_KEY_PEM is required for Kalshi workers'
      );
    }
  }

  return true;
}

/** Validate frontend env (anon key only — never service role). */
function validateFrontendEnv(options = {}) {
  const vars = options.vars ?? process.env;

  function read(name) {
    const raw = vars[name];
    if (raw == null) {
      return '';
    }
    return String(raw).trim();
  }

  function assertTrimmed(name) {
    const raw = vars[name];
    if (raw == null) {
      return;
    }
    if (raw !== String(raw).trim()) {
      throw new Error(
        `[validate-env] ${name} has leading/trailing whitespace — remove spaces around the value`
      );
    }
  }

  assertTrimmed('NEXT_PUBLIC_SUPABASE_URL');
  assertTrimmed('NEXT_PUBLIC_SUPABASE_ANON_KEY');

  assertSupabaseUrl('NEXT_PUBLIC_SUPABASE_URL', read('NEXT_PUBLIC_SUPABASE_URL'));
  assertNonEmpty('NEXT_PUBLIC_SUPABASE_ANON_KEY', read('NEXT_PUBLIC_SUPABASE_ANON_KEY'));

  if (options.frontendEnvFileContent) {
    if (/^\s*SUPABASE_SERVICE_ROLE_KEY\s*=/m.test(options.frontendEnvFileContent)) {
      throw new Error(
        '[validate-env] SUPABASE_SERVICE_ROLE_KEY must not be set in frontend/.env.local'
      );
    }
  } else if (read('SUPABASE_SERVICE_ROLE_KEY')) {
    throw new Error(
      '[validate-env] SUPABASE_SERVICE_ROLE_KEY must not be set in the frontend environment'
    );
  }

  return true;
}

module.exports = {
  readEnv,
  assertNonEmpty,
  assertEnvTrimmed,
  assertSupabaseUrl,
  validateBackendEnv,
  validateFrontendEnv,
};
