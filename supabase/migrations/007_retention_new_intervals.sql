-- 007_retention_new_intervals.sql — pg_cron purge jobs for 15m / 4h / 1w
-- Mirrors CANDLE_RETENTION_MS in backend/lib/retention.js.
-- 15m follows the 5m policy (90 days); 4h and 1w follow the 1h/1d policy (2 years).

SELECT cron.schedule(
  'purge-candles-15m',
  '15 * * * *',
  $$DELETE FROM candles WHERE interval = '15m' AND ts < NOW() - INTERVAL '90 days';$$
);

SELECT cron.schedule(
  'purge-candles-4h-1w',
  '0 3 * * *',
  $$DELETE FROM candles WHERE interval IN ('4h', '1w') AND ts < NOW() - INTERVAL '2 years';$$
);
