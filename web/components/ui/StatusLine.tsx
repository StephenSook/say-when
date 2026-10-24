'use client';

import { useEffect, useState } from 'react';
import { cx } from '@/lib/cx';
import { Spinner } from './Spinner';
import styles from './StatusLine.module.css';

/** When the sentence changes, in ms after the wait began (docs/ui.md "Status line"). */
export const STATUS_LINE_STEPS_MS: readonly [number, number, number] = [0, 3_000, 10_000];

export interface StatusLineProps {
  /**
   * The sentence at 0 s, at 3 s and at 10 s. Give one, two or three; the last one stays.
   * For example ["Drafting options", "Still drafting", "Still drafting. Claude can take a few seconds."].
   */
  messages: readonly [string, string?, string?];
  /** Change this to start the 0, 3 and 10 s clock again, for example a new question id. */
  resetKey?: string | number;
  /** Show the spinner before the sentence. Default true. */
  spinner?: boolean;
  size?: 'meta' | 'body' | 'lead';
  align?: 'center' | 'start';
  className?: string;
}

/** One muted sentence that changes as a wait goes on, with role="status". */
export function StatusLine({ messages, resetKey, spinner = true, size = 'body', align = 'center', className }: StatusLineProps) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    setStep(0);
    const timers = [
      setTimeout(() => setStep(1), STATUS_LINE_STEPS_MS[1]),
      setTimeout(() => setStep(2), STATUS_LINE_STEPS_MS[2]),
    ];
    return () => timers.forEach((timer) => clearTimeout(timer));
  }, [resetKey]);

  const available = messages.filter((message): message is string => typeof message === 'string' && message !== '');
  const text = available[Math.min(step, available.length - 1)] ?? '';

  return (
    <p className={cx(styles.line, styles[size], align === 'start' && styles.start, className)} role="status">
      {spinner ? <Spinner size={size === 'lead' ? 20 : 14} /> : null}
      <span key={text} className={styles.text}>
        {text}
      </span>
    </p>
  );
}
