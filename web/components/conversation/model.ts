/**
 * The Live conversation screen's model (docs/ui.md "Screen 3: Live conversation"). Pure: no React
 * and no clock. The parts that tick (the word in the earpiece, the time left on an option, the
 * command echo) read their own clock, so every rule here can be checked against the sample replay.
 *
 * How one turn is read:
 * - The screen follows the turn the scan clock is on while a scan runs, since that is what the
 *   person hears. Otherwise it follows the newest question.
 * - While a scan runs it shows the option version being read. A newer version waits for the end of
 *   the pass (docs/spacetime.md `pending_version`), so it is not shown early. Otherwise the newest.
 * - Direct select (D18): the options are read once, numbered, then the list waits for a pick. The
 *   cursor is on an option only while it is read; during the wait it sits on the whole list (no
 *   option id), with the time left to pick. It stops, with no clock, while paused or the headset is off.
 * - A pick of a reply is said out loud at once. A pick of an errand or a call starts its read-back,
 *   then "Clench your jaw to send it." (D29). One line under the picked option says where that
 *   errand or call is; the Agents screen shows every step.
 * - Free text (the question, the options) goes through maskPhoneNumbers: a projected screen never
 *   shows a phone number.
 */
import { CONFIRM_SHORT, offWord } from '../../lib/commands';
import { latestOfStage, latestQuestion, optionUnderCursor, pickedOption, wordIndexAt } from '../../lib/data/derive';
import {
  GESTURE_PICKS,
  type AnswerOption,
  type CallRequest,
  type Errand,
  type InputKind,
  type OptionKind,
  type PipelineEvent,
  type Question,
  type SafetyState,
  type ScanOutcome,
  type ScanPhase,
  type ScanState,
  type StageError,
  type WordTiming,
} from '../../lib/data/types';
import { maskPhoneNumbers } from '../../lib/format';
import { callStatusWord, statusFromCall, statusFromErrand, type RunStatus } from '../../lib/status';

/** The line under the list while options are read (docs/ui.md "Screen 3"). */
export const PICK_LEGEND = 'Pick any number, any time. STOP means none of these. Silence picks nothing.';
/** The same line for the person's own menu. */
export const MENU_LEGEND = 'Pick any number. STOP closes the menu. Silence picks nothing.';
/** The same line for a yes or no question: one prompt, and 1 or 2 answers it. */
export const YES_NO_LEGEND = '1 answers yes. 2 answers no. STOP means neither. Silence picks nothing.';
/** The stock prompt the earpiece plays for a yes or no question (docs/spacetime.md 4.1). */
export const YES_NO_PROMPT = 'Yes or no?';

/**
 * The kind tag on an option. docs/ui.md: a chip says "Errand" or "Call" when the kind is not a reply,
 * so the options that would act stand out and a plain reply carries no tag. Menu items need none: the
 * header already says it is the menu.
 */
export const KIND_WORDS: Readonly<Record<OptionKind, string | null>> = {
  reply: null,
  errand: 'Errand',
  call: 'Call',
  search: 'Web search',
  category: 'Category',
  menu: null,
};

/** "Warm tone" for the Cartesia tone an option is read in (PLAN D10). null when it has none. */
export function toneWord(tone: string | null): string | null {
  const clean = tone?.trim().toLowerCase();
  if (!clean) return null;
  return `${clean.charAt(0).toUpperCase()}${clean.slice(1)} tone`;
}

/** Free text as it may appear on a projected screen: trimmed, phone numbers hidden. null when empty. */
export function screenText(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  return trimmed ? maskPhoneNumbers(trimmed) : null;
}

/** The question this screen follows: the turn the scan is on while it runs, else the newest question. */
export function focusQuestion(questions: readonly Question[], scan: ScanState | null): Question | null {
  const newest = latestQuestion(questions);
  if (scan === null || scan.outcome !== null || scan.phase === 'idle') return newest;
  return questions.find((question) => question.id === scan.questionId) ?? newest;
}

export interface Header {
  /** The small line on top: "The partner asked". */
  eyebrow: string;
  /** The question in the partner's words, or a stand-in such as "Question 7". */
  lead: string;
  /** true when `lead` is the partner's own words, shown in quotes. */
  quoted: boolean;
}

