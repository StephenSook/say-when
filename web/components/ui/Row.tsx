import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './Row.module.css';

export interface RowListProps {
  children: ReactNode;
  /** What the list holds, for screen readers: "Apify rows". */
  label?: string;
  className?: string;
}

/** A list of rows separated by hairlines. Put only <Row> inside. */
export function RowList({ children, label, className }: RowListProps) {
  return (
    <ul className={cx(styles.list, className)} aria-label={label}>
      {children}
    </ul>
  );
}

export interface RowProps {
  /** The main line, in fg. */
  main: ReactNode;
  /** The muted "source · fetched 12:40:58" line under it, at meta size. */
  meta?: ReactNode;
  /** Right of the main line, muted meta size: a time, a score, a count. */
  side?: ReactNode;
  /** Right of the meta line. */
  sideMeta?: ReactNode;
  /** The current row: active fill plus a 3 px accent bar on the left. Pair it with a word on screen. */
  current?: boolean;
  /** With `current`: the row is the person's pick, so the bar on the left is the pick green. */
  pick?: boolean;
  /** Grow in from zero height and fade over 240 ms. Use for rows that arrive live. */
  enter?: boolean;
  /** Makes the whole row a button. */
  onSelect?: () => void;
  /** Raw detail for a tooltip. */
  title?: string;
  className?: string;
}

/** One row: a main line over a muted meta line, numbers in tabular figures (docs/ui.md "Row"). */
export function Row({ main, meta, side, sideMeta, current = false, pick = false, enter = false, onSelect, title, className }: RowProps) {
  const body = (
    <span className={styles.grid}>
      <span className={styles.main}>{main}</span>
      {side !== undefined ? <span className={cx(styles.side, 'num')}>{side}</span> : null}
      {meta !== undefined ? <span className={styles.meta}>{meta}</span> : null}
      {sideMeta !== undefined ? <span className={cx(styles.sideMeta, 'num')}>{sideMeta}</span> : null}
    </span>
  );
  return (
    <li className={cx(styles.row, current && styles.current, current && pick && styles.pick, enter && styles.enter, className)} title={title}>
      <span className={styles.clip}>
        {onSelect ? (
          <button type="button" className={styles.button} onClick={onSelect} aria-current={current ? 'true' : undefined}>
            {body}
          </button>
        ) : (
          body
        )}
      </span>
    </li>
  );
}
