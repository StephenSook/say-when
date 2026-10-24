'use client';

/**
 * What each node of the Suggested replies tree shows, drawn the same in the React Flow canvas and in the stacked
 * phone view. Every status is an icon, a word and a color, never a color alone (docs/ui.md "Status vocabulary").
 * Only a running step or an open confirm window ticks a clock; an idle screen holds still.
 */
import { memo, type ReactNode } from 'react';
import { useClockNow } from '@/components/agents/useClockNow';
import { CheckIcon, CrossIcon, HourglassIcon, NoEntryIcon, PauseIcon } from '@/components/ui/icons';
import { Spinner } from '@/components/ui/Spinner';
import { cx } from '@/lib/cx';
import { formatSeconds, formatTimeLeft } from '@/lib/format';
import type { ChildNode, HubNode, MoreNode, OptionNode, QuestionNode, StepNode, TreeNode, TreeStatus } from '@/lib/tree/model';
import styles from './ReplyTree.module.css';

function Glyph({ status }: { status: TreeStatus }) {
  switch (status) {
    case 'working':
      return <Spinner size={20} />;
    case 'done':
    case 'picked':
      return <CheckIcon size={18} />;
    case 'waiting':
      return <HourglassIcon size={18} />;
    case 'failed':
      return <CrossIcon size={18} />;
    case 'stopped':
      return <PauseIcon size={16} />;
    case 'refused':
      return <NoEntryIcon size={18} />;
    case 'idle':
      return null;
  }
}

/** Time since a step started, or time left in a confirm window. Mounted only while one runs. */
function Clock({ since, until }: { since: number | null; until: number | null }) {
  const now = useClockNow(250);
  if (now === null) return null;
  if (until !== null) return <span className={cx(styles.clock, 'num')}>{formatTimeLeft(until - now)}</span>;
  if (since !== null) return <span className={cx(styles.clock, 'num')}>{formatSeconds(Math.max(0, now - since))}</span>;
  return null;
}

export function StatusBadge({ status, word, since = null, until = null }: { status: TreeStatus; word: string; since?: number | null; until?: number | null }) {
  if (!word) return null;
  const ticking = (status === 'working' && since !== null) || (status === 'waiting' && until !== null);
  return (
    <span className={cx(styles.badge, styles[`badge_${status}`])}>
      <span className={styles.mark} aria-hidden="true">
        <Glyph status={status} />
      </span>
      <span className={styles.word}>{word}</span>
      {ticking ? <Clock since={status === 'working' ? since : null} until={status === 'waiting' ? until : null} /> : null}
    </span>
  );
}

function QuestionBody({ node }: { node: QuestionNode }) {
  return (
    <>
      <div className={styles.row}>
        <span className={styles.eyebrow}>{node.label}</span>
        <StatusBadge status={node.status} word={node.word} since={node.since} />
      </div>
      <p className={cx(styles.questionText, !node.quoted && styles.muted)} title={node.text}>
        {node.text}
      </p>
      {node.tool ? <p className={styles.tool}>{node.tool}</p> : null}
    </>
  );
}

function HubBody({ node }: { node: HubNode }) {
  return (
    <>
      <p className={cx(styles.title, node.job === 'draft' && styles.titleWrap)}>{node.title}</p>
      <div className={styles.row}>
        <StatusBadge status={node.status} word={node.word} since={node.since} />
        {node.meta ? (
          <span className={cx(styles.meta, 'num')} title={node.detail ?? node.meta}>
            {node.meta}
          </span>
        ) : null}
        {node.tool ? <span className={styles.toolTag}>{node.tool}</span> : null}
      </div>
    </>
  );
}

function ChildBody({ node }: { node: ChildNode | MoreNode }) {
  const muted = node.kind === 'more' || node.muted;
  return (
    <>
      <p className={cx(styles.childTitle, muted && styles.muted)} title={node.title}>
        {node.title}
      </p>
      {node.meta ? <p className={styles.childMeta}>{node.meta}</p> : null}
    </>
  );
}

function OptionBody({ node }: { node: OptionNode }) {
  return (
    <>
      <div className={styles.row}>
        <span className={styles.eyebrow}>{node.heading}</span>
        {node.state === 'picked' || node.state === 'reading' ? <StatusBadge status={node.status} word={node.word} /> : null}
      </div>
      <p className={cx(styles.optionText, node.text === null && styles.muted)} title={node.text ?? undefined}>
        {node.text ?? 'Words not shared on this screen.'}
      </p>
      <div className={cx(styles.row, styles.bottom)}>
        {node.tag ? <span className={styles.tag}>{node.tag}</span> : null}
        {node.pickLine ? <p className={styles.pickLine}>{node.pickLine}</p> : node.source ? <p className={styles.source}>{node.source}</p> : null}
      </div>
    </>
  );
}

function StepBody({ node }: { node: StepNode }) {
  return (
    <>
      {node.eyebrow ? <p className={styles.eyebrow}>{node.eyebrow}</p> : null}
      <div className={styles.row}>
        <span className={styles.stepTitle}>{node.title}</span>
        <StatusBadge status={node.status} word={node.word} since={node.since} />
      </div>
      {node.meta ? (
        <p className={styles.stepMeta} title={node.meta}>
          {node.meta}
          {node.status === 'waiting' && node.until !== null ? (
            <>
              {' '}
              <Clock since={null} until={node.until} />
            </>
          ) : null}
        </p>
      ) : null}
      {node.text ? (
        <p className={styles.stepText} title={node.text}>
          {node.text}
        </p>
      ) : null}
    </>
  );
}

/** The inside of one card, for any node but a region box. */
export function CardBody({ node }: { node: TreeNode }): ReactNode {
  switch (node.kind) {
    case 'question':
      return <QuestionBody node={node} />;
    case 'hub':
      return <HubBody node={node} />;
    case 'child':
    case 'more':
      return <ChildBody node={node} />;
    case 'option':
      return <OptionBody node={node} />;
    case 'step':
      return <StepBody node={node} />;
    case 'region':
      return null;
  }
}

/** The card's class names: its kind and its state. */
export function cardClass(node: TreeNode): string {
  const state = node.kind === 'option' ? styles[`option_${node.state}`] : styles[`card_${node.status}`];
  return cx(styles.card, styles[`kind_${node.kind}`], state);
}

export const Card = memo(function Card({ node, className }: { node: TreeNode; className?: string }) {
  return (
    <div className={cx(cardClass(node), className)}>
      <CardBody node={node} />
    </div>
  );
});
