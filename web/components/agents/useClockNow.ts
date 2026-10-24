'use client';

/**
 * The clock for this screen's countdowns, ring timers and call durations. null until the first
 * tick (the server render reads 0), so no time text is drawn from a zero clock.
 *
 * While the connection is down the rows may be stale ("Showing the last known state"), so the
 * clock stops at the moment the connection first dropped instead of counting on from old rows.
 * It stays stopped there when Reconnecting turns into Offline, and runs again once rows are live.
 */
import { useEffect, useState } from 'react';
import { useConnection } from '@/lib/data/provider';
import { useNow } from '@/lib/use-now';

export function useClockNow(intervalMs: number = 250): number | null {
  const now = useNow(intervalMs);
  const { dimmed, since } = useConnection();
  const [stoppedAt, setStoppedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!dimmed) {
      setStoppedAt(null);
      return;
    }
    // Keep the first moment only: `since` moves again when Reconnecting turns into Offline.
    setStoppedAt((current) => current ?? (since > 0 ? Math.min(Date.now(), since) : Date.now()));
    // `since` is left out of the dependencies on purpose, for the same reason.
  }, [dimmed]);

  if (now <= 0) return null;
  if (dimmed) return stoppedAt ?? (since > 0 ? Math.min(now, since) : now);
  return now;
}
