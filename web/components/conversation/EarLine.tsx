'use client';

/**
 * The line under the option in the earpiece: "In the earpiece now", then the phase. While the clip
 * plays it says "Reading"; once the audio ends the response window opens and a time-left bar runs
 * (docs/ui.md: never advance before the audio ends, and show reading and the window as two phases).
 * Paused or headset off, the cursor stops here and no clock runs. While the connection is down the
 * rows may be stale, so it says "at the last update" instead of counting.
 */
import { Bar } from '@/components/ui/Bar';
import { HeadsetIcon } from '@/components/ui/icons';
import { StatusMark } from '@/components/ui/StatusMark';
import { cx } from '@/lib/cx';
import { useNow } from '@/lib/use-now';
import { formatSecondsLeft, windowLeft, type CursorView } from './model';
import styles from './EarLine.module.css';

export interface EarLineProps {
  cursor: CursorView;
  /** false while the connection is down: no clock runs on stale rows. */
  live: boolean;
  paused: 'paused' | 'headset_off' | null;
  /** What plays when it is not an option, such as the yes or no prompt. */
  prompt?: string;
}

export function EarLine({ cursor, live, paused, prompt }: EarLineProps) {
  if (cursor.phase === 'stopped') {
    return (
      <div className={styles.ear}>
        <StatusMark status="stopped" word={paused === 'headset_off' ? 'Headset off. The cursor stopped here.' : 'Paused. The cursor stopped here.'} />
      </div>
    );
  }

  const heard = prompt ? `: "${prompt}"` : '';
  if (!live) {
    return (
      <div className={styles.ear}>
        <span className={styles.stale}>{`In the earpiece at the last update${heard}`}</span>
      </div>
    );
  }

  return (
    <div className={styles.ear}>
      <span className={styles.label}>
        <HeadsetIcon size={16} className={styles.icon} />
        <span>{`In the earpiece now${heard}`}</span>
      </span>
      {cursor.phase === 'reading' ? (
        <>
          <div className={styles.meter} aria-hidden="true" />
          <span className={styles.phase}>Reading</span>
        </>
      ) : (
        <WindowCountdown startedAt={cursor.startedAt} endsAt={cursor.endsAt} label={prompt ? 'Time left to answer' : 'Time left on this option'} />
      )}
    </div>
  );
}

/** The response window: a bar that empties from the right and the seconds left. Ticks every 100 ms. */
function WindowCountdown({ startedAt, endsAt, label }: { startedAt: number; endsAt: number; label: string }) {
  const now = useNow(100);
  const left = now > 0 ? windowLeft(startedAt, endsAt, now) : null;
  const seconds = left === null ? 0 : left.leftMs / 1000;
  return (
    <>
      <div className={styles.meter}>
        {left !== null ? <Bar value={seconds} max={left.spanMs / 1000} label={label} valueText={`${seconds.toFixed(1)} seconds left`} /> : null}
      </div>
      <span className={cx(styles.time, 'num')}>{left !== null ? formatSecondsLeft(left.leftMs) : ''}</span>
    </>
  );
}
