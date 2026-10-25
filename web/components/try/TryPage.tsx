'use client';

/**
 * /try (PLAN 5.11): a judge runs Eleven from their own phone or laptop. They type a question, watch Eleven look it up
 * and draft spoken options, hear them, and pick one with on-screen buttons that stand in for the headset. Few words;
 * everything shown comes from lib/try/model.ts.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { StatusMark } from '@/components/ui';
import { commandLabel } from '@/lib/commands';
import type { RunStatus } from '@/lib/status';
import type { StationCommand } from '@/lib/station/commands';
import { TRY_WORDS, type StepStatus } from '@/lib/try/model';
import { cx } from '@/lib/cx';
import { useTry } from './useTry';
import styles from './TryPage.module.css';

const STEP_STATUS: Record<StepStatus, { status: RunStatus; word: string }> = {
  waiting: { status: 'not_started', word: 'Waiting' },
  working: { status: 'working', word: 'Working' },
  done: { status: 'done', word: 'Done' },
  skipped: { status: 'stopped', word: 'Skipped' },
  failed: { status: 'failed', word: 'Failed' },
};

/** Direct select (D18): one button per pick and STOP, labeled from the one legend (lib/commands.ts). */
const BUTTONS: ReadonlyArray<{ command: StationCommand; word: string; hint: string; tone: 'pick' | 'stop' | null }> = [
  { command: 'PICK_1', word: commandLabel('PICK_1'), hint: 'option 1, or send it', tone: 'pick' },
  { command: 'PICK_2', word: commandLabel('PICK_2'), hint: 'option 2, or cancel', tone: null },
  { command: 'PICK_3', word: commandLabel('PICK_3'), hint: 'option 3', tone: null },
  { command: 'PICK_4', word: commandLabel('PICK_4'), hint: 'option 4', tone: null },
  { command: 'STOP', word: commandLabel('STOP'), hint: 'cancel, hang up', tone: 'stop' },
];

export function TryPage() {
  const { view, start, end, press, ask, asking } = useTry();
  const [text, setText] = useState('');
  const optionsRef = useRef<HTMLDivElement | null>(null);
  const firstOption = view.options[0]?.id ?? null;

  // When a question's options arrive, bring them into view above the buttons (no animation if motion is reduced).
  useEffect(() => {
    if (!firstOption || !optionsRef.current) return;
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    optionsRef.current.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  }, [firstOption]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const words = text.trim();
    if (!words || asking) return;
    if (await ask(words)) setText('');
  };

  return (
    <section className={styles.root} aria-labelledby="try-title">
      <header className={styles.top}>
        <h1 id="try-title" className={styles.title}>
          Try Eleven
        </h1>
        <p className={styles.honest}>{TRY_WORDS.honesty}</p>
      </header>

      {view.notices.map((notice) => (
        <p key={notice} className={styles.notice} role="status">
          {notice}
        </p>
      ))}
      {view.error ? (
        <p className={styles.error} role="alert">
          {view.error}
        </p>
      ) : null}

      {view.phase === 'loading' ? (
        <p className={styles.lead} role="status">
          Getting ready
        </p>
      ) : null}

      {view.phase === 'ready' || view.phase === 'ended' || view.phase === 'starting' ? (
        <div className={styles.card}>
          {view.phase === 'ended' ? <p className={styles.lead}>{TRY_WORDS.ended}</p> : null}
          <p className={styles.lead}>Ask a question. Eleven looks it up and reads you short spoken replies. You pick one.</p>
          <p className={styles.meta}>{TRY_WORDS.shared}</p>
          <button type="button" className={styles.primary} onClick={start} disabled={view.phase === 'starting'}>
            {view.phase === 'starting' ? 'Starting' : view.phase === 'ended' ? 'Start again' : 'Start'}
          </button>
        </div>
      ) : null}

      {view.phase === 'running' ? (
        <>
          <form className={styles.ask} onSubmit={submit}>
            <label htmlFor="try-question" className={styles.label}>
              Your question
            </label>
            <div className={styles.askRow}>
              <input
                id="try-question"
                className={styles.input}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="Where can we get dinner near here?"
                maxLength={300}
                autoComplete="off"
                disabled={!view.canAsk}
              />
              <button type="submit" className={styles.primary} disabled={!view.canAsk || asking || text.trim() === ''}>
                {asking ? 'Asking' : 'Ask'}
              </button>
            </div>
            {view.questionsLeft !== null ? (
              <p className={styles.meta}>
                {view.questionsLeft} {view.questionsLeft === 1 ? 'question' : 'questions'} left in this try
              </p>
            ) : null}
          </form>

          {view.question ? (
            <div className={styles.card}>
              <p className={styles.meta}>You asked</p>
              <p className={styles.lead}>{view.question.text}</p>
              <ol className={styles.steps}>
                {view.steps.map((step) => (
                  <li key={step.key} className={styles.step}>
                    <StatusMark status={STEP_STATUS[step.status].status} word={STEP_STATUS[step.status].word} />
                    <span className={styles.stepTitle}>{step.title}</span>
                    {step.detail ? <span className={styles.meta}>{step.detail}</span> : null}
                    {step.items.length > 0 ? (
                      <ul className={styles.items}>
                        {step.items.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          {view.options.length > 0 ? (
            <div className={styles.card} ref={optionsRef}>
              <p className={styles.meta}>Spoken options</p>
              {view.turn ? (
                <p className={styles.turn} role="status">
                  {view.turn}
                </p>
              ) : null}
              <ol className={styles.options}>
                {view.options.map((option) => (
                  <li key={option.id} className={cx(styles.option, option.now && styles.now, option.picked && styles.picked)} aria-current={option.now ? 'true' : undefined}>
                    <span className={styles.rank}>{option.rank}</span>
                    <span>{option.text}</span>
                    {option.kind === 'errand' ? <span className={styles.meta}> (form errand)</span> : null}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          {view.turn && view.options.length === 0 ? (
            <p className={styles.turn} role="status">
              {view.turn}
            </p>
          ) : null}

          {view.errand ? (
            <div className={styles.card}>
              <p className={styles.meta}>{view.errand.form}</p>
              <p className={styles.lead}>{view.errand.status}</p>
              <ul className={styles.items}>
                {view.errand.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {view.reply ? (
            <div className={cx(styles.card, styles.said)} role="status">
              <p className={styles.meta}>{view.reply.heading}</p>
              <p className={styles.lead}>{view.reply.text}</p>
            </div>
          ) : null}

          <div className={styles.buttons} role="group" aria-label="Headset stand-in buttons">
            {BUTTONS.map((b) => (
              <button
                key={b.command}
                type="button"
                className={cx(styles.command, b.tone === 'pick' && styles.yes, b.tone === 'stop' && styles.stop)}
                onClick={() => press(b.command)}
                aria-label={`${b.word}: ${b.hint}`}
              >
                <span className={styles.commandWord}>{b.word}</span>
                <span className={styles.commandHint}>{b.hint}</span>
              </button>
            ))}
          </div>

          <button type="button" className={styles.secondary} onClick={end}>
            End try
          </button>
        </>
      ) : null}
    </section>
  );
}
