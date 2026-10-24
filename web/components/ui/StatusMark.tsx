import { cx } from '@/lib/cx';
import { STATUS_WORDS, type RunStatus } from '@/lib/status';
import { CheckIcon, CrossIcon, HourglassIcon, NoEntryIcon, PauseIcon } from './icons';
import { Spinner } from './Spinner';
import styles from './StatusMark.module.css';

export interface StatusMarkProps {
  status: RunStatus;
  /**
   * Show the status word next to the mark. Default true. With false the word is still read by
   * screen readers and shown as a tooltip; use that only where a visible label sits beside it,
   * as in a step list.
   */
  showWord?: boolean;
  /** A more precise word, for example "Not sent" or "Ringing". Defaults to the docs/ui.md vocabulary. */
  word?: string;
  className?: string;
}

/** Status as an icon shape, a word and a color, never color alone (docs/ui.md "Status vocabulary"). */
export function StatusMark({ status, showWord = true, word, className }: StatusMarkProps) {
  const text = word ?? STATUS_WORDS[status];
  return (
    <span className={cx(styles.status, styles[status], className)} title={showWord ? undefined : text}>
      <span className={styles.mark} aria-hidden="true">
        <MarkGlyph status={status} />
      </span>
      <span className={showWord ? styles.word : 'visually-hidden'}>{text}</span>
    </span>
  );
}

function MarkGlyph({ status }: { status: RunStatus }) {
  switch (status) {
    case 'working':
      return <Spinner size={16} />;
    case 'waiting':
      return <HourglassIcon />;
    case 'done':
      return <CheckIcon />;
    case 'refused':
      return <NoEntryIcon />;
    case 'stopped':
      return <PauseIcon />;
    case 'failed':
      return <CrossIcon />;
    case 'not_started':
      return null;
  }
}