export function headerFor(question: Question, menu: boolean, listening: boolean): Header {
  const text = screenText(question.text);
  if (question.origin === 'menu') {
    if (menu || question.number === 0) return { eyebrow: 'Opened by the person', lead: "The person's menu", quoted: false };
    if (text !== null) return { eyebrow: "From the person's menu", lead: text, quoted: true };
    return { eyebrow: "From the person's menu", lead: `Question ${question.number}`, quoted: false };
  }
  const eyebrow = listening ? 'The partner is asking' : question.via === 'typed' ? 'The partner typed' : 'The partner asked';
  if (text !== null) return { eyebrow, lead: text, quoted: true };
  return { eyebrow, lead: question.number > 0 ? `Question ${question.number}` : 'A new question', quoted: false };
}

/** Where the option under the cursor is: its audio plays, its window is open, or the cursor stopped. */
export type CursorPhase = 'reading' | 'window' | 'stopped';

export interface CursorView {
  /** The option under the cursor, or null for the yes or no prompt and for the wait for a pick after the list. */
  optionId: string | null;
  /** Direct select: the list was read and waits for a pick, "1 to 3". null otherwise. */
  waitingFor?: string | null;
  phase: CursorPhase;
  /** When the current scan phase started and when it is planned to end, for the word mark and the time left. */
  startedAt: number;
  endsAt: number;
  /** Cartesia word timings for this option's clip, when a speak event carried them. */
  words: readonly WordTiming[] | null;
}

/** A one-line wait or error under the question or the list. */
export type TurnNote =
  | { kind: 'listening' }
  | { kind: 'drafting' }
  | { kind: 'drafting-more' }
  | { kind: 'preparing' }
  | { kind: 'no-options' }
  | { kind: 'error'; sentence: string; raw: string | null };

/** How a turn ended when nothing was picked. */
export interface Ending {
  outcome: Exclude<ScanOutcome, 'picked'>;
  sentence: string;
}

/** Where a picked errand or call is, in one sentence that starts with its state. */
export interface AgentStatus {
  kind: 'errand' | 'call';
  status: RunStatus;
  sentence: string;
}

export interface ConversationView {
  question: Question;
  header: Header;
  /** The options on screen, in reading order. Empty while the first options are drafted. */
  options: readonly AnswerOption[];
  /** Changes when a new version replaces the list, which fades the new list in. */
  listKey: string;
  /** These options were offered after a pick: an errand, a call, or nothing else. */
  followUp: boolean;
  /** The list is the person's own menu, opened with YES while idle. */
  menu: boolean;
  /** A yes or no question: one prompt; YES picks rank 1, NO picks rank 2. */
  yesNo: boolean;
  cursor: CursorView | null;
  /** The option YES picked: during the veto, and after the pick. */
  picked: AnswerOption | null;
  /** YES picked a reply, and NO or STOP can still cancel it before it is said out loud. */
  vetoing: boolean;
  agent: AgentStatus | null;
  note: TurnNote | null;
  ending: Ending | null;
  pass: { pass: number; max: number } | null;
  /** The way out of the list, kept on screen while it is read. */
  legend: string | null;
  /** The shell banner's state. The list drops to 40% and the cursor stops. */
  paused: 'paused' | 'headset_off' | null;
  /** That state in words for the stopped cursor: "Paused", "Headset off", or "Input off" for keys or a switch. */
  pausedWord: string | null;
  /** For a polite live region: the pick, or how the turn ended. Never the list itself. */
  announcement: string;
}

export interface ViewInput {
  question: Question;
  scan: ScanState | null;
  /** Every option row. */
  options: readonly AnswerOption[];
  /** This question's pipeline events, oldest first. */
  events: readonly PipelineEvent[];
  errands: readonly Errand[];
  calls: readonly CallRequest[];
  safety: SafetyState;
  /** The session's input, so a key press never reads as a jaw clench. */
  input: InputKind;
  /** A reply was already said out loud for this question, so a later "nothing" means nothing more. */
  hasReply: boolean;
}

const READING_VERSION_PHASES: readonly ScanPhase[] = ['reading', 'window', 'veto', 'paused'];

function newestVersion(options: readonly AnswerOption[], questionId: string): number | null {
  let version: number | null = null;
  for (const option of options) {
    if (option.questionId === questionId && (version === null || option.version > version)) version = option.version;
  }
  return version;
}

function optionsOf(options: readonly AnswerOption[], questionId: string, version: number): AnswerOption[] {
  return options
    .filter((option) => option.questionId === questionId && option.version === version)
    .sort((a, b) => a.rank - b.rank);
}

