-- 002_rls_policies.sql — anon read on public tables only

ALTER TABLE providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE markets ENABLE ROW LEVEL SECURITY;
ALTER TABLE candles ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_prices_latest ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_ticks ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_ingestion_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_health ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon read providers" ON providers FOR SELECT TO anon USING (true);
CREATE POLICY "anon read events" ON events FOR SELECT TO anon USING (true);
CREATE POLICY "anon read markets" ON markets FOR SELECT TO anon USING (true);
CREATE POLICY "anon read candles" ON candles FOR SELECT TO anon USING (true);
CREATE POLICY "anon read latest" ON market_prices_latest FOR SELECT TO anon USING (true);

-- live_ticks, worker_health, market_ingestion_state: no anon policy (blocked by RLS)
