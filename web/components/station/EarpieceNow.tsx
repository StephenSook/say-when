'use client';

/**
 * "In the earpiece now" (docs/station.md 2.2): which option the wearer hears, its number, tone and kind, and a time
 * bar for the read and the window. The option's words show only while the room's sharing toggle is on; then the word
 * being read is marked from Cartesia's word timings on each animation frame. The mark switches at once (no motion).
 */
import { useEffect, useState } from 'react';
import { Bar } from '@/components/ui/Bar';
import { cx } from '@/lib/cx';
import type { StationEngine } from '@/lib/station/engine';
import { earpieceHero } from '@/lib/station/model';
import type { StationSnapshot } from '@/lib/station/snapshot';
import styles from './EarpieceNow.module.css';

export interface EarpieceNowProps {
  s: StationSnapshot;
  engine: StationEngine | null;
  now: number;
}

export function EarpieceNow({ s, engine, now }: EarpieceNowProps) {
  const hero = earpieceHero(s, now);
  const share = s.config?.shareText === true;
  const marking = share && hero.words !== null && s.playing === 'option';
  const { index, words } = useWordMark(engine, marking);
  const timed = marking && words.length > 0;

  return (
    <section className={styles.now} aria-labelledby="earpiece-now">
      <h2 id="earpiece-now" className={styles.label}>
        In the earpiece now
      </h2>
      <p className={styles.title}>{hero.title}</p>
      {hero.words !== null ? (
        <p className={styles.words}>
          {timed
            ? words.map((word, i) => (
                <span key={i} className={cx(styles.word, i === index && styles.current)} aria-current={i === index ? 'true' : undefined}>
                  {word}{' '}
                </span>
              ))
            : hero.words}
        </p>
      ) : null}
      {hero.note ? <p className={styles.note}>{hero.note}</p> : null}
      {hero.bar ? (
        <div className={styles.barRow}>
          <Bar value={hero.bar.value} max={hero.bar.max} label={hero.bar.label} valueText={hero.bar.valueText} tone={hero.bar.tone} />
          <span className={cx(styles.note, 'num')}>{hero.bar.valueText}</span>
        </div>
      ) : null}
    </section>
  );
}

/** The word being read, from the engine on each animation frame, while `on`. */
function useWordMark(engine: StationEngine | null, on: boolean): { index: number; words: readonly string[] } {
  const [mark, setMark] = useState<{ index: number; words: readonly string[] }>({ index: -1, words: [] });
  useEffect(() => {
    if (!engine || !on) {
      setMark((m) => (m.index === -1 && m.words.length === 0 ? m : { index: -1, words: [] }));
      return;
    }
    let frame = 0;
    const tick = () => {
      const words = engine.playingWords();
      const index = engine.wordIndex();
      setMark((m) => (m.index === index && m.words.length === words.length && m.words[0] === words[0] ? m : { index, words }));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [engine, on]);
  return mark;
}
