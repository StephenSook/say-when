import { cx } from '@/lib/cx';
import styles from './Spinner.module.css';

export interface SpinnerProps {
  /** Diameter in px. docs/ui.md uses 12 to 16. */
  size?: 12 | 14 | 16 | 20;
  /** Color of the moving segment. */
  tone?: 'accent' | 'fg';
  /** Words for screen readers. Leave it out when a visible word sits next to the spinner. */
  label?: string;
  className?: string;
}

/** The only motion kept under reduced motion, since it is the only sign of work (data-spinner). */
export function Spinner({ size = 16, tone = 'accent', label, className }: SpinnerProps) {
  return (
    <span
      className={cx(styles.spinner, tone === 'fg' && styles.fg, className)}
      style={{ width: size, height: size }}
      data-spinner=""
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
