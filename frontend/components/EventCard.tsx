import Link from 'next/link';
import { formatGmtIso } from '@/lib/datetime';
import type { EventRow } from '@/lib/types';

function formatDate(value: string | null) {
  return formatGmtIso(value);
}

export default function EventCard({ event }: { event: EventRow }) {
  return (
    <Link href={`/events/${event.id}`} className="card card-link">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
        <div>
          <div style={{ fontWeight: 600 }}>
            {event.title ?? `Event #${event.id}`}
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
