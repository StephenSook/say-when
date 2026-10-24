'use client';

/**
 * The big card for the agent at work (docs/ui.md "Screen 2"): its name on the left, its state in
 * words at the top right, then two columns. The steps go left; the form preview or the call
 * transcript goes right. Under 1000 px the columns stack.
 */
import { useId, type ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import { agentTitle, type AgentKind, type Badge } from './model';
import { StateBadge } from './StateBadge';
import styles from './AgentCard.module.css';

export interface AgentCardProps {
  kind: AgentKind;
  /** The form's title or the contact's name. Never a phone number. */
  name: string;
  badge: Badge;
  children: ReactNode;
}

export function AgentCard({ kind, name, badge, children }: AgentCardProps) {
  const titleId = useId();
  return (
    <Card as="article" enter aria-labelledby={titleId}>
      <div className={styles.head}>
        <h2 id={titleId} className={styles.title}>
          {agentTitle(kind, name)}
        </h2>
        <StateBadge badge={badge} />
      </div>
      <div className={styles.body}>{children}</div>
    </Card>
  );
}
