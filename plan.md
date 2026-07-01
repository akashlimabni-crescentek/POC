# POC Build Guide — Prediction Market Data Platform

Use this document as a **master spec + step-by-step prompts** to build a monorepo POC in one folder. Each step is a **copy-paste prompt** for Cursor (or another AI) in a **new empty repo**.

This guide incorporates **enterprise-grade structure**, **optimization patterns**, and **every issue discovered** in the production `prediction-market-pipeline` review — the POC must **not repeat those mistakes**.

---

## Table of contents

1. [What the POC should prove](#1-what-the-poc-should-prove)
2. [Architecture overview](#2-architecture-overview)
3. [Data domain map](#3-data-domain-map)
4. [Enterprise monorepo layout](#4-enterprise-monorepo-layout)
5. [Enterprise coding standards (mandatory)](#5-enterprise-coding-standards-mandatory)
6. [Production anti-patterns — do NOT repeat](#6-production-anti-patterns--do-not-repeat)
7. [Supabase schema](#7-supabase-schema)
8. [Shared library catalog](#8-shared-library-catalog)
9. [Tech stack](#9-tech-stack)
10. [Step-by-step prompts](#10-step-by-step-prompts)
11. [Scenarios & acceptance criteria](#11-scenarios--acceptance-criteria)
12. [Improvements vs current production pipeline](#12-improvements-vs-current-production-pipeline)
13. [One-shot mega prompt](#13-one-shot-mega-prompt)
14. [Client demo script](#14-client-demo-script)
15. [Production pipeline assessment (reference)](#15-production-pipeline-assessment-reference)
16. [Operational runbook](#16-operational-runbook)

---

## 1. What the POC should prove

| Capability | POC must show |
|------------|----------------|
| Multi-provider ingest | Polymarket + Kalshi metadata |
| Catalogue | Providers → events → markets hierarchy |
| Live prices | WebSocket for **active/hot** markets only |
| History | Candles **1m, 5m, 1h, 1d** in Supabase Postgres |
| Scale patterns | Ingestion tiers, retention, overlap guards, bulk writes |
| UI | List events/markets + candlestick chart per market |
| Direct frontend reads | Next.js reads via `@supabase/supabase-js` (no custom REST API) |
| Enterprise quality | Guarded intervals, heartbeats, bounded memory, unit-tested OHLC, no silent errors |

---

## 2. Architecture overview

```text
┌─────────────────┐     REST / WebSocket      ┌──────────────────────────┐
│  Exchange APIs  │ ─────────────────────────▶│  backend/workers         │
│  Polymarket     │                           │  (Node, service role key)│
│  Kalshi         │                           │  lib/ + config/ shared   │
└─────────────────┘                           └────────────┬─────────────┘
                                                           │ bulk upsert / RPC
                                                           ▼
                                                ┌──────────────────────────┐
                                                │  Supabase Postgres (EU)  │
                                                │  + Realtime publication  │
                                                │  + RLS (anon read)       │
                                                │  + pg_cron retention     │
                                                └────────────┬─────────────┘
                                                             │
                      @supabase/supabase-js (anon key)       │
                      .from() + Realtime + rpc()             │
                                                             ▼
                                                ┌──────────────────────────┐
                                                │  frontend/ (Next.js)     │
                                                │  no backend API layer    │
                                                └──────────────────────────┘
```

### Key rules

| Layer | Access pattern |
|-------|----------------|
| **Workers** | `@supabase/supabase-js` with `SUPABASE_SERVICE_ROLE_KEY` — bypasses RLS, full write access |
| **Frontend** | `@supabase/supabase-js` with `NEXT_PUBLIC_SUPABASE_ANON_KEY` — RLS read-only on public tables |
| **Tier promotion** | Frontend calls Supabase RPC `promote_event_to_hot(event_id)` (security definer) |
| **Live price updates** | Supabase Realtime on `market_prices_latest` (fallback poll every 2s) |
| **No custom REST API** | Frontend never calls a Node HTTP server for data |
| **No browser → exchange** | Exchange keys and WebSocket connections live in workers only |

### Write path vs read path

| Path | Flow | Latency |
|------|------|---------|
| **Live** | Exchange WS → worker buffer → `live_ticks` + `market_prices_latest` → Realtime → UI | ~0.5–3s |
| **Recent OHLC** | Exchange WS → worker 1m bucket close → `candles` interval=1m | ~1 min |
| **History OHLC** | Exchange REST → worker aggregate → `candles` 1m/5m/1h/1d | minutes |
| **Metadata** | Exchange REST → worker bulk upsert → `events` / `markets` | 60s (Poly) / 30m (Kalshi) |

**Do not store raw WebSocket JSON** in Postgres. Store parsed, normalized snapshots only.

---

## 3. Data domain map

| Layer | What | Source | POC worker | Supabase table(s) | Frontend read |
|-------|------|--------|------------|-------------------|---------------|
| **Providers** | Polymarket, Kalshi | Manual seed | — | `providers` | `.from('providers')` |
| **Events** | Event metadata | REST | `polymarket/events`, `kalshi/events` | `events` | `.from('events')` |
| **Markets** | Outcome markets | REST | same | `markets` | `.from('markets')` |
| **Live ticks** | Best bid/ask, last, mid | WebSocket | `*/live-ws` | `live_ticks` | not exposed (RLS off) |
| **Live snapshot** | Latest price per market | Derived | worker upsert | `market_prices_latest` | Realtime subscribe |
| **OHLC recent** | 1m candles from WS | WebSocket | `*/live-ws` | `candles` (`interval=1m`) | `.from('candles')` |
| **OHLC history** | 1m, 5m, 1h, 1d backfill | REST | `*/history` | `candles` | `.from('candles')` |
| **Ingestion state** | tier, backfill cursor | Internal | all workers | `market_ingestion_state` | not exposed |
| **Worker health** | Liveness | Internal | all workers | `worker_health` | optional admin view |

### Real-time vs history (FAQ)

| Question | Answer |
|----------|--------|
| Is history real-time? | **No.** History is REST backfill (minutes delay). |
| Is live price real-time? | **Near–real-time** via WS → `market_prices_latest` → Supabase Realtime. |
| Does frontend talk to exchanges? | **No.** Browser only talks to Supabase. |
| Is `kalshi_price_history`-style table real-time? | **No** — production lesson: history tables are REST-only; UI must read live tables for price. |
| WebSocket in browser? | **Never** — keys, rate limits, licensing. |

---

## 4. Enterprise monorepo layout

```text
prediction-market-poc/
├── README.md
├── WORKERS.md                  # authoritative worker map (update when behaviour changes)
├── .gitignore                  # .env, *.pem, node_modules — NEVER commit secrets
├── .env.example                # variable NAMES only, no values
├── package.json                # npm workspaces root
├── supabase/
│   ├── config.toml
│   └── migrations/             # numbered, never edit after merge
│       ├── 001_schema.sql
│       ├── 002_rls_policies.sql
│       ├── 003_realtime.sql
│       ├── 004_rpc_promote_hot.sql
│       ├── 005_bulk_upsert_helpers.sql   # optional RPCs for set-based writes
│       └── 006_retention.sql             # pg_cron purge jobs
├── backend/
│   ├── package.json
│   ├── WORKERS.md              # symlink or copy — keep in sync with root
│   ├── config/
│   │   ├── supabase.js         # service-role client, fail-fast, no session auth
│   │   ├── kalshi-key.js       # RSA key from env ONLY (never tracked file)
│   │   ├── providers.js        # series list, API base URLs, chunk sizes
│   │   └── intervals.js        # poll/flush/refresh constants (named, documented)
│   ├── lib/
│   │   ├── http-client.js      # timeout, retry, 429 backoff + jitter
│   │   ├── db-retry.js         # bounded retry for live inserts (never throw)
│   │   ├── bulk-upsert.js      # chunked upsert helper (batch 100–500)
│   │   ├── dead-letter.js      # in-memory retry queue for failed upserts
│   │   ├── ohlc.js             # pure OHLC + gap-fill + eviction (unit-tested)
│   │   ├── price-units.js      # Kalshi cents → 0–1 conversion
│   │   ├── guarded-interval.js # overlap guard for ALL setInterval jobs
│   │   ├── heartbeat.js        # worker_health upsert (fire-and-forget)
│   │   └── tiers.js            # demoteStale, hot-market queries
│   ├── workers/
│   │   ├── polymarket/
│   │   │   ├── events.js
│   │   │   ├── live-ws.js
│   │   │   └── history.js
│   │   ├── kalshi/
│   │   │   ├── events.js
│   │   │   ├── live-ws.js
│   │   │   └── history.js
│   │   └── maintenance/
│   │       └── retention.js
│   └── test/
│       ├── ohlc.test.js
│       ├── guarded-interval.test.js
│       ├── price-units.test.js
│       └── bulk-upsert.test.js
└── frontend/
    ├── package.json
    ├── .env.local.example
    ├── next.config.js
    ├── app/
    │   ├── page.tsx
    │   ├── events/[id]/page.tsx
    │   └── markets/[id]/page.tsx
    └── lib/
        ├── supabase/
        │   ├── client.ts       # browser client (anon key)
        │   └── server.ts       # server component client
        ├── queries.ts          # typed Supabase query helpers
        └── chart.ts            # lightweight-charts adapter
```

**No `backend/api/` folder.** Frontend reads Supabase directly.

---

## 5. Enterprise coding standards (mandatory)

These rules come from production `CLAUDE.md` and the code review. **Every POC worker and lib must follow them.**

### 5.1 Secrets & config

| Rule | Detail |
|------|--------|
| **No secrets in repo** | No API keys, PEM files, or `.env` in git. `.gitignore` must block `.env`, `.env.*`, `*.pem`, `*.key`. |
| **Kalshi key** | Load only via `config/kalshi-key.js` from `KALSHI_PRIVATE_KEY_B64` or `KALSHI_PRIVATE_KEY_PEM`. Fail fast at startup if missing. |
| **Supabase client** | Single `config/supabase.js` with `auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }`. |
| **Env documentation** | Every `process.env.*` used must appear in `.env.example` with a one-line comment. No real values. |
| **Frontend env** | Only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. **Never** expose service role key. |

### 5.2 Price units (critical)

| Source | Native unit | POC storage |
|--------|-------------|-------------|
| Polymarket (Gamma, CLOB, Data API) | probability **0–1** | store as-is |
| Kalshi REST / WS / candlesticks | **cents 0–100** (or dollars in some fields) | **normalize to 0–1** on write via `lib/price-units.js` |

- **One unit per column:** all `bid`, `ask`, `mid`, `last_price`, `open`, `high`, `low`, `close` are **0–1 probability**.
- Comment the unit at every read/write boundary in worker code.
- Never mix count and volume in one column.

### 5.3 Volume vs trade_count

| Column | Meaning |
|--------|---------|
| `volume` | Sum of real trade sizes only. If size is missing or ≤ 0, contribute **0**. |
| `trade_count` | +1 per trade event. Never add `1` to `volume` when size is missing. |

Production bug (CHT-02): worker 2 mixed count and volume. POC must use separate fields everywhere.

### 5.4 Database writes

| Rule | Threshold |
|------|-----------|
| **No per-row writes in loops** | Any write touching > ~50 rows → chunked bulk upsert or RPC |
| **Chunk sizes** | Upsert in batches of **100–500** rows (tune per table) |
| **Conflict keys** | Always specify `onConflict` explicitly |
| **Dead letter queue** | Failed batches go to in-memory queue; retry next cycle (see worker 1 pattern) |
| **Set-based updates** | Prefer SQL RPC for multi-row updates; fail loudly if RPC missing — no silent N+1 fallback |
| **Live inserts** | Use `lib/db-retry.js` — 3 attempts, 250ms → 1s backoff; log dropped rows, never throw |

### 5.5 Scheduling & concurrency

| Rule | Detail |
|------|--------|
| **Overlap guard** | **Every** `setInterval` job wrapped in `createGuardedInterval()`. No exceptions. |
| **Cadence vs runtime** | Schedule interval must be **longer than worst-case cycle time** at expected scale. If a full-catalog job takes 20 min, do not schedule every 5 min. |
| **Hot tier only** | WebSocket subscriptions and aggressive history backfill only for `ingestion_tier = 'hot'`. |
| **Incremental after cold** | First run = full sync; subsequent runs = incremental (`min_updated_ts` for Kalshi, `updatedAt` watermark for Polymarket). |

### 5.6 Memory discipline

| In-memory map | Eviction rule |
|---------------|---------------|
| OHLC buckets per token/ticker | Evict after **24h** with no real tick (`ohlc.shouldEvict`) |
| `lastKnownClose` for gap-fill | Evict with same 24h rule |
| Order books per token | Evict with same 24h rule (production worker 2 leak) |
| Dead letter queues | Bounded; log if queue exceeds 10,000 rows |
| WS connection state | Max tokens per connection chunk (250 Polymarket); diff subscribe/unsubscribe |

### 5.7 OHLC gap-fill

When a market is quiet between candle buckets:

1. Synthesize flat candles (`open = high = low = close = lastKnownClose`, `volume = 0`, `trade_count = 0`).
2. Fill **every** missing bucket between last written and current — **capped at 36 buckets (3 hours)**.
3. If gap exceeds cap, fill only the most recent 36 and log a warning once per token.
4. Constants: `GAP_FILL_CAP = 36`, `TOKEN_EVICTION_MS = 24h` — named at top of file.

Production bug (CHT-03): only one bucket was filled; memory grew forever.

### 5.8 Error handling & observability

| Rule | Detail |
|------|--------|
| **No silent catches** | Every `catch` logs: `[worker-name] operation identifier: err.message` |
| **Heartbeat on every worker** | `reportCycle(name, rows)` each cycle; `reportError(name, err)` on failure |
| **Fire-and-forget heartbeat** | Heartbeat failure must never crash a worker |
| **Structured logs** | Include ISO timestamp, worker id, rows written, duration ms |

### 5.9 External API etiquette

| Rule | Detail |
|------|--------|
| **Timeout** | Every `fetch` uses `AbortController` (default 15s) |
| **Retry** | 3 attempts with exponential backoff + jitter |
| **429 handling** | Respect `Retry-After` header or `attempt * 2000ms` backoff |
| **Rate pacing** | `REQUEST_DELAY_MS` between sequential API calls (e.g. 600ms for Kalshi history) |
| **Licensing** | Do not add new endpoints that redistribute raw exchange data beyond existing patterns |

### 5.10 Migrations & schema

| Rule | Detail |
|------|--------|
| **Numbered SQL** | `supabase/migrations/00N_name.sql` — never edit after merge |
| **Retention in migrations** | pg_cron jobs defined in SQL, not assumed |
| **Idempotent cron** | `cron.schedule('job-name', ...)` updates in place if name exists |
| **Index every hot query** | `(market_id, interval, ts DESC)`, `(provider_id, status)`, `(ingestion_tier, status)` |

### 5.11 Testing & CI

| Rule | Detail |
|------|--------|
| **Unit tests** | `lib/ohlc.js`, `lib/guarded-interval.js`, `lib/price-units.js` — vitest |
| **Pre-PR check** | `node --check` on every modified `.js` file; `npm test` must pass |
| **No network in unit tests** | Pure logic only in `test/` |

---

## 6. Production anti-patterns — do NOT repeat

This is the **issue register from the production pipeline review**. Each row maps a real bug or gap to a **mandatory POC fix**.

### P0 — Critical (would break at scale or silently corrupt data)

| ID | Production bug | Where | POC mandatory fix |
|----|----------------|-------|-------------------|
| **P0-1** | History backfill runs on **full active catalog** (5a/5c load all `kalshi_markets`) | worker 5a, 5c | **Hot tier only** for history workers. Warm/cold markets never backfilled until user opens event. |
| **P0-2** | Kalshi warm poll **never wired** — `fetchUpdatedMarkets(min_updated_ts)` exists but `poll()` always calls `fetchWorldCupMarketsCold()` | worker 3 | After cold start, **always** use `min_updated_ts` warm poll. Track `lastPollTs` in memory or `market_ingestion_state`. Log `cold` vs `warm` each cycle. |
| **P0-3** | Polymarket WS **no subscription refresh** after startup; `handleNewMarket` only logs, does not subscribe or upsert | worker 2 | Refresh hot token list **every 5 min** (diff subscribe/unsubscribe). On `new_market` WS event: queue for Gamma re-fetch or direct upsert + subscribe on next refresh. |
| **P0-4** | Worker 5c scheduled **every 5 min** but iterates **all active tickers** sequentially with 600ms delay — cannot finish at 1K+ markets | worker 5c | Hot-only + overlap guard. If cycle exceeds interval, **skip** next run (guarded) and log warning. Batch 4 tickers per Kalshi request. |
| **P0-5** | **No retention** on `kalshi_price_history` / `polymarket_price_history` — DB grows forever | migrations | pg_cron + maintenance worker: live_ticks 6h; candles 1m 30d; 5m 90d; 1h/1d 2y; closed markets 30d grace. |
| **P0-6** | Volume/trade **unit mixing** in OHLC (`volume += 1` when size missing) | worker 2 | Separate `volume` and `trade_count` columns. `applyTrade()` in `lib/ohlc.js`. |
| **P0-7** | Gap-fill only **one** bucket + unbounded `lastKnownClose` memory | worker 2 | `computeGapFills()` up to 36 buckets + `shouldEvict()` after 24h idle. |
| **P0-8** | **World Cup hardcoded** for Kalshi — not config-driven | worker 3, 4 | `config/providers.js` series list. No hardcoded tournament names in worker body. |
| **P0-9** | `.env` / private keys **committed to repo** (SEC-01) | repo root | `.gitignore` + `kalshi-key.js` env-only + `.env.example`. |

### P1 — High (reliability, performance, ops)

| ID | Production bug | Where | POC mandatory fix |
|----|----------------|-------|-------------------|
| **P1-1** | **No overlap guard** on workers 1, 3, 5a, 5c scheduled polls | multiple | `createGuardedInterval()` on **every** `setInterval` in **every** worker. |
| **P1-2** | **N+1 DB updates** — PredictionHunt title sync loops per market | worker 3 | Bulk upsert only. No `for (...) { await supabase.update() }`. |
| **P1-3** | Polymarket backfill **one-shot only** (90d on start, never incremental) | worker 5b | History worker: incremental every 15 min for hot markets (last 2h lookback). |
| **P1-4** | `orderBooks` map **never evicted** — memory leak over weeks | worker 2 | Evict with `shouldEvict(lastRealTickAt, ...)` alongside OHLC state. |
| **P1-5** | **Live vs history confusion** — `kalshi_price_history` is REST, not real-time | docs/UI | UI reads `market_prices_latest` for price; `candles` for charts. Document in README. |
| **P1-6** | Heartbeats only on workers **2, 4, 6, 7** — others appear dead | multiple | `reportCycle` / `reportError` on **all** long-running workers. |
| **P1-7** | Per-row price sync loop before RPC existed | worker 7 | Use chunked RPC or bulk upsert. If RPC missing, **fail loudly** — no silent N+1. |
| **P1-8** | Momentum detector ran every **500ms** on 5m candles | worker 7 | N/A in POC (no signal engine). Lesson: **match job cadence to data granularity**. |
| **P1-9** | Empty `catch {}` blocks swallow errors | repo-wide | Every catch logs worker + operation + identifier. |
| **P1-10** | Leading spaces in `.env` break dotenv | deployment | Document: no leading/trailing whitespace on env lines. Validate at startup. |
| **P1-11** | `platform_id` key mismatch across writers (event id vs token id) | workers 2, 4, 6, 7 | POC uses `markets.id` (internal PK) as join key everywhere. Document external_id mapping per provider. |
| **P1-12** | Live tick inserts have no retry — rows dropped silently on transient DB error | workers 2, 4 | `insertWithRetry()` — 3 attempts; log dropped count. |

### P2 — Medium (POC should still address)

| ID | Production gap | POC fix |
|----|----------------|---------|
| **P2-1** | No `WORKERS.md` kept in sync | Maintain `WORKERS.md` at repo root with cadence, tables, env vars per worker. |
| **P2-2** | Inconsistent retry across workers | Single `lib/http-client.js` used by all REST workers. |
| **P2-3** | Frontend pagination missing on large event lists | Frontend queries use `.range(offset, offset+49)` with infinite scroll or paging. |
| **P2-4** | No env validation at startup | Each worker validates required env vars in `start()` before connecting. |
| **P2-5** | Kalshi `min_updated_ts` incompatible with other filters | Warm poll uses **only** `min_updated_ts` param; filter WC/series in application code after fetch. |

---

## 7. Supabase schema

Apply via `supabase/migrations/` (Supabase CLI `db push` or SQL Editor).

### 7.1 Tables

```sql
-- providers (manual seed)
CREATE TABLE providers (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,  -- 'polymarket', 'kalshi'
  name TEXT NOT NULL
);

CREATE TABLE events (
  id SERIAL PRIMARY KEY,
  provider_id INT REFERENCES providers(id),
  external_id TEXT NOT NULL,
  title TEXT,
  slug TEXT,
  category TEXT,
  close_time TIMESTAMPTZ,
  image_url TEXT,
  status TEXT,
  raw JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (provider_id, external_id)
);

CREATE TABLE markets (
  id SERIAL PRIMARY KEY,
  event_id INT REFERENCES events(id),
  provider_id INT REFERENCES providers(id),
  external_id TEXT NOT NULL,       -- polymarket market id OR kalshi ticker
  title TEXT,
  outcome_label TEXT,
  status TEXT,
  close_time TIMESTAMPTZ,
  token_ids JSONB,                 -- Polymarket CLOB token ids
  series_ticker TEXT,              -- Kalshi
  event_ticker TEXT,               -- Kalshi
  ingestion_tier TEXT NOT NULL DEFAULT 'cold',  -- 'hot' | 'warm' | 'cold'
  UNIQUE (provider_id, external_id)
);

-- High-churn: purge > 6h (pg_cron). No anon RLS.
CREATE TABLE live_ticks (
  id BIGSERIAL PRIMARY KEY,
  market_id INT REFERENCES markets(id),
  ts TIMESTAMPTZ NOT NULL,
  bid NUMERIC,       -- 0-1 probability
  ask NUMERIC,
  mid NUMERIC,
  last_price NUMERIC,
  volume NUMERIC
);

-- UI live price source. Realtime-enabled.
CREATE TABLE market_prices_latest (
  market_id INT PRIMARY KEY REFERENCES markets(id),
  bid NUMERIC,
  ask NUMERIC,
  mid NUMERIC,
  last_price NUMERIC,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Unified candles. All prices 0-1. volume = sum sizes; trade_count = event count.
CREATE TABLE candles (
  market_id INT REFERENCES markets(id),
  interval TEXT NOT NULL,    -- '1m' | '5m' | '1h' | '1d'
  ts TIMESTAMPTZ NOT NULL,
  open NUMERIC,
  high NUMERIC,
  low NUMERIC,
  close NUMERIC,
  volume NUMERIC DEFAULT 0,
  trade_count INT DEFAULT 0,
  PRIMARY KEY (market_id, interval, ts)
);

CREATE TABLE market_ingestion_state (
  market_id INT PRIMARY KEY REFERENCES markets(id),
  tier TEXT,
  last_backfill_at TIMESTAMPTZ,
  last_candle_ts JSONB,        -- { "1m": "...", "1h": "..." }
  last_poll_ts TIMESTAMPTZ     -- for warm REST polling watermark
);

CREATE TABLE worker_health (
  worker TEXT PRIMARY KEY,
  last_cycle_at TIMESTAMPTZ NOT NULL,
  last_cycle_rows INT,
  last_error TEXT,
  last_error_at TIMESTAMPTZ
);

-- Indexes (query patterns from frontend + workers)
CREATE INDEX idx_events_provider_status ON events(provider_id, status);
CREATE INDEX idx_events_updated_at ON events(updated_at DESC);
CREATE INDEX idx_markets_provider_tier ON markets(provider_id, status, ingestion_tier);
CREATE INDEX idx_markets_event_id ON markets(event_id);
CREATE INDEX idx_markets_hot ON markets(ingestion_tier) WHERE ingestion_tier = 'hot';
CREATE INDEX idx_candles_market_interval_ts ON candles(market_id, interval, ts DESC);
CREATE INDEX idx_live_ticks_market_ts ON live_ticks(market_id, ts DESC);
CREATE INDEX idx_live_ticks_ts ON live_ticks(ts);  -- for retention DELETE
```

### 7.2 RLS policies

```sql
ALTER TABLE providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE markets ENABLE ROW LEVEL SECURITY;
ALTER TABLE candles ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_prices_latest ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_ticks ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_ingestion_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_health ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon read providers" ON providers FOR SELECT TO anon USING (true);
CREATE POLICY "anon read events"    ON events    FOR SELECT TO anon USING (true);
CREATE POLICY "anon read markets"   ON markets   FOR SELECT TO anon USING (true);
CREATE POLICY "anon read candles"   ON candles   FOR SELECT TO anon USING (true);
CREATE POLICY "anon read latest"    ON market_prices_latest FOR SELECT TO anon USING (true);
-- live_ticks, worker_health, market_ingestion_state: no anon policy
```

### 7.3 Realtime

```sql
ALTER PUBLICATION supabase_realtime ADD TABLE market_prices_latest;
```

### 7.4 RPC — promote event to hot

```sql
CREATE OR REPLACE FUNCTION promote_event_to_hot(p_event_id INT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE markets
  SET ingestion_tier = 'hot'
  WHERE event_id = p_event_id
    AND status IN ('active', 'open');
  INSERT INTO market_ingestion_state (market_id, tier, last_backfill_at)
  SELECT id, 'hot', NULL FROM markets
  WHERE event_id = p_event_id AND status IN ('active', 'open')
  ON CONFLICT (market_id) DO UPDATE SET tier = 'hot';
END;
$$;
GRANT EXECUTE ON FUNCTION promote_event_to_hot(INT) TO anon;
```

### 7.5 Retention (pg_cron)

```sql
-- Requires pg_cron extension enabled in Supabase Dashboard
SELECT cron.schedule('purge-live-ticks', '0 * * * *', $$
  DELETE FROM live_ticks WHERE ts < NOW() - INTERVAL '6 hours';
$$);

SELECT cron.schedule('purge-candles-1m', '15 * * * *', $$
  DELETE FROM candles WHERE interval = '1m' AND ts < NOW() - INTERVAL '30 days';
$$);

SELECT cron.schedule('purge-candles-5m', '15 * * * *', $$
  DELETE FROM candles WHERE interval = '5m' AND ts < NOW() - INTERVAL '90 days';
$$);

SELECT cron.schedule('purge-candles-1h-1d', '0 3 * * *', $$
  DELETE FROM candles WHERE interval IN ('1h','1d') AND ts < NOW() - INTERVAL '2 years';
$$);
```

| Table / interval | Retention |
|------------------|-----------|
| `live_ticks` | **6 hours** |
| `candles` 1m | **30 days** |
| `candles` 5m | **90 days** |
| `candles` 1h / 1d | **2 years** |
| Closed/settled markets | Delete candles after **30 days** grace (maintenance worker) |

---

## 8. Shared library catalog

| Module | Purpose | Production lesson |
|--------|---------|-------------------|
| `config/supabase.js` | Service-role client, fail-fast | PIPE-06: disable session auth |
| `config/kalshi-key.js` | RSA key from env only | SEC-01: no tracked PEM files |
| `config/providers.js` | Series list, URLs, chunk sizes | P0-8: no hardcoded WC |
| `config/intervals.js` | Named constants for all timers | Avoid magic numbers |
| `lib/http-client.js` | fetch + timeout + retry + 429 | P2-2: consistent across workers |
| `lib/db-retry.js` | Live insert retry, never throw | P1-12, PIPE-04 |
| `lib/bulk-upsert.js` | Chunked upsert with onConflict | P1-2, PIPE-01 |
| `lib/dead-letter.js` | Failed batch queue + retry next cycle | worker 1 pattern |
| `lib/ohlc.js` | Buckets, gap-fill, eviction | CHT-02, CHT-03 |
| `lib/price-units.js` | `kalshiCentsToProb()`, `normalizePrice()` | Price unit rule |
| `lib/guarded-interval.js` | Overlap guard wrapper | P1-1, PIPE-03 |
| `lib/heartbeat.js` | `reportCycle`, `reportError` | P1-6, PIPE-05 |
| `lib/tiers.js` | `getHotMarkets()`, `demoteStale()` | P0-1, tier system |

### `lib/guarded-interval.js` (required pattern)

```js
function createGuardedInterval(name, fn, intervalMs) {
  let running = false;
  const guarded = async () => {
    if (running) {
      console.warn(`[${name}] previous run still in progress — skipping`);
      return;
    }
    running = true;
    const t0 = Date.now();
    try {
      const rows = await fn();
      await reportCycle(name, rows ?? null);
    } catch (err) {
      console.error(`[${name}] failed:`, err.message);
      await reportError(name, err);
    } finally {
      running = false;
      console.log(`[${name}] cycle done in ${Date.now() - t0}ms`);
    }
  };
  return { start: () => { guarded(); return setInterval(guarded, intervalMs); } };
}
```

### `lib/bulk-upsert.js` (required pattern)

```js
async function upsertBatched(supabase, table, rows, { onConflict, batchSize = 200 }) {
  let written = 0;
  const failed = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase.from(table).upsert(batch, { onConflict, ignoreDuplicates: false });
    if (error) { failed.push(...batch); console.error(`[bulk-upsert] ${table} batch failed:`, error.message); }
    else written += batch.length;
  }
  return { written, failed };
}
```

---

## 9. Tech stack

| Layer | Choice |
|-------|--------|
| Backend workers | Node 20+, CommonJS |
| Database | **Supabase Postgres** (hosted, EU region preferred) |
| Worker DB client | `@supabase/supabase-js` + `SUPABASE_SERVICE_ROLE_KEY` |
| Frontend DB client | `@supabase/supabase-js` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| Live updates | Supabase Realtime on `market_prices_latest` |
| WebSocket (workers) | `ws` package |
| Frontend | Next.js 14+ App Router + lightweight-charts |
| Monorepo | npm workspaces |
| Migrations | Supabase CLI (`supabase db push`) |
| Tests | vitest (`backend/test/`) |
| Deploy | Workers as separate processes (Render / Railway / systemd) |

---

## 10. Step-by-step prompts

Run in order in a **new empty repo**. Complete and test each step before the next.

---

### Prompt 0 — Bootstrap monorepo + Supabase + enterprise scaffold

```text
Create monorepo `prediction-market-poc` with enterprise structure from POC_BUILD_GUIDE.md section 4:

- npm workspaces: ["backend", "frontend"]
- NO docker-compose Postgres — use Supabase hosted Postgres
- .gitignore: node_modules, .env, .env.*, *.pem, *.key, .DS_Store
- .env.example: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY, KALSHI_API_KEY_ID, KALSHI_PRIVATE_KEY_B64 (names only, no values)
- supabase/migrations/ (empty placeholder)
- backend/config/, backend/lib/, backend/workers/, backend/test/
- frontend/lib/supabase/
- WORKERS.md stub table (empty rows to fill later)
- README: Supabase project setup, migration apply, worker run, frontend run

Do NOT implement workers yet. Scaffold only.
Follow section 5 enterprise coding standards from the guide.
```

---

### Prompt 1 — Supabase schema, RLS, Realtime, RPC, retention

```text
In prediction-market-poc, create all supabase/migrations/ from POC_BUILD_GUIDE.md section 7:

001_schema.sql — all tables + indexes (note: prices are 0-1 probability)
002_rls_policies.sql — anon read on public tables only
003_realtime.sql — market_prices_latest in supabase_realtime publication
004_rpc_promote_hot.sql — promote_event_to_hot() with market_ingestion_state upsert
006_retention.sql — pg_cron jobs (purge-live-ticks, purge-candles-*)

supabase/seed.sql — INSERT providers (polymarket, kalshi)

backend/config/supabase.js:
  - createClient with service role
  - auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  - throw if SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing

Verify:
  - anon key can SELECT events
  - anon key cannot INSERT events
  - service role can upsert markets
  - promote_event_to_hot RPC works
```

---

### Prompt 2 — Shared libraries (enterprise lib catalog)

```text
Implement ALL libs from POC_BUILD_GUIDE.md section 8:

1. lib/http-client.js — fetchWithRetry, AbortController 15s timeout, 429 backoff + jitter
2. lib/db-retry.js — insertWithRetry (3 attempts, 250ms→1s, never throw)
3. lib/bulk-upsert.js — upsertBatched(table, rows, onConflict, batchSize=200)
4. lib/dead-letter.js — queue failed rows, retry next cycle, log if >10000
5. lib/ohlc.js — getBucketMs, applyTick, applyTrade, computeGapFills (cap 36),
   shouldEvict (24h), aggregateCandles (1m→5m→1h→1d)
6. lib/price-units.js — kalshiCentsToProb(cents), normalizePrice(provider, raw)
7. lib/guarded-interval.js — createGuardedInterval with heartbeat integration
8. lib/heartbeat.js — reportCycle, reportError (fire-and-forget, never throw)
9. lib/tiers.js — getHotMarkets(), demoteStale()
10. config/kalshi-key.js — B64/PEM env only, fail fast
11. config/intervals.js — all timer constants named and documented

Vitest tests: ohlc.test.js, guarded-interval.test.js, price-units.test.js
npm test must pass.
```

---

### Prompt 3 — Polymarket events worker

```text
Create backend/workers/polymarket/events.js:

- Poll Gamma API: GET /events?active=true&closed=false&limit=50&offset=...
- Use lib/http-client.js, lib/bulk-upsert.js, lib/dead-letter.js
- Upsert events + markets (provider polymarket)
- markets.external_id = polymarket market id; token_ids in JSONB
- Default ingestion_tier = 'warm'
- Poll every 60s via createGuardedInterval (NOT bare setInterval) — fixes P1-1
- reportCycle + reportError each cycle — fixes P1-6
- Track lastSeenTs watermark for future incremental optimization
- Validate SUPABASE_URL at startup — fixes P2-4

npm script: "worker:poly:events"
Update WORKERS.md row for this worker.
```

---

### Prompt 4 — Kalshi events worker (warm poll wired correctly)

```text
Create backend/workers/kalshi/events.js:

CRITICAL — fix production P0-2 and P0-8:
- Series list from config/providers.js (NOT hardcoded World Cup)
- Auth via config/kalshi-key.js
- COLD START (isFirstPoll=true): full fetch for configured series
- WARM POLL (isFirstPoll=false): fetchUpdatedMarkets(min_updated_ts) ONLY
  Kalshi rule: min_updated_ts cannot be combined with other API filters — post-filter in app code (P2-5)
- Store lastPollTs in market_ingestion_state or worker memory
- Upsert via bulk-upsert.js — NO per-row update loops (P1-2)
- Poll every 30m with createGuardedInterval
- reportCycle + reportError every cycle

npm script: "worker:kalshi:events"
Update WORKERS.md.
```

---

### Prompt 5 — Tier promotion (Supabase RPC only)

```text
Tier promotion — NO REST API (fixes architecture requirement):

1. Migration 004_rpc_promote_hot.sql already applied
2. lib/tiers.js:
   - demoteStale(): closed/settled markets → tier 'cold'; called from maintenance worker
   - getHotMarkets(provider): query for live-ws workers
3. Document frontend: supabase.rpc('promote_event_to_hot', { p_event_id: eventId })
4. Do NOT create backend/api/server.js

Rule: only HOT markets get WebSocket + history backfill (fixes P0-1, P0-4).
```

---

### Prompt 6 — Polymarket live WebSocket worker

```text
Create backend/workers/polymarket/live-ws.js:

CRITICAL — fix production P0-3, P0-6, P0-7, P1-4, P1-12:
- Load HOT markets only via lib/tiers.js
- wss://ws-subscriptions-clob.polymarket.com/ws/market
- Subscribe token_ids in chunks of 250
- Refresh hot subscription list every 5 MIN — diff subscribe/unsubscribe (P0-3)
- On new_market WS event: add to pending queue; process on next refresh (not just log)
- On market_resolved: update markets.status = closed via supabase
- In-memory: OHLC buckets, lastKnownClose, lastRealTickAt, orderBooks
- Evict all per-token state after 24h idle via ohlc.shouldEvict (P0-7, P1-4)
- Gap-fill up to 36 buckets on flush (P0-7)
- volume vs trade_count separate — use lib/ohlc.js applyTrade (P0-6)
- Flush every 1s: live_ticks via insertWithRetry (P1-12) + upsert market_prices_latest
- Flush every 60s: close 1m buckets → upsert candles interval='1m'
- WS PING/PONG with reconnect on timeout
- reportCycle every 60s

npm script: "worker:poly:live"
Do NOT store raw WS JSON.
```

---

### Prompt 7 — Kalshi live WebSocket worker

```text
Create backend/workers/kalshi/live-ws.js:

- wss://api.elections.kalshi.com/trade-api/ws/v2 with signed headers
- HOT markets only (lib/tiers.js)
- Subscribe ticker + trade channels
- Refresh hot tickers every 5 min (diff subscribe/unsubscribe)
- Sequence gap detection → resubscribe channel
- Normalize all prices to 0-1 via lib/price-units.js on write
- Flush live_ticks (insertWithRetry) + market_prices_latest every 1s
- Build 1m candles with lib/ohlc.js (volume/trade_count separate)
- Evict idle ticker state after 24h
- reportCycle + reportError

npm script: "worker:kalshi:live"
```

---

### Prompt 8 — History workers (hot tier, incremental, overlap-guarded)

```text
Create history workers — fix P0-1, P0-4, P1-3:

polymarket/history.js:
- Query markets WHERE ingestion_tier='hot' ONLY
- Polymarket Data API /trades → 1m candles → aggregate to 5m, 1h, 1d via lib/ohlc.js
- Lookback: 1m/5m: 7d; 1h: 90d; 1d: 365d
- INCREMENTAL every 15 min (last 2h) — NOT one-shot only (P1-3)
- On first hot promotion: deeper one-shot backfill for that market
- createGuardedInterval — if cycle > 15min, skip next (P0-4)
- bulk-upsert candles in batches of 200
- Update market_ingestion_state.last_backfill_at + last_candle_ts
- REQUEST_DELAY_MS between API calls

kalshi/history.js:
- HOT markets only
- Kalshi REST candlesticks, batch 4 tickers per request
- Normalize prices to 0-1 via price-units.js
- Same incremental + guarded rules
- 429 backoff via http-client.js

npm scripts: worker:poly:history, worker:kalshi:history
```

---

### Prompt 9 — Retention + maintenance

```text
1. pg_cron in 006_retention.sql (primary)
2. backend/workers/maintenance/retention.js (fallback, hourly, guarded):
   - DELETE live_ticks > 6h
   - DELETE candles by interval retention policy
   - DELETE candles for closed markets > 30d grace
   - tiers.demoteStale()
   - reportCycle with deleted row counts

npm script: "worker:maintenance"
Document in README: live tables assume ≤6h data (PIPE-04 lesson).
```

---

### Prompt 10 — Frontend (Supabase direct, optimized queries)

```text
Create frontend/ Next.js 14 — NO REST API:

1. lib/supabase/client.ts — createBrowserClient (anon key only)
2. lib/supabase/server.ts — createServerClient for SSR
3. lib/queries.ts:
   - getProviders(), getEvents(providerSlug, { page, limit })
   - getEventMarkets(eventId) with market_prices_latest join
   - getCandles(marketId, interval, from, to) — use index-friendly filters
   - promoteEventToHot(eventId) → rpc('promote_event_to_hot')
4. Pagination on event list — .range(offset, offset+49) (P2-3)
5. /events/[id]: call promoteEventToHot on mount
6. /markets/[id]:
   - Realtime on market_prices_latest (filter market_id=eq.{id})
   - Fallback poll every 2s
   - lightweight-charts candlestick
   - Interval selector 1m|5m|1h|1d
   - Show "Backfilling..." if candles empty; show updated_at if stale
7. NEVER import SUPABASE_SERVICE_ROLE_KEY (P0-9)
8. Env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY

Dark responsive UI. No auth in POC.
```

---

### Prompt 11 — Dev experience, WORKERS.md, validation

```text
1. Complete WORKERS.md: every worker, cadence, reads, writes, env vars (P2-1)
2. Root scripts:
   "dev:migrate": "supabase db push"
   "dev:workers": concurrently all workers
   "dev:frontend": "npm run dev -w frontend"
   "test": "npm test -w backend"
3. README demo flow + env validation notes (no leading spaces — P1-10)
4. Startup env check script or shared validateEnv() in config/
5. Split env files:
   backend/.env — service role + kalshi keys
   frontend/.env.local — anon key only
```

---

### Prompt 12 — Tests + full acceptance checklist

```text
Vitest: ohlc, guarded-interval, price-units, bulk-upsert

Manual checklist in README (maps to section 11):
1. Polymarket event appears within 60s
2. Open event → RPC hot → Realtime price within 3s
3. Chart 1m within 2 min of promote
4. Chart 1h backfills within 15 min (hot only)
5. Warm poll logs "warm" not "cold" on Kalshi events worker cycle 2+
6. Overlap guard logs "skipping" if cycle overlaps
7. live_ticks purged after 6h
8. Both providers in UI
9. Anon cannot write; service role never in frontend bundle
10. worker_health shows all workers reporting
11. 1000+ warm markets: history worker does NOT process all (hot only)
```

---

## 11. Scenarios & acceptance criteria

| # | Scenario | Expected behavior |
|---|----------|-------------------|
| S1 | User browses events | Supabase `.from('events')` with pagination; no exchange calls |
| S2 | User opens event | RPC promotes hot; live worker subscribes within 5 min |
| S3 | Live price | Realtime on `market_prices_latest`; updates 1–3s |
| S4 | Chart intervals | Same component; `candles` filtered by `interval` |
| S5 | New market after workers up | Events worker upserts; live picks up on next 5m refresh |
| S6 | 10K inactive events | Stay warm/cold; no WS; no history backfill |
| S7 | API 429 | Backoff; worker survives; logs warning |
| S8 | Long run (days) | Memory stable (24h eviction); retention keeps DB bounded |
| S9 | Provider down | `worker_health.last_error` set; UI shows stale `updated_at` |
| S10 | Security | RLS blocks anon writes; service role not in browser |
| S11 | Kalshi warm poll | Cycle 2+ uses `min_updated_ts`, not full cold fetch |
| S12 | Overlap | Second poll skipped if first still running |
| S13 | DB blip | Live inserts retried; dropped rows logged |

---

## 12. Improvements vs current production pipeline

| Production issue | POC fix |
|------------------|---------|
| Kalshi WC hardcode | `config/providers.js` series list |
| Worker 3 warm poll unused | `min_updated_ts` after cold start |
| Worker 2 no subscription refresh | 5 min hot-market diff refresh |
| 5c every 5 min on all tickers | Hot only + overlap guard + 15 min history cadence |
| No history retention | pg_cron + maintenance worker |
| Separate `*_price_history` tables | Unified `candles` + `market_prices_latest` |
| No ingestion tier | RPC hot on event page open |
| N+1 DB updates | `bulk-upsert.js` everywhere |
| Volume/count mixing | `lib/ohlc.js` separate fields |
| Gap-fill / memory leaks | `computeGapFills` + `shouldEvict` |
| Missing heartbeats | All workers use `lib/heartbeat.js` |
| Missing overlap guards | All intervals use `guarded-interval.js` |
| Custom REST API layer | Frontend reads Supabase directly |
| Inconsistent retry | Shared `http-client.js` + `db-retry.js` |
| Committed secrets | `.gitignore` + env-only keys |

---

## 13. One-shot mega prompt

```text
Build complete monorepo "prediction-market-poc" per POC_BUILD_GUIDE.md v1.2:

ARCHITECTURE:
- Supabase Postgres (hosted, NOT docker). Frontend reads via anon key + Realtime.
- Backend workers use service role. NO custom REST API.
- npm workspaces: backend + frontend

ENTERPRISE REQUIREMENTS (section 5):
- All prices stored 0-1. Kalshi converted via price-units.js.
- volume vs trade_count separate. No per-row DB loops. Bulk upsert chunks of 200.
- createGuardedInterval on EVERY setInterval. Heartbeat on EVERY worker.
- insertWithRetry for live_ticks. dead-letter queue for failed upserts.
- ohlc.js: gap-fill cap 36, eviction 24h. Memory bounds on all per-token maps.
- kalshi-key.js env only. .gitignore blocks secrets.

ANTI-PATTERNS TO AVOID (section 6):
- NO full-catalog history backfill — hot tier only
- NO warm poll skipped — Kalshi min_updated_ts after cold start
- NO WS without 5min subscription refresh
- NO handleNewMarket that only logs
- NO history schedule faster than cycle can complete
- NO retention missing on live_ticks or candles

WORKERS:
polymarket/events (60s guarded), polymarket/live-ws, polymarket/history (15m guarded),
kalshi/events (30m guarded, warm poll), kalshi/live-ws, kalshi/history,
maintenance/retention

SUPABASE:
migrations: schema, RLS, realtime, promote_event_to_hot RPC, pg_cron retention
Indexes on all hot query paths.

FRONTEND:
Next.js 14, Supabase client, Realtime on market_prices_latest,
candlestick chart (lightweight-charts), pagination, promote RPC on event open.

TESTS: vitest for ohlc, guarded-interval, price-units.
DOCS: WORKERS.md, README demo flow, .env.example.

Deliver: supabase db push, npm test, npm run dev:workers, npm run dev:frontend
```

---

## 14. Client demo script

1. **Supabase Dashboard** — show `providers`, `events`, `markets` populated.
2. **RLS** — show anon key can read, cannot write.
3. **UI event list** — data from Supabase client (network tab shows `supabase.co`, not exchange APIs).
4. **Open event** — `promote_event_to_hot` RPC; show `ingestion_tier = hot` in Table Editor.
5. **Live price** — Realtime updates on market page without refresh.
6. **Chart** — switch 1m → 5m → 1h → 1d from `candles` table.
7. **worker_health** — all workers reporting `last_cycle_at`.
8. **Retention** — show pg_cron jobs; `live_ticks` row count bounded.
9. **Scale story** — 10K warm markets: only 3–5 hot; WS and history load is controlled.

---

## 15. Production pipeline assessment (reference)

### What works well in production (keep these patterns)

- Workers → Supabase Postgres → UI architecture
- WebSocket live path (workers 2 & 4) with processed snapshots (not raw JSON)
- Bulk upserts with explicit conflict keys (worker 1, 6)
- Live tick 6h purge via pg_cron (migration 004)
- Signal engine overlap guards (worker 7)
- Unit-tested OHLC logic (`lib/ohlc.js`)
- `config/supabase.js` with session auth disabled
- `lib/db-retry.js` for live inserts
- `lib/heartbeat.js` pattern

### Observation corrections

| Claim | Reality |
|-------|---------|
| "No retry on API failure" | Partial — exists in 5a/5c/5b, db-retry, dead-letter; not universal |
| "No rate limit handling" | Partial — delays, 429 backoff; gaps at scale on unguarded workers |
| "Static World Cup only" | Kalshi WC-only in prod; Polymarket is full catalog |
| "No automated delete" | Live tables yes (6h); history tables no |
| "No real-time DB" | Supabase Realtime used on frontend; workers write to Postgres |

---

## 16. Operational runbook

### Startup order

1. Apply Supabase migrations + seed providers
2. Start `polymarket/events` + `kalshi/events` — wait for rows in Table Editor
3. Start `maintenance/retention`
4. Start frontend
5. User opens event in UI → triggers hot promotion
6. Start `polymarket/live-ws` + `kalshi/live-ws` + history workers

### Health checks

```sql
-- All workers alive?
SELECT worker, last_cycle_at, last_error, last_error_at
FROM worker_health ORDER BY last_cycle_at DESC;

-- Hot market count (should be small)
SELECT COUNT(*) FROM markets WHERE ingestion_tier = 'hot';

-- Live tick age (should be < 6h)
SELECT MAX(ts) FROM live_ticks;

-- Candle coverage for a market
SELECT interval, COUNT(*), MIN(ts), MAX(ts)
FROM candles WHERE market_id = :id GROUP BY interval;
```

### When something breaks

| Symptom | Check |
|---------|-------|
| No live price | `worker_health` for live-ws workers; `ingestion_tier`; Realtime publication |
| Empty chart | History worker running? `market_ingestion_state.last_backfill_at` |
| DB growing fast | pg_cron enabled? maintenance worker running? |
| Worker "stuck" | Overlap guard skipping? Check logs for cycle duration |
| Kalshi auth fail | `KALSHI_PRIVATE_KEY_B64` set? No leading spaces in `.env` |

---

## Quick reference: worker catalog

| Worker | Cadence | Guarded? | Heartbeat? | Hot only? | Writes |
|--------|---------|----------|------------|-----------|--------|
| `polymarket/events.js` | 60s | yes | yes | n/a | `events`, `markets` |
| `kalshi/events.js` | 30m | yes | yes | n/a | `events`, `markets` |
| `polymarket/live-ws.js` | WS + 1s flush | n/a | yes | **yes** | `live_ticks`, `market_prices_latest`, `candles` 1m |
| `kalshi/live-ws.js` | WS + 1s flush | n/a | yes | **yes** | same |
| `polymarket/history.js` | 15m | yes | yes | **yes** | `candles` all intervals |
| `kalshi/history.js` | 15m | yes | yes | **yes** | `candles` all intervals |
| `maintenance/retention.js` | 1h | yes | yes | n/a | DELETE old rows |

---

## Environment variables

### Backend (`backend/.env`)

```env
# Supabase — service role (workers ONLY — never in frontend)
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=

# Kalshi — env only, never commit PEM files
KALSHI_API_KEY_ID=
KALSHI_PRIVATE_KEY_B64=
```

### Frontend (`frontend/.env.local`)

```env
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

**Note:** No leading/trailing whitespace on any line. Polymarket public APIs need no key.

---

*Document version: 1.2 — June 2026 (Supabase + enterprise standards + production anti-patterns)*
