/**
 * The judge try page (/try, PLAN 5.11): what to show, from plain values. Pure, so every rule here runs in a test.
 *
 * The page runs Eleven on the `say-when-try` database with one identity, a Station: it asks the question, plays the
 * options, takes the judge's on-screen 1, 2, 3, 4 and STOP (D18 direct select; recorded with source `button`, never as a headset
 * signal), and says the picked reply aloud. The module's try sandbox ties the try to that station alone
 * (spacetime/src/sandbox.ts). What it shows comes from the board rows of that database, whose text is shared on
 * purpose: the judge typed it.
 */
import { eventsForQuestion, hitDisplay, latestOfStage, latestOptions } from '../data/derive';
import { readSpacetimeSettings, type SpacetimeSettings } from '../data/source-mode';
import type { DataRows, Errand, Question } from '../data/types';
import type { Ownership } from '../station/snapshot';

export const TRY_HOST_DEFAULT = 'https://maincloud.spacetimedb.com';
export const TRY_DB_DEFAULT = 'say-when-try';
/** The session label a try starts with; it names no input, so no screen reads it as a headset session. */
export const TRY_SESSION_LABEL = 'try';

/** The try database. Neither value is a secret; NEXT_PUBLIC_TRY_SPACETIMEDB_DB overrides the default. */
export function trySettings(host: string | undefined, db: string | undefined): SpacetimeSettings {
  return readSpacetimeSettings(host?.trim() || TRY_HOST_DEFAULT, db?.trim() || TRY_DB_DEFAULT) ?? { host: TRY_HOST_DEFAULT, db: TRY_DB_DEFAULT };
}

export const TRY_WORDS = {
  honesty: "On-screen buttons stand in for the headset's four picks (1 to 4) and STOP.",
  shared: "What you type shows on this sandbox's public board.",
  busy: 'Someone else is trying Eleven right now. Try again in a minute.',
  agentOff: "Eleven's agent is offline right now, so no options will come.",
  voiceOff: 'Voice is off on this sandbox, so options show as text only.',
  ended: 'Your try ended.',
  demoForm: 'Demo form: nothing is sent anywhere.',
} as const;

export type TryPhase = 'loading' | 'ready' | 'starting' | 'running' | 'ended';

export type VoiceWord = 'ready' | 'off' | 'checking' | 'problem';

export interface TryInput {
  /** The station connection is live and its device is paired. */
  connected: boolean;
  paired: boolean;
  voice: VoiceWord;
  ownership: Ownership;
  /** The session this page started, as a string id, or null. */
  mySessionId: string | null;
  /** The session the station sees as active (its own only, in the sandbox), or null. */
  activeSessionId: string | null;
  /** True once this page has run a try. */
  everStarted: boolean;
  /** The station's raw start or end error, or null. */
  sessionError: string | null;
  /** The last ask error's raw text, or null. */
  askError: string | null;
  agentOnline: boolean | null;
  questionsPerTry: number | null;
  rows: DataRows;
}

export type StepStatus = 'waiting' | 'working' | 'done' | 'skipped' | 'failed';

export interface TryStep {
  key: 'heard' | 'notes' | 'web' | 'draft';
  title: string;
  status: StepStatus;
  detail: string | null;
  items: string[];
}

export interface TryOption {
  id: string;
  rank: number;
  text: string;
  kind: string;
  now: boolean;
  picked: boolean;
}

export interface TryView {
  phase: TryPhase;
  error: string | null;
  notices: string[];
  canAsk: boolean;
  questionsLeft: number | null;
  question: { number: number; text: string } | null;
  steps: TryStep[];
  options: TryOption[];
  turn: string | null;
  /** The picked reply: said out loud, or picked with the voice off. */
  reply: { heading: string; text: string } | null;
  errand: { form: string; status: string; lines: string[] } | null;
}

/** The text after "try limit:" or "busy:" in a module refusal, as a sentence; null for any other error. */
export function limitSentence(raw: string | null): string | null {
  if (!raw) return null;
  const busy = /busy:/i.test(raw);
  if (busy) return TRY_WORDS.busy;
  const match = /try limit:\s*(.+)$/i.exec(raw);
  if (!match) return null;
  const text = (match[1] ?? '').trim().replace(/[.\s]+$/, '');
  return text ? `Try limit: ${text}.` : null;
}

