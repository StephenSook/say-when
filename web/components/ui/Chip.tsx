import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { Spinner } from './Spinner';
import styles from './Chip.module.css';

export type ChipTone = 'default' | 'muted' | 'live' | 'accent' | 'wait' | 'error';

export interface ChipProps {
  children: ReactNode;
  /** Text color, and the dot color when `lead` is 'dot'. 'live' adds a soft halo to the dot. */
  tone?: ChipTone;
  /** Something before the words: an 8 px dot, a 12 px spinner, or an icon. */
  lead?: 'dot' | 'spinner' | ReactNode;
  /** md is 32 px tall (docs/ui.md); lg is 40 px, for the command strip. */
  size?: 'md' | 'lg';
  /** The command echo: accent border and fill. Turns on in 150 ms and off in 300 ms. */
  lit?: boolean;
  /** A dashed outline, for things that are not live, such as the sample replay. */
  dashed?: boolean;
  title?: string;
  className?: string;
}

/** A small pill: 1 px line, control background, meta text (docs/ui.md "Chip"). */
export function Chip({ children, tone = 'default', lead, size = 'md', lit = false, dashed = false, title, className }: ChipProps) {
  return (
    <span
      className={cx(styles.chip, styles[tone], size === 'lg' && styles.lg, lit && styles.lit, dashed && styles.dashed, className)}
      title={title}
    >
      {lead === 'dot' ? <span className={styles.dot} aria-hidden="true" /> : null}
      {lead === 'spinner' ? <Spinner size={12} /> : null}
      {lead !== undefined && lead !== 'dot' && lead !== 'spinner' ? (
        <span className={styles.icon} aria-hidden="true">
          {lead}
        </span>
      ) : null}
      <span className={styles.label}>{children}</span>
    </span>
  );
}
