'use client';

/**
 * The options at hero size, one per row, in reading order (docs/ui.md "Screen 3"). All rows are the
 * same size, so nothing jumps when the cursor moves:
 * - Each row keeps room for its own line under the text ("In the earpiece now", or "Picked").
 * - The text sits over a hidden copy at the cursor's weight, so the weight change never rewraps it.
 * The cursor is a 4 px accent outline, a tint and the words "In the earpiece now", never color
 * alone. It moves between rows in 160 ms. A new version of the options fades the list in (the key).
 * The list is not a live region: it changes every few seconds. The screen announces the pick only.
 */
import { Chip } from '@/components/ui/Chip';
import { StatusMark } from '@/components/ui/StatusMark';
import { TextLink } from '@/components/ui/TextLink';
import { optionBadge } from '@/lib/commands';
import { cx } from '@/lib/cx';
import type { AnswerOption } from '@/lib/data/types';
import { EarLine } from './EarLine';
import { KIND_WORDS, screenText, toneWord, YES_NO_PROMPT, type AgentStatus, type ConversationView, type CursorView } from './model';
import { ReadingText } from './ReadingText';
import styles from './OptionList.module.css';

export interface OptionListProps {
  view: ConversationView;
  /** false while the connection is down: the rows may be stale, so no clock runs. */
  live: boolean;
}

export function OptionList({ view, live }: OptionListProps) {
  const { options, cursor, picked, vetoing, agent, yesNo, menu, followUp, pausedWord } = view;
  const label = yesNo
    ? 'Answers: 1 picks the first, 2 picks the second'
    : menu
      ? "The person's menu, read once, numbered"
      : 'Options, read once, numbered. The person picks one by its number';
  return (
    <div key={view.listKey} className={styles.wrap}>
      {followUp ? <p className={styles.eyebrow}>Follow-up options</p> : null}
      <ol className={cx(styles.options, yesNo && styles.yesNo)} aria-label={label}>
        {options.map((option) => (
          <OptionRow
            key={option.id}
            option={option}
            yesNo={yesNo}
            cursor={cursor !== null && cursor.optionId === option.id ? cursor : null}
            picked={picked !== null && picked.id === option.id}
            vetoing={vetoing}
            agent={agent}
            live={live}
            pausedWord={pausedWord}
          />
        ))}
      </ol>
      {cursor !== null && cursor.optionId === null && (yesNo || cursor.waitingFor) ? (
        <div className={cx(styles.prompt, cursor.phase === 'stopped' ? styles.halted : styles.current)}>
          <EarLine cursor={cursor} live={live} pausedWord={pausedWord} {...(yesNo ? { prompt: YES_NO_PROMPT } : {})} />
        </div>
      ) : null}
    </div>
  );
}

interface OptionRowProps {
  option: AnswerOption;
  yesNo: boolean;
  /** Set only on the row under the cursor. */
  cursor: CursorView | null;
  picked: boolean;
  vetoing: boolean;
  agent: AgentStatus | null;
  live: boolean;
  pausedWord: string | null;
}

/** The short earpiece label (D18) when it says something the text does not; null for "Option N" or the text itself. */
function earLabel(option: AnswerOption): string | null {
  const label = screenText(option.label ?? '')?.trim() ?? '';
  if (label === '' || label === screenText(option.text)?.trim() || /^Option \d+$/.test(label)) return null;
  return label;
}

function OptionRow({ option, yesNo, cursor, picked, vetoing, agent, live, pausedWord }: OptionRowProps) {
  const text = screenText(option.text) ?? '';
  const kind = KIND_WORDS[option.kind];
  const tone = toneWord(option.tone);
  const stopped = cursor !== null && cursor.phase === 'stopped';
  const reading = cursor !== null && cursor.phase === 'reading' && live;
  // Direct select (D18): every option is picked by its number, the badge the legend and the earpiece use.
  const number = optionBadge(option.rank) || String(option.rank);
  const ear = earLabel(option);

  return (
    <li
      className={cx(styles.option, cursor !== null && !stopped && styles.current, stopped && styles.halted, picked && styles.picked)}
      aria-current={cursor !== null ? 'true' : undefined}
    >
      <span className={cx(styles.n, 'num')}>{number}</span>
      <span className={styles.text}>
        <span className={styles.sizer} aria-hidden="true">
          {text}
        </span>
        <span className={styles.shown}>
          {reading && cursor !== null ? <ReadingText text={text} startedAt={cursor.startedAt} endsAt={cursor.endsAt} timings={cursor.words} /> : text}
        </span>
      </span>
      {kind !== null || tone !== null || ear !== null ? (
        <span className={styles.tags}>
          {ear !== null ? (
            <span className={styles.ear} title="What the earpiece says before the room hears anything">
              Ear: {ear}
            </span>
          ) : null}
          {kind !== null ? <Chip tone="muted">{kind}</Chip> : null}
          {tone !== null ? <span className={styles.tone}>{tone}</span> : null}
        </span>
      ) : null}
      <div className={styles.slot}>
        {cursor !== null ? <EarLine cursor={cursor} live={live} pausedWord={pausedWord} /> : null}
        {picked ? <PickedLine vetoing={vetoing} agent={agent} /> : null}
      </div>
    </li>
  );
}

/**
 * "Picked" in the pick green, then the veto or where the picked errand or call is. The shared
 * mark carries the word for screen readers; the visible words are larger than its meta size,
 * because this line is read from across the room.
 */
function PickedLine({ vetoing, agent }: { vetoing: boolean; agent: AgentStatus | null }) {
  return (
    <div className={styles.pickedLine}>
      <span className={styles.state}>
        <StatusMark status="done" showWord={false} word="Picked" pick />
        <span className={styles.pickedWord} aria-hidden="true">
          Picked
        </span>
      </span>
      {vetoing ? <span className={styles.veto}>About to be said out loud. STOP still cancels it.</span> : null}
      {agent !== null ? (
        <span className={styles.state}>
          <StatusMark status={agent.status} showWord={false} word={agent.sentence} />
          <span className={cx(styles.agentText, styles[`state_${agent.status}`])} aria-hidden="true">
            {agent.sentence}
          </span>
        </span>
      ) : null}
      {agent !== null ? <TextLink href="/agents">See it on Agents</TextLink> : null}
    </div>
  );
}
