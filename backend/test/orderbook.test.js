import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseLevelTuples,
  createKalshiBook,
  setKalshiSnapshot,
  applyKalshiDelta,
  setPolymarketBook,
  dedupeOrderbookRowsByMarket,
} = require('../lib/orderbook');

describe('orderbook', () => {
  it('parseLevelTuples handles Kalshi fp tuples', () => {
    const levels = parseLevelTuples([
      ['0.4100', '120.00'],
      ['0.4000', '50.25'],
    ]);
    expect(levels).toEqual([
      { price: 0.41, qty: 120 },
      { price: 0.4, qty: 50.25 },
    ]);
  });

  it('setKalshiSnapshot and applyKalshiDelta maintain book', () => {
    const book = createKalshiBook();
    setKalshiSnapshot(book, {
      yes_dollars_fp: [
        ['0.40', '100'],
        ['0.39', '50'],
      ],
      no_dollars_fp: [['0.55', '80']],
    });
    expect(book.yes_bids).toHaveLength(2);
    expect(book.no_bids).toHaveLength(1);

    applyKalshiDelta(book, {
      side: 'yes',
      price_dollars: '0.40',
      delta_fp: '-100',
    });
    expect(book.yes_bids).toEqual([{ price: 0.39, qty: 50 }]);

    applyKalshiDelta(book, {
      side: 'yes',
      price_dollars: '0.41',
      delta_fp: '25',
    });
    expect(book.yes_bids[0]).toEqual({ price: 0.41, qty: 25 });
  });

  it('setPolymarketBook normalizes bids and asks', () => {
    const state = {};
    setPolymarketBook(
      state,
      [{ price: '0.45', size: '10' }],
      [{ price: '0.47', size: '5' }],
      '2026-07-20T12:00:00.000Z'
    );
    expect(state.pendingOrderbook.bids).toEqual([{ price: 0.45, qty: 10 }]);
    expect(state.pendingOrderbook.asks).toEqual([{ price: 0.47, qty: 5 }]);
  });

  it('applyPolymarketPriceChange updates bid levels', () => {
    const state = {
      orderBook: {
        bids: [{ price: '0.45', size: '10' }],
        asks: [{ price: '0.47', size: '5' }],
      },
    };
    const { applyPolymarketPriceChange } = require('../lib/orderbook');
    applyPolymarketPriceChange(state, {
      side: 'BUY',
      price: '0.46',
      size: '20',
    });
    expect(state.orderBook.bids).toEqual([
      { price: '0.46', size: '20' },
      { price: '0.45', size: '10' },
    ]);
  });

  it('dedupeOrderbookRowsByMarket keeps one row per market_id', () => {
    const rows = dedupeOrderbookRowsByMarket([
      {
        market_id: 1,
        yes_bids: [],
        no_bids: [],
        bids: [{ price: 0.4, qty: 1 }],
        asks: [],
        updated_at: 't1',
      },
      {
        market_id: 1,
        yes_bids: [],
        no_bids: [],
        bids: [{ price: 0.5, qty: 2 }],
        asks: [],
        updated_at: 't2',
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].bids[0].price).toBe(0.5);
  });
});