function phaseOf(input: TryInput): TryPhase {
  if (!input.connected || !input.paired) return 'loading';
  if (input.ownership === 'starting') return 'starting';
  const mine = input.mySessionId !== null && input.mySessionId === input.activeSessionId && (input.ownership === 'mine' || input.ownership === 'claiming');
  if (mine) return 'running';
  return input.everStarted ? 'ended' : 'ready';
}

function myQuestions(rows: DataRows, sessionId: string | null): Question[] {
  if (sessionId === null) return [];
  return rows.questions.filter((q) => q.sessionId === sessionId && q.origin === 'partner');
}

function stepsFor(rows: DataRows, q: Question): TryStep[] {
  const events = eventsForQuestion(rows.pipelineEvents, q.id);
  const listen = latestOfStage(events, 'listen');
  const search = latestOfStage(events, 'search');
  const plan = latestOfStage(events, 'plan');

  const heard: TryStep = { key: 'heard', title: 'Heard', status: listen?.status === 'ok' ? 'done' : 'working', detail: listen?.status === 'ok' ? 'Your question reached Eleven.' : null, items: [] };

  // Saved notes: every memory hit of this question's retrieve steps, once each.
  const notes: string[] = [];
  const seen = new Set<string>();
  let retrieveDone = false;
  let retrieveStarted = false;
  for (const e of events) {
    if (e.stage !== 'retrieve') continue;
    retrieveStarted = true;
    if (e.status === 'ok') retrieveDone = true;
    for (const hit of e.detail.hits ?? []) {
      if (hit.origin !== 'memory' || seen.has(hit.id)) continue;
      seen.add(hit.id);
      notes.push(hitDisplay(hit).text);
    }
  }
  const notesStep: TryStep = {
    key: 'notes',
    title: 'Saved notes (Moss)',
    status: notes.length > 0 || retrieveDone ? 'done' : retrieveStarted ? 'working' : 'waiting',
    detail: notes.length > 0 ? null : retrieveDone ? 'No saved note matched.' : null,
    items: notes.slice(0, 3),
  };

  let web: TryStep;
  if (!search) web = { key: 'web', title: 'Web search (Apify)', status: 'waiting', detail: null, items: [] };
  else if (search.detail.needsWeb === false) web = { key: 'web', title: 'Web search (Apify)', status: 'skipped', detail: 'Not needed for this question.', items: [] };
  else if (search.status === 'error') web = { key: 'web', title: 'Web search (Apify)', status: 'failed', detail: 'The search did not answer in time.', items: [] };
  else if (search.status === 'started') web = { key: 'web', title: 'Web search (Apify)', status: 'working', detail: 'Looking it up.', items: [] };
  else {
    const rowsFound = search.detail.rows ?? [];
    const count = search.detail.rowCount ?? rowsFound.length;
    web = { key: 'web', title: 'Web search (Apify)', status: 'done', detail: `${count} ${count === 1 ? 'result' : 'results'}.`, items: rowsFound.slice(0, 3).map((r) => r.title) };
  }

  let draft: TryStep;
  if (!plan) draft = { key: 'draft', title: 'Drafting (Claude)', status: 'waiting', detail: null, items: [] };
  else if (plan.status === 'started') draft = { key: 'draft', title: 'Drafting (Claude)', status: 'working', detail: 'Writing spoken options.', items: [] };
  else if (plan.status === 'error') {
    const label = plan.detail.label ?? '';
    draft = { key: 'draft', title: 'Drafting (Claude)', status: 'failed', detail: /try_limit/.test(label) ? 'Try limit reached for now. Try again later.' : 'No options this time. Ask again.', items: [] };
  } else {
    const n = plan.detail.optionCount;
    draft = { key: 'draft', title: 'Drafting (Claude)', status: 'done', detail: n ? `${n} options.` : 'Options ready.', items: [] };
  }
  // Once the draft is done, a step that never started was not used for this question: never "Waiting" forever.
  if (draft.status === 'done' || draft.status === 'failed') {
    for (const step of [notesStep, web]) {
      if (step.status === 'waiting') {
        step.status = 'skipped';
        step.detail = 'Not used for this question.';
      }
    }
  }
  return [heard, notesStep, web, draft];
}

