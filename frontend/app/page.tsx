import Link from 'next/link';
import { Suspense } from 'react';
import { createServerClient } from '@/lib/supabase/server';
import { getEvents, getProviders } from '@/lib/queries';
import EventCard from '@/components/EventCard';
import EventSearch from '@/components/EventSearch';

const PAGE_SIZE = 50;

type HomePageProps = {
  searchParams?: {
    provider?: string;
    page?: string;
    q?: string;
  };
};

function buildListHref(provider: string, page: number, q?: string) {
  const params = new URLSearchParams({
    provider,
    page: String(page),
  });
  const trimmed = q?.trim();
  if (trimmed) {
    params.set('q', trimmed);
  }
  return `/?${params.toString()}`;
}

export default async function HomePage({ searchParams }: HomePageProps) {
  const supabase = await createServerClient();
  const providers = await getProviders(supabase);

  const providerSlug =
    searchParams?.provider && providers.some((p) => p.slug === searchParams.provider)
      ? searchParams.provider
      : (providers[0]?.slug ?? 'polymarket');

  const searchQuery = searchParams?.q?.trim() ?? '';
  const page = Math.max(1, Number(searchParams?.page ?? 1) || 1);
  const { events, total } = await getEvents(supabase, providerSlug, {
    page,
    limit: PAGE_SIZE,
    search: searchQuery || undefined,
  });

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const prevPage = page > 1 ? page - 1 : null;
  const nextPage = page < totalPages ? page + 1 : null;

  return (
    <div>
      <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.75rem' }}>Events</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Browse prediction markets from Polymarket and Kalshi. Open an event to promote it to hot
        tier for live prices and chart backfill.
      </p>

      <nav className="tabs" aria-label="Providers">
        {providers.map((provider) => (
          <Link
            key={provider.id}
            href={buildListHref(provider.slug, 1, searchQuery)}
            className={`tab ${provider.slug === providerSlug ? 'tab-active' : ''}`}
          >
            {provider.name}
          </Link>
        ))}
      </nav>

      <Suspense fallback={null}>
        <EventSearch provider={providerSlug} initialQuery={searchQuery} />
      </Suspense>

      {searchQuery ? (
        <p className="muted" style={{ margin: '0 0 1rem', fontSize: '0.875rem' }}>
          Showing results for &ldquo;{searchQuery}&rdquo; · {total} match{total === 1 ? '' : 'es'}
        </p>
      ) : null}

      {events.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0 }}>
            {searchQuery
              ? `No events matching "${searchQuery}" for ${providerSlug}.`
              : `No events yet for ${providerSlug}.`}
          </p>
          <p className="muted" style={{ margin: '0.5rem 0 0', fontSize: '0.875rem' }}>
            {searchQuery
              ? 'Try a different search term or clear the filter.'
              : 'Start the events worker and wait for the first sync cycle.'}
          </p>
        </div>
      ) : (
        <div>
          {events.map((event) => (
            <EventCard key={event.id} event={event} />
          ))}
        </div>
      )}

      <div className="pagination">
        <span className="muted" style={{ fontSize: '0.875rem' }}>
          Page {page} of {totalPages} · {total} events
        </span>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {prevPage ? (
            <Link href={buildListHref(providerSlug, prevPage, searchQuery)} className="btn">
              Previous
            </Link>
          ) : (
            <span className="btn" aria-disabled>
              Previous
            </span>
          )}
          {nextPage ? (
            <Link href={buildListHref(providerSlug, nextPage, searchQuery)} className="btn">
              Next
            </Link>
          ) : (
            <span className="btn" aria-disabled>
              Next
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
