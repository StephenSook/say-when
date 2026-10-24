import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import type { RunStatus } from '@/lib/status';
import { StatusMark } from './StatusMark';
import styles from './StepList.module.css';

export interface Step {
  /** Stable key for React. */
  key: string;
  label: ReactNode;
  status: RunStatus;
  /** Right side: a clock time ("12:41:02") or a duration ("1.8 s"). */
  time?: ReactNode;
  /** Under the label, muted: read-back values, a countdown bar, "Not sent: <reason>". */
  detail?: ReactNode;
  /** A more precise status word for screen readers and the tooltip, such as "Not sent". */
  statusWord?: string;
}

export interface StepListProps {
  steps: readonly Step[];
  /** What the steps are, for screen readers: "Form errand steps". */
  label?: string;
  /** lg puts the labels at title size, for the phone. */
  size?: 'md' | 'lg';
  className?: string;
}

/**
 * One line per step: mark, name, time or count on the right (docs/ui.md "Step list").
 * The running or waiting step gets aria-current="step".
 */
export function StepList({ steps, label, size = 'md', className }: StepListProps) {
  return (
    <ol className={cx(styles.steps, size === 'lg' && styles.lg, className)} aria-label={label}>
      {steps.map((step) => (
        <li
          key={step.key}
          className={cx(styles.step, styles[step.status])}
          aria-current={step.status === 'working' || step.status === 'waiting' ? 'step' : undefined}
        >
          <StatusMark status={step.status} showWord={false} word={step.statusWord} className={styles.mark} />
          <span className={styles.label}>{step.label}</span>
          <span className={cx(styles.time, 'num')}>{step.time}</span>
          {step.detail !== undefined && step.detail !== null ? <div className={styles.detail}>{step.detail}</div> : null}
        </li>
      ))}
    </ol>
  );
}
