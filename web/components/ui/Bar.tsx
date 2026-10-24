import { cx } from '@/lib/cx';
import styles from './Bar.module.css';

export interface BarProps {
  /** Current value, from 0 to `max`. */
  value: number;
  max?: number;
  /** What the bar measures, for screen readers: "Time left on this option". */
  label: string;
  /** The value in words, for screen readers: "6 seconds left". */
  valueText?: string;
  /** accent: progress or live. wait: a confirm window. error: something failed. */
  tone?: 'accent' | 'wait' | 'error';
  /** Track height in px. The mockups use 4. */
  thickness?: 2 | 4;
  className?: string;
}

/** A thin track with a fill from the left, as role="progressbar" (docs/ui.md "Bar"). */
export function Bar({ value, max = 1, label, valueText, tone = 'accent', thickness = 4, className }: BarProps) {
  const safeMax = max > 0 ? max : 1;
  const clamped = Math.min(safeMax, Math.max(0, Number.isFinite(value) ? value : 0));
  const percent = (clamped / safeMax) * 100;
  return (
    <div
      className={cx(styles.bar, styles[tone], thickness === 2 && styles.thin, className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={Math.round(clamped * 100) / 100}
      aria-valuetext={valueText}
    >
      <span className={styles.fill} style={{ width: `${percent}%` }} />
    </div>
  );
}
