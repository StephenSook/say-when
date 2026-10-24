'use client';

/**
 * DataProvider and the hooks every screen reads. Screens never know which source is active:
 * SpacetimeDB, the sample replay, or none (lib/data/source-mode.ts decides).
 *
 * The provider sits in the root layout, so moving between screens keeps the same connection.
 * The server cannot see the address bar, so the server render and the first client render show
 * "Connecting"; the real source starts right after the page loads.
 *
 * The sample replay is loaded with a dynamic import inside the effect that starts it, so its script
 * ships in its own chunk and the browser fetches it only when the replay is on.
 */
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { isRolePageRoute } from '../routes';
import { describeConnection, type ConnectionInfo } from './connection';
import { eventsForQuestion, latestOptions, latestQuestion, spokenReply, type SpokenReply } from './derive';
import { createNoneSource, createPendingSource, type DataSource } from './source';
import { chooseSource, withReplayParam, type SourceChoice } from './source-mode';
import { createSpacetimeSource } from './spacetime';
import type {
  AnswerOption,
  CallRequest,
  CommandEvent,
  DataRows,
  Errand,
  InputKind,
  PipelineEvent,
  Question,
  SafetyState,
  ScanState,
  SourceMode,
  SourceState,
} from './types';

function choiceFor(search: string): SourceChoice {
  return chooseSource({
    nodeEnv: process.env.NODE_ENV,
    host: process.env.NEXT_PUBLIC_SPACETIMEDB_HOST,
    db: process.env.NEXT_PUBLIC_SPACETIMEDB_DB,
    search,
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

/** What the server renders, and what the client shows until its source starts. */
const PENDING_SOURCE: DataSource = createPendingSource(choiceFor('').mode);
const PENDING_STATE: SourceState = PENDING_SOURCE.getState();

interface DataContextValue {
  state: SourceState;
  replayParam: '1' | '0' | null;
}

const DataContext = createContext<DataContextValue | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const [source, setSource] = useState<DataSource>(PENDING_SOURCE);
  const [replayParam, setReplayParam] = useState<'1' | '0' | null>(null);

  useEffect(() => {
    const choice = choiceFor(window.location.search);
    setReplayParam(choice.replayParam);
    // The station and the speaker open their own role connection and never show board rows: start no source there
    // and keep the pending one (docs/station.md 1.6; the EEG laptop has 8 GB).
    if (isRolePageRoute(window.location.pathname)) return;
    let cancelled = false;
    let started: DataSource | null = null;
    const use = (next: DataSource) => {
      if (cancelled) return;
      started = next;
      setSource(next);
      next.start();
    };

    if (choice.mode === 'replay') {
      // Shows "Loading the sample replay" while the replay's own chunk downloads.
      setSource(createPendingSource('replay'));
      import('./replay').then(
        (replay) => use(replay.createReplaySource()),
        (error: unknown) =>
          use(createNoneSource({ mode: 'replay', reason: 'network', errorText: `Could not load the sample replay: ${errorMessage(error)}` })),
      );
    } else if (choice.mode === 'spacetime' && choice.spacetime) {
      use(createSpacetimeSource(choice.spacetime));
    } else {
      use(createNoneSource());
    }

    return () => {
      cancelled = true;
      started?.stop();
    };
  }, []);

  const state = useSyncExternalStore(source.subscribe, source.getState, () => PENDING_STATE);
  const value = useMemo(() => ({ state, replayParam }), [state, replayParam]);

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

function useData(): DataContextValue {
  const value = useContext(DataContext);
  if (!value) throw new Error('NeuroLingo: wrap the app in <DataProvider> (app/layout.tsx does this).');
  return value;
}

/** The connection chip state plus what the screen should do with it. See lib/data/connection.ts. */
export function useConnection(): ConnectionInfo {
  const { state } = useData();
  return useMemo(() => describeConnection(state), [state]);
}

/** 'spacetime', 'replay' or 'none'. The shell shows the "Sample replay, not live data" banner for 'replay'. */
export function useSourceMode(): SourceMode {
  return useData().state.mode;
}

/** Every row, for anything the named hooks below do not cover. */
export function useRows(): DataRows {
  return useData().state.rows;
}

/** Every question, oldest first. */
export function useQuestions(): readonly Question[] {
  return useData().state.rows.questions;
}

/** The newest question, or null before the first one. */
export function useCurrentQuestion(): Question | null {
  const questions = useQuestions();
  return useMemo(() => latestQuestion(questions), [questions]);
}

/** Every pipeline event, oldest first (the raw event feed). */
export function usePipelineEvents(): readonly PipelineEvent[] {
  return useData().state.rows.pipelineEvents;
}

/** One question's pipeline events, oldest first. null gives an empty list. */
export function useQuestionEvents(questionId: string | null): readonly PipelineEvent[] {
  const events = usePipelineEvents();
  return useMemo(() => eventsForQuestion(events, questionId), [events, questionId]);
}

/** One question's options: the newest version only, in reading order. null gives an empty list. */
export function useOptions(questionId: string | null): readonly AnswerOption[] {
  const options = useData().state.rows.options;
  return useMemo(() => latestOptions(options, questionId), [options, questionId]);
}

/** The reply said out loud after YES picks a reply, for one question. null until there is one. */
export function useSpokenReply(questionId: string | null): SpokenReply | null {
  const questions = useQuestions();
  return useMemo(() => spokenReply(questions.find((q) => q.id === questionId) ?? null), [questions, questionId]);
}

/** Every errand, oldest first. The newest is the last one. */
export function useErrands(): readonly Errand[] {
  return useData().state.rows.errands;
}

/** Every call request, oldest first. The newest is the last one. */
export function useCalls(): readonly CallRequest[] {
  return useData().state.rows.calls;
}

/** Every command event, oldest first, including ignored repeats (`accepted: false`). */
export function useCommands(): readonly CommandEvent[] {
  return useData().state.rows.commands;
}

/** The scan clock: the option in the earpiece, its phase and the time left. null when no scan runs. */
export function useScanState(): ScanState | null {
  return useData().state.rows.scan;
}

/** The headset safety state behind the shell banner and the headset chip. */
export function useSafety(): SafetyState {
  return useData().state.rows.safety;
}

/** The board session's input mode (headset, keyboard, switch or unknown), so no screen passes a key press off as a headset signal. */
export function useInput(): InputKind {
  return useData().state.rows.input;
}

/** The ?replay flag from the address, kept on in-app links. */
export function useReplayParam(): '1' | '0' | null {
  return useData().replayParam;
}

/** An in-app link that keeps ?replay=1 (or ?replay=0) when moving between screens. */
export function useHref(path: string): string {
  const replayParam = useReplayParam();
  return useMemo(() => withReplayParam(path, replayParam), [path, replayParam]);
}
