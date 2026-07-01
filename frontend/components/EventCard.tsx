import Link from 'next/link';
import type { EventRow } from '@/lib/types';

function formatDate(value: string | null) {
  if (!value) {
    return '—';
  }
  return new Date(value).toLocaleString();
}

export default function EventCard({ event }: { event: EventRow }) {
  return (
    <Link href={`/events/${event.id}`} className="card card-link">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
        <div>
          <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
            {event.title ?? `Event #${event.id}`}
          </div>
          <div className="muted" style={{ fontSize: '0.875rem' }}>
            {event.category ? `${event.category} · ` : ''}
            {event.status ?? 'unknown'}
          </div>
        </div>
        <div className="muted" style={{ fontSize: '0.8rem', textAlign: 'right' }}>
          <div>closes {formatDate(event.close_time)}</div>
          <div>updated {formatDate(event.updated_at)}</div>
        </div>
      </div>
    </Link>
  );
}