/** The newest word timings for one option's earpiece clip. The same clip plays on every pass. */
export function wordsFor(events: readonly PipelineEvent[], optionId: string): readonly WordTiming[] | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (
      event &&
      event.stage === 'speak' &&
      event.detail.channel !== 'aloud' &&
      event.detail.optionId === optionId &&
      Array.isArray(event.detail.words) &&
      event.detail.words.length > 0
    ) {
      return event.detail.words;
    }
  }
  return null;
}

function errorText(error: StageError | undefined): string | null {
  if (!error) return null;
  return error.raw ?? error.sentence ?? null;
}

function isRunning(event: PipelineEvent | null): boolean {
  return event !== null && event.status === 'started';
}

/** A reason as one sentence with a period, or an empty string. */
function asSentence(text: string | null | undefined): string {
  const trimmed = text?.trim();
  if (!trimmed) return '';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function joinSentences(...parts: string[]): string {
  return parts.filter((part) => part !== '').join(' ');
}

/** The newest errand or call row for a picked option. Rows without an option id fall back to the question. */
function rowFor<T extends { optionId: string | null; questionId: string | null }>(
  rows: readonly T[],
  optionId: string,
  questionId: string,
): T | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row && row.optionId === optionId) return row;
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row && row.optionId === null && row.questionId === questionId) return row;
  }
  return null;
}

/** One line for a picked errand option. Nothing leaves without CONFIRM, so the line says so until it is sent. */
export function errandStatus(errand: Errand | null, input: InputKind): AgentStatus {
  if (errand === null) return { kind: 'errand', status: 'working', sentence: 'Starting the errand. Nothing is sent yet.' };
  const status = statusFromErrand(errand.status);
  const reason = asSentence(screenText(errand.reason));
  let sentence: string;
  switch (errand.status) {
    case 'preparing':
      sentence = 'Filling in the form. Nothing is sent yet.';
      break;
    case 'previewed':
    case 'reading_back':
      sentence = 'Reading it back to the person. Nothing is sent yet.';
      break;
    case 'awaiting_confirm':
      sentence = `Waiting for ${CONFIRM_SHORT}. Nothing is sent yet.`;
      break;
    case 'confirmed':
    case 'submitting':
      sentence = 'Confirmed. Sending the form.';
      break;
    case 'sent':
      sentence = `Sent: ${screenText(errand.form) ?? 'the form'}.`;
      break;
    case 'unknown_outcome':
      sentence = 'It may or may not have gone through. Nothing was sent again.';
      break;
    case 'stopped':
      sentence = joinSentences('Not sent.', reason);
      break;
    case 'refused':
      sentence = joinSentences('Refused.', reason, 'Nothing was sent.');
      break;
    case 'failed':
    default:
      sentence = joinSentences('Failed.', reason, 'Nothing was sent.');
      break;
  }
  return { kind: 'errand', status, sentence };
}

/** One line for a picked call option. Names only, never a number. */
export function callStatus(call: CallRequest | null, input: InputKind): AgentStatus {
  if (call === null) return { kind: 'call', status: 'working', sentence: 'Preparing the call. No call yet.' };
  const status = statusFromCall(call.status);
  const name = screenText(call.contactName) ?? 'the contact';
  const reason = asSentence(screenText(call.reason));
  // A hang-up was asked for (STOP, headset off or a pause) and the line has not dropped yet.
  const live = call.status === 'confirmed' || call.status === 'dialing' || call.status === 'ringing' || call.status === 'connected';
  if (call.cancelRequested === true && live) return { kind: 'call', status: 'stopped', sentence: `Hanging up on ${name}.` };
  let sentence: string;
  switch (call.status) {
    case 'prepared':
      sentence = 'Reading the call back to the person. No call yet.';
      break;
    case 'awaiting_confirm':
      sentence = `Waiting for ${CONFIRM_SHORT}. No call yet.`;
      break;
    case 'confirmed':
      sentence = 'Confirmed. Starting the call.';
      break;
    case 'dialing':
      sentence = `Dialing ${name}.`;
      break;
    case 'ringing':
      sentence = `Ringing ${name}.`;
      break;
    case 'connected':
      sentence = `Connected to ${name}. STOP hangs up.`;
      break;
    case 'ended': {
      const why = screenText(call.endReason);
      sentence = why !== null ? `Call ended. ${asSentence(why)}` : `${callStatusWord(call)}.`;
      break;
    }
    case 'stopped':
      sentence = joinSentences('No call was made.', reason);
      break;
    case 'refused':
      sentence = joinSentences('Refused.', reason, 'No call was made.');
      break;
    case 'failed':
    default:
      sentence = joinSentences('The call failed.', reason || asSentence(screenText(call.endReason)));
      break;
  }
  return { kind: 'call', status, sentence };
}

