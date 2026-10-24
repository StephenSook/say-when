/**
 * The Live data screen's model: what each pipeline step produced for one question, and how long it
 * took (docs/ui.md "Screen 1: Live data"). Pure: no React and no clock. Elapsed.tsx owns the clock,
 * so every rule here can be checked against the sample replay at any moment.
 *
 * How the six steps are read:
 * - Heard, Searched and Recalled run once per question. Each shows the newest row of its stage.
 *   A stage can report more than once (Apify runs a web search and a Maps search), so the rows
 *   and counts add up across every finished run.
 * - Drafting, Speaking and Picked run again for follow-up options (an errand, a call, nothing
 *   else). A new Drafting run starts a new round: Speaking and Picked then show rows from that
 *   round only, so the pipeline always reads left to right.
 * - A step that started and has not finished counts up, unless it can no longer finish: the next
 *   question began, the scan ended without a pick, or the system paused. Then it reads as stopped
 *   with the time it ran, so no clock counts up forever.
 * - Producers may send counts where the screen expects lists (`rows: 6` while the board does not
 *   share text), so every detail field is read with a type check.
 * - Memory text is only ever read through hitDisplay: a memory shows its words only when the
 *   person marked it shareable.
 */
import { COMMAND_INFO, commandSignal, commandWord, offWord, withSignal } from '../../lib/commands';
import { hitDisplay, latestOptions, timeToFirstOption } from '../../lib/data/derive';
import type {
  AnswerOption,
  CallRequest,
  CommandEvent,
  CommandName,
  Errand,
  InputKind,
  MossHit,
  OptionKind,
  PipelineEvent,
  Question,
  SafetyState,
  ScanOutcome,
  ScanState,
  SearchRow,
  Stage,
} from '../../lib/data/types';
import { countWords, formatCount, formatMs, maskPhoneNumbers } from '../../lib/format';
import { callStatusWord, STATUS_WORDS, statusFromCall, statusFromErrand, type RunStatus } from '../../lib/status';

/** The six steps drawn left to right. Errand and call steps are one line each under them. */
export type CardStage = 'listen' | 'search' | 'retrieve' | 'plan' | 'speak' | 'select';

export const CARD_STAGES: readonly CardStage[] = ['listen', 'search', 'retrieve', 'plan', 'speak', 'select'];

const NAMES: Readonly<Record<CardStage, string>> = {
  listen: 'Heard',
  search: 'Searched',
  retrieve: 'Recalled',
  plan: 'Drafting',
  speak: 'Speaking',
  select: 'Picked',
};

/** How long a step took, or how long it has been running. */
export type StageTime =
  /** Finished, Done or Failed. `ms` is null when no time was reported. */
  | { kind: 'final'; ms: number | null }
  /** Running: count up from `from`. `until` stops the count, for example while the connection is down. */
  | { kind: 'running'; from: number; until: number | null }
  /** Stopped before it finished, after running `ms`. */
  | { kind: 'cut'; ms: number };

export interface StageCard {
  stage: CardStage;
  name: string;
  /** The tool behind the step, as a muted line: "Cartesia Ink-2". */
  tool: string;
  status: RunStatus;
  /** The state in words: Done, Working, Failed, Not started, Skipped, Not needed, Stopped, Paused. */
  word: string;
  /** The step's real payload in one line, or a note about the step. */
  payload: string;
  /** true when `payload` is a note about the step (drawn muted), not its data. */
  note: boolean;
  /** The full payload or the raw error, for a tooltip. */
  payloadTitle: string | null;
  time: StageTime | null;
  /** What passed on to the next step, such as "10 words". null until there is something to count. */
  passed: string | null;
  /** A voice clip to play, only when the speak row carries one (docs/ui.md). */
  clip: { url: string; label: string } | null;
  /** The newest row behind the card, to restart waits and fades when a new run begins. */
  eventId: string | null;
}

/** The headline latency: "2.9 s to the first option". */
export type FirstOption =
  | { kind: 'final'; ms: number }
  | { kind: 'running'; from: number; until: number | null }
  | { kind: 'none'; sentence: string };

export interface SearchPanel {
  card: StageCard;
  rows: SearchRow[];
  rowCount: number | null;
  searches: number;
  /** Some results were dropped or a run hit its time limit. */
  partial: boolean;
  /** One search failed while another came back. */
  failedNote: string | null;
}

export interface RecallPanel {
  card: StageCard;
  /** Highest match first. Render each one through hitDisplay. */
  hits: MossHit[];
  hitCount: number | null;
}

export interface DraftPanel {
  card: StageCard;
  /** The newest option version, in reading order. */
  options: AnswerOption[];
  followUp: boolean;
  /** The option YES picked in this round, if it is in the list. */
  pickedId: string | null;
}

/**
 * What happened after the pick, one line each: the reply said out loud, then the errand and the
 * call, which link to the Agents screen.
 */
export interface ActionLine {
  key: string;
  kind: 'reply' | 'errand' | 'call';
  /** "Said out loud", "Errand: Care team request" or "Call: Demo caregiver". A contact's name only, never a number. */
  title: string;
  status: RunStatus;
  word: string;
  sentence: string;
  time: StageTime | null;
}

export interface LiveInput {
  question: Question;
  /** The question asked after this one, or null for the newest question. */
  nextQuestion: Question | null;
  /** This question's pipeline events, oldest first. */
  events: readonly PipelineEvent[];
  /** Option rows; only this question's are used. */
  options: readonly AnswerOption[];
  errands: readonly Errand[];
  calls: readonly CallRequest[];
  scan: ScanState | null;
  safety: SafetyState;
  /** The session's input: a key or switch press never reads as a headset signal. */
  input: InputKind;
  /** Set while the connection is not live: every clock stops at this moment. */
  freezeAt: number | null;
}

export interface LiveView {
  cards: StageCard[];
  firstOption: FirstOption | null;
  /** The partner's words from the Listen row, for when the question row has no text. */
  heardWords: string | null;
  search: SearchPanel;
  recall: RecallPanel;
  draft: DraftPanel;
  actions: ActionLine[];
  /** The newest failure, for the screen's role="alert" region. */
  alert: string | null;
}

// ---------------------------------------------------------------------------------------------
// Reading loose producer values

type Loose = Record<string, unknown>;

