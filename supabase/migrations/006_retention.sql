-- 006_retention.sql — pg_cron purge jobs
-- Requires pg_cron extension enabled in Supabase Dashboard → Database → Extensions

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

GRANT USAGE ON SCHEMA cron TO postgres;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron TO postgres;

SELECT cron.schedule(
  'purge-live-ticks',
  '0 * * * *',
  $$DELETE FROM live_ticks WHERE ts < NOW() - INTERVAL '6 hours';$$
);

SELECT cron.schedule(
  'purge-candles-1m',
  '15 * * * *',
  $$DELETE FROM candles WHERE interval = '1m' AND ts < NOW() - INTERVAL '30 days';$$
);

SELECT cron.schedule(
  'purge-candles-5m',
  '15 * * * *',
  $$DELETE FROM candles WHERE interval = '5m' AND ts < NOW() - INTERVAL '90 days';$$
);

SELECT cron.schedule(
  'purge-candles-1h-1d',
  '0 3 * * *',
  $$DELETE FROM candles WHERE interval IN ('1h', '1d') AND ts < NOW() - INTERVAL '2 years';$$
);

-- Closed-market candle purge (30d after close_time) runs in maintenance/retention.js.
-- pg_cron does not cover per-market grace; the hourly worker is authoritative for that rule.
