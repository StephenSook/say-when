'use client';

/**
 * The option text while it plays in the earpiece, with the word being read marked. It ticks every
 * 100 ms and is mounted only while the option is read, so nothing else on the screen re-renders.
 * Cartesia's word timings are used when a speak event carried them; otherwise the position is an
 * estimate spread across the clip, and the mark's tooltip says so.
 */
import { Fragment, useMemo } from 'react';
import { useNow } from '@/lib/use-now';
import { splitWords, wordBeingRead } from './model';
import type { WordTiming } from '@/lib/data/types';
import styles from './ReadingText.module.css';

export interface ReadingTextProps {
  text: string;
  /** When the reading phase started and when it is planned to end (the clip length). */
  startedAt: number;
  endsAt: number;
  timings: readonly WordTiming[] | null;
}

export function ReadingText({ text, startedAt, endsAt, timings }: ReadingTextProps) {
  const now = useNow(100);
  const parts = useMemo(() => splitWords(text), [text]);
  const words = useMemo(() => parts.filter((part) => part.word !== null).map((part) => part.text), [parts]);
  const mark = now > 0 ? wordBeingRead(words, timings, startedAt, endsAt, now) : null;

  return (
    <>
      {parts.map((part, i) =>
        mark !== null && part.word !== null && part.word === mark.index ? (
          <mark key={i} className={styles.mark} title={mark.estimated ? 'Word position estimated from the clip length' : undefined}>
            {part.text}
          </mark>
        ) : (
          <Fragment key={i}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}
