'use strict';

/**
 * Shared order book normalization and Kalshi delta application.
 * All prices are 0–1 probability; qty is contract/share count.
 */

function parsePositiveNumber(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Kalshi WS/REST [price, qty] tuples or {price, qty} objects. */
function parseLevelTuples(raw) {
  if (!Array.isArray(raw)) return [];

  const levels = [];
  for (const item of raw) {
    if (Array.isArray(item)) {
      const price = parsePositiveNumber(item[0]);
      const qty = parsePositiveNumber(item[1]);
      if (price != null && qty != null && qty > 0) {
        levels.push({ price, qty });
      }
      continue;
    }
    if (item && typeof item === 'object') {
      const price = parsePositiveNumber(item.price ?? item.price_dollars);
      const qty = parsePositiveNumber(item.qty ?? item.size ?? item.quantity);
      if (price != null && qty != null && qty > 0) {
        levels.push({ price, qty });
      }
    }
  }
  return levels;
}

function sortYesBids(levels) {
  return [...levels].sort((a, b) => b.price - a.price);
}

function sortAsks(levels) {
  return [...levels].sort((a, b) => a.price - b.price);
}

function createKalshiBook() {
  return {
    yes_bids: [],
    no_bids: [],
    dirty: false,
  };
}

function setKalshiSnapshot(book, payload) {
  book.yes_bids = sortYesBids(
    parseLevelTuples(payload.yes_dollars_fp ?? payload.yes_dollars ?? payload.yes)
  );
  book.no_bids = sortYesBids(
    parseLevelTuples(payload.no_dollars_fp ?? payload.no_dollars ?? payload.no)
  );
  book.dirty = true;
}

function applyKalshiDelta(book, payload) {
  const side = payload.side === 'no' ? 'no_bids' : 'yes_bids';
  const price = parsePositiveNumber(payload.price_dollars ?? payload.price);
  const delta = parsePositiveNumber(payload.delta_fp ?? payload.delta);
  if (price == null || delta == null) return;

  const levels = [...book[side]];
  const idx = levels.findIndex((l) => Math.abs(l.price - price) < 1e-9);
  const prevQty = idx >= 0 ? levels[idx].qty : 0;
  const nextQty = prevQty + delta;

  if (nextQty <= 0) {
    if (idx >= 0) levels.splice(idx, 1);
  } else if (idx >= 0) {
    levels[idx] = { price, qty: nextQty };
  } else {
    levels.push({ price, qty: nextQty });
  }

  book[side] = sortYesBids(levels);
  book.dirty = true;
}

/** Polymarket WS `book` event levels. */
function parsePolymarketLevels(raw) {
  return parseLevelTuples(raw);
}

function setPolymarketBook(state, bids, asks, ts) {
  state.pendingOrderbook = {
    bids: sortYesBids(parsePolymarketLevels(bids)),
    asks: sortAsks(parsePolymarketLevels(asks)),
    ts: ts ?? new Date().toISOString(),
  };
}

function levelsToPolyRaw(levels) {
  return levels.map((level) => ({
    price: String(level.price),
    size: String(level.qty),
  }));
}

/** Apply Polymarket WS `price_change` delta to in-memory book. */
function applyPolymarketPriceChange(state, change) {
  const side = change.side === 'SELL' ? 'asks' : 'bids';
  const price = parsePositiveNumber(change.price);
  const size = parsePositiveNumber(change.size);
  if (price == null || size == null) return false;

  if (!state.orderBook) {
    state.orderBook = { bids: [], asks: [] };
  }

  const current = parsePolymarketLevels(state.orderBook[side]);
  const idx = current.findIndex((level) => Math.abs(level.price - price) < 1e-9);

  if (size <= 0) {
    if (idx >= 0) current.splice(idx, 1);
  } else if (idx >= 0) {
    current[idx] = { price, qty: size };
  } else {
    current.push({ price, qty: size });
  }

  const sorted = side === 'bids' ? sortYesBids(current) : sortAsks(current);
  state.orderBook[side] = levelsToPolyRaw(sorted);
  return true;
}

function rowFromKalshiBook(marketId, book) {
  return {
    market_id: marketId,
    yes_bids: book.yes_bids,
    no_bids: book.no_bids,
    bids: [],
    asks: [],
    updated_at: new Date().toISOString(),
  };
}

function rowFromPolymarketBook(marketId, pending) {
  return {
    market_id: marketId,
    yes_bids: [],
    no_bids: [],
    bids: pending.bids,
    asks: pending.asks,
    updated_at: pending.ts,
  };
}

/** Last row wins — one orderbook row per market_id per upsert batch. */
function dedupeOrderbookRowsByMarket(rows) {
  const byMarket = new Map();
  for (const row of rows) {
    byMarket.set(row.market_id, row);
  }
  return [...byMarket.values()];
}

module.exports = {
  parseLevelTuples,
  createKalshiBook,
  setKalshiSnapshot,
  applyKalshiDelta,
  parsePolymarketLevels,
  setPolymarketBook,
  applyPolymarketPriceChange,
  rowFromKalshiBook,
  rowFromPolymarketBook,
  dedupeOrderbookRowsByMarket,
};
