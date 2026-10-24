'use client';

/**
 * The top of Live data: which question this is, the partner's words, and the one headline number,
 * the time from the words being heard to the first option in the earpiece (docs/ui.md "Screen 1").
 * Earlier questions are one Left arrow away; "Back to live" returns to the newest.
 */
import { StatusLine } from '@/components/ui/StatusLine';
import { TextLink } from '@/components/ui/TextLink';
import { cx } from '@/lib/cx';
import type { Question } from '@/lib/data/types';
import { formatSeconds } from '@/lib/format';
import { Elapsed } from './Elapsed';
import type { FirstOption } from './model';
import styles from './QuestionHeader.module.css';

/** "Question 7, asked by the partner", or where the turn came from. */
export function eyebrowFor(question: Question): string {
  if (question.origin === 'menu') {
    return question.number > 0 ? `Question ${question.number}, from the person's menu` : "The person's menu, opened with YES";
  }
  return `Question ${question.number}, ${question.via === 'typed' ? 'typed' : 'asked'} by the partner`;
}

const LISTENING: readonly [string, string, string] = [
  'Listening to the partner',
  'Still listening',
  'Still listening. The partner may still be talking.',
];

export interface QuestionHeaderProps {
  question: Question;
  /** The partner's words from the Listen row, when the question row has none. */
  heardWords: string | null;
  /** The Listen step is running. */
  listening: boolean;
  firstOption: FirstOption | null;
  /** Showing the newest question. */
  live: boolean;
  canGoEarlier: boolean;
  onEarlier: () => void;
  onLater: () => void;
  onLive: () => void;
}

export function QuestionHeader({ question, heardWords, listening, firstOption, live, canGoEarlier, onEarlier, onLater, onLive }: QuestionHeaderProps) {
  const menu = question.origin === 'menu';
  const words = question.text?.trim() || heardWords;

  let headline = null;
  if (words) {
    headline = <span className={styles.headline}>{menu ? words : `"${words}"`}</span>;
  } else if (menu) {
    headline = <span className={styles.headline}>Menu</span>;
  } else if (!listening) {
    headline = <span className={cx(styles.headline, styles.quiet)}>Words not shared on this screen</span>;
  }

  return (
    <div className={styles.header}>
      <div className={styles.main}>
        <h2 className={styles.heading}>
          <span className={styles.eyebrow}>{eyebrowFor(question)}</span>
          {headline}
        </h2>
        {!words && !menu && listening ? (
          <StatusLine messages={LISTENING} resetKey={question.id} size="lead" align="start" className={styles.listening} />
        ) : null}
        {canGoEarlier || !live ? (
          <div className={styles.nav}>
            {canGoEarlier ? (
              <TextLink onClick={onEarlier} title="Left arrow key" className={styles.navLink}>
                Earlier question
              </TextLink>
            ) : null}
            {!live ? (
              <TextLink onClick={onLater} title="Right arrow key" className={styles.navLink}>
                Later question
              </TextLink>
            ) : null}
            {!live ? (
              <TextLink onClick={onLive} className={styles.navLink}>
                Back to live
              </TextLink>
            ) : null}
          </div>
        ) : null}
        <p className={styles.navNote} role="status">
          {live ? '' : 'Showing an earlier question.'}
        </p>
      </div>

      <div className={styles.ttfo}>
        {firstOption?.kind === 'final' ? (
          <>
            <span className={cx(styles.big, 'num')}>{formatSeconds(firstOption.ms)}</span>
            <span className={styles.ttfoLabel}>to the first option</span>
          </>
        ) : null}
        {firstOption?.kind === 'running' ? (
          <>
            <span className={cx(styles.big, styles.counting, 'num')} aria-hidden="true">
              <Elapsed from={firstOption.from} until={firstOption.until} />
            </span>
            <span className={styles.ttfoLabel}>waiting for the first option</span>
          </>
        ) : null}
        {firstOption?.kind === 'none' ? <span className={styles.none}>{firstOption.sentence}</span> : null}
      </div>
      <p className="visually-hidden" role="status">
        {firstOption?.kind === 'final' ? `${formatSeconds(firstOption.ms)} to the first option.` : ''}
      </p>
    </div>
  );
}
