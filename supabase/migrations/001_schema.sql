-- 001_schema.sql — core tables and indexes
-- All price columns store probability 0-1 (Kalshi normalized on write in workers)

CREATE TABLE providers (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
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
  external_id TEXT NOT NULL,
  title TEXT,
  outcome_label TEXT,
  status TEXT,
  close_time TIMESTAMPTZ,
  token_ids JSONB,
  condition_id TEXT,
  series_ticker TEXT,
  event_ticker TEXT,
  ingestion_tier TEXT NOT NULL DEFAULT 'cold',
  UNIQUE (provider_id, external_id)
);

-- High-churn: purge > 6h (pg_cron). No anon RLS.
CREATE TABLE live_ticks (
  id BIGSERIAL PRIMARY KEY,
  market_id INT REFERENCES markets(id),
  ts TIMESTAMPTZ NOT NULL,
  bid NUMERIC,
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

-- Unified candles. volume = sum sizes; trade_count = event count.
CREATE TABLE candles (
  market_id INT REFERENCES markets(id),
  interval TEXT NOT NULL,
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
  last_candle_ts JSONB,
  last_poll_ts TIMESTAMPTZ
);

CREATE TABLE worker_health (
  worker TEXT PRIMARY KEY,
  last_cycle_at TIMESTAMPTZ NOT NULL,
  last_cycle_rows INT,
  last_error TEXT,
  last_error_at TIMESTAMPTZ
);

CREATE INDEX idx_events_provider_status ON events(provider_id, status);
CREATE INDEX idx_events_updated_at ON events(updated_at DESC);
CREATE INDEX idx_markets_provider_tier ON markets(provider_id, status, ingestion_tier);
CREATE INDEX idx_markets_event_id ON markets(event_id);
CREATE INDEX idx_markets_hot ON markets(ingestion_tier) WHERE ingestion_tier = 'hot';
CREATE INDEX idx_markets_condition_id ON markets(condition_id) WHERE condition_id IS NOT NULL;
CREATE INDEX idx_candles_market_interval_ts ON candles(market_id, interval, ts DESC);
CREATE INDEX idx_live_ticks_market_ts ON live_ticks(market_id, ts DESC);
CREATE INDEX idx_live_ticks_ts ON live_ticks(ts);
