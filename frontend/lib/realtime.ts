import type { SupabaseClient } from '@supabase/supabase-js';
import type { LiveTickRow, MarketIngestionStateRow, MarketPriceLatest } from './types';

export type RealtimeUnsubscribe = () => void;

const LOG = '[WebSocket]';

type PostgresHandler<T> = (row: T) => void;

type RealtimePayload = {
  eventType?: string;
  schema?: string;
  table?: string;
  new: unknown;
  old?: unknown;
};

function handlePayload<T extends { market_id: number }>(
  channelName: string,
  table: string,
  payload: RealtimePayload,
  onUpdate: PostgresHandler<T>
): void {
  if (!payload.new || typeof payload.new !== 'object') {
    return;
  }

  const row = payload.new as T;

  console.log(`${LOG} data received`, {
    table,
    channel: channelName,
    event: payload.eventType ?? 'UNKNOWN',
    schema: payload.schema ?? 'public',
    market_id: row.market_id,
    receivedAt: new Date().toISOString(),
    data: row,
    previous: payload.old ?? null,
  });

  onUpdate(row);
}

function realtimeApiUrl(): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/$/, '');
  return base ? `${base}/realtime/v1/websocket` : 'unknown';
}

function logSubscribeStatus(
  table: string,
  channelName: string,
  marketIds: number[],
  status: string,
  err?: Error
): void {
  const subscription = {
    status,
    api: realtimeApiUrl(),
    channel: channelName,
    table,
    schema: 'public',
    event: '*',
    marketIds,
    filters: marketIds.map((id) => `market_id=eq.${id}`),
  };

  if (status === 'SUBSCRIBED') {
    console.log(`${LOG} subscribed (waiting for data)`, subscription);
    return;
  }

  if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
    console.error(`${LOG} subscription failed`, { ...subscription, error: err?.message });
    return;
  }

  if (status === 'CLOSED') {
    console.log(`${LOG} closed`, subscription);
  }
}

function subscribeTable<T extends { market_id: number }>(
  supabase: SupabaseClient,
  channelName: string,
  table: 'market_prices_latest' | 'live_ticks' | 'market_ingestion_state',
  marketId: number,
  onUpdate: PostgresHandler<T>
): RealtimeUnsubscribe {
  const channel = supabase
    .channel(channelName)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table,
        filter: `market_id=eq.${marketId}`,
      },
      (payload) => {
        console.log(`${LOG} raw event`, {
          table,
          channel: channelName,
          event: payload.eventType,
          hasNew: payload.new != null,
          hasOld: payload.old != null,
        });
        handlePayload(channelName, table, payload, onUpdate);
      }
    )
    .subscribe((status, err) => {
      logSubscribeStatus(table, channelName, [marketId], status, err);
    });

  return () => {
    console.log(`${LOG} unsubscribed`, { channel: channelName, table, marketIds: [marketId] });
    supabase.removeChannel(channel);
  };
}

function subscribeTableMany<T extends { market_id: number }>(
  supabase: SupabaseClient,
  channelName: string,
  table: 'market_prices_latest' | 'live_ticks' | 'market_ingestion_state',
  marketIds: number[],
  onUpdate: PostgresHandler<T>
): RealtimeUnsubscribe {
  if (!marketIds.length) {
    return () => {};
  }

  let channel = supabase.channel(channelName);

  for (const marketId of marketIds) {
    channel = channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table,
        filter: `market_id=eq.${marketId}`,
      },
      (payload) => {
        console.log(`${LOG} raw event`, {
          table,
          channel: channelName,
          event: payload.eventType,
          hasNew: payload.new != null,
          hasOld: payload.old != null,
        });
        handlePayload(channelName, table, payload, onUpdate);
      }
    );
  }

  channel.subscribe((status, err) => {
    logSubscribeStatus(table, channelName, marketIds, status, err);
  });

  return () => {
    console.log(`${LOG} unsubscribed`, { channel: channelName, table, marketIds });
    supabase.removeChannel(channel);
  };
}
export function subscribeMarketPrices(
  supabase: SupabaseClient,
  marketId: number,
  onUpdate: PostgresHandler<MarketPriceLatest>
): RealtimeUnsubscribe {
  return subscribeTable(supabase, `market-prices-${marketId}`, 'market_prices_latest', marketId, onUpdate);
}

/** Subscribe to market_prices_latest for multiple markets on one channel. */
export function subscribeMarketPricesMany(
  supabase: SupabaseClient,
  channelKey: string,
  marketIds: number[],
  onUpdate: PostgresHandler<MarketPriceLatest>
): RealtimeUnsubscribe {
  return subscribeTableMany(supabase, channelKey, 'market_prices_latest', marketIds, onUpdate);
}

/**
 * Subscribe to market_prices_latest for a single market, exposing channel
 * status transitions so the caller can resync after a reconnect. The realtime
 * client auto-reconnects the socket, but events during the outage are missed —
 * the status callback is how the chart knows to refetch and reseed.
 */
export function subscribeMarketPricesWithStatus(
  supabase: SupabaseClient,
  marketId: number,
  onUpdate: PostgresHandler<MarketPriceLatest>,
  onStatus?: (status: string) => void
): RealtimeUnsubscribe {
  const channelName = `market-prices-live-${marketId}`;
  const table = 'market_prices_latest' as const;

  const channel = supabase
    .channel(channelName)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table, filter: `market_id=eq.${marketId}` },
      (payload) => handlePayload(channelName, table, payload, onUpdate)
    )
    .subscribe((status, err) => {
      logSubscribeStatus(table, channelName, [marketId], status, err);
      onStatus?.(status);
    });

  return () => {
    console.log(`${LOG} unsubscribed`, { channel: channelName, table, marketIds: [marketId] });
    supabase.removeChannel(channel);
  };
}

/** Subscribe to live_ticks for a single market. */
export function subscribeLiveTicks(
  supabase: SupabaseClient,
  marketId: number,
  onUpdate: PostgresHandler<LiveTickRow>
): RealtimeUnsubscribe {
  return subscribeTable(supabase, `live-ticks-${marketId}`, 'live_ticks', marketId, onUpdate);
}

/** Subscribe to live_ticks for multiple markets on one channel. */
export function subscribeLiveTicksMany(
  supabase: SupabaseClient,
  channelKey: string,
  marketIds: number[],
  onUpdate: PostgresHandler<LiveTickRow>
): RealtimeUnsubscribe {
  return subscribeTableMany(supabase, channelKey, 'live_ticks', marketIds, onUpdate);
}

/** Subscribe to market_ingestion_state for a single market. */
export function subscribeMarketIngestionState(
  supabase: SupabaseClient,
  marketId: number,
  onUpdate: PostgresHandler<MarketIngestionStateRow>
): RealtimeUnsubscribe {
  return subscribeTable(
    supabase,
    `ingestion-state-${marketId}`,
    'market_ingestion_state',
    marketId,
    onUpdate
  );
}

/** Subscribe to market_ingestion_state for multiple markets on one channel. */
export function subscribeMarketIngestionStateMany(
  supabase: SupabaseClient,
  channelKey: string,
  marketIds: number[],
  onUpdate: PostgresHandler<MarketIngestionStateRow>
): RealtimeUnsubscribe {
  return subscribeTableMany(supabase, channelKey, 'market_ingestion_state', marketIds, onUpdate);
}
