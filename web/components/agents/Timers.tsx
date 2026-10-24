'use client';

/**
 * The parts of the Agents screen that tick: elapsed time on a running step, a live clock face for
 * ringing and talking, and the confirm window. Each is a small leaf, so only it redraws every 250 ms.
 */
import { useState } from 'react';
import { Bar } from '@/components/ui/Bar';
import { cx } from '@/lib/cx';
import { formatClockDuration, formatSeconds, formatTimeLeft } from '@/lib/format';
import { useClockNow } from './useClockNow';
import styles from './Timers.module.css';

/** "1.2 s so far" on a running step, counting up from `since`. */
export function Elapsed({ since }: { since: number }) {
  const now = useClockNow();
  if (now === null) return null;
  return <>{formatSeconds(Math.max(0, now - since))} so far</>;
}

/** A live clock face from `since`, for the ring timer and the call duration: "0:42". */
export function LiveDuration({ since }: { since: number }) {
  const now = useClockNow();
  if (now === null) return null;
  return <>{formatClockDuration(Math.max(0, now - since))}</>;
}

export interface CountdownProps {
  /** When the confirm window closes (the row's `confirmClosesAt`). */
  closesAt: number;
  /**
   * When it opened: the row's `confirmOpensAt` (the read-back's end plus the quiet hold), else the read-back's end.
   * null: the bar starts full when this screen first saw it.
   */
  opensAt: number | null;
  /** What the bar measures, for screen readers. */
  label: string;
}

/**
 * The confirm window: a wait-colored bar that empties, and "6 s left". Nothing here releases
 * anything; only a CONFIRM does, and when the time runs out the row turns Stopped, nothing sent.
 * The words count down to the close, as the state label does; the bar stays full until the window
 * opens (during the quiet hold after the read-back) and then empties across the window.
 */
export function Countdown({ closesAt, opensAt, label }: CountdownProps) {
  const now = useClockNow();
  const [firstSeen] = useState(() => Date.now());
  if (now === null) return null;
  const start = opensAt !== null && opensAt < closesAt ? opensAt : Math.min(firstSeen, closesAt);
  const totalMs = Math.max(1_000, closesAt - start);
  const leftMs = Math.max(0, closesAt - now);
  const open = leftMs > 0;
  const seconds = Math.ceil(leftMs / 1000);
  return (
    <div className={styles.countdown}>
      <Bar
        value={Math.min(totalMs, leftMs) / 1000}
        max={totalMs / 1000}
        tone="wait"
        label={label}
        valueText={open ? `${seconds} ${seconds === 1 ? 'second' : 'seconds'} left` : 'The window closed'}
      />
      <span className={cx(styles.left, !open && styles.closed, 'num')}>{open ? formatTimeLeft(leftMs) : 'Window closed'}</span>
    </div>
  );
}
