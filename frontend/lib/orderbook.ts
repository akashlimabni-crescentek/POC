export type BookLevel = {
  price: number;
  qty: number;
};

export type KalshiBookResponse = {
  ticker: string;
  yes_bids: BookLevel[];
  no_bids: BookLevel[];
};

export type PolyBookResponse = {
  tokenId: string;
  bids: BookLevel[];
  asks: BookLevel[];
};

export type NormalizedBook = {
  bids: BookLevel[];
  asks: BookLevel[];
};

export function parseBookLevels(
  raw: unknown,
  priceKey: 'price' | 0 = 'price',
  qtyKey: 'qty' | 'size' | 1 = 'qty'
): BookLevel[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const levels: BookLevel[] = [];
  for (const item of raw) {
    if (Array.isArray(item)) {
      const price = parseFloat(String(item[0] ?? ''));
      const qty = parseFloat(String(item[1] ?? ''));
      if (Number.isFinite(price) && Number.isFinite(qty) && qty > 0) {
        levels.push({ price, qty });
      }
      continue;
    }
    if (item && typeof item === 'object') {
      const row = item as Record<string, unknown>;
      const price = parseFloat(String(row[priceKey] ?? row.price ?? ''));
      const qty = parseFloat(String(row[qtyKey] ?? row.size ?? row.qty ?? ''));
      if (Number.isFinite(price) && Number.isFinite(qty) && qty > 0) {
        levels.push({ price, qty });
      }
    }
  }
  return levels;
}

/** Kalshi: NO bid at p implies YES ask at 1−p. */
export function kalshiToYesBook(yesBids: BookLevel[], noBids: BookLevel[]): NormalizedBook {
  const bids = [...yesBids].sort((a, b) => b.price - a.price);
  const asks = noBids
    .map((l) => ({ price: 1 - l.price, qty: l.qty }))
    .sort((a, b) => a.price - b.price);
  return { bids, asks };
}

/** NO-side book: invert YES bids to NO asks. */
export function kalshiToNoBook(yesBids: BookLevel[], noBids: BookLevel[]): NormalizedBook {
  const bids = [...noBids].sort((a, b) => b.price - a.price);
  const asks = yesBids
    .map((l) => ({ price: 1 - l.price, qty: l.qty }))
    .sort((a, b) => a.price - b.price);
  return { bids, asks };
}

export function polyToBook(bids: BookLevel[], asks: BookLevel[]): NormalizedBook {
  return {
    bids: [...bids].sort((a, b) => b.price - a.price),
    asks: [...asks].sort((a, b) => a.price - b.price),
  };
}

export function fmtBookQty(qty: number): string {
  if (qty >= 1_000_000) return `${(qty / 1_000_000).toFixed(1)}M`;
  if (qty >= 1_000) return `${(qty / 1_000).toFixed(1)}K`;
  return qty.toFixed(0);
}

export function fmtBookPrice(price: number): string {
  return `${(price * 100).toFixed(1)}¢`;
}

export function primaryTokenId(tokenIds: unknown): string | null {
  if (!Array.isArray(tokenIds) || tokenIds.length === 0) {
    return null;
  }
  const first = tokenIds[0];
  return first != null ? String(first) : null;
}

export type OrderbookLogSource = 'db' | 'realtime' | 'rest';

/** Compact summary for console verification of order book payloads. */
export function summarizeOrderbookPayload(
  providerSlug: string,
  payload: {
    yes_bids?: unknown;
    no_bids?: unknown;
    bids?: unknown;
    asks?: unknown;
    updated_at?: string | null;
  }
) {
  if (providerSlug === 'kalshi') {
    const yes_bids = parseBookLevels(payload.yes_bids);
    const no_bids = parseBookLevels(payload.no_bids);
    return {
      yes_bid_levels: yes_bids.length,
      no_bid_levels: no_bids.length,
      best_yes_bid: yes_bids[0] ?? null,
      best_no_bid: no_bids[0] ?? null,
      top_yes_bids: yes_bids.slice(0, 3),
      top_no_bids: no_bids.slice(0, 3),
      updated_at: payload.updated_at ?? null,
    };
  }

  const bids = parseBookLevels(payload.bids);
  const asks = parseBookLevels(payload.asks);
  return {
    bid_levels: bids.length,
    ask_levels: asks.length,
    best_bid: bids[0] ?? null,
    best_ask: asks[0] ?? null,
    top_bids: bids.slice(0, 3),
    top_asks: asks.slice(0, 3),
    updated_at: payload.updated_at ?? null,
  };
}

export function logOrderbookEvent(
  source: OrderbookLogSource,
  marketId: number,
  providerSlug: string,
  payload: {
    yes_bids?: unknown;
    no_bids?: unknown;
    bids?: unknown;
    asks?: unknown;
    updated_at?: string | null;
  },
  extra?: Record<string, unknown>
) {
  const table = source === 'rest' ? null : 'market_orderbook_latest';
  console.log('[OrderBook]', {
    source,
    table,
    marketId,
    provider: providerSlug,
    receivedAt: new Date().toISOString(),
    summary: summarizeOrderbookPayload(providerSlug, payload),
    raw: payload,
    ...extra,
  });
}
