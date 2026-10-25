'use client';

/**
 * "Said out loud" (docs/ui.md pattern 10): what the room hears, as opposed to "In the earpiece now",
 * which only the person hears. The reply appears only after the person picks a reply by its number (D18).
 */
import { Spinner } from '@/components/ui/Spinner';
import { cx } from '@/lib/cx';
import type { SpokenReply } from '@/lib/data/derive';
import { formatClock } from '@/lib/format';
import { screenText } from './model';
import styles from './SaidAloud.module.css';

export interface SaidAloudProps {
  reply: SpokenReply | null;
  /** The turn ended without a pick (STOP, no pick, cancelled), so nothing was said. */
  nothingSaid: boolean;
}

export function SaidAloud({ reply, nothingSaid }: SaidAloudProps) {
  const text = reply ? screenText(reply.text) : null;
  return (
    <div className={styles.aloud}>
      <span className={styles.label}>Said out loud</span>
      {reply && text ? (
        <div className={styles.body}>
          <p key={text} className={styles.text}>{`"${text}"`}</p>
          <p className={cx(styles.meta, 'num')}>
            {reply.spokenAt === null ? (
              <>
                <Spinner size={12} />
                <span>Saying it now</span>
              </>
            ) : (
              <span>Said at {formatClock(reply.spokenAt)}</span>
            )}
          </p>
        </div>
      ) : (
        <p className={styles.none}>{nothingSaid ? 'Nothing was said.' : 'Nothing yet. A reply is spoken only once the person picks it.'}</p>
      )}
    </div>
  );
}
