'use client';

/**
 * The agent that is not at work: one dimmed line at the bottom (docs/ui.md "Screen 2": "The other
 * agent is one line at the bottom"). Its name, its state as a mark and a word, and the time it last
 * changed. While nothing is at work, "Show" moves it into the big card.
 *
 * Dimmed means muted text, not lowered opacity, so every word still reads at 4.5:1 or better.
 */
import { useId } from 'react';
import { StatusMark } from '@/components/ui/StatusMark';
import { TextLink } from '@/components/ui/TextLink';
import { cx } from '@/lib/cx';
import { formatClock } from '@/lib/format';
import { AGENT_NAMES, agentLastAt, agentTitle, callBadge, errandBadge, type AgentKind, type AgentRef, type SafetyWord } from './model';
import styles from './AgentLine.module.css';

export interface AgentLineProps {
  kind: AgentKind;
  /** The agent's newest row. null: it has not run yet. */
  agent: AgentRef | null;
  safety: SafetyWord;
  /** Moves this agent into the big card. null while the other agent is at work. */
  onShow: (() => void) | null;
}

export function AgentLine({ kind, agent, safety, onShow }: AgentLineProps) {
  const titleId = useId();
  if (agent === null) {
    return (
      <section className={styles.line} aria-labelledby={titleId}>
        <h2 id={titleId} className={styles.title}>
          {AGENT_NAMES[kind]}
        </h2>
        <StatusMark status="not_started" />
      </section>
    );
  }
  const badge = agent.kind === 'errand' ? errandBadge(agent.row, safety) : callBadge(agent.row, safety);
  const name = agent.kind === 'errand' ? agent.row.form : agent.row.contactName;
  return (
    <section className={styles.line} aria-labelledby={titleId}>
      <h2 id={titleId} className={styles.title}>
        {agentTitle(agent.kind, name)}
      </h2>
      <StatusMark status={badge.status} word={badge.word} />
      <span className={cx(styles.time, 'num')}>{formatClock(agentLastAt(agent))}</span>
      {onShow ? (
        <TextLink onClick={onShow} className={styles.show}>
          Show<span className="visually-hidden"> the {AGENT_NAMES[agent.kind].toLowerCase()}</span>
        </TextLink>
      ) : null}
    </section>
  );
}
