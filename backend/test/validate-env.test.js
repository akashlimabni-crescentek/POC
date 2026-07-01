import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  assertSupabaseUrl,
  assertEnvTrimmed,
  validateBackendEnv,
  validateFrontendEnv,
} = require('../config/validate-env');

describe('validate-env', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('assertSupabaseUrl rejects /rest/v1 suffix', () => {
    expect(() =>
      assertSupabaseUrl('SUPABASE_URL', 'https://abc.supabase.co/rest/v1/')
    ).toThrow(/not.*rest\/v1/i);
  });

  it('assertSupabaseUrl accepts project root URL', () => {
    expect(() =>
      assertSupabaseUrl('SUPABASE_URL', 'https://abc.supabase.co')
    ).not.toThrow();
  });

  it('assertNonEmpty rejects whitespace-padded values via assertEnvTrimmed', () => {
    process.env.TEST_VAR = ' value ';
    expect(() => assertEnvTrimmed('TEST_VAR')).toThrow(/whitespace/i);
  });

  it('validateBackendEnv requires supabase keys', () => {
    process.env.SUPABASE_URL = 'https://abc.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
    expect(() => validateBackendEnv()).not.toThrow();
  });

  it('validateFrontendEnv rejects service role in frontend env file', () => {
    expect(() =>
      validateFrontendEnv({
        vars: {
          NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
          NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
        },
        frontendEnvFileContent: 'SUPABASE_SERVICE_ROLE_KEY=leak\n',
      })
    ).toThrow(/must not be set in frontend/i);
  });

  it('validateFrontendEnv allows backend service role when checking frontend file only', () => {
    expect(() =>
      validateFrontendEnv({
        vars: {
          NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
          NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
        },
        frontendEnvFileContent:
          'NEXT_PUBLIC_SUPABASE_URL=https://abc.supabase.co\nNEXT_PUBLIC_SUPABASE_ANON_KEY=anon\n',
      })
    ).not.toThrow();
  });
});