function endingFor(outcome: Exclude<ScanOutcome, 'picked'>, menu: boolean, more: boolean): Ending {
  const nothing = more ? 'Nothing more was said or sent.' : 'Nothing was said or sent.';
  switch (outcome) {
    case 'none':
      return { outcome, sentence: menu ? `Menu closed with STOP. ${nothing}` : `None of these. ${nothing}` };
    case 'no_pick':
      return { outcome, sentence: `No pick. ${nothing}` };
    case 'stopped':
      return { outcome, sentence: `Stopped. ${nothing}` };
    case 'cancelled':
    default:
      return { outcome, sentence: `The partner cancelled the question. ${nothing}` };
  }
}

function cursorFor(
  run: ScanState | null,
  shown: readonly AnswerOption[],
  version: number | null,
  yesNo: boolean,
  paused: boolean,
  events: readonly PipelineEvent[],
): CursorView | null {
  if (run === null || shown.length === 0 || run.version !== version) return null;
  const live = run.phase === 'reading' || run.phase === 'window';
  if (!live && run.phase !== 'paused') return null;
  const phase: CursorPhase = live && !paused ? (run.phase === 'reading' ? 'reading' : 'window') : 'stopped';
  const timing = { startedAt: run.stepStartedAt, endsAt: run.stepEndsAt };
  if (yesNo) return { optionId: null, phase, words: null, ...timing };
  // Direct select (D18): after the list is read, the wait is for any of its numbers, not for one option.
  if (run.phase === 'window') return { optionId: null, phase, words: null, waitingFor: pickRangeWords(shown.length), ...timing };
  const option = live ? optionUnderCursor(run, shown) : (shown.find((o) => o.rank === run.cursor) ?? null);
  if (option === null) return null;
  return { optionId: option.id, phase, words: wordsFor(events, option.id), ...timing };
}

/** "1 to 3", "1 or 2", "1": the numbers a gesture picks in a list of this many options (no gesture gives 4). */
export function pickRangeWords(count: number): string {
  if (count <= 1) return '1';
  if (count === 2) return '1 or 2';
  return `1 to ${Math.min(GESTURE_PICKS, count)}`;
}

/** Everything the screen draws for one question. */
export function buildConversationView({ question, scan, options, events, errands, calls, safety, input, hasReply }: ViewInput): ConversationView {
  const here = scan !== null && scan.questionId === question.id ? scan : null;
  /** The scan on this turn, while it still runs. */
  const run = here !== null && here.outcome === null ? here : null;
  const outcome = here?.outcome ?? null;

  const newest = newestVersion(options, question.id);
  const readingVersion =
    run !== null &&
    run.version > 0 &&
    READING_VERSION_PHASES.includes(run.phase) &&
    options.some((option) => option.questionId === question.id && option.version === run.version)
      ? run.version
      : null;
  const version = readingVersion ?? newest;
  const shown = version === null ? [] : optionsOf(options, question.id, version);

  const menu =
    shown.length > 0 && ((here !== null && here.mode === 'menu' && here.version === version) || shown.every((option) => option.kind === 'menu'));
  const yesNo = shown.length > 0 && here !== null && here.answerMode === 'yes_no' && here.version === version;

  const followUp =
    version !== null &&
    events.some((event) => event.stage === 'plan' && event.status === 'ok' && event.detail.followUp === true && event.detail.version === version);

  const paused: ConversationView['paused'] =
    safety.state === 'paused' || safety.state === 'headset_off' ? safety.state : scan?.phase === 'paused' ? 'paused' : null;

  const listen = latestOfStage(events, 'listen');
  const search = latestOfStage(events, 'search');
  const retrieve = latestOfStage(events, 'retrieve');
  const plan = latestOfStage(events, 'plan');
  const listening = shown.length === 0 && listen?.status === 'started';

  const cursor = cursorFor(run, shown, version, yesNo, paused !== null, events);
  const vetoing = run !== null && run.phase === 'veto';
  const picked = vetoing || outcome === 'picked' ? pickedOption(here, shown) : null;

  let agent: AgentStatus | null = null;
  if (picked !== null && !vetoing) {
    if (picked.kind === 'errand') agent = errandStatus(rowFor(errands, picked.id, question.id), input);
    if (picked.kind === 'call') agent = callStatus(rowFor(calls, picked.id, question.id), input);
  }

  const ending = outcome !== null && outcome !== 'picked' ? endingFor(outcome, menu, hasReply || followUp) : null;

  let note: TurnNote | null = null;
  if (plan?.status === 'error') {
    note = { kind: 'error', sentence: 'Could not draft options. Ask again.', raw: errorText(plan.detail.error) };
  } else if (shown.length === 0 && listen?.status === 'error') {
    note = { kind: 'error', sentence: 'Could not hear the question. Ask again.', raw: errorText(listen.detail.error) };
  } else if (listening) {
    note = { kind: 'listening' };
  } else if (shown.length === 0) {
    if (outcome === null) {
      const drafting =
        run?.phase === 'preparing' ||
        isRunning(search) ||
        isRunning(retrieve) ||
        isRunning(plan) ||
        (scan === null && listen?.status === 'ok');
      note = drafting ? { kind: 'drafting' } : { kind: 'no-options' };
    }
  } else if (isRunning(plan)) {
    note = { kind: 'drafting-more' };
  } else if (run !== null && run.phase === 'preparing') {
    note = { kind: 'preparing' };
  }

  const pass =
    run !== null && run.version === version && shown.length > 0 && (cursor !== null || vetoing) && run.maxPasses > 0
      ? { pass: Math.max(1, run.pass), max: run.maxPasses }
      : null;

  const legend = shown.length > 0 && outcome === null ? (yesNo ? YES_NO_LEGEND : menu ? MENU_LEGEND : PICK_LEGEND) : null;

  const pickedText = picked ? screenText(picked.text) : null;
  const announcement = pickedText ? `Picked: ${pickedText}` : (ending?.sentence ?? '');

  return {
    question,
    header: headerFor(question, menu, listening),
    options: shown,
    listKey: `${question.id}:${version ?? 'none'}`,
    followUp,
    menu,
    yesNo,
    cursor,
    picked,
    vetoing,
    agent,
    note,
    ending,
    pass,
    legend,
    paused,
    pausedWord: paused === 'headset_off' ? offWord(input) : paused === 'paused' ? 'Paused' : null,
    announcement,
  };
}