function loose(value: unknown): Loose {
  return value !== null && typeof value === 'object' ? (value as Loose) : {};
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function quoted(value: string): string {
  return `"${value}"`;
}

/** Ends a reason with a period, so it can be followed by another sentence. */
function sentence(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

/** The step's error sentence and raw text. A producer may send an object or a plain string. */
function errorOf(detail: unknown): { sentence: string | null; raw: string | null } {
  const error = loose(detail).error;
  if (typeof error === 'string') return { sentence: text(error), raw: null };
  const fields = loose(error);
  return { sentence: text(fields.sentence), raw: text(fields.raw) };
}

/** A short label from the producer, such as "web partial" (docs/spacetime.md `pipeline_event.detail`). */
function labelOf(detail: unknown): string | null {
  return text(loose(detail).label);
}

/** Only addresses an audio element can play. Anything else gets no play button. */
function safeClipUrl(value: unknown): string | null {
  const url = text(value);
  if (!url) return null;
  return /^(https?:|blob:|data:audio\/)/i.test(url) ? url : null;
}

// ---------------------------------------------------------------------------------------------
// Runs of one stage

/**
 * One stage's rows. Details are read through the checked readers above (loose, num, text), not
 * through the stage's detail type, since producers may send counts where lists are expected.
 */
interface Scope {
  /** The stage's rows in scope, oldest first. */
  events: PipelineEvent[];
  latest: PipelineEvent | null;
  /** Start of the run that is still open, when the newest row is `started`. */
  openFrom: number | null;
  /** Start of the run the newest finished row closed. */
  closedFrom: number | null;
}

/**
 * One stage's rows at or after `from`, optionally only those `keep` accepts. A run starts at its
 * first `started` row and ends at `ok` or `error`.
 */
function scopeOf(events: readonly PipelineEvent[], stage: Stage, from: number, keep?: (event: PipelineEvent) => boolean): Scope {
  const rows: PipelineEvent[] = [];
  for (const event of events) {
    if (event.stage === stage && event.at >= from && (!keep || keep(event))) rows.push(event);
  }
  let open: number | null = null;
  let closed: number | null = null;
  for (const event of rows) {
    if (event.status === 'started') {
      if (open === null) open = event.at;
    } else {
      closed = open;
      open = null;
    }
  }
  return { events: rows, latest: rows[rows.length - 1] ?? null, openFrom: open, closedFrom: closed };
}

/** Start of the newest Drafting run, which starts a round. -Infinity before the first. */
function roundStartOf(events: readonly PipelineEvent[]): number {
  let open = false;
  let newest = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    if (event.stage !== 'plan') continue;
    if (event.status === 'started') {
      if (!open) newest = event.at;
      open = true;
    } else {
      if (!open) newest = event.at - Math.max(0, num(event.ms) ?? 0);
      open = false;
    }
  }
  return newest;
}

/**
 * The time of a finished stage. One run: the producer's own `ms`. Several runs (a web search and a
 * Maps search side by side): from the first row to the last, never less than the longest run.
 */
function finishedMs(scope: Scope, severalRuns: boolean): number | null {
  const latest = scope.latest;
  if (!latest || latest.status === 'started') return null;
  if (severalRuns) {
    const finished = scope.events.filter((event) => event.status !== 'started');
    const first = scope.events[0];
    if (finished.length > 1 && first) {
      const longest = Math.max(...finished.map((event) => num(event.ms) ?? 0));
      return Math.max(0, latest.at - first.at, longest);
    }
  }
  const ms = num(latest.ms);
  if (ms !== null) return Math.max(0, ms);
  return scope.closedFrom !== null ? Math.max(0, latest.at - scope.closedFrom) : null;
}

// ---------------------------------------------------------------------------------------------
// When a running step can no longer finish

interface Cut {
  at: number;
  word: string;
  sentence: string;
}

interface Context {
  question: Question;
  nextQuestion: Question | null;
  /** The scan for this question ended without a pick. */
  ended: Cut | null;
  /** The system is paused or the input is off (newest question only). */
  paused: Cut | null;
  freezeAt: number | null;
  input: InputKind;
}

const ENDINGS: Readonly<Record<Exclude<ScanOutcome, 'picked'>, { word: string; sentence: string }>> = {
  none: { word: 'None of these', sentence: 'STOP: none of these. Nothing was said or sent.' },
  no_pick: { word: 'No pick', sentence: 'No pick. Nothing was said or sent.' },
  stopped: { word: 'Stopped', sentence: 'Stopped. Nothing was said or sent.' },
  cancelled: { word: 'Cancelled', sentence: 'The partner cancelled the question.' },
};

function contextFor(input: LiveInput): Context {
  const { question, scan, safety } = input;
  let ended: Cut | null = null;
  if (scan && scan.questionId === question.id && scan.outcome !== null && scan.outcome !== 'picked') {
    const words = ENDINGS[scan.outcome] ?? ENDINGS.stopped;
    ended = { at: scan.stepStartedAt, ...words };
  }
  let paused: Cut | null = null;
  if (input.nextQuestion === null && safety.since !== null) {
    if (safety.state === 'paused') paused = { at: safety.since, word: 'Paused', sentence: 'Paused. Nothing will be sent.' };
    if (safety.state === 'headset_off') {
      const off = offWord(input.input);
      paused = { at: safety.since, word: off, sentence: `${off}. Nothing will be sent.` };
    }
  }
  return { question, nextQuestion: input.nextQuestion, ended, paused, freezeAt: input.freezeAt, input: input.input };
}

function cutFor(stage: CardStage, from: number, ctx: Context): Cut | null {
  const next = ctx.nextQuestion;
  if (next && next.askedAt >= from) {
    return { at: next.askedAt, word: 'Not finished', sentence: 'Did not finish before the next question.' };
  }
  const scanStage = stage === 'plan' || stage === 'speak' || stage === 'select';
  if (scanStage && ctx.ended && ctx.ended.at >= from) return ctx.ended;
  if ((stage === 'speak' || stage === 'select') && ctx.paused && ctx.paused.at >= from) return ctx.paused;
  return null;
}

interface StepState {
  status: RunStatus;
  word: string;
  time: StageTime;
  /** Set when the step stopped before it finished. */
  cut: Cut | null;
  error: { sentence: string | null; raw: string | null } | null;
}

/** The step's state from its newest row: started is Working, ok is Done, error is Failed (docs/ui.md). */
function stepState(stage: CardStage, scope: Scope, ctx: Context, severalRuns: boolean): StepState | null {
  const latest = scope.latest;
  if (!latest) return null;
  if (latest.status === 'started') {
    const from = scope.openFrom ?? latest.at;
    const cut = cutFor(stage, from, ctx);
    if (cut) return { status: 'stopped', word: cut.word, time: { kind: 'cut', ms: Math.max(0, cut.at - from) }, cut, error: null };
    return { status: 'working', word: STATUS_WORDS.working, time: { kind: 'running', from, until: ctx.freezeAt }, cut: null, error: null };
  }
  const time: StageTime = { kind: 'final', ms: finishedMs(scope, severalRuns) };
  if (latest.status === 'error') return { status: 'failed', word: STATUS_WORDS.failed, time, cut: null, error: errorOf(latest.detail) };
  return { status: 'done', word: STATUS_WORDS.done, time, cut: null, error: null };
}

const SKIPPED: Readonly<Record<CardStage, string>> = {
  listen: 'Skipped. No speech step for this question.',
  search: 'Skipped. No web search for this question.',
  retrieve: 'Skipped. Nothing was recalled for this question.',
  plan: 'Skipped. No options were drafted.',
  speak: 'Skipped. No option was read.',
  select: 'Not started',
};

/** A step with no row. "Skipped" once a later step has rows; "Not needed" for the person's menu. */
function notRun(stage: CardStage, tool: string, later: boolean, menu: boolean): StageCard {
  let word: string = STATUS_WORDS.not_started;
  let payload = 'Not started';
  if (menu && stage !== 'speak' && stage !== 'select') {
    word = 'Not needed';
    payload = stage === 'listen' ? 'Not needed. The person opened their menu.' : 'Not needed for the menu.';
  } else if (later) {
    word = 'Skipped';
    payload = SKIPPED[stage];
  }
  return {
    stage,
    name: NAMES[stage],
    tool,
    status: 'not_started',
    word,
    payload,
    note: true,
    payloadTitle: null,
    time: null,
    passed: null,
    clip: null,
    eventId: null,
  };
}

function baseCard(stage: CardStage, tool: string, state: StepState, eventId: string): Omit<StageCard, 'payload' | 'note' | 'payloadTitle' | 'passed'> {
  return { stage, name: NAMES[stage], tool, status: state.status, word: state.word, time: state.time, clip: null, eventId };
}

/** Payload for a stopped or failed step, or null for a running or finished one. */
function interrupted(state: StepState, fallback: string): Pick<StageCard, 'payload' | 'note' | 'payloadTitle'> | null {
  if (state.cut) return { payload: state.cut.sentence, note: true, payloadTitle: null };
  if (state.status === 'failed') {
    const error = state.error;
    return { payload: error?.sentence ?? fallback, note: false, payloadTitle: error?.raw ?? null };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The six cards

function listenCard(input: LiveInput, ctx: Context, scope: Scope, later: boolean): { card: StageCard; words: string | null } {
  const { question } = input;
  const tool = question.origin === 'menu' ? "The person's menu" : question.via === 'typed' ? "Typed on the partner's phone" : 'Cartesia Ink-2';
  const state = stepState('listen', scope, ctx, true);
  const latest = scope.latest;
  const words = latest ? text(loose(latest.detail).words) : null;
  if (!state || !latest) return { card: notRun('listen', tool, later, question.origin === 'menu'), words };
  const heard = words ?? text(question.text);
  const base = baseCard('listen', tool, state, latest.id);
  const stopped = interrupted(state, 'Could not hear the question.');
  if (stopped) return { card: { ...base, ...stopped, passed: null }, words };
  if (state.status === 'working') {
    const payload = question.via === 'typed' ? 'Reading the typed question' : 'Listening to the partner';
    return { card: { ...base, payload, note: true, payloadTitle: null, passed: null }, words };
  }
  const detail = loose(latest.detail);
  const count = num(detail.wordCount) ?? num(detail.words) ?? (heard ? countWords(heard) : null);
  return {
    card: {
      ...base,
      payload: heard ? quoted(heard) : 'Words not shared on this screen.',
      note: heard === null,
      payloadTitle: heard,
      passed: count === null ? null : formatCount(count, 'word'),
    },
    words,
  };
}

interface SearchFacts {
  rows: SearchRow[];
  rowCount: number | null;
  searches: number;
  partial: boolean;
  /** Every finished search said no outside facts were needed (PLAN D8). */
  noWeb: boolean;
  noWebReason: string | null;
  okCount: number;
}

function searchFacts(scope: Scope): SearchFacts {
  const rows: SearchRow[] = [];
  const seen = new Set<string>();
  let counted: number | null = null;
  let searches = 0;
  let partial = false;
  let okCount = 0;
  let webCount = 0;
  let noWebReason: string | null = null;
  for (const event of scope.events) {
    if (event.status !== 'ok') continue;
    okCount += 1;
    const detail = loose(event.detail);
    if (detail.needsWeb === false) {
      noWebReason = text(detail.reason) ?? noWebReason;
      continue;
    }
    webCount += 1;
    const list = Array.isArray(detail.rows) ? detail.rows : [];
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue;
      const row = item as SearchRow;
      const key = text(row.id) ?? `${String(row.source)}:${String(row.title)}:${rows.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
    const n = num(detail.rowCount) ?? num(detail.rows) ?? (Array.isArray(detail.rows) ? detail.rows.length : null);
    if (n !== null) counted = (counted ?? 0) + n;
    searches += num(detail.searches) ?? 1;
    if (detail.partial === true || (labelOf(detail)?.includes('partial') ?? false)) partial = true;
  }
  return {
    rows,
    rowCount: rows.length > 0 ? rows.length : counted,
    searches,
    partial,
    noWeb: okCount > 0 && webCount === 0,
    noWebReason,
    okCount,
  };
}

function searchCard(input: LiveInput, ctx: Context, scope: Scope, later: boolean): SearchPanel {
  const tool = 'Apify, Google Maps and web';
  const facts = searchFacts(scope);
  let state = stepState('search', scope, ctx, true);
  const latest = scope.latest;
  let failedNote: string | null = null;
  if (state && state.status === 'failed' && facts.okCount > 0) {
    // One search failed while another came back: the step still has rows.
    failedNote = state.error?.sentence ?? 'One of the searches failed.';
    state = { ...state, status: 'done', word: STATUS_WORDS.done, error: null };
  }
  const panel = (card: StageCard): SearchPanel => ({
    card,
    rows: facts.rows,
    rowCount: facts.rowCount,
    searches: facts.searches,
    partial: facts.partial,
    failedNote,
  });
  if (!state || !latest) return panel(notRun('search', tool, later, input.question.origin === 'menu'));
  const base = baseCard('search', tool, state, latest.id);
  const stopped = interrupted(state, 'The search failed.');
  if (stopped) return panel({ ...base, ...stopped, passed: null });
  if (state.status === 'working') {
    const reason = scope.events.map((event) => text(loose(event.detail).reason)).filter((r): r is string => r !== null).pop() ?? null;
    const payload = reason ? `Searching. ${sentence(reason)}` : 'Searching Google Maps and the web';
    return panel({ ...base, payload, note: true, payloadTitle: null, passed: null });
  }
  if (facts.noWeb) {
    const reason = facts.noWebReason ? sentence(facts.noWebReason) : 'No outside facts were needed.';
    return panel({ ...base, payload: `No web search. ${reason}`, note: true, payloadTitle: null, passed: 'no search' });
  }
  const top = facts.rows[0];
  const count = facts.rowCount;
  if (top) {
    const title = text(top.title) ?? 'Untitled result';
    return panel({ ...base, payload: title, note: false, payloadTitle: text(top.text) ?? title, passed: formatCount(count ?? 0, 'row') });
  }
  if (count !== null && count > 0) {
    return panel({ ...base, payload: `${formatCount(count, 'row')}. Not shared on this screen.`, note: true, payloadTitle: null, passed: formatCount(count, 'row') });
  }
  return panel({
    ...base,
    payload: count === 0 ? 'No rows came back.' : 'Done. No rows were reported.',
    note: true,
    payloadTitle: null,
    passed: count === 0 ? '0 rows' : null,
  });
}

function recallCard(input: LiveInput, ctx: Context, scope: Scope, later: boolean): RecallPanel {
  const tool = 'Moss, memory and web';
  const hits: MossHit[] = [];
  const seen = new Set<string>();
  let counted: number | null = null;
  for (const event of scope.events) {
    if (event.status !== 'ok') continue;
    const detail = loose(event.detail);
    const list = Array.isArray(detail.hits) ? detail.hits : [];
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue;
      const raw = item as MossHit;
      // Drop malformed values so hitDisplay never meets a non-string. Nothing is added: a memory
      // still shows words only through sharedText.
      const hit: MossHit = {
        ...raw,
        text: typeof raw.text === 'string' ? raw.text : undefined,
        sharedText: typeof raw.sharedText === 'string' ? raw.sharedText : undefined,
      };
      const key = text(hit.id) ?? `hit:${hits.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(hit);
    }
    const n = num(detail.hitCount) ?? num(detail.hits) ?? (Array.isArray(detail.hits) ? detail.hits.length : null);
    if (n !== null) counted = (counted ?? 0) + n;
  }
  hits.sort((a, b) => (num(b.score) ?? 0) - (num(a.score) ?? 0));
  const hitCount = hits.length > 0 ? hits.length : counted;
  const state = stepState('retrieve', scope, ctx, true);
  const latest = scope.latest;
  const panel = (card: StageCard): RecallPanel => ({ card, hits, hitCount });
  if (!state || !latest) return panel(notRun('retrieve', tool, later, input.question.origin === 'menu'));
  const base = baseCard('retrieve', tool, state, latest.id);
  const stopped = interrupted(state, 'Could not recall memory.');
  if (stopped) return panel({ ...base, ...stopped, passed: null });
  if (state.status === 'working') {
    return panel({ ...base, payload: 'Recalling memory and web results', note: true, payloadTitle: null, passed: null });
  }
  const top = hits[0];
  if (top) {
    const shown = hitDisplay(top);
    const payload = shown.isPrivate
      ? `Private memory, ${(shown.category ?? 'Memory').toLowerCase()}`
      : shown.origin === 'memory'
        ? quoted(shown.text)
        : shown.text;
    return panel({ ...base, payload, note: shown.isPrivate, payloadTitle: payload, passed: formatCount(hitCount ?? 0, 'hit') });
  }
  if (hitCount !== null && hitCount > 0) {
    return panel({ ...base, payload: `${formatCount(hitCount, 'hit')}. Not shared on this screen.`, note: true, payloadTitle: null, passed: formatCount(hitCount, 'hit') });
  }
  return panel({ ...base, payload: 'Nothing was recalled.', note: true, payloadTitle: null, passed: hitCount === 0 ? '0 hits' : null });
}

const KIND_COUNTS: ReadonlyArray<[OptionKind, string, string]> = [
  ['errand', 'errand', 'errands'],
  ['call', 'call', 'calls'],
  ['reply', 'reply', 'replies'],
  ['menu', 'menu item', 'menu items'],
];

/** "4 replies in 4 tones", or "3 follow-up options: 1 errand, 1 call, 1 reply". */
function draftSummary(options: readonly AnswerOption[], count: number, followUp: boolean): string {
  if (count === 0) return 'No options.';
  const lead = followUp ? 'follow-up ' : '';
  if (options.length === 0) return formatCount(count, `${lead}option`);
  const replies = options.filter((option) => option.kind === 'reply').length;
  if (replies === options.length) {
    const tones = new Set(options.map((option) => option.tone).filter((tone): tone is string => typeof tone === 'string' && tone !== '')).size;
    const body = formatCount(count, `${lead}reply`, `${lead}replies`);
    return tones > 1 ? `${body} in ${tones} tones` : body;
  }
  const parts = KIND_COUNTS.map(([kind, one, many]) => {
    const n = options.filter((option) => option.kind === kind).length;
    return n > 0 ? formatCount(n, one, many) : null;
  }).filter((part): part is string => part !== null);
  return `${formatCount(count, `${lead}option`)}: ${parts.join(', ')}`;
}

function draftCard(
  input: LiveInput,
  ctx: Context,
  scope: Scope,
  options: AnswerOption[],
  earlierRound: boolean,
  later: boolean,
): { card: StageCard; followUp: boolean } {
  // "Claude" only when a row says so: the real agent labels its plan step `claude` (agent/src/jobs.ts). A stand-in
  // agent (the smoke script labels its step `smoke options`) is not Claude.
  const tool = scope.events.some((event) => labelOf(event.detail)?.toLowerCase() === 'claude') ? 'Claude' : 'Agent';
  const state = stepState('plan', scope, ctx, false);
  const latest = scope.latest;
  const followUp = earlierRound || scope.events.some((event) => loose(event.detail).followUp === true);
  if (!state || !latest) return { card: notRun('plan', tool, later, input.question.origin === 'menu'), followUp };
  const base = baseCard('plan', tool, state, latest.id);
  const stopped = interrupted(state, 'Could not draft options. Ask again.');
  if (stopped) return { card: { ...base, ...stopped, passed: null }, followUp };
  if (state.status === 'working') {
    const payload = followUp ? 'Writing follow-up options' : 'Writing up to four options';
    return { card: { ...base, payload, note: true, payloadTitle: null, passed: null }, followUp };
  }
  const count = num(loose(latest.detail).optionCount) ?? options.length;
  return {
    card: { ...base, payload: draftSummary(options, count, followUp), note: count === 0, payloadTitle: null, passed: formatCount(count, 'option') },
    followUp,
  };
}

interface SpokenRef {
  rank: number | null;
  text: string | null;
  kind: OptionKind | null;
  tone: string | null;
}

/**
 * An option's rank, text, kind and tone from the row, filled in from the option row when missing. With the room's
 * sharing off the option row's text is the stand-in "Option N", which is no text: the rank already says it.
 */
function spokenRef(detail: unknown, byId: ReadonlyMap<string, AnswerOption>): SpokenRef {
  const fields = loose(detail);
  const option = byId.get(text(fields.optionId) ?? '');
  const kind = text(fields.kind) ?? option?.kind ?? null;
  const optionText = text(option?.text);
  return {
    rank: num(fields.rank) ?? option?.rank ?? null,
    text: text(fields.text) ?? (option && optionText !== `Option ${option.rank}` ? optionText : null),
    kind: kind === 'reply' || kind === 'errand' || kind === 'call' || kind === 'menu' ? kind : null,
    tone: text(fields.tone) ?? text(option?.tone) ?? null,
  };
}

function optionWords(ref: SpokenRef, pass: number | null): string {
  const name = ref.rank !== null ? `Option ${ref.rank}` : 'An option';
  const tone = ref.tone ? `, ${ref.tone} voice` : '';
  const again = pass !== null && pass > 1 ? `, pass ${pass}` : '';
  return ref.text ? `${name}${tone}${again}: ${quoted(ref.text)}` : `${name}${tone}${again}`;
}

/** A speak row for the reply said out loud for the room, not an option in the earpiece. */
function isAloud(event: PipelineEvent): boolean {
  return loose(event.detail).channel === 'aloud';
}

/**
 * A read of the yes or no prompt: the module's one speak step per read (docs/spacetime.md 14) for a question that is
 * answered YES or NO. It names no option. The scan's own start row carries the same label but no step.
 */
function isPromptRead(event: PipelineEvent): boolean {
  const fields = loose(event.detail);
  return labelOf(fields) === 'yes or no prompt' && num(fields.stepSeq) !== null;
}

/** A speak row that names what was read: an option (by id or rank), or the yes or no prompt. */
function namesRead(event: PipelineEvent): boolean {
  const fields = loose(event.detail);
  return text(fields.optionId) !== null || (num(fields.rank) ?? 0) > 0 || isPromptRead(event);
}

const VOICED_TOOL = 'Cartesia Sonic, into the earpiece';
const NO_CLIP_TOOL = 'No voice clip reported';

/**
 * No read in this round shows a voice clip: every option read was planned from an estimated length (`estimated`, set
 * by the module when the station had reported no clip for that option as the read began) and no read carries word
 * timings or a clip, which the station reports only for a clip that exists and plays (docs/station.md 2.9). A silent
 * test station looks like this, and so does one whose clips never came; either way the board has no sign of a voice,
 * so the card names none. Reads of the yes or no prompt are a stock phrase with no `estimated`, so a round of prompt
 * reads alone is not judged here.
 */
export function noClipReported(events: readonly PipelineEvent[]): boolean {
  let optionReads = 0;
  for (const event of events) {
    const fields = loose(event.detail);
    if ((Array.isArray(fields.words) && fields.words.length > 0) || safeClipUrl(fields.clipUrl) !== null) return false;
    if (event.status !== 'started' || isPromptRead(event) || num(fields.stepSeq) === null || !namesRead(event)) continue;
    if (fields.estimated !== true) return false;
    optionReads += 1;
  }
  return optionReads > 0;
}

/**
 * The earpiece only: what the person hears privately (docs/ui.md pattern 10 labels the two audio
 * channels apart). The reply said out loud comes after the pick, so it is its own line under the
 * steps; inside Speaking it would read right to left.
 *
 * Every read is its own speak row with the option's rank (since module v2 on live data, and in the
 * sample replay). The card names the newest read, so after the scan's "scan ended" row it still says
 * which option was read last, and counts the options played. When no voice clip was reported for the
 * round (`noClipReported`), it names no voice: the reads were scanned, not shown to be played.
 */
function speakCard(ctx: Context, scope: Scope, byId: ReadonlyMap<string, AnswerOption>, later: boolean): StageCard {
  const noClip = noClipReported(scope.events);
  const tool = noClip ? NO_CLIP_TOOL : VOICED_TOOL;
  const latest = scope.latest;
  const state = stepState('speak', scope, ctx, false);
  if (!state || !latest) return notRun('speak', tool, later, false);
  const shown = [...scope.events].reverse().find(namesRead) ?? latest;
  const detail = loose(shown.detail);
  const base = baseCard('speak', tool, state, latest.id);
  const played = new Set<string>();
  for (const event of scope.events) {
    const fields = loose(event.detail);
    const rank = num(fields.rank);
    const key = text(fields.optionId) ?? (rank !== null && rank > 0 ? `rank:${rank}` : isPromptRead(event) ? 'prompt' : null);
    if (key) played.add(key);
  }
  // A source that names no read (one row per scan) counts the scans it started.
  if (played.size === 0) for (const event of scope.events) if (event.status === 'started') played.add(event.id);
  const passed = played.size > 0 ? `${played.size} ${noClip ? 'scanned' : 'played'}` : null;
  const stopped = interrupted(state, 'Could not play the option.');
  if (stopped) return { ...base, ...stopped, passed };
  const ref = spokenRef(shown.detail, byId);
  let payload = isPromptRead(shown) ? 'The yes or no prompt' : optionWords(ref, num(detail.pass));
  const by = detail.stoppedBy;
  if (typeof by === 'string' && by in COMMAND_INFO) payload = `${payload} Cut short by ${commandWord(by as CommandName, ctx.input)}.`;
  const url = safeClipUrl(detail.clipUrl);
  const clip = url ? { url, label: ref.rank !== null ? `Play option ${ref.rank}` : 'Play the option' } : null;
  return { ...base, payload, note: false, payloadTitle: payload, passed, clip };
}

/** The tool behind a pick: the input the person used (a headset only in a headset session). */
const PICK_TOOLS: Readonly<Record<InputKind, string>> = {
  headset: 'Headset',
  keyboard: 'Keyboard',
  switch: 'USB switch',
  unknown: 'Input',
};

function selectCard(ctx: Context, scope: Scope, byId: ReadonlyMap<string, AnswerOption>, roundFrom: number): StageCard {
  const tool = PICK_TOOLS[ctx.input];
  const state = stepState('select', scope, ctx, false);
  const latest = scope.latest;
  if (!state || !latest) {
    const ended = ctx.ended;
    if (ended && ended.at >= roundFrom) {
      return {
        stage: 'select',
        name: NAMES.select,
        tool,
        status: 'stopped',
        word: ended.word,
        payload: ended.sentence,
        note: true,
        payloadTitle: null,
        time: null,
        passed: null,
        clip: null,
        eventId: null,
      };
    }
    return notRun('select', tool, false, false);
  }
  const base = baseCard('select', tool, state, latest.id);
  const stopped = interrupted(state, 'Could not record the pick.');
  if (stopped) return { ...base, ...stopped, passed: null };
  const ref = spokenRef(latest.detail, byId);
  const name = ref.rank !== null ? `option ${ref.rank}` : 'an option';
  if (state.status === 'working') {
    const payload = ref.kind === 'reply' || ref.kind === null ? `YES on ${name}. NO or STOP can still cancel it.` : `YES on ${name}.`;
    return { ...base, payload, note: false, payloadTitle: null, passed: null };
  }
  const kindWords = ref.kind === 'errand' ? ', an errand' : ref.kind === 'call' ? ', a call' : ref.kind === 'menu' ? ', from the menu' : '';
  const lead = ref.rank !== null ? `Option ${ref.rank}` : 'An option';
  const payload = ref.text ? `${lead}${kindWords}: ${quoted(ref.text)}` : `${lead}${kindWords}`;
  return { ...base, payload, note: false, payloadTitle: payload, passed: null };
}

// ---------------------------------------------------------------------------------------------
// Errand and call lines

const ERRAND_DONE = new Set<Errand['status']>(['sent', 'stopped', 'refused', 'failed', 'unknown_outcome']);
const CALL_DONE = new Set<CallRequest['status']>(['ended', 'failed', 'stopped', 'refused']);

function span(from: number | null, to: number | null): number | null {
  return from !== null && to !== null ? Math.max(0, to - from) : null;
}

function errandSentence(errand: Errand, input: InputKind): string {
  const reason = text(errand.reason);
  switch (errand.status) {
    case 'preparing':
      return 'Filling in the form. Nothing is sent yet.';
    case 'previewed':
      return 'The form is filled. Nothing is sent yet.';
    case 'reading_back':
      return 'Reading the values back in the earpiece.';
    case 'awaiting_confirm':
      return `Waiting for ${withSignal('CONFIRM', input)}.`;
    case 'confirmed':
      return 'CONFIRM matched the read-back. Sending.';
    case 'submitting':
      return 'Sending.';
    case 'sent':
      return 'Sent.';
    case 'unknown_outcome':
      return 'It may or may not have gone through. Nothing was sent again.';
    case 'stopped':
      return reason ? `Not sent: ${sentence(reason)}` : 'Stopped. Nothing was sent.';
    case 'refused':
      return reason ? `Refused: ${sentence(reason)} Nothing was sent.` : 'Refused by a safety rule. Nothing was sent.';
    case 'failed':
      return reason ? `${sentence(reason)} Nothing was sent.` : 'Failed. Nothing was sent.';
    default:
      return 'Working.';
  }
}

function callSentence(call: CallRequest, input: InputKind): string {
  const reason = text(call.reason);
  const ended = text(call.endReason);
  switch (call.status) {
    case 'prepared':
      return 'Reading the call script back in the earpiece.';
    case 'awaiting_confirm':
      return `Waiting for ${withSignal('CONFIRM', input)}.`;
    case 'confirmed':
      return 'CONFIRM matched the script. Dialing next.';
    case 'dialing':
      return 'Dialing.';
    case 'ringing':
      return 'Ringing.';
    case 'connected':
      return 'Connected.';
    case 'ended':
      return ended ? sentence(ended) : call.result === 'no_answer' ? 'No answer.' : 'The call ended.';
    case 'failed':
      return ended || reason ? `The call ended: ${sentence(ended ?? reason ?? '')}` : 'The call failed.';
    case 'stopped':
      return reason ? `Not called: ${sentence(reason)}` : 'Stopped before dialing. No call was made.';
    case 'refused':
      return reason ? `Refused: ${sentence(reason)} No call was made.` : 'Refused by a safety rule. No call was made.';
    default:
      return 'Working.';
  }
}

function newestFor<T extends { questionId: string | null }>(rows: readonly T[], questionId: string): T | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row && row.questionId === questionId) return row;
  }
  return null;
}

