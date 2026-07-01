import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isWorldCupSeries } = require('../lib/kalshi-wc-series');

describe('kalshi-wc-series', () => {
  it('includes FIFA mens World Cup series', () => {
    expect(
      isWorldCupSeries({ ticker: 'KXWCGAME', title: "2026 Men's World Cup Game", tags: [] })
    ).toBe(true);
  });

  it('excludes esports and club world cup', () => {
    expect(
      isWorldCupSeries({ ticker: 'KXEWC', title: 'Esports World Cup', tags: ['esport'] })
    ).toBe(false);
    expect(
      isWorldCupSeries({ ticker: 'KXCLUBWC', title: 'Club World Cup', tags: [] })
    ).toBe(false);
    expect(
      isWorldCupSeries({ ticker: 'KXWCDOTA2', title: 'Dota 2 World Cup', tags: [] })
    ).toBe(false);
  });
});
