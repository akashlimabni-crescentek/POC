import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { kalshiCentsToProb, kalshiDollarsToProb, normalizePrice } = require('../lib/price-units');

describe('price-units', () => {
  it('kalshiCentsToProb converts cents to 0-1', () => {
    expect(kalshiCentsToProb(50)).toBe(0.5);
    expect(kalshiCentsToProb(0)).toBe(0);
    expect(kalshiCentsToProb(100)).toBe(1);
    expect(kalshiCentsToProb(null)).toBeNull();
  });

  it('kalshiDollarsToProb handles dollar and prob inputs', () => {
    expect(kalshiDollarsToProb(0.5)).toBe(0.5);
    expect(kalshiDollarsToProb(50)).toBe(0.5);
  });

  it('normalizePrice passes polymarket through unchanged', () => {
    expect(normalizePrice('polymarket', 0.73)).toBe(0.73);
  });

  it('normalizePrice converts kalshi cents', () => {
    expect(normalizePrice('kalshi', 65, { unit: 'cents' })).toBe(0.65);
    expect(normalizePrice('kalshi', 65)).toBe(0.65);
  });

  it('normalizePrice treats kalshi values <=1 as probability', () => {
    expect(normalizePrice('kalshi', 0.42, { unit: 'prob' })).toBe(0.42);
  });
});
