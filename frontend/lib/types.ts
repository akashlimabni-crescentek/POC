export type Provider = {
  id: number;
  slug: string;
  name: string;
};

export type ProviderRef = {
  slug: string;
  name: string;
};

export type EventRow = {
  id: number;
  provider_id: number;
  external_id: string;
  title: string | null;
  slug: string | null;
  category: string | null;
  close_time: string | null;
  status: string | null;
  updated_at: string | null;
  providers?: ProviderRef | ProviderRef[] | null;
};

export type MarketPriceLatest = {
  market_id: number;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  last_price: number | null;
  updated_at: string | null;
};

export type MarketRow = {
  id: number;
  event_id: number | null;
  provider_id: number;
  external_id: string;
  title: string | null;
  outcome_label: string | null;
  status: string | null;
  close_time: string | null;
  ingestion_tier: string;
  market_prices_latest?: MarketPriceLatest | MarketPriceLatest[] | null;
  events?: { id: number; title: string | null } | { id: number; title: string | null }[] | null;
  providers?: ProviderRef | ProviderRef[] | null;
};

export type CandleRow = {
  market_id: number;
  interval: string;
  ts: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  trade_count: number | null;
};

export type CandleInterval = '1m' | '5m' | '1h' | '1d';

export type LiveTickRow = {
  id?: number;
  market_id: number;
  ts: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  last_price: number | null;
  volume: number | null;
};

export type MarketIngestionStateRow = {
  market_id: number;
  tier: string | null;
  last_backfill_at: string | null;
  last_candle_ts: Record<string, string> | null;
  last_poll_ts: string | null;
};
