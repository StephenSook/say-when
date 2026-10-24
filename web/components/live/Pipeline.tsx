'use client';

/**
 * The six steps, left to right: Heard, Searched, Recalled, Drafting, Speaking, Picked. Each shows
 * its tool, its real payload in one line and its time; the link between two steps shows what
 * passed ("10 words", "6 rows", "4 hits"). The step running now is outlined. Under 1100 px the
 * steps stack top to bottom with the counts on the links (docs/ui.md "Screen 1").
 */
import { StatusMark } from '@/components/ui/StatusMark';
import { cx } from '@/lib/cx';
import { formatSeconds } from '@/lib/format';
import { ClipButton } from './ClipButton';
import { Elapsed } from './Elapsed';
import type { StageCard } from './model';
import styles from './Pipeline.module.css';

export function Pipeline({ cards }: { cards: readonly StageCard[] }) {
  return (
    <ol className={styles.pipeline} aria-label="Pipeline for this question">
      {cards.map((card, i) => (
        <li key={card.stage} className={styles.item} aria-current={card.status === 'working' ? 'step' : undefined}>
          <div className={cx(styles.card, styles[card.status])}>
            <div className={styles.top}>
              {/* The visible time line carries the word, so the mark's own word is not read twice. */}
              <span aria-hidden="true" className={styles.mark}>
                <StatusMark status={card.status} showWord={false} word={card.word} pick={card.stage === 'select'} />
              </span>
              <span className={styles.name}>{card.name}</span>
            </div>
            <p className={styles.tool}>{card.tool}</p>
            <div className={styles.payloadRow}>
              <p className={cx(styles.payload, card.note && styles.note)} title={card.payloadTitle ?? undefined}>
                {card.payload}
              </p>
              {card.clip ? <ClipButton url={card.clip.url} label={card.clip.label} /> : null}
            </div>
            <TimeLine card={card} />
          </div>
          {i < cards.length - 1 ? <Link label={card.passed} done={card.status === 'done'} /> : null}
        </li>
      ))}
    </ol>
  );
}

/** "Done in 0.4 s", "Working, 0.6 s so far", "Failed after 1.2 s". Never a Done without its number. */
function TimeLine({ card }: { card: StageCard }) {
  const time = card.time;
  let body = null;
  if (time?.kind === 'running') {
    body = (
      <>
        {card.word}, <Elapsed from={time.from} until={time.until} /> so far
      </>
    );
  } else if (time?.kind === 'cut') {
    body = `${card.word}, after ${formatSeconds(time.ms)}`;
  } else if (time?.kind === 'final') {
    if (time.ms === null) body = `${card.word}, no time reported`;
    else body = `${card.status === 'failed' ? 'Failed after' : 'Done in'} ${formatSeconds(time.ms)}`;
  } else {
    // No run: the payload already says Not started, Skipped or Not needed.
    return null;
  }
  return <p className={cx(styles.time, 'num')}>{body}</p>;
}

function Link({ label, done }: { label: string | null; done: boolean }) {
  return (
    <div className={cx(styles.link, done && styles.linkDone)}>
      {label ? (
        <span className={cx(styles.linkLabel, 'num')}>
          <span className="visually-hidden">Passed on: </span>
          {label}
        </span>
      ) : null}
    </div>
  );
}
