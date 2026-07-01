-- 003_realtime.sql — enable Realtime on market_prices_latest

ALTER PUBLICATION supabase_realtime ADD TABLE market_prices_latest;
