'use client';

/**
 * The brain slot wherever the live brain (Screen 1) does not show: the session's input and the newest commands, each
 * with what the person did and when (lib/stage/decoder.ts). Text and one mark per command, nothing that moves like a
 * brain: the rows hold commands, not brain activity. A keyboard session says keys; an unknown input names no signal.
 */
import { useMemo } from 'react';
import { cx } from '@/lib/cx';
import { useCommands, useInput } from '@/lib/data/provider';
import { buildDecoderView, type DecoderLine } from '@/lib/stage/decoder';
import { useNow } from '@/lib/use-now';
import styles from './Stage.module.css';

export function DecoderPanel() {
  const commands = useCommands();
  const input = useInput();
  const now = useNow(1000);
  const view = useMemo(() => buildDecoderView(commands, input, now), [commands, input, now]);

  return (
    <section className={styles.decoder} aria-labelledby="stage-decoder-title">
      <header className={styles.decoderHead}>
        <h2 id="stage-decoder-title" className={styles.decoderTitle}>
          {view.title}
        </h2>
        {view.how !== null ? <p className={styles.decoderHow}>{view.how}</p> : null}
      </header>
      {view.last !== null ? <LastCommand line={view.last} /> : <p className={styles.decoderNone}>{view.none}</p>}
      {view.earlier.length > 0 ? (
        <ol className={styles.earlier} aria-label="Other recent commands, newest first">
          {view.earlier.map((line) => (
            <li key={line.id} className={cx(styles.earlierRow, line.ignored !== null && styles.ignored)}>
              <Mark line={line} small />
              <span className={styles.earlierWord}>{line.word}</span>
              {line.signal !== null ? <span className={styles.earlierSignal}>{line.signal}</span> : null}
              <span className={cx(styles.earlierAgo, 'num')}>{line.ignored !== null ? `Not counted, ${line.ago}` : line.ago}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function LastCommand({ line }: { line: DecoderLine }) {
  const meta = [line.signal, line.ago, line.confidence !== null ? `confidence ${line.confidence}` : null].filter(Boolean).join(', ');
  return (
    <div key={line.id} className={styles.last}>
      <Mark line={line} />
      <span className={cx(styles.lastWord, line.hand !== null && styles[`hand_${line.hand}`])}>{line.word}</span>
      <span className={cx(styles.lastMeta, 'num')}>{meta}</span>
    </div>
  );
}

/** A ring per command; an imagined squeeze fills it in its hand's color. An ignored one is dashed. */
function Mark({ line, small = false }: { line: DecoderLine; small?: boolean }) {
  return (
    <span
      className={cx(styles.mark, small && styles.markSmall, line.hand !== null && styles[`markHand_${line.hand}`], line.ignored !== null && styles.markIgnored)}
      aria-hidden="true"
    />
  );
}
