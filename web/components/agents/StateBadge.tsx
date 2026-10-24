'use client';

/**
 * The state label at the top right of an agent card: always the current state in words, with its
 * mark and color (docs/ui.md "Screen 2"). "Waiting for confirm, 6 s left", "Ringing 0:03",
 * "Connected 0:42", "Sent", "Stopped". Only a label with a timer ticks.
 */
import { StatusMark } from '@/components/ui/StatusMark';
import { cx } from '@/lib/cx';
import { formatClockDuration, formatTimeLeft } from '@/lib/format';
import type { RunStatus } from '@/lib/status';
import type { Badge } from './model';
import { useClockNow } from './useClockNow';
import styles from './StateBadge.module.css';

export function StateBadge({ badge }: { badge: Badge }) {
  if (badge.countdownTo !== undefined || badge.clockSince !== undefined) return <TickingBadge badge={badge} />;
  return <BadgeFrame status={badge.status} word={badge.word} />;
}

function TickingBadge({ badge }: { badge: Badge }) {
  const now = useClockNow();
  let word = badge.word;
  if (now !== null && badge.countdownTo !== undefined) {
    const left = badge.countdownTo - now;
    word = left > 0 ? `${badge.word}, ${formatTimeLeft(left)}` : `${badge.word}, window closed`;
  } else if (now !== null && badge.clockSince !== undefined) {
    word = `${badge.word} ${formatClockDuration(Math.max(0, now - badge.clockSince))}`;
  }
  return <BadgeFrame status={badge.status} word={word} />;
}

function BadgeFrame({ status, word }: { status: RunStatus; word: string }) {
  return (
    <span className={cx(styles.badge, styles[status], 'num')}>
      <StatusMark status={status} word={word} />
    </span>
  );
}
