'use strict';

/**
 * Local test harness for the frontend realtime candle aggregator.
 *
 * It upserts market_prices_latest on a timer — exactly what the real
 * live-ws worker's flushLive() does — so Supabase Realtime fires and the
 * frontend builds/updates the live candle. No Kalshi credentials needed.
 *
 * Usage:
 *   node scripts/simulate-ticks.js                 # list markets that have candle history
 *   node scripts/simulate-ticks.js <marketId>      # stream real-time ticks (1/sec)
 *   node scripts/simulate-ticks.js <marketId> --speed 60   # virtual clock 60x → 5m bucket in 5s
 *   node scripts/simulate-ticks.js <marketId> --every 250  # 250ms between ticks (stress test)
 *
 * Flags:
 *   --speed N   advance the candle timestamp N× wall-clock (fast-forward bucket rollovers)
 *   --every MS  milliseconds between ticks (default 1000)
 *   --vol V     random-walk step size in probability units (default 0.02)
 */

const { supabase } = require('../config/supabase');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      flags[arg.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/** List markets that already have candle history — those load a chart to build on. */
async function listMarkets() {
  const { data: candleRows, error } = await supabase
    .from('candles')
    .select('market_id')
    .order('ts', { ascending: false })
    .limit(2000);

  if (error) throw new Error(`candles lookup failed: ${error.message}`);

  const ids = [...new Set((candleRows ?? []).map((r) => r.market_id))];
  if (!ids.length) {
    console.log('No candles found. Backfill history first, then re-run.');
    return;
  }

  const { data: markets, error: mErr } = await supabase
    .from('markets')
    .select('id, title, outcome_label, ingestion_tier, event_id')
    .in('id', ids);

  if (mErr) throw new Error(`markets lookup failed: ${mErr.message}`);

  console.log('\nMarkets with candle history (pick one to simulate):\n');
  for (const m of markets ?? []) {
    const label = m.outcome_label || m.title || '(untitled)';
    console.log(
      `  marketId=${m.id}  tier=${m.ingestion_tier ?? '-'}  event=${m.event_id ?? '-'}  ${label}`
    );
  }
  console.log(`\nThen run:  node scripts/simulate-ticks.js <marketId>\n`);
}

async function getStartPrice(marketId) {
  const { data } = await supabase
    .from('market_prices_latest')
    .select('last_price, mid')
    .eq('market_id', marketId)
    .maybeSingle();
  const p = data?.last_price ?? data?.mid;
  return typeof p === 'number' && p > 0 && p < 1 ? p : 0.5;
}

async function stream(marketId, { speed, every, vol }) {
  let price = await getStartPrice(marketId);

  // Virtual clock: with --speed > 1, each real tick advances the candle
  // timestamp by (every * speed) ms, so bucket boundaries arrive fast.
  let virtualMs = Date.now();

  console.log(
    `Streaming ticks: marketId=${marketId} every=${every}ms speed=${speed}x vol=${vol} start=${price.toFixed(3)}`
  );
  console.log('Watch the OHLCV chart for this market. Ctrl-C to stop.\n');

  const send = async () => {
    // Random walk, clamped to a valid 0–1 probability.
    price += (Math.random() - 0.5) * 2 * vol;
    price = Math.min(0.99, Math.max(0.01, price));

    const spread = 0.01;
    const bid = Math.max(0.01, price - spread / 2);
    const ask = Math.min(0.99, price + spread / 2);
    virtualMs += every * speed;

    const row = {
      market_id: marketId,
      bid: Number(bid.toFixed(4)),
      ask: Number(ask.toFixed(4)),
      mid: Number(price.toFixed(4)),
      last_price: Number(price.toFixed(4)),
      updated_at: new Date(virtualMs).toISOString(),
    };

    const { error } = await supabase
      .from('market_prices_latest')
      .upsert(row, { onConflict: 'market_id' });

    if (error) {
      console.error(`upsert failed: ${error.message}`);
    } else {
      console.log(`tick  ${row.updated_at}  price=${row.last_price}`);
    }
  };

  await send();
  setInterval(send, every);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));

  if (!positional.length) {
    await listMarkets();
    return;
  }

  const marketId = Number(positional[0]);
  if (!Number.isInteger(marketId)) {
    console.error(`Invalid marketId: ${positional[0]}`);
    process.exit(1);
  }

  await stream(marketId, {
    speed: Number(flags.speed) || 1,
    every: Number(flags.every) || 1000,
    vol: Number(flags.vol) || 0.02,
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