/** The option text split into words and the spaces between them, so one word can be marked. */
export interface TextPart {
  text: string;
  /** The word's index among the words, or null for the space between words. */
  word: number | null;
}

export function splitWords(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let index = 0;
  for (const piece of text.split(/(\s+)/)) {
    if (piece === '') continue;
    if (/^\s+$/.test(piece)) parts.push({ text: piece, word: null });
    else parts.push({ text: piece, word: index++ });
  }
  return parts;
}

export interface WordMark {
  /** The word being read, or -1 for none. */
  index: number;
  /** true when no word timings arrived and the position is spread across the clip by word length. */
  estimated: boolean;
}

/**
 * Which word of the option is in the earpiece at `now`. It uses Cartesia's word timings when a
 * speak event carried them. Without them it estimates: the reading phase lasts as long as the clip,
 * so the words are spread across it by length. The mark says when it is an estimate.
 */
export function wordBeingRead(
  words: readonly string[],
  timings: readonly WordTiming[] | null,
  startedAt: number,
  endsAt: number,
  now: number,
): WordMark {
  if (words.length === 0) return { index: -1, estimated: false };
  const elapsed = Math.max(0, now - startedAt);
  if (timings !== null && timings.length > 0) {
    const at = wordIndexAt(timings, elapsed);
    if (at < 0) return { index: -1, estimated: false };
    // Cartesia may split words differently from the text on screen; keep the same place in the line.
    const index = timings.length === words.length ? at : Math.min(words.length - 1, Math.floor((at * words.length) / timings.length));
    return { index, estimated: false };
  }
  const span = endsAt - startedAt;
  if (span <= 0) return { index: -1, estimated: true };
  const weights = words.map((word) => word.length + 2);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const target = (Math.min(elapsed, span) / span) * total;
  let reached = 0;
  for (let i = 0; i < weights.length; i++) {
    reached += weights[i] ?? 0;
    if (target < reached) return { index: i, estimated: true };
  }
  return { index: words.length - 1, estimated: true };
}

/** Time left in a response window at `now`, kept inside the window. null when the window has no length. */
export function windowLeft(startedAt: number, endsAt: number, now: number): { leftMs: number; spanMs: number } | null {
  const spanMs = endsAt - startedAt;
  if (!Number.isFinite(spanMs) || spanMs <= 0) return null;
  return { leftMs: Math.min(spanMs, Math.max(0, endsAt - now)), spanMs };
}

/** "2.1 s left": tenths, because a response window is only 3 to 4 seconds long. */
export function formatSecondsLeft(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s left`;
}