function turnOf(rows: DataRows, q: Question, options: TryOption[], errand: Errand | null): string | null {
  const scan = rows.scan;
  if (errand && (errand.status === 'reading_back' || errand.status === 'previewed' || errand.status === 'preparing')) return 'Getting the form ready and reading it back.';
  if (errand && errand.status === 'awaiting_confirm') return '1 sends it. 2 or STOP cancels.';
  if (!scan || scan.questionId !== q.id) return null;
  const total = options.length;
  switch (scan.phase) {
    case 'preparing':
      return 'Getting the options ready.';
    case 'reading':
      return `Reading option ${scan.cursor ?? 1} of ${total}. Tap its number any time.`;
    case 'window':
      return `Pick 1 to ${total}. Silence picks nothing.`;
    case 'veto':
      return 'Picked. STOP still cancels it.';
    case 'paused':
      return 'Paused. 1 resumes.';
    case 'idle':
      if (scan.outcome === 'no_pick' || scan.outcome === 'none') return 'No pick. Nothing was said.';
      if (scan.outcome === 'stopped' || scan.outcome === 'cancelled') return 'Stopped. Nothing was said.';
      return null;
  }
}

const ERRAND_WORDS: Record<Errand['status'], string> = {
  preparing: 'Filling the form',
  previewed: 'Form filled, not sent',
  reading_back: 'Reading it back',
  awaiting_confirm: 'Waiting for 1 to send, 2 to cancel',
  confirmed: 'Confirmed',
  submitting: 'Sending',
  sent: 'Sent to the demo form',
  unknown_outcome: 'It may have been sent',
  stopped: 'Stopped. Nothing was sent',
  refused: 'Refused. Nothing was sent',
  failed: 'Failed. Nothing was sent',
};

export function tryView(input: TryInput): TryView {
  const phase = phaseOf(input);
  const notices: string[] = [];
  if (phase !== 'loading') {
    if (input.agentOnline === false) notices.push(TRY_WORDS.agentOff);
    if (input.voice === 'off') notices.push(TRY_WORDS.voiceOff);
  }
  const startError = phase === 'ready' || phase === 'ended' ? input.sessionError : null;
  const error = limitSentence(input.askError) ?? limitSentence(startError) ?? (startError ? 'Could not start. Try again.' : null) ?? (input.askError ? 'Could not send the question. Try again.' : null);

  const running = phase === 'running';
  const mine = running ? myQuestions(input.rows, input.mySessionId) : [];
  const q = mine.length > 0 ? (mine[mine.length - 1] ?? null) : null;
  const used = mine.length;
  const questionsLeft = input.questionsPerTry === null ? null : Math.max(0, input.questionsPerTry - used);

  const empty: TryView = { phase, error, notices, canAsk: running && questionsLeft !== 0, questionsLeft: running ? questionsLeft : null, question: null, steps: [], options: [], turn: null, reply: null, errand: null };
  if (!running || !q) return empty;

  const scan = input.rows.scan;
  const options: TryOption[] = latestOptions(input.rows.options, q.id).map((o) => ({
    id: o.id,
    rank: o.rank,
    text: o.text,
    kind: o.kind,
    // Direct select (D18): an option is "now" only while it is read; the wait after the list is on no option.
    now: !!scan && scan.questionId === q.id && scan.phase === 'reading' && scan.cursor === o.rank && scan.answerMode === 'pick',
    picked: !!scan && scan.pickedOptionId === o.id,
  }));
  const errandRow = [...input.rows.errands].reverse().find((e) => e.questionId === q.id) ?? null;
  const errand = errandRow
    ? {
        form: errandRow.form || 'Care team request',
        status: ERRAND_WORDS[errandRow.status],
        lines: [...errandRow.readBack.map((r) => `${r.label} ${r.value}`), TRY_WORDS.demoForm],
      }
    : null;

  // "Said out loud" only once the room voice reported it; with the voice off, the pick says so instead.
  let reply: TryView['reply'] = null;
  if (q.replyText && q.spokenAt !== null) reply = { heading: 'Said out loud', text: q.replyText };
  else if (q.replyText && input.voice === 'off') reply = { heading: 'Picked. Voice is off, so it was not said out loud', text: q.replyText };

  return {
    ...empty,
    question: { number: q.number, text: q.text ?? `Question ${q.number}` },
    steps: stepsFor(input.rows, q),
    options,
    turn: turnOf(input.rows, q, options, errandRow),
    reply,
    errand,
  };
}
