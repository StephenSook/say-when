'use client';

/**
 * Screen 3, Live conversation (PLAN 5.4). Spec: docs/ui.md "Screen 3: Live conversation". Look: docs/mockups/conversation.html.
 *
 * Purpose: the conversation itself. The partner's question, each option as it is read into the
 * earpiece, the pick, and the reply said out loud. Focus: the option being read right now.
 *
 * Top to bottom:
 * - "The partner asked" over the question. A turn from the person's own menu reads "Opened by the
 *   person" over "The person's menu", and its items show the same way as options.
 * - The options at hero size with their kind and tone. The one under the cursor is outlined, says
 *   "In the earpiece now", marks the word being read, and shows a time-left bar only once its audio
 *   has ended and the response window is open. "Pass 1 of 2" and the way out of the list sit below:
 *   "NO skips this one. STOP means none of these. Silence moves on."
 * - The command strip, the gesture legend (lib/commands.ts): 1, 2, 3, 4 and STOP, each lit for 1.2 s
 *   when its command arrives.
 * - "Said out loud" with the reply, which appears only once the person picks it.
 *
 * States. It renders inside the shell's <main> behind ConnectionGate, so rows exist by the time it
 * renders; connecting and "Not connected" before any rows are the gate's.
 * - Empty: "Waiting for the partner to ask something." at --text-lead.
 * - Loading: "Listening to the partner", then the question and "Drafting options" (the status line,
 *   0, 3 and 10 s messages); "Getting ready to read the options" while the clips are made.
 * - Error: "Could not draft options. Ask again." with the failed mark (raw text in a tooltip).
 * - Reconnecting or offline with rows: the shell dims the screen and says "Showing the last known
 *   state"; here the word mark and the countdown stop, since the rows may be stale.
 * - Paused or the input off: under the shell banner the list drops to 40% and the cursor stops.
 * The rules for reading the rows live in components/conversation/model.ts.
 */
import { useMemo } from 'react';
import { CommandStrip } from '@/components/conversation/CommandStrip';
import { buildConversationView, focusQuestion } from '@/components/conversation/model';
import { OptionList } from '@/components/conversation/OptionList';
import { SaidAloud } from '@/components/conversation/SaidAloud';
import { TurnHeader } from '@/components/conversation/TurnHeader';
import { TurnEnding, TurnNote } from '@/components/conversation/TurnNote';
import { cx } from '@/lib/cx';
import {
  useCalls,
  useConnection,
  useErrands,
  useInput,
  useQuestionEvents,
  useQuestions,
  useRows,
  useSafety,
  useScanState,
  useSpokenReply,
} from '@/lib/data/provider';
import styles from './Conversation.module.css';

export function Conversation() {
  const questions = useQuestions();
  const scan = useScanState();
  const { options } = useRows();
  const errands = useErrands();
  const calls = useCalls();
  const safety = useSafety();
  const input = useInput();
  const conn = useConnection();

  const question = useMemo(() => focusQuestion(questions, scan), [questions, scan]);
  const events = useQuestionEvents(question?.id ?? null);
  const reply = useSpokenReply(question?.id ?? null);

  const view = useMemo(
    () =>
      question
        ? buildConversationView({ question, scan, options, events, errands, calls, safety, input, hasReply: reply !== null })
        : null,
    [question, scan, options, events, errands, calls, safety, input, reply],
  );

  if (view === null) {
    return (
      <section className={styles.root} aria-labelledby="conversation-title">
        <h1 id="conversation-title" className="visually-hidden">
          Live conversation
        </h1>
        <p className={styles.empty} role="status">
          Waiting for the partner to ask something.
        </p>
        <CommandStrip />
      </section>
    );
  }

  const live = !conn.dimmed;

  return (
    <section className={styles.root} aria-labelledby="conversation-title">
      <h1 id="conversation-title" className="visually-hidden">
        Live conversation
      </h1>

      <TurnHeader header={view.header} />

      <div className={cx(styles.turn, view.paused !== null && styles.paused)}>
        {view.options.length > 0 ? <OptionList view={view} live={live} /> : null}
        {view.legend !== null ? (
          <div className={styles.foot}>
            <span>{view.legend}</span>
            {view.pass !== null ? (
              <span className={cx(styles.pass, 'num')}>
                Pass {view.pass.pass} of {view.pass.max}
              </span>
            ) : null}
          </div>
        ) : null}
        {view.note !== null ? <TurnNote note={view.note} resetKey={view.listKey} /> : null}
        {view.ending !== null ? <TurnEnding ending={view.ending} /> : null}
      </div>

      <CommandStrip />

      <SaidAloud reply={reply} nothingSaid={view.ending !== null} />

      {/* The list is not a live region; only the pick, or how the turn ended, is announced. */}
      <p className="visually-hidden" role="status">
        {view.announcement}
      </p>
    </section>
  );
}
