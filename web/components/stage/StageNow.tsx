'use client';

/**
 * The stage's side column under the brain slot: what is in the earpiece now (with the word being read), the pick and
 * where its errand or call is, or the wait, then what was said out loud. It reuses the Conversation screen's parts,
 * fed by the same view, so the words match that screen.
 */
import { EarLine } from '@/components/conversation/EarLine';
import { screenText, YES_NO_PROMPT, type ConversationView } from '@/components/conversation/model';
import { ReadingText } from '@/components/conversation/ReadingText';
import { SaidAloud } from '@/components/conversation/SaidAloud';
import { TurnEnding, TurnNote } from '@/components/conversation/TurnNote';
import { StatusMark } from '@/components/ui/StatusMark';
import { cx } from '@/lib/cx';
import type { SpokenReply } from '@/lib/data/derive';
import { nowBlock } from './model';
import styles from './Stage.module.css';

export interface StageNowProps {
  view: ConversationView | null;
  reply: SpokenReply | null;
  /** false while the connection is down: the rows may be stale, so no clock runs. */
  live: boolean;
}

export function StageNow({ view, reply, live }: StageNowProps) {
  return (
    <div className={styles.now}>
      {/* Before the first question the stage's header says it is waiting; nothing more here. */}
      {view !== null ? <Block view={view} live={live} /> : null}
      <div className={styles.aloud}>
        <SaidAloud reply={reply} nothingSaid={view !== null && view.ending !== null} />
      </div>
    </div>
  );
}

function Block({ view, live }: { view: ConversationView; live: boolean }) {
  const block = nowBlock(view);
  switch (block.kind) {
    case 'ear': {
      const text = block.option ? (screenText(block.option.text) ?? '') : null;
      const reading = block.cursor.phase === 'reading' && live;
      const stopped = block.cursor.phase === 'stopped';
      return (
        <div className={cx(styles.card, stopped ? styles.cardStopped : styles.cardEar)} key={block.option?.id ?? 'prompt'}>
          <EarLine cursor={block.cursor} live={live} pausedWord={view.pausedWord} prompt={block.prompt ? YES_NO_PROMPT : undefined} />
          {text !== null && block.option ? (
            <p className={styles.cardText}>
              <span className={cx(styles.rank, 'num')}>{block.option.rank}</span>
              <span>
                {reading ? <ReadingText text={text} startedAt={block.cursor.startedAt} endsAt={block.cursor.endsAt} timings={block.cursor.words} /> : text}
              </span>
            </p>
          ) : null}
        </div>
      );
    }
    case 'picked': {
      const text = screenText(block.option.text) ?? `Option ${block.option.rank}`;
      return (
        <div className={cx(styles.card, styles.cardPicked)} key={`picked:${block.option.id}`}>
          <span className={styles.pickedWord}>
            <span className={styles.pickedMark} aria-hidden="true" />
            Picked
          </span>
          <p className={styles.cardText}>{text}</p>
          {block.vetoing ? <p className={styles.veto}>About to be said out loud. NO or STOP still cancels it.</p> : null}
          {block.agent !== null ? (
            <p className={styles.agent}>
              <StatusMark status={block.agent.status} showWord={false} word={block.agent.sentence} />
              <span aria-hidden="true">{block.agent.sentence}</span>
            </p>
          ) : null}
        </div>
      );
    }
    case 'note':
      return (
        <div className={styles.noteBox}>
          <TurnNote note={block.note} resetKey={view.listKey} />
        </div>
      );
    case 'ending':
      return (
        <div className={styles.noteBox}>
          <TurnEnding ending={block.ending} />
        </div>
      );
    case 'between':
      return null;
  }
}
