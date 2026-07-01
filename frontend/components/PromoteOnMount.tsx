'use client';

import { useEffect, useState } from 'react';
import { promoteEventToHot } from '@/lib/queries';

type PromoteStatus = 'pending' | 'done' | 'error';

export default function PromoteOnMount({ eventId }: { eventId: number }) {
  const [status, setStatus] = useState<PromoteStatus>('pending');

  useEffect(() => {
    let cancelled = false;

    promoteEventToHot(eventId)
      .then(() => {
        if (!cancelled) {
          setStatus('done');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus('error');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [eventId]);

  if (status === 'pending') {
    return (
      <div className="status-banner status-banner-info">
        Promoting markets to hot tier for live ingestion…
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="status-banner status-banner-warn">
        Hot promotion failed — live prices may be delayed until RPC succeeds.
      </div>
    );
  }

  return (
    <div className="status-banner status-banner-info">
      Markets promoted to hot — live WebSocket and history workers will pick them up.
    </div>
  );
}
