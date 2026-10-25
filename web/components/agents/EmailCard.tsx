'use client';

/**
 * The Email card under the form errand (PLAN D25): the care team email the agent drafted with the read-back and sends
 * only after the form was sent. Drafted (subject, masked address, body), Sending, Sent (with its time), or Failed
 * (with its reason). The rules sit in components/agents/email.ts; this file only lays them out.
 */
import { useId } from 'react';
import { Card } from '@/components/ui/Card';
import { formatClock } from '@/lib/format';
import type { EmailCardView } from './email';
import { StateBadge } from './StateBadge';
import { Elapsed } from './Timers';
import cardStyles from './AgentCard.module.css';
import styles from './EmailCard.module.css';

export function EmailCard({ view }: { view: EmailCardView }) {
  const titleId = useId();
  const time =
    view.state === 'sent' && view.sentAt !== null ? (
      <p className={cardStyles.note}>Sent at {formatClock(view.sentAt)}.</p>
    ) : view.state === 'sending' && view.sendingSince !== null ? (
      <p className={cardStyles.note}>
        Sending for <Elapsed since={view.sendingSince} />
      </p>
    ) : view.state === 'drafted' && view.draftedAt !== null ? (
      <p className={cardStyles.note}>Drafted at {formatClock(view.draftedAt)}.</p>
    ) : null;
  return (
    <Card as="article" enter aria-labelledby={titleId}>
      <div className={cardStyles.head}>
        <h2 id={titleId} className={cardStyles.title}>
          Email to the care team
        </h2>
        <StateBadge badge={{ status: view.status, word: view.word }} />
      </div>
      <p className={styles.sentence}>{view.sentence}</p>
      {time}
      {view.shared ? (
        <dl className={cardStyles.values}>
          {view.to ? (
            <>
              <dt>To</dt>
              <dd>{view.to}</dd>
            </>
          ) : null}
          {view.subject ? (
            <>
              <dt>Subject</dt>
              <dd>{view.subject}</dd>
            </>
          ) : null}
        </dl>
      ) : (
        <p className={cardStyles.note}>The email is not shared with this screen.</p>
      )}
      {view.shared && view.body ? <pre className={styles.body}>{view.body}</pre> : null}
    </Card>
  );
}
