-- Seed providers (run after migrations)

INSERT INTO providers (slug, name) VALUES
  ('polymarket', 'Polymarket'),
  ('kalshi', 'Kalshi')
ON CONFLICT (slug) DO NOTHING;