/** A line from the stage rows alone, when the errand or call row is not on this screen. */
function lineFromEvents(stage: 'errand' | 'call', title: string, scope: Scope, ctx: Context): ActionLine | null {
  const latest = scope.latest;
  if (!latest) return null;
  const finished = latest.status !== 'started';
  const status: RunStatus = latest.status === 'error' ? 'failed' : finished ? 'done' : 'working';
  const from = scope.openFrom ?? latest.at;
  return {
    key: `${stage}:${latest.id}`,
    kind: stage,
    title,
    status,
    word: STATUS_WORDS[status],
    sentence: status === 'failed' ? (errorOf(latest.detail).sentence ?? 'Failed. Nothing was sent.') : STATUS_WORDS[status],
    time: finished ? { kind: 'final', ms: finishedMs(scope, false) } : { kind: 'running', from, until: ctx.freezeAt },
  };
}

/** "Said out loud": the reply the room hears after YES picks it (docs/ui.md pattern 10). */
function replyLine(input: LiveInput, ctx: Context): ActionLine | null {
  const { question } = input;
  const scope = scopeOf(input.events, 'speak', Number.NEGATIVE_INFINITY, isAloud);
  const latest = scope.latest;
  const replyText = text(question.replyText);
  const words = (latest ? text(loose(latest.detail).text) : null) ?? replyText;
  const said = words ? quoted(words) : 'The reply.';
  const state = latest ? stepState('speak', scope, ctx, false) : null;
  if (latest && state) {
    let sentenceText = said;
    if (state.cut) sentenceText = state.cut.sentence;
    else if (state.status === 'failed') sentenceText = state.error?.sentence ?? 'Could not say the reply out loud.';
    return { key: `reply:${latest.id}`, kind: 'reply', title: 'Said out loud', status: state.status, word: state.word, sentence: sentenceText, time: state.time };
  }
  if (!replyText) return null;
  // No speak row, but the question carries the released reply.
  const spoken = question.spokenAt !== null;
  return {
    key: `reply:${question.id}`,
    kind: 'reply',
    title: 'Said out loud',
    status: spoken ? 'done' : 'working',
    word: spoken ? STATUS_WORDS.done : STATUS_WORDS.working,
    sentence: said,
    time: null,
  };
}

