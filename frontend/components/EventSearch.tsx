'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, useEffect, useState } from 'react';

type EventSearchProps = {
  provider: string;
  initialQuery?: string;
};

export default function EventSearch({ provider, initialQuery = '' }: EventSearchProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(initialQuery);

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  function buildHref(nextQuery: string) {
    const params = new URLSearchParams();
    params.set('provider', provider);
    params.set('page', '1');
    const trimmed = nextQuery.trim();
    if (trimmed) {
      params.set('q', trimmed);
    }
    return `/?${params.toString()}`;
  }

  function navigate(nextQuery: string) {
    const href = buildHref(nextQuery);
    if (`/?${searchParams.toString()}` !== href) {
      router.push(href);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    navigate(query);
  }

  useEffect(() => {
    const trimmed = query.trim();
    const current = (searchParams.get('q') ?? '').trim();
    if (trimmed === current) {
      return;
    }

    const timer = setTimeout(() => navigate(query), 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- debounce query only
  }, [query]);

  return (
    <form className="search-bar" onSubmit={onSubmit} role="search">
      <input
        type="search"
        className="search-input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search events by name…"
        aria-label="Search events by name"
        autoComplete="off"
      />
      {query.trim() ? (
        <button
          type="button"
          className="btn"
          onClick={() => {
            setQuery('');
            navigate('');
          }}
        >
          Clear
        </button>
      ) : null}
      <button type="submit" className="btn btn-primary">
        Search
      </button>
    </form>
  );
}
