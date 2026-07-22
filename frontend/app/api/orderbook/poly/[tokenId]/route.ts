import { NextRequest, NextResponse } from 'next/server';
import { parseBookLevels, type PolyBookResponse } from '@/lib/orderbook';

const CLOB_BOOK_URL = 'https://clob.polymarket.com/book';

export async function GET(
  _req: NextRequest,
  { params }: { params: { tokenId: string } }
) {
  const tokenId = decodeURIComponent(params.tokenId ?? '').trim();
  if (!tokenId) {
    return NextResponse.json({ error: 'tokenId required' }, { status: 400 });
  }

  try {
    const res = await fetch(`${CLOB_BOOK_URL}?token_id=${encodeURIComponent(tokenId)}`, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `CLOB ${res.status}: ${text.slice(0, 300)}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    const bids = parseBookLevels(data?.bids, 'price', 'size').sort((a, b) => b.price - a.price);
    const asks = parseBookLevels(data?.asks, 'price', 'size').sort((a, b) => a.price - b.price);

    const body: PolyBookResponse = { tokenId, bids, asks };
    return NextResponse.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
