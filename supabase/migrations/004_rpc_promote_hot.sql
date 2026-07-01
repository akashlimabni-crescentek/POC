-- 004_rpc_promote_hot.sql — promote event markets to hot tier

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
