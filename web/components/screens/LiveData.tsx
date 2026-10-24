'use client';

/**
 * Screen 1, Live data (PLAN 5.2). Spec: docs/ui.md "Screen 1: Live data". Look: docs/mockups/live.html.
 *
 * Purpose: what each pipeline step produced for the current question, and how long it took.
 * Focus: the step running now, outlined. It renders inside the Shell's <main>, behind
 * ConnectionGate, so rows exist by the time it renders; loading and "Not connected" are the gate's.
 *
 * States on this screen:
 * - Empty: "Waiting for the partner to ask something."
 * - Error: the failed step in the error color with one sentence (the raw error is its tooltip),
 *   later steps stay Not started, and the sentence goes to a role="alert" region.
 * - Reconnecting or offline with rows: the shell dims the screen; here every clock stops at the
 *   moment the connection dropped, so nothing counts up on stale rows.
 * - Paused or headset off: the shell shows the banner; a step that was reading or waiting on the
 *   pick reads "Paused" or "Headset off" with the time it ran, and the commands show in the feed.
 *
 * Left and Right arrows step through earlier questions; "Back to live" returns to the newest.
 * The rules for reading the rows live in components/live/model.ts.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActionLines } from '@/components/live/ActionLines';
import { EventFeed } from '@/components/live/EventFeed';
import { buildLiveView } from '@/components/live/model';
import { Panels } from '@/components/live/Panels';
import { Pipeline } from '@/components/live/Pipeline';
import { QuestionHeader } from '@/components/live/QuestionHeader';
import {
  useCalls,
  useCommands,
  useConnection,
  useErrands,
  usePipelineEvents,
  useQuestionEvents,
  useQuestions,
  useRows,
  useSafety,
  useScanState,
} from '@/lib/data/provider';
import styles from './LiveData.module.css';

export function LiveData() {
  const questions = useQuestions();
  const conn = useConnection();
  const rows = useRows();
  const errands = useErrands();
  const calls = useCalls();
  const scan = useScanState();
  const safety = useSafety();
  const allEvents = usePipelineEvents();
  const commands = useCommands();

  // null follows the newest question. An id that has left the rows falls back to the newest.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIndex = selectedId === null ? -1 : questions.findIndex((q) => q.id === selectedId);
  const live = selectedIndex < 0;
  const index = live ? questions.length - 1 : selectedIndex;
  const question = index >= 0 ? (questions[index] ?? null) : null;
  const nextQuestion = live ? null : (questions[index + 1] ?? null);

  useEffect(() => {
    if (selectedId !== null && selectedIndex < 0) setSelectedId(null);
  }, [selectedId, selectedIndex]);

  const events = useQuestionEvents(question?.id ?? null);
  const freezeAt = conn.status === 'live' ? null : conn.since > 0 ? conn.since : null;

  const view = useMemo(
    () =>
      question
        ? buildLiveView({ question, nextQuestion, events, options: rows.options, errands, calls, scan, safety, freezeAt })
        : null,
    [question, nextQuestion, events, rows.options, errands, calls, scan, safety, freezeAt],
  );

  const goEarlier = () => {
    if (index > 0) setSelectedId(questions[index - 1]?.id ?? null);
  };
  const goLater = () => {
    if (live) return;
    // Stepping onto the newest question is the same as going back to live.
    const later = index + 1;
    setSelectedId(later >= questions.length - 1 ? null : (questions[later]?.id ?? null));
  };
  const goLive = () => setSelectedId(null);

  // One key listener for the screen's life; it calls the newest handlers through a ref.
  const keys = useRef({ goEarlier, goLater });
  useEffect(() => {
    keys.current = { goEarlier, goLater };
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.closest('input, textarea, select, audio, video, [role="textbox"], [role="slider"], [role="listbox"], [role="menu"], [role="tablist"]'))
      ) {
        return;
      }
      if (document.querySelector('dialog[open]')) return;
      event.preventDefault();
      if (event.key === 'ArrowLeft') keys.current.goEarlier();
      else keys.current.goLater();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (!question || !view) {
    const anyEvents = allEvents.length > 0 || commands.length > 0;
    return (
      <section className={styles.root} aria-labelledby="live-data-title">
        <h1 id="live-data-title" className="visually-hidden">
          Live data
        </h1>
        <p className={styles.empty} role="status">
          Waiting for the partner to ask something.
        </p>
        {anyEvents ? <EventFeed /> : null}
      </section>
    );
  }

  const listening = view.cards[0]?.status === 'working';

  return (
    <section className={styles.root} aria-labelledby="live-data-title">
      <h1 id="live-data-title" className="visually-hidden">
        Live data
      </h1>
      <QuestionHeader
        question={question}
        heardWords={view.heardWords}
        listening={listening}
        firstOption={view.firstOption}
        live={live}
        canGoEarlier={index > 0}
        onEarlier={goEarlier}
        onLater={goLater}
        onLive={goLive}
      />
      <Pipeline cards={view.cards} />
      <ActionLines lines={view.actions} />
      <Panels search={view.search} recall={view.recall} draft={view.draft} />
      <EventFeed />
      <div className="visually-hidden" role="alert">
        {view.alert ?? ''}
      </div>
    </section>
  );
}
