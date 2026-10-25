'use client';

/**
 * Screen 2, Suggested replies (/replies, key 5): the replies Eleven drafts for one question, drawn as a tree that
 * grows from the rows. The question at the root, the three jobs one agent sidecar runs (saved notes with Moss, web
 * facts with Apify, the drafting), up to three options with where each came from, and the person's pick, which turns
 * green while the camera frames it. Errands and calls grow their read-back, confirm window and result beside it.
 *
 * Every pixel that moves traces to a row: lib/tree/model.ts derives the tree, lib/tree/layout.ts fixes every
 * position, and the canvas (components/replies/ReplyGraph.tsx) adds motion only for new rows. The rows draw once
 * per animation frame. Under 720 px the same tree is a list.
 *
 * Words: the options are drafted, the person decides. Nothing here claims to know what the person is thinking.
 * "STOP: none of these" stays on screen, because a list with no way out of it is a forced choice.
 */
import dynamic from 'next/dynamic';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrameValue, useMediaQuery, useReducedMotion } from '@/components/replies/hooks';
import { StackedTree } from '@/components/replies/StackedTree';
import { PauseIcon } from '@/components/ui/icons';
import { cx } from '@/lib/cx';
import { useRows } from '@/lib/data/provider';
import { deriveReplyTree, SCREEN_SUBTITLE, SCREEN_TITLE } from '@/lib/tree/model';
import styles from './Replies.module.css';

const ReplyGraph = dynamic(() => import('@/components/replies/ReplyGraph').then((m) => m.ReplyGraph), {
  ssr: false,
  loading: () => null,
});

/** The canvas fills the window below the title, so the page itself never scrolls on a projector. */
function useFillHeight(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    const measure = () => {
      const top = element.getBoundingClientRect().top + window.scrollY;
      const next = Math.max(360, Math.floor(window.innerHeight - top));
      setHeight((current) => (current === next ? current : next));
    };
    measure();
    window.addEventListener('resize', measure);
    // A banner above (paused, reconnecting, replay) moves the canvas down: measure again.
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    return () => {
      window.removeEventListener('resize', measure);
      observer.disconnect();
    };
  }, [enabled]);
  return { ref, height };
}

export function Replies() {
  const rows = useFrameValue(useRows());
  const tree = useMemo(() => deriveReplyTree(rows), [rows]);
  const phone = useMediaQuery('(max-width: 720px)');
  const reduced = useReducedMotion();
  const { ref, height } = useFillHeight(!phone);
  const stopLine = (
    <p className={cx(styles.stop, tree.stop.used && styles.stopUsed)}>
      <span className={styles.stopMark} aria-hidden="true">
        <PauseIcon size={14} />
      </span>
      <span>{tree.stop.text}</span>
      {tree.stop.used && tree.stop.detail ? <span className={styles.stopDetail}>{tree.stop.detail}</span> : null}
    </p>
  );

  return (
    <section className={cx(styles.root, !phone && styles.wide)} aria-labelledby="replies-title">
      <header className={styles.head}>
        <div className={styles.titles}>
          <h1 id="replies-title" className={styles.title}>
            {SCREEN_TITLE}
          </h1>
          <p className={styles.subtitle}>{SCREEN_SUBTITLE}</p>
        </div>
        {stopLine}
      </header>

      {/* One polite line for screen readers: the newest pick, confirm, end or failure. */}
      <p role="status" className="visually-hidden">
        {tree.announcement ?? ''}
      </p>

      {phone ? (
        <StackedTree tree={tree} />
      ) : (
        <div ref={ref} className={styles.canvas} style={height ? { height } : undefined}>
          <ReplyGraph tree={tree} reduced={reduced} />
        </div>
      )}
    </section>
  );
}