function actionLines(input: LiveInput, ctx: Context): ActionLine[] {
  const lines: ActionLine[] = [];
  const questionId = input.question.id;

  const reply = replyLine(input, ctx);
  if (reply) lines.push(reply);

  const errandScope = scopeOf(input.events, 'errand', Number.NEGATIVE_INFINITY);
  const errandId = errandScope.latest ? text(loose(errandScope.latest.detail).errandId) : null;
  const errand = (errandId ? input.errands.find((row) => row.id === errandId) : undefined) ?? newestFor(input.errands, questionId);
  if (errand) {
    const status = statusFromErrand(errand.status) ?? 'working';
    const done = ERRAND_DONE.has(errand.status);
    const finishedAt = errand.sentAt ?? errand.endedAt;
    lines.push({
      key: `errand:${errand.id}`,
      kind: 'errand',
      title: `Errand: ${text(errand.form) ?? 'a form'}`,
      status,
      word: errand.status === 'stopped' ? 'Not sent' : STATUS_WORDS[status],
      sentence: errandSentence(errand, ctx.input),
      time: done
        ? { kind: 'final', ms: (errandScope.latest?.status !== 'started' ? finishedMs(errandScope, false) : null) ?? span(errand.createdAt, finishedAt) }
        : { kind: 'running', from: errand.createdAt, until: ctx.freezeAt },
    });
  } else {
    const line = lineFromEvents('errand', 'Errand', errandScope, ctx);
    if (line) lines.push(line);
  }

  const callScope = scopeOf(input.events, 'call', Number.NEGATIVE_INFINITY);
  const callId = callScope.latest ? text(loose(callScope.latest.detail).callId) : null;
  const call = (callId ? input.calls.find((row) => row.id === callId) : undefined) ?? newestFor(input.calls, questionId);
  if (call) {
    const status = statusFromCall(call.status) ?? 'working';
    const done = CALL_DONE.has(call.status);
    const from = call.startedAt ?? call.createdAt;
    lines.push({
      key: `call:${call.id}`,
      kind: 'call',
      title: `Call: ${maskPhoneNumbers(text(call.contactName) ?? 'a contact')}`,
      status,
      word: callStatusWord(call),
      sentence: maskPhoneNumbers(callSentence(call, ctx.input)),
      time: done ? { kind: 'final', ms: span(from, call.endedAt) } : { kind: 'running', from, until: ctx.freezeAt },
    });
  } else {
    const line = lineFromEvents('call', 'Call', callScope, ctx);
    if (line) lines.push(line);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// The whole view

function firstOptionOf(input: LiveInput, ctx: Context, cards: readonly StageCard[]): FirstOption | null {
  const { question, events } = input;
  let heardAt: number | null = null;
  let anyListen = false;
  for (const event of events) {
    if (event.stage !== 'listen') continue;
    anyListen = true;
    if (event.status === 'ok') heardAt = event.at;
  }
  // The person's menu has no Listen step: time it from the moment the turn began.
  if (heardAt === null && !anyListen && question.origin === 'menu') heardAt = question.askedAt;
  let final = timeToFirstOption(events);
  if (final === null && heardAt !== null && !anyListen) {
    const start = heardAt;
    const first = events.find((event) => event.stage === 'speak' && event.status === 'started' && loose(event.detail).channel !== 'aloud' && event.at >= start);
    if (first) final = first.at - start;
  }
  if (final !== null) return { kind: 'final', ms: Math.max(0, final) };
  if (heardAt === null) return null;
  const failed = cards.some((card) => card.status === 'failed' && card.stage !== 'speak' && card.stage !== 'select');
  if (failed || ctx.ended || ctx.nextQuestion) return { kind: 'none', sentence: 'No option was read' };
  const until = ctx.freezeAt ?? (ctx.paused && ctx.paused.at >= heardAt ? ctx.paused.at : null);
  return { kind: 'running', from: heardAt, until };
}

/** Everything the Live data screen shows for one question. */
export function buildLiveView(input: LiveInput): LiveView {
  const ctx = contextFor(input);
  const { events, question } = input;
  const questionOptions = input.options.filter((option) => option.questionId === question.id);
  const byId = new Map(questionOptions.map((option) => [option.id, option] as const));
  const newestOptions = latestOptions(questionOptions, question.id);

  const roundStart = roundStartOf(events);
  const all = Number.NEGATIVE_INFINITY;
  const listen = scopeOf(events, 'listen', all);
  const search = scopeOf(events, 'search', all);
  const retrieve = scopeOf(events, 'retrieve', all);
  const plan = scopeOf(events, 'plan', roundStart);
  const speak = scopeOf(events, 'speak', roundStart, (event) => !isAloud(event));
  const select = scopeOf(events, 'select', roundStart);
  const earlierRound = events.some((event) => event.stage === 'plan' && event.at < roundStart);
  const has = [listen, search, retrieve, plan, speak, select].map((scope) => scope.latest !== null);
  const laterHas = (index: number) => has.slice(index + 1).some(Boolean);

  const heard = listenCard(input, ctx, listen, laterHas(0));
  const searchPanel = searchCard(input, ctx, search, laterHas(1));
  const recallPanel = recallCard(input, ctx, retrieve, laterHas(2));
  const draft = draftCard(input, ctx, plan, newestOptions, earlierRound, laterHas(3));
  const speaking = speakCard(ctx, speak, byId, laterHas(4));
  const roundFrom = Number.isFinite(roundStart) ? Math.max(roundStart, question.askedAt) : question.askedAt;
  const picked = selectCard(ctx, select, byId, roundFrom);
  const cards = [heard.card, searchPanel.card, recallPanel.card, draft.card, speaking, picked];

  // The pick in this round, for the "Picked" mark in the options list. Only a released pick counts:
  // during the veto NO or STOP can still cancel it.
  let pickedId: string | null = null;
  for (const event of select.events) {
    const id = text(loose(event.detail).optionId);
    if (event.status === 'ok' && id) pickedId = id;
  }
  const scan = input.scan;
  if (pickedId === null && scan && scan.questionId === question.id && scan.outcome === 'picked' && scan.pickedOptionId) {
    pickedId = scan.pickedOptionId;
  }
  if (pickedId !== null && !newestOptions.some((option) => option.id === pickedId)) pickedId = null;

  const failedCard = [...cards].reverse().find((card) => card.status === 'failed');
  const alert = ctx.nextQuestion === null && failedCard ? `${failedCard.name}: ${failedCard.payload}` : null;

  return {
    cards,
    firstOption: firstOptionOf(input, ctx, cards),
    heardWords: heard.words,
    search: searchPanel,
    recall: recallPanel,
    draft: { card: draft.card, options: newestOptions, followUp: draft.followUp, pickedId },
    actions: actionLines(input, ctx),
    alert,
  };
}

// ---------------------------------------------------------------------------------------------
// The raw event feed

export interface FeedItem {
  key: string;
  at: number;
  /** The stage name, or the command word ("YES", "Headset off"). */
  name: string;
  /** started, ok, error, accepted or ignored. */
  status: string;
  tone: 'ok' | 'error' | 'muted' | 'plain';
  /** The step's time, such as "81 ms". */
  value: string;
  detail: string;
}

function eventSummary(event: PipelineEvent, errands: readonly Errand[], calls: readonly CallRequest[], input: InputKind): string | null {
  const detail = loose(event.detail);
  if (event.status === 'error') return errorOf(event.detail).sentence;
  switch (event.stage) {
    case 'listen': {
      if (event.status !== 'ok') return null;
      const words = text(detail.words);
      const n = num(detail.wordCount) ?? num(detail.words) ?? (words ? countWords(words) : null);
      return n === null ? null : formatCount(n, 'word');
    }
    case 'search': {
      if (event.status !== 'ok') {
        const searches = num(detail.searches);
        return searches === null ? null : formatCount(searches, 'search', 'searches');
      }
      if (detail.needsWeb === false) return 'no web search';
      const n = num(detail.rowCount) ?? num(detail.rows) ?? (Array.isArray(detail.rows) ? detail.rows.length : null);
      return n === null ? null : formatCount(n, 'row');
    }
    case 'retrieve': {
      if (event.status !== 'ok') return null;
      const n = num(detail.hitCount) ?? num(detail.hits) ?? (Array.isArray(detail.hits) ? detail.hits.length : null);
      return n === null ? null : formatCount(n, 'hit');
    }
    case 'plan': {
      if (event.status !== 'ok') return null;
      const n = num(detail.optionCount);
      const version = num(detail.version);
      return [n === null ? null : formatCount(n, 'option'), detail.followUp === true ? 'follow-up' : null, version === null ? null : `version ${version}`]
        .filter(Boolean)
        .join(', ');
    }
    case 'speak': {
      const rank = num(detail.rank);
      const pass = num(detail.pass);
      const timed = Array.isArray(detail.words) ? detail.words.length : 0;
      const by = detail.stoppedBy;
      return [
        rank === null ? null : `option ${rank}`,
        pass === null ? null : `pass ${pass}`,
        detail.channel === 'aloud' ? 'out loud' : detail.channel === 'earpiece' ? 'earpiece' : null,
        timed > 0 ? formatCount(timed, 'word timing') : null,
        typeof by === 'string' && by in COMMAND_INFO ? `cut short by ${commandWord(by as CommandName, input)}` : null,
      ]
        .filter(Boolean)
        .join(', ');
    }
    case 'select': {
      const rank = num(detail.rank);
      return rank === null ? null : `option ${rank}`;
    }
    case 'errand': {
      const id = text(detail.errandId);
      const errand = id ? errands.find((row) => row.id === id) : undefined;
      return errand ? text(errand.form) : null;
    }
    case 'call': {
      const id = text(detail.callId);
      const call = id ? calls.find((row) => row.id === id) : undefined;
      return call ? maskPhoneNumbers(call.contactName) : null;
    }
    default:
      return null;
  }
}

function eventItem(event: PipelineEvent, errands: readonly Errand[], calls: readonly CallRequest[], input: InputKind): FeedItem {
  const ms = num(event.ms);
  const parts = [labelOf(event.detail), eventSummary(event, errands, calls, input)].filter((part): part is string => !!part);
  return {
    key: `event:${event.id}`,
    at: event.at,
    name: event.stage,
    status: event.status,
    tone: event.status === 'ok' ? 'ok' : event.status === 'error' ? 'error' : 'plain',
    value: ms !== null && event.status !== 'started' ? formatMs(ms) : '',
    detail: maskPhoneNumbers(parts.join(', ')),
  };
}

/**
 * What an accepted command was, in the session's input: "imagined right fist" for the headset, "key Y" for a keyboard
 * test, "short switch press" for a switch, nothing when the input is unknown. HEADSET_OFF in a keyboard test is the H
 * test key (docs/station.md 2.5); elsewhere it is a system event.
 */
function commandWhat(command: CommandEvent, input: InputKind): string | null {
  if (command.command === 'HEADSET_OFF') return input === 'keyboard' ? 'key H, a test' : 'system event, not a command';
  return commandSignal(command.command, input);
}

function commandItem(command: CommandEvent, input: InputKind): FeedItem {
  const confidence = num(command.confidence);
  const what = commandWhat(command, input);
  const parts = [command.accepted ? what : (text(command.ignoredReason) ?? 'ignored'), confidence === null ? null : `confidence ${confidence.toFixed(2)}`];
  return {
    key: `command:${command.id}`,
    at: command.at,
    name: commandWord(command.command, input),
    status: command.accepted ? 'accepted' : 'ignored',
    tone: command.accepted ? 'ok' : 'muted',
    value: '',
    detail: parts.filter((part): part is string => !!part).join(', '),
  };
}

/** Pipeline events and command events together, newest first, at most `limit` of them. `input` names each command's true signal. */
export function feedItems(
  events: readonly PipelineEvent[],
  commands: readonly CommandEvent[],
  errands: readonly Errand[],
  calls: readonly CallRequest[],
  limit: number,
  input: InputKind,
): FeedItem[] {
  // Both lists are oldest first, so the newest `limit` of the two together are in their tails.
  const items = [
    ...commands.slice(-limit).map((command) => commandItem(command, input)),
    ...events.slice(-limit).map((event) => eventItem(event, errands, calls, input)),
  ];
  // Rows written in the same millisecond keep their written order, newest first: a scan's first read comes after its
  // "scan started" row, and a step a command caused comes after the command.
  const order = new Map(items.map((item, index) => [item, index] as const));
  items.sort((a, b) => b.at - a.at || (order.get(b) ?? 0) - (order.get(a) ?? 0));
  return items.slice(0, limit);
}

/** How many pipeline and command events arrived after `since`. */
export function countNewer(events: readonly PipelineEvent[], commands: readonly CommandEvent[], since: number): number {
  let count = 0;
  for (let i = events.length - 1; i >= 0 && (events[i]?.at ?? since) > since; i--) count += 1;
  for (let i = commands.length - 1; i >= 0 && (commands[i]?.at ?? since) > since; i--) count += 1;
  return count;
}
