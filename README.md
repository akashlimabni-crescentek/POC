# Prediction Market Data Platform — POC

Monorepo POC for ingesting Polymarket + Kalshi data into **Supabase Postgres**, with a **Next.js** frontend that reads directly via `@supabase/supabase-js` (no custom REST API).

## Architecture

```
Exchange APIs → backend/workers (Node, service role) → Supabase Postgres → frontend (anon key + Realtime)
```

- **Workers** write with `SUPABASE_SERVICE_ROLE_KEY`
- **Frontend** reads with `NEXT_PUBLIC_SUPABASE_ANON_KEY` (RLS read-only)
- **Live prices** via Supabase Realtime on `market_prices_latest`
- **Hot tier promotion** via RPC `promote_event_to_hot(event_id)`

See [plan.md](./plan.md) for the full build guide.

## Prerequisites

- Node.js 20+
- [Supabase](https://supabase.com) project (hosted Postgres, EU region preferred)
- [Supabase CLI](https://supabase.com/docs/guides/cli) — installed locally via `npm install` (or `brew install supabase/tap/supabase`)
- Kalshi API credentials (for Kalshi workers only)

## Environment setup

Env files are **split by package** — never mix service role into the frontend.

```bash
cp backend/.env.example backend/.env
cp frontend/.env.local.example frontend/.env.local
npm run validate:env
```

### Backend (`backend/.env`)

Copy from `backend/.env.example` and fill in:

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` (project root — **not** `/rest/v1/`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (Dashboard → Settings → API) |
| `KALSHI_API_KEY_ID` | Kalshi API key ID (Kalshi workers only) |
| `KALSHI_PRIVATE_KEY_B64` | Kalshi RSA private key, base64-encoded |
| `KALSHI_SERIES_TICKERS` | Optional comma-separated series for cold sync |

**Important:** No leading/trailing whitespace on env lines. Never commit `.env` files.

### Frontend (`frontend/.env.local`)

Copy from `frontend/.env.local.example` and fill in:

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Same project root URL as backend (`https://<ref>.supabase.co`) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon/public key (Dashboard → Settings → API) |

**Never** put `SUPABASE_SERVICE_ROLE_KEY` in the frontend.

### Validate env before running

```bash
npm run validate:env                  # backend + frontend
npm run validate:env -- --backend-only --kalshi   # workers + Kalshi keys
npm run validate:env -- --frontend-only           # Next.js only
```

Common failure: `SUPABASE_URL` set to `https://<ref>.supabase.co/rest/v1/` — use the project root URL instead.

## Supabase project setup

1. Create a Supabase project at [supabase.com/dashboard](https://supabase.com/dashboard)
2. **Link** your hosted project (one-time, requires browser login):

   ```bash
   npx supabase login
   npx supabase link --project-ref rsmknjzkntwejkdkcanx
   ```

   Replace `rsmknjzkntwejkdkcanx` with your project ref from the Supabase Dashboard URL.

3. Apply migrations + seed:

   ```bash
   npm run dev:migrate
   npx supabase db execute --file supabase/seed.sql
   ```

   `dev:migrate` uses the Supabase CLI from `node_modules` (no global install required).

4. Enable **pg_cron** extension in Dashboard → Database → Extensions (for retention jobs in `006_retention.sql`)

## Data retention

| Table / rule | Retention | Enforced by |
|--------------|-----------|-------------|
| `live_ticks` | **6 hours** | pg_cron (hourly) + `maintenance/retention` fallback |
| `candles` 1m | **30 days** | pg_cron + maintenance worker |
| `candles` 5m | **90 days** | pg_cron + maintenance worker |
| `candles` 1h / 1d | **2 years** | pg_cron + maintenance worker |
| Closed markets | Delete all candles **30d after close** | maintenance worker only |

**PIPE-04 lesson:** `live_ticks` is high-churn — UI and ops should assume **≤ 6h** of tick history exists. Use `market_prices_latest` for current price and `candles` for charts.

## Install

```bash
npm install
```

## Ingestion tiers & hot promotion

| Tier | Set by | Live WS | History backfill |
|------|--------|---------|------------------|
| `cold` | Schema default / `demoteStale()` | No | No |
| `warm` | Events workers (metadata sync) | No | No |
| `hot` | Frontend RPC on event open | **Yes** | **Yes** |

**Promotion uses Supabase RPC only — there is no `backend/api/` REST layer.**

Migration `004_rpc_promote_hot.sql` defines `promote_event_to_hot(p_event_id)` (security definer, granted to `anon`).

### Frontend (browser)

```typescript
import { promoteEventToHot } from '@/lib/queries';

// Call when user opens /events/[id]
await promoteEventToHot(eventId);
```

Equivalent raw call:

```typescript
await supabase.rpc('promote_event_to_hot', { p_event_id: eventId });
```

### Backend workers

- `lib/tiers.js` → `getHotMarkets(supabase, 'polymarket' | 'kalshi')` for live-ws + history workers
- `lib/tiers.js` → `demoteStale(supabase)` from maintenance worker (closed/settled → `cold`)
- Only markets with `ingestion_tier = 'hot'` AND `status IN ('active', 'open')` receive WebSocket + history load

## Run

```bash
# 1. Install + configure env (see above)
npm install
npm run validate:env

# 2. Apply migrations
npm run dev:migrate

# 3. Start all workers (7 processes via concurrently)
npm run dev:workers

# 4. Start frontend (separate terminal)
npm run dev:frontend

# 5. Unit tests
npm test
```

See [WORKERS.md](./WORKERS.md) for per-worker cadence, tables, and env requirements.

## Repo layout

```
├── backend/
│   ├── config/          # supabase client, providers, intervals
│   ├── lib/             # shared utilities (ohlc, bulk-upsert, etc.)
│   ├── workers/         # polymarket/, kalshi/, maintenance/
│   └── test/            # vitest unit tests
├── frontend/
│   ├── app/             # Next.js App Router pages
│   └── lib/supabase/    # browser + server clients
├── supabase/
│   └── migrations/      # numbered SQL migrations
└── WORKERS.md           # worker catalog (keep in sync)
```

## Demo flow

1. `npm run validate:env` — confirm URLs and keys (no `/rest/v1/` suffix, no whitespace)
2. `npm run dev:migrate` — apply schema, RLS, RPC, pg_cron jobs
3. `npm run dev:workers` — events, live-ws, history, maintenance workers
4. Open [http://localhost:3000](http://localhost:3000) (`npm run dev:frontend`) — browse events by provider
5. Open an event → frontend calls `promote_event_to_hot` RPC → markets become **hot**
6. Open a market → Realtime price on `market_prices_latest`; chart backfills within minutes
7. Verify in Supabase: `worker_health` rows updating; `markets.ingestion_tier = 'hot'` for opened event

**Polymarket-only:** run `worker:poly:*` scripts individually if Kalshi credentials are not configured.

## Testing

### Unit tests (Vitest)

```bash
npm test
```

Core libraries covered (Prompt 12):

| Module | Test file |
|--------|-----------|
| `lib/ohlc.js` | `test/ohlc.test.js` |
| `lib/guarded-interval.js` | `test/guarded-interval.test.js` |
| `lib/price-units.js` | `test/price-units.test.js` |
| `lib/bulk-upsert.js` | `test/bulk-upsert.test.js` |
| `lib/db-retry.js` | `test/db-retry.test.js` |

Additional coverage: `tiers`, `retention`, `history`, `validate-env`, Polymarket/Kalshi events + live-ws workers.

### Manual acceptance checklist

Run with `npm run dev:workers` and `npm run dev:frontend` against a live Supabase project. Maps to [plan.md §11](./plan.md#11-scenarios--acceptance-criteria).

| # | Criterion | How to verify |
|---|-----------|---------------|
| 1 | **Polymarket event within 60s** | Start `worker:poly:events`. Within one cycle, `events` + `markets` rows appear (UI home tab or Table Editor). |
| 2 | **Open event → hot → Realtime price ≤3s** | Open `/events/[id]` (RPC runs). Open a market; price updates via Realtime on `market_prices_latest` within ~3s (live-ws worker running). |
| 3 | **Chart 1m within 2 min of promote** | On `/markets/[id]`, select **1m**; candles appear within ~2 min (history worker + hot tier). |
| 4 | **Chart 1h backfills within 15 min (hot only)** | Same market, select **1h**; data appears within one history cycle (~15m). Non-hot markets stay empty. |
| 5 | **Kalshi warm poll on cycle 2+** | Start `worker:kalshi:events`. Cycle 1 logs `mode=cold`; cycle 2+ logs `mode=warm` (not another full cold fetch). |
| 6 | **Overlap guard skips** | If a worker cycle exceeds its interval, logs contain `previous run still in progress — skipping` (e.g. slow history backfill). |
| 7 | **`live_ticks` purged after 6h** | After retention runs: `SELECT COUNT(*) FROM live_ticks WHERE ts < NOW() - INTERVAL '6 hours';` → **0**. |
| 8 | **Both providers in UI** | Home page provider tabs show **Polymarket** and **Kalshi** with paginated event lists. |
| 9 | **Anon cannot write; no service role in frontend** | Anon `INSERT` into `events` fails (RLS). `npm run build -w frontend` then `grep -r service_role frontend/.next` → no matches. |
| 10 | **`worker_health` reports all workers** | `SELECT worker, last_cycle_at, last_error FROM worker_health ORDER BY worker;` — 7 workers updating. |
| 11 | **History is hot-only** | With many warm markets, history logs show `hot=N` (small N), not processing full catalog. |

**Quick SQL checks**

```sql
-- Hot markets only (should match opened events)
SELECT COUNT(*) FROM markets WHERE ingestion_tier = 'hot';

-- Worker health
SELECT worker, last_cycle_at, last_cycle_rows, last_error FROM worker_health ORDER BY worker;

-- Live tick freshness (< 6h)
SELECT MAX(ts) AS newest_tick FROM live_ticks;

-- Candles for a hot market
SELECT interval, COUNT(*) FROM candles WHERE market_id = <id> GROUP BY interval;
```

**Anon write test** (Supabase SQL editor — should error / 0 rows):

```sql
SET ROLE anon;
INSERT INTO events (provider_id, external_id, title) VALUES (1, 'test', 'should fail');
RESET ROLE;
```

## Security

- `.gitignore` blocks `.env`, `.env.*`, `*.pem`, `*.key`
- RLS: anon can SELECT public tables only; no anon INSERT/UPDATE
- Exchange API keys and WebSocket connections live in workers only
