'use client';

/**
 * "Their answer" (docs/mockups/partner.html .answer): the reply the person picked, in large text,
 * once it is released, with whether it has been said out loud yet. Before the pick it holds a muted
 * placeholder, so the layout does not jump when the answer arrives.
 */
import { useId } from 'react';
import { CheckIcon } from '@/components/ui/icons';
import { Spinner } from '@/components/ui/Spinner';
import { cx } from '@/lib/cx';
import type { PartnerAnswer } from './model';
import styles from './TheirAnswer.module.css';

export function TheirAnswer({ answer }: { answer: PartnerAnswer }) {
  const titleId = useId();
  return (
    <section className={styles.answer} aria-labelledby={titleId}>
      <h2 id={titleId} className={styles.title}>
        Their answer
      </h2>
      <p key={answer.text} className={cx(styles.text, answer.isReply ? styles.reply : styles.placeholder)}>
        {answer.isReply ? `"${answer.text}"` : answer.text}
      </p>
      {answer.spoken?.state === 'said' ? (
        <p className={styles.meta}>
          <CheckIcon size={14} className={styles.done} />
          <span>
            Said out loud at <span className="num">{answer.spoken.at}</span>
          </span>
        </p>
      ) : null}
      {answer.spoken?.state === 'saying' ? (
        <p className={styles.meta}>
          <Spinner size={14} />
          <span>Saying it out loud</span>
        </p>
      ) : null}
    </section>
  );
}
