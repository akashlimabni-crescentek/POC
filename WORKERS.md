# Worker catalog

Authoritative map of all backend workers. Update this file whenever worker behaviour changes.

## Quick start

```bash
# From repo root
npm install
cp backend/.env.example backend/.env          # service role + Kalshi keys
cp frontend/.env.local.example frontend/.env.local  # anon key only
npm run validate:env                          # fail-fast env check
npm run dev:migrate                           # apply Supabase migrations
npm run dev:workers                           # all 7 workers (concurrently)
npm run dev:frontend                          # Next.js on :3000
```

**Env rule:** `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL` must be `https://<ref>.supabase.co` — **not** `.../rest/v1/`. No leading/trailing whitespace on any line.

## Worker summary

| Worker | Cadence | Guarded? | Heartbeat? | Hot only? | Reads | Writes | Env vars |
|--------|---------|----------|------------|-----------|-------|--------|----------|
| `polymarket/events.js` | 60s | yes | yes | n/a | Gamma API `/events` | `events`, `markets` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| `kalshi/events.js` | 30m | yes | yes | n/a | Kalshi API `/markets` | `events`, `markets`, `market_ingestion_state` | `SUPABASE_*`, `KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY_B64`, `KALSHI_SERIES_TICKERS` (optional) |
| `polymarket/live-ws.js` | WS + 1s/60s flush | n/a | yes | **yes** | Polymarket WS market channel | `live_ticks`, `market_prices_latest`, `market_orderbook_latest`, `candles` 1m | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| `kalshi/live-ws.js` | WS + 1s/60s flush | n/a | yes | **yes** | Kalshi WS ticker + trade + orderbook | `live_ticks`, `market_prices_latest`, `market_orderbook_latest`, `candles` 1m | `SUPABASE_*`, `KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY_B64` |
| `polymarket/history.js` | 15m | yes | yes | **yes** | Data API `/trades`, CLOB `/prices-history` | `candles` all intervals | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| `kalshi/history.js` | 15m | yes | yes | **yes** | Kalshi `/markets/candlesticks` | `candles` all intervals | `SUPABASE_*`, `KALSHI_*` |
| `maintenance/retention.js` | 1h | yes | yes | n/a | `live_ticks`, `candles`, `markets` | DELETE old rows; `demoteStale` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |

## npm scripts

| Script | Worker / purpose |
|--------|------------------|
| `npm run dev:workers` (root) | All workers via `concurrently` |
| `npm run dev:frontend` (root) | Next.js dev server |
| `npm run validate:env` (root) | Check `backend/.env` + `frontend/.env.local` |
| `npm run worker:poly:events -w backend` | `polymarket/events.js` |
| `npm run worker:kalshi:events -w backend` | `kalshi/events.js` |
| `npm run worker:poly:live -w backend` | `polymarket/live-ws.js` |
| `npm run worker:kalshi:live -w backend` | `kalshi/live-ws.js` |
| `npm run worker:poly:history -w backend` | `polymarket/history.js` |
| `npm run worker:kalshi:history -w backend` | `kalshi/history.js` |
| `npm run worker:maintenance -w backend` | `maintenance/retention.js` |

Run a subset for Polymarket-only dev (no Kalshi credentials):

```bash
npm run worker:poly:events -w backend
npm run worker:poly:live -w backend
npm run worker:poly:history -w backend
```

## Environment variables by worker

| Variable | poly/events | kalshi/events | poly/live | kalshi/live | poly/history | kalshi/history | maintenance |
|----------|:-----------:|:-------------:|:---------:|:-----------:|:------------:|:--------------:|:-----------:|
| `SUPABASE_URL` | yes | yes | yes | yes | yes | yes | yes |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | yes | yes | yes | yes | yes | yes |
| `KALSHI_API_KEY_ID` | | yes | | yes | | yes | |
| `KALSHI_PRIVATE_KEY_B64` or `KALSHI_PRIVATE_KEY_PEM` | | yes | | yes | | yes | |
| `KALSHI_SERIES_TICKERS` (optional) | | yes | | | | | |

Frontend (`frontend/.env.local`): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` only. **Never** `SUPABASE_SERVICE_ROLE_KEY`.

Validation: `npm run validate:env` (root) or `node scripts/validate-env.js --backend-only --kalshi`.

## `polymarket/events.js`

- **Source:** `GET https://gamma-api.polymarket.com/events?active=true&closed=false&limit=50&offset=...`
- **Markets:** nested `event.markets[]` → `markets` table; `external_id` = Polymarket market id; `token_ids` = `clobTokenIds`
- **Default tier:** `warm` for new/active markets; preserves `hot` on upsert
- **Dead letter:** failed event/market batches retried next cycle
- **Watermark:** `lastSeenTs` from max `event.updatedAt` (in-memory, for future incremental poll)
- **Heartbeat:** `reportCycle` / `reportError` each guarded cycle

## `kalshi/events.js`

- **Cold start (cycle 1):** full fetch per `KALSHI_SERIES_TICKERS` (env) or `config/providers.js` → `GET /markets?series_ticker=&status=open`; if no series configured, `GET /markets?status=open`
- **Warm poll (cycle 2+):** `GET /markets?min_updated_ts=<lastPollTs>` **only** — series filter applied in app code (P2-5)
- **Auth:** RSA-PSS signed headers via `lib/kalshi-client.js` + `config/kalshi-key.js`
- **Events:** grouped by `event_ticker`; **markets:** `external_id` = Kalshi `ticker`
- **Default tier:** `warm`; preserves `hot` on upsert
- **Watermark:** `lastPollTs` (Unix seconds, in-memory) + `market_ingestion_state.last_poll_ts` per market
- **Logs:** `mode=cold` or `mode=warm` each cycle (expect `warm` on cycle 2+ when data exists)

