import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createServerClient } from '@/lib/supabase/server';
import { getEventById, getEventMarkets } from '@/lib/queries';
import { pickProvider } from '@/lib/utils';
import PromoteOnMount from '@/components/PromoteOnMount';
import EventChart from '@/components/EventChart';
import EventMarketsList from '@/components/EventMarketsList';

type EventPageProps = {
  params: {
    id: string;
  };
};

export default async function EventPage({ params }: EventPageProps) {
  const eventId = Number(params.id);
  if (!Number.isFinite(eventId)) {
    notFound();
  }

  const supabase = await createServerClient();
  const event = await getEventById(supabase, eventId);

  if (!event) {
    notFound();
  }

  const markets = await getEventMarkets(supabase, eventId);
  const providerName =
    pickProvider(event.providers)?.name ??
    pickProvider(event.providers)?.slug ??
    'Provider';

  return (
    <div>
      <div style={{ marginBottom: '1rem' }}>
        <Link href="/" className="muted">
          ← All events
        </Link>
      </div>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.75rem' }}>
          {event.title ?? `Event #${event.id}`}
        </h1>
        <div className="muted" style={{ fontSize: '0.875rem' }}>
          {providerName}
          {event.category ? ` · ${event.category}` : ''}
          {event.status ? ` · ${event.status}` : ''}
        </div>
      </div>

      <PromoteOnMount eventId={eventId} />

      {markets.length > 0 && (
        <EventChart eventTitle={event.title} markets={markets} />
      )}

      <h2 style={{ fontSize: '1.125rem', margin: '1.5rem 0 0.75rem' }}>Markets</h2>

      <EventMarketsList eventTitle={event.title} markets={markets} />
    </div>
  );
}
