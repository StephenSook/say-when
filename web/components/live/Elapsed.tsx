'use client';

/**
 * A running time such as "0.6 s", counted up from `from` every 250 ms (tube's useElapsed rate).
 * With `until` set the count is stopped at that moment and nothing ticks. Only this text
 * re-renders on each tick, not the screen around it.
 *
 * Times on rows come from the database clock and `now` from this laptop's clock, so a small
 * difference is clamped at zero instead of showing a negative time.
 */
import { formatSeconds } from '@/lib/format';
import { useNow } from '@/lib/use-now';

export interface ElapsedProps {
  from: number;
  /** Stop the count here, for example while the connection is down. */
  until: number | null;
}

export function Elapsed({ from, until }: ElapsedProps) {
  if (until !== null) return <>{formatSeconds(Math.max(0, until - from))}</>;
  return <Ticking from={from} />;
}

function Ticking({ from }: { from: number }) {
  const now = useNow(250);
  // useNow reads 0 until its clock starts; show 0 s rather than a time measured from 1970.
  const end = now > 0 ? now : from;
  return <>{formatSeconds(Math.max(0, end - from))}</>;
}