## `polymarket/live-ws.js`

- **Endpoint:** `wss://ws-subscriptions-clob.polymarket.com/ws/market`
- **Hot only:** `getHotMarkets(supabase, 'polymarket')` — refresh every 5 min (diff subscribe/unsubscribe)
- **Chunks:** 250 `token_ids` per subscribe message
- **Events:** `book`, `best_bid_ask`, `last_trade_price`, `price_change`, `new_market` (queued), `market_resolved` (→ `closed`)
- **Order book:** `book` events → full bid/ask ladders upserted to `market_orderbook_latest` (Realtime-enabled)
- **Flush:** 1s → `live_ticks` + `market_prices_latest` + `market_orderbook_latest`; 60s → `candles` 1m with gap-fill (cap 36)
- **Memory:** per-token OHLC, orderBook, lastKnownClose — evict after 24h idle
- **Keepalive:** PING every 10s, reconnect on PONG timeout
- **Prices:** stored as 0–1 probability (Polymarket native)

## `kalshi/live-ws.js`

- **Endpoint:** `wss://api.elections.kalshi.com/trade-api/ws/v2` (signed handshake)
- **Hot only:** `getHotMarkets(supabase, 'kalshi')` — refresh every 5 min via `update_subscription`
- **Channels:** `ticker` + `trade` + `orderbook_delta` (`use_yes_price: true`) for hot `market_tickers`
- **Order book:** `orderbook_snapshot` + `orderbook_delta` → yes/no bid ladders in `market_orderbook_latest`
- **Sequence gaps:** `seq` per `sid` — reconnect on gap
- **Flush:** 1s → `live_ticks` + `market_prices_latest` + `market_orderbook_latest`; 60s → `candles` 1m with gap-fill
- **Prices:** Kalshi cents/dollars → 0–1 via `lib/price-units.js` on write
- **Memory:** per-ticker OHLC state — evict after 24h idle

## `polymarket/history.js`

- **Hot only:** `getHotMarkets` — guarded poll every **15m**
- **1m source:** Data API `/trades` → `tradesTo1mCandles`; CLOB `/prices-history` fallback
- **Aggregate:** 1m → 5m/1h/1d via `lib/ohlc.js`
- **First backfill:** 1m/5m 7d; 1h 90d; 1d 365d (CLOB for 1h/1d on first promotion)
- **Incremental:** last **2h** every 15m
- **State:** `market_ingestion_state.last_backfill_at` + `last_candle_ts`
- **Overlap guard:** logs `previous run still in progress — skipping` if cycle > 15m

## `kalshi/history.js`

- **Hot only:** batch **4 tickers** per `/markets/candlesticks` request
- **Intervals:** `period_interval` 1 / 60 / 1440 → normalize to 0–1 on write
- **5m:** aggregated from 1m candles
- **Same incremental / lookback / guarded rules** as Polymarket history

## `maintenance/retention.js`

- **Primary:** pg_cron jobs in `006_retention.sql` (enable extension in Supabase Dashboard)
- **Fallback:** hourly guarded worker when pg_cron is unavailable or for closed-market grace
- **Purges:**
  - `live_ticks` older than **6 hours**
  - `candles` 1m → **30d**; 5m → **90d**; 1h/1d → **2y**
  - All `candles` for markets closed **> 30d** (uses `markets.close_time` or `events.close_time`)
- **`demoteStale()`:** closed/settled markets → `cold` tier
- **`reportCycle`:** total deleted + demoted row count each cycle

## Ingestion tiers (`lib/tiers.js`)

| Function | Used by | Purpose |
|----------|---------|---------|
| `getHotMarkets(supabase, slug)` | `live-ws`, `history` workers | Markets to subscribe/backfill |
| `getAllHotMarkets(supabase)` | Debug / ops | All hot markets across providers |
| `getHotMarketCount(supabase)` | Health checks | Count hot active markets |
| `demoteStale(supabase)` | `maintenance/retention` | closed/settled → `cold` |
| `shouldReceiveLiveIngestion(market)` | Worker guards | `hot` + active/open check |

**Hot promotion:** frontend only via `promote_event_to_hot` RPC — not a worker responsibility.

## Ops queries

```sql
-- Worker health
SELECT worker, last_cycle_at, last_cycle_rows, last_error FROM worker_health ORDER BY worker;

-- Hot market count
SELECT COUNT(*) FROM markets WHERE ingestion_tier = 'hot' AND status IN ('active', 'open');

-- Live tick age (should be < 6h)
SELECT MAX(ts) FROM live_ticks;
```

## Startup order

1. Apply Supabase migrations + seed providers (`npm run dev:migrate`)
2. `npm run validate:env`
3. Start metadata workers (`polymarket/events`, `kalshi/events`) — or `npm run dev:workers`
4. Start `maintenance/retention`
5. Start frontend (`npm run dev:frontend`)
6. User opens event → `promote_event_to_hot` RPC
7. Live-ws + history workers pick up hot markets (already running if using `dev:workers`)
