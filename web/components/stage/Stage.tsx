'use client';

/**
 * The stage view (/stage): one screen for the projector, so the audience follows the whole loop without anyone
 * switching tabs. It is made of the other screens' parts, fed by the same rows:
 * - the partner's question on top (Conversation's header);
 * - the Suggested replies tree as the main area (lookups, drafting, the options, the pick, an errand's read-back);
 * - a side column: the brain slot (the live brain once Screen 1 is on this build, else the decoder panel), what is in
 *   the earpiece now or what was picked, and what was said out loud;
 * - the command strip along the bottom, in this session's true input words (keys say keys).
 * The header's connection and input chips come from the shell, as on every dashboard. `?replay=1` plays the sample
 * replay here too.
 *
 * Frame (lib/stage/layout.ts): the tree beside the side column at 1920 x 1080 and 1280 x 720, filling the window so
 * nothing scrolls; under 960 px wide one column with the tree as a list.
 */
import dynamic from 'next/dynamic';
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { buildConversationView, focusQuestion } from '@/components/conversation/model';
import { CommandStrip } from '@/components/conversation/CommandStrip';
import { TurnHeader } from '@/components/conversation/TurnHeader';
import { useFrameValue, useReducedMotion } from '@/components/replies/hooks';
import { StackedTree } from '@/components/replies/StackedTree';
import { cx } from '@/lib/cx';
import { eventsForQuestion, spokenReply } from '@/lib/data/derive';
import { useConnection, useRows } from '@/lib/data/provider';
import { parseSize, stageLayout, type StageLayout } from '@/lib/stage/layout';
import { deriveReplyTree } from '@/lib/tree/model';
import { BrainSlot, useBrainSlotKind } from './BrainSlot';
import { StageNow } from './StageNow';
import styles from './Stage.module.css';

const ReplyGraph = dynamic(() => import('@/components/replies/ReplyGraph').then((m) => m.ReplyGraph), {
  ssr: false,
  loading: () => null,
});

function subscribeResize(notify: () => void) {
  window.addEventListener('resize', notify);
  return () => window.removeEventListener('resize', notify);
}

/** The window's frame. The server render gets the projector frame (`stageLayout(null)`). */
function useStageLayout(): StageLayout {
  const key = useSyncExternalStore(
    subscribeResize,
    () => `${window.innerWidth}x${window.innerHeight}`,
    () => null,
  );
  return useMemo(() => stageLayout(parseSize(key)), [key]);
}

/** The stage fills the window below the header and any banner, so the page never scrolls on a projector. */
function useFillHeight(enabled: boolean) {
  const ref = useRef<HTMLElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element) {
      setHeight(null);
      return;
    }
    const measure = () => {
      const top = element.getBoundingClientRect().top + window.scrollY;
      const next = Math.max(420, Math.floor(window.innerHeight - top));
      setHeight((current) => (current === next ? current : next));
    };
    measure();
    window.addEventListener('resize', measure);
    // A banner above (paused, reconnecting, replay) moves the stage down: measure again.
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    return () => {
      window.removeEventListener('resize', measure);
      observer.disconnect();
    };
  }, [enabled]);
  return { ref, height };
}

export function Stage() {
  const rows = useFrameValue(useRows());
  const conn = useConnection();
  const reduced = useReducedMotion();
  const layout = useStageLayout();
  const slot = useBrainSlotKind();
  const { ref, height } = useFillHeight(layout.canvas);

  const tree = useMemo(() => deriveReplyTree(rows), [rows]);
  const question = useMemo(() => focusQuestion(rows.questions, rows.scan), [rows.questions, rows.scan]);
  const reply = useMemo(() => spokenReply(question), [question]);
  const view = useMemo(() => {
    if (question === null) return null;
    return buildConversationView({
      question,
      scan: rows.scan,
      options: rows.options,
      events: eventsForQuestion(rows.pipelineEvents, question.id),
      errands: rows.errands,
      calls: rows.calls,
      safety: rows.safety,
      input: rows.input,
      hasReply: reply !== null,
    });
  }, [question, rows, reply]);

  const style = {
    ...(height !== null ? { height } : null),
    ...(layout.sideWidth !== null ? { '--side-w': `${layout.sideWidth}px` } : null),
  } as CSSProperties;

  return (
    <section ref={ref} className={cx(styles.root, styles[layout.kind])} style={style} aria-labelledby="stage-title">
      <h1 id="stage-title" className="visually-hidden">
        Stage
      </h1>

      <div className={styles.head}>
        {view !== null ? <TurnHeader header={view.header} /> : <p className={styles.waitingHead}>Waiting for the partner to ask something.</p>}
      </div>

      <div className={styles.tree}>
        {layout.canvas ? (
          <div className={styles.canvas}>
            <ReplyGraph tree={tree} reduced={reduced} />
          </div>
        ) : (
          <StackedTree tree={tree} />
        )}
      </div>

      <aside className={styles.side} aria-label="Now">
        <div className={cx(styles.slot, slot === 'live-brain' && styles.slotLive)}>
          <BrainSlot kind={slot} />
        </div>
        <StageNow view={view} reply={reply} live={!conn.dimmed} />
      </aside>

      <div className={styles.strip}>
        <CommandStrip />
      </div>

      {/* One polite line for screen readers: the pick, or how the turn ended. Never the list itself. */}
      <p className="visually-hidden" role="status">
        {view?.announcement ?? ''}
      </p>
    </section>
  );
}
