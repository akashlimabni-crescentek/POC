import { NextRequest, NextResponse } from 'next/server';
import { buildKalshiAuthHeaders } from '@/lib/kalshi-auth';
import { parseBookLevels, type KalshiBookResponse } from '@/lib/orderbook';

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

export async function GET(
  _req: NextRequest,
  { params }: { params: { ticker: string } }
) {
  const ticker = decodeURIComponent(params.ticker ?? '').trim();
  if (!ticker) {
    return NextResponse.json({ error: 'ticker required' }, { status: 400 });
  }

  const endpoint = `/markets/${encodeURIComponent(ticker)}/orderbook`;

  try {
    const res = await fetch(`${KALSHI_API_BASE}${endpoint}`, {
      headers: buildKalshiAuthHeaders('GET', endpoint),
      cache: 'no-store',
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `Kalshi ${res.status}: ${text.slice(0, 300)}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    const book = data.orderbook_fp ?? data.orderbook ?? {};

    const yes_bids = parseBookLevels(book.yes_dollars ?? book.yes, 0, 1)
      .sort((a, b) => b.price - a.price);
    const no_bids = parseBookLevels(book.no_dollars ?? book.no, 0, 1)
      .sort((a, b) => b.price - a.price);

    const body: KalshiBookResponse = { ticker, yes_bids, no_bids };
    return NextResponse.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
