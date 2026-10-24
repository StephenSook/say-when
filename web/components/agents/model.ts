/**
 * Pure rules for Screen 2, Agents at work (docs/ui.md "Screen 2: Agents at work"): which agent gets
 * the big card, how far each agent got, the sentence on top and the state label at the top right.
 * No React here, so every rule sits in one place.
 *
 * Errands and calls are options (PLAN D11). YES picks one, the read-back plays in the earpiece, and
 * only a fresh CONFIRM (a double jaw clench) matched to the read-back digest sends it. Silence, NO,
 * STOP, the headset coming off and the idle auto-pause all mean nothing is sent
 * (docs/spacetime.md 4.2 to 4.4).
 *
 * Every piece of row text passes through maskPhoneNumbers before it reaches a screen.
 */
import type {
  AnswerOption,
  CallRequest,
  CallResult,
  CallStatus,
  CommandEvent,
  CommandName,
  Errand,
  ErrandStatus,
  SafetyState,
} from '@/lib/data/types';
import { maskPhoneNumbers } from '@/lib/format';
import { callStatusWord, statusFromCall, statusFromErrand, STATUS_WORDS, type RunStatus } from '@/lib/status';

export type AgentKind = 'errand' | 'call';

/** One agent's newest row. */
export type AgentRef = { kind: 'errand'; row: Errand } | { kind: 'call'; row: CallRequest };

export type SafetyWord = SafetyState['state'];

export const AGENT_NAMES: Readonly<Record<AgentKind, string>> = {
  errand: 'Form errand',
  call: 'Phone call',
};

/* ------------------------------------------------------------------------------------------------
 * Small text helpers
 * ---------------------------------------------------------------------------------------------- */

/** Ends a phrase with a period unless it already ends with one, or with ! or ?. */
export function asSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return trimmed;
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Row text made safe for the screen: trimmed, phone numbers hidden. null when empty. */
export function screenText(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  return trimmed ? maskPhoneNumbers(trimmed) : null;
}

/** Row text as a full sentence for the screen. null when empty. */
function screenSentence(text: string | null | undefined): string | null {
  const safe = screenText(text);
  return safe ? asSentence(safe) : null;
}

/** "Form errand: Care team request", or just "Phone call" when the row has no name. */
export function agentTitle(kind: AgentKind, name: string | null | undefined): string {
  const safe = screenText(name);
  return safe ? `${AGENT_NAMES[kind]}: ${safe}` : AGENT_NAMES[kind];
}

/** Digests show their first 8 characters; the full value goes in a tooltip (docs/ui.md). */
export function shortDigest(digest: string | null | undefined): string | null {
  const trimmed = digest?.trim();
  return trimmed ? trimmed.slice(0, 8) : null;
}

/** The newest row of a list that is sorted oldest first. */
export function newest<T>(rows: readonly T[]): T | null {
  return rows.length === 0 ? null : (rows[rows.length - 1] ?? null);
}

/** The option YES picked, looked up by id. */
export function findOption(options: readonly AnswerOption[], optionId: string | null): AnswerOption | null {
  if (optionId === null) return null;
  return options.find((option) => option.id === optionId) ?? null;
}

/* ------------------------------------------------------------------------------------------------
 * Which agent is at work
 * ---------------------------------------------------------------------------------------------- */

/** Statuses where the errand is still moving. A moving agent always holds the big card. */
const errandMoving: ReadonlySet<ErrandStatus> = new Set<ErrandStatus>([
  'preparing',
  'previewed',
  'reading_back',
  'awaiting_confirm',
  'confirmed',
  'submitting',
]);

const callMoving: ReadonlySet<CallStatus> = new Set<CallStatus>([
  'prepared',
  'awaiting_confirm',
  'confirmed',
  'dialing',
  'ringing',
  'connected',
]);

/** A pause or the headset coming off stops these, so nothing is sent (docs/spacetime.md 4.2). */
const errandStoppedByPause: ReadonlySet<ErrandStatus> = new Set<ErrandStatus>([
  'preparing',
  'previewed',
  'reading_back',
  'awaiting_confirm',
  'confirmed',
]);

const callStoppedByPause: ReadonlySet<CallStatus> = new Set<CallStatus>(['prepared', 'awaiting_confirm']);

/** A pause or the headset coming off asks the call agent to hang these up (docs/spacetime.md 4.4). */
const callCancelledByPause: ReadonlySet<CallStatus> = new Set<CallStatus>(['confirmed', 'dialing', 'ringing', 'connected']);

export function errandIsMoving(errand: Errand): boolean {
  return errandMoving.has(errand.status);
}

export function callIsMoving(call: CallRequest): boolean {
  return callMoving.has(call.status);
}

/** The row says a hang-up was asked for and the line has not dropped yet (`cancel_requested`). */
export function callHangingUp(call: CallRequest): boolean {
  return call.cancelRequested === true && callCancelledByPause.has(call.status);
}

export function isPaused(safety: SafetyWord): boolean {
  return safety === 'paused' || safety === 'headset_off';
}

/** The first words of the shell banner: "Paused." or "Headset off." null when not paused. */
export function pauseWords(safety: SafetyWord): string | null {
  if (safety === 'paused') return 'Paused.';
  if (safety === 'headset_off') return 'Headset off.';
  return null;
}

/** The newest moment on an errand row. */
export function errandLastAt(errand: Errand): number {
  return Math.max(
    errand.createdAt,
    errand.previewedAt ?? 0,
    errand.readAloudAt ?? 0,
    errand.confirmedAt ?? 0,
    errand.sentAt ?? 0,
    errand.endedAt ?? 0,
  );
}

/** The newest moment on a call row, its transcript included. */
export function callLastAt(call: CallRequest): number {
  return Math.max(
    call.createdAt,
    call.readAloudAt ?? 0,
    call.confirmedAt ?? 0,
    call.dialedAt ?? 0,
    call.ringingAt ?? 0,
    call.startedAt ?? 0,
    call.endedAt ?? 0,
    newest(call.transcript)?.at ?? 0,
  );
}

export function agentLastAt(agent: AgentRef): number {
  return agent.kind === 'errand' ? errandLastAt(agent.row) : callLastAt(agent.row);
}

/**
 * Which agent gets the big card (docs/ui.md: "the agent that is working gets the big card").
 * 1. An agent that is moving. If both are, the one waiting for the person's CONFIRM, else the newer one.
 * 2. Nothing moving: the one the viewer chose with "Show" (`pinned`), else the one that changed last.
 */
export function chooseFocus(errand: Errand | null, call: CallRequest | null, pinned: AgentKind | null): AgentRef | null {
  if (errand === null && call === null) return null;
  if (errand === null) return call === null ? null : { kind: 'call', row: call };
  if (call === null) return { kind: 'errand', row: errand };
  const errandBusy = errandIsMoving(errand);
  const callBusy = callIsMoving(call);
  if (errandBusy && callBusy) {
    const errandWaits = errand.status === 'awaiting_confirm';
    const callWaits = call.status === 'awaiting_confirm';
    if (errandWaits !== callWaits) return errandWaits ? { kind: 'errand', row: errand } : { kind: 'call', row: call };
    return call.createdAt >= errand.createdAt ? { kind: 'call', row: call } : { kind: 'errand', row: errand };
  }
  if (errandBusy) return { kind: 'errand', row: errand };
  if (callBusy) return { kind: 'call', row: call };
  if (pinned === 'errand') return { kind: 'errand', row: errand };
  if (pinned === 'call') return { kind: 'call', row: call };
  return callLastAt(call) >= errandLastAt(errand) ? { kind: 'call', row: call } : { kind: 'errand', row: errand };
}

/* ------------------------------------------------------------------------------------------------
 * How far each agent got
 * ---------------------------------------------------------------------------------------------- */

/**
 * The form errand's six steps (docs/mockups/agents.html):
 * 1 picked with YES, 2 form filled in a browser, 3 values read back off the page,
 * 4 read back in the earpiece, 5 CONFIRM, a double jaw clench, 6 sent with the form's confirmation.
 */
export interface ErrandPlan {
  picked: RunStatus;
  filled: RunStatus;
  values: RunStatus;
  readBack: RunStatus;
  confirm: RunStatus;
  send: RunStatus;
}

type ErrandStepNumber = 2 | 4 | 5 | 6;

/** The step a status is on. Steps 1 and 3 finish together with the step before them. */
const errandStepOfStatus: Readonly<Record<ErrandStatus, ErrandStepNumber>> = {
  preparing: 2,
  previewed: 4,
  reading_back: 4,
  awaiting_confirm: 5,
  confirmed: 6,
  submitting: 6,
  sent: 6,
  unknown_outcome: 6,
  stopped: 2,
  refused: 2,
  failed: 2,
};

/** How far a finished errand got, read from its times, so a stop lands on the step it stopped. */
function errandStepFromTimes(errand: Errand): ErrandStepNumber {
  if (errand.sentAt !== null || errand.confirmedAt !== null) return 6;
  if (errand.readAloudAt !== null) return 5;
  if (errand.previewedAt !== null) return 4;
  return 2;
}

/** The step the errand is on now, or ended on. */
export function errandStep(errand: Errand): ErrandStepNumber {
  const byStatus = errandStepOfStatus[errand.status];
  if (errandIsMoving(errand)) return byStatus;
  const byTimes = errandStepFromTimes(errand);
  return byTimes > byStatus ? byTimes : byStatus;
}

export function errandPlan(errand: Errand): ErrandPlan {
  const reached = errandStep(errand);
  const current = statusFromErrand(errand.status);
  const at = (step: number): RunStatus => (step < reached ? 'done' : step === reached ? current : 'not_started');
  return { picked: 'done', filled: at(2), values: at(3), readBack: at(4), confirm: at(5), send: at(6) };
}

/**
 * true when the send was tried and its result is not known: the form may have gone through.
 * The form-errand Actor reports "I pressed send but did not see a confirmation" as `failed`
 * (apify/form-errand/README.md), so a failure on the send step is never "nothing was sent".
 */
export function errandMaybeSent(errand: Errand): boolean {
  if (errand.status === 'unknown_outcome') return true;
  return errand.status === 'failed' && errandStep(errand) === 6;
}

/** The phone call's five steps: script read back, CONFIRM, ringing, connected, ended. */
export interface CallPlan {
  script: RunStatus;
  confirm: RunStatus;
  ring: RunStatus;
  talk: RunStatus;
  end: RunStatus;
}

/** true once the call agent dialed. */
export function callWasDialed(call: CallRequest): boolean {
  return call.dialedAt !== null || call.ringingAt !== null || call.startedAt !== null;
}

/** How a finished call reads: calm for no answer or a STOP, red only when something broke. */
export function callOutcome(call: CallRequest): RunStatus {
  if (call.status === 'failed') return 'failed';
  if (call.status === 'stopped') return 'stopped';
  if (call.status === 'refused') return 'refused';
  if (call.status !== 'ended') return statusFromCall(call.status);
  switch (call.result) {
    case 'failed':
    case 'unknown':
      return 'failed';
    case 'refused':
      return 'refused';
    case 'no_answer':
    case 'busy':
    case 'voicemail':
      return 'stopped';
    case 'cancelled':
      return call.startedAt !== null ? 'done' : 'stopped';
    case 'answered':
    case null:
      return 'done';
  }
}

export function callPlan(call: CallRequest): CallPlan {
  const no: RunStatus = 'not_started';
  switch (call.status) {
    case 'prepared':
      return { script: 'working', confirm: no, ring: no, talk: no, end: no };
    case 'awaiting_confirm':
      return { script: 'done', confirm: 'waiting', ring: no, talk: no, end: no };
    case 'confirmed':
    case 'dialing':
    case 'ringing':
      return { script: 'done', confirm: 'done', ring: 'working', talk: no, end: no };
    case 'connected':
      return { script: 'done', confirm: 'done', ring: 'done', talk: 'working', end: no };
    case 'ended':
    case 'failed':
      return {
        script: 'done',
        confirm: 'done',
        ring: callWasDialed(call) ? 'done' : no,
        talk: call.startedAt !== null ? 'done' : no,
        end: callOutcome(call),
      };
    case 'stopped':
    case 'refused': {
      // Never dialed: the step where it stopped gets the mark (a STOP during a live call ends it instead).
      const outcome: RunStatus = call.status;
      const step = call.confirmedAt !== null || callWasDialed(call) ? 3 : call.readAloudAt !== null ? 2 : 1;
      const at = (n: number): RunStatus => (n < step ? 'done' : n === step ? outcome : no);
      return { script: at(1), confirm: at(2), ring: at(3), talk: no, end: no };
    }
  }
}

/* ------------------------------------------------------------------------------------------------
 * Reasons in plain words
 * ---------------------------------------------------------------------------------------------- */

const commandStopSentences: Readonly<Partial<Record<CommandName, string>>> = {
  NO: 'The person answered NO.',
  STOP: 'The person used STOP, a long jaw clench.',
  HEADSET_OFF: 'The headset lost contact.',
};

const reasonCodeSentences: ReadonlyMap<string, string> = new Map([
  ['window_closed', 'The confirm window closed without a double jaw clench.'],
  ['readback_not_finished', 'The read-back did not finish.'],
  ['no_consent', 'There is no consent on file.'],
]);

const NO_REASON = 'No reason was recorded.';

export interface ReasonFields {
  reason: string | null;
  stopCommandId: string | null;
  reasonCode?: string | null;
}

function reasonFromCode(code: string | null | undefined): string | null {
  const trimmed = code?.trim();
  return trimmed ? (reasonCodeSentences.get(trimmed) ?? null) : null;
}

/** Why an errand or call was stopped: the row's sentence, else the command that stopped it, else its code. */
export function stopReason(row: ReasonFields, commands: readonly CommandEvent[]): string {
  const own = screenSentence(row.reason);
  if (own) return own;
  if (row.stopCommandId !== null) {
    const command = commands.find((event) => event.id === row.stopCommandId);
    const sentence = command ? commandStopSentences[command.command] : undefined;
    if (sentence) return sentence;
  }
  return reasonFromCode(row.reasonCode) ?? NO_REASON;
}

/** Why it was refused or failed, as one sentence. */
export function rowReason(row: { reason: string | null; reasonCode?: string | null }): string {
  return screenSentence(row.reason) ?? reasonFromCode(row.reasonCode) ?? NO_REASON;
}

/** The row's own end reason, for example "The person hung up with STOP." null when it has none. */
export function callOwnReason(call: CallRequest): string | null {
  return screenSentence(call.endReason) ?? screenSentence(call.reason);
}

const callResultSentences: Readonly<Partial<Record<CallResult, string>>> = {
  no_answer: 'No answer.',
  busy: 'The line was busy.',
  voicemail: 'It went to voicemail.',
  cancelled: 'The call was hung up.',
  failed: 'The call failed.',
  refused: 'A safety rule stopped the call.',
  unknown: 'The call did not report how it ended.',
};

/** How the call ended, in plain words: its own reason, else its result. null for a plain answered call. */
export function callEndReason(call: CallRequest): string | null {
  return callOwnReason(call) ?? (call.result ? (callResultSentences[call.result] ?? null) : null);
}

/** docs/ui.md "Error": "The call ended: <reason>." */
export function callFailedSentence(call: CallRequest): string {
  const own = callOwnReason(call);
  return own ? `The call ended: ${own}` : 'The call failed.';
}

/* ------------------------------------------------------------------------------------------------
 * The sentence on top (docs/ui.md pattern 8)
 * ---------------------------------------------------------------------------------------------- */

export interface Headline {
  status: RunStatus;
  text: string;
}

/** No time or count in here: the sentence is a live region, so it must not change every second. */
export function errandHeadline(errand: Errand, safety: SafetyWord): Headline {
  const paused = pauseWords(safety);
  if (paused && errandStoppedByPause.has(errand.status)) return { status: 'stopped', text: `${paused} Nothing will be sent.` };
  switch (errand.status) {
    case 'preparing':
      return { status: 'working', text: 'Filling in the form in a browser. Nothing has been sent.' };
    case 'previewed':
    case 'reading_back':
      return { status: 'working', text: 'Reading the form back to the person. Nothing has been sent.' };
    case 'awaiting_confirm':
      return { status: 'waiting', text: 'Waiting for the person to confirm. Nothing has been sent.' };
    case 'confirmed':
    case 'submitting':
      // A pause does not stop a send that already started (docs/spacetime.md 4.2).
      return paused
        ? { status: 'working', text: `${paused} The confirmed form is still being sent.` }
        : { status: 'working', text: 'Confirmed with a double jaw clench. Sending the form.' };
    case 'sent':
      return { status: 'done', text: 'Sent after the person confirmed with a double jaw clench.' };
    case 'unknown_outcome':
      return { status: 'failed', text: 'The form may or may not have gone through. It was not sent again.' };
    case 'stopped':
      return { status: 'stopped', text: 'Stopped. Nothing was sent.' };
    case 'refused':
      return { status: 'refused', text: 'Refused by a safety rule. Nothing was sent.' };
    case 'failed':
      return errandMaybeSent(errand)
        ? { status: 'failed', text: 'Sending did not finish. The form may or may not have gone through.' }
        : { status: 'failed', text: 'The form errand failed. Nothing was sent.' };
  }
}

export function callHeadline(call: CallRequest, safety: SafetyWord): Headline {
  const paused = pauseWords(safety);
  const name = screenText(call.contactName) ?? 'the contact';
  if (paused && callStoppedByPause.has(call.status)) return { status: 'stopped', text: `${paused} Nobody will be called.` };
  if (paused && callCancelledByPause.has(call.status)) return { status: 'stopped', text: `${paused} Cancelling the call.` };
  // Not paused, so the hang-up came from STOP during the call (docs/spacetime.md 4.2).
  if (callHangingUp(call)) return { status: 'stopped', text: `Hanging up on ${name}. The person used STOP.` };
  switch (call.status) {
    case 'prepared':
      return { status: 'working', text: 'Reading the call script to the person. Nobody has been called.' };
    case 'awaiting_confirm':
      return { status: 'waiting', text: 'Waiting for the person to confirm the call. Nobody has been called.' };
    case 'confirmed':
    case 'dialing':
      return { status: 'working', text: `Confirmed with a double jaw clench. Calling ${name}.` };
    case 'ringing':
      return { status: 'working', text: `Ringing ${name}.` };
    case 'connected':
      return { status: 'working', text: `On the phone with ${name}. STOP, a long jaw clench, hangs up.` };
    case 'ended': {
      const outcome = callOutcome(call);
      if (outcome === 'failed') return { status: 'failed', text: callFailedSentence(call) };
      const reason = callEndReason(call);
      return { status: outcome, text: reason ? `The call ended. ${reason}` : 'The call ended.' };
    }
    case 'failed':
      return { status: 'failed', text: callFailedSentence(call) };
    case 'stopped':
      return { status: 'stopped', text: 'Stopped. Nobody was called.' };
    case 'refused':
      return { status: 'refused', text: 'Refused by a safety rule. Nobody was called.' };
  }
}

/* ------------------------------------------------------------------------------------------------
 * The state label at the top right of a card, and on the dimmed line
 * ---------------------------------------------------------------------------------------------- */

export interface Badge {
  status: RunStatus;
  /** The state in words: the docs/ui.md vocabulary, plus the call words (Dialing, Ringing, Connected, Ended, No answer). */
  word: string;
  /** Adds ", 6 s left" while the confirm window is open. */
  countdownTo?: number;
  /** Adds a live clock face from this moment: "Connected 0:42". */
  clockSince?: number;
}

export function errandBadge(errand: Errand, safety: SafetyWord): Badge {
  if (isPaused(safety) && errandStoppedByPause.has(errand.status)) return { status: 'stopped', word: 'Paused' };
  switch (errand.status) {
    case 'awaiting_confirm':
      return errand.confirmClosesAt !== null
        ? { status: 'waiting', word: STATUS_WORDS.waiting, countdownTo: errand.confirmClosesAt }
        : { status: 'waiting', word: STATUS_WORDS.waiting };
    case 'sent':
      return { status: 'done', word: 'Sent' };
    case 'unknown_outcome':
      return { status: 'failed', word: 'Outcome unknown' };
    default: {
      const status = statusFromErrand(errand.status);
      return { status, word: STATUS_WORDS[status] };
    }
  }
}

export function callBadge(call: CallRequest, safety: SafetyWord): Badge {
  if (isPaused(safety) && callStoppedByPause.has(call.status)) return { status: 'stopped', word: 'Paused' };
  if (isPaused(safety) && callCancelledByPause.has(call.status)) return { status: 'stopped', word: 'Cancelling' };
  if (callHangingUp(call)) return { status: 'stopped', word: 'Hanging up' };
  const word = callStatusWord(call);
  switch (call.status) {
    case 'awaiting_confirm':
      return call.confirmClosesAt !== null
        ? { status: 'waiting', word, countdownTo: call.confirmClosesAt }
        : { status: 'waiting', word };
    case 'ringing':
      return call.ringingAt !== null ? { status: 'working', word, clockSince: call.ringingAt } : { status: 'working', word };
    case 'connected':
      return call.startedAt !== null ? { status: 'working', word, clockSince: call.startedAt } : { status: 'working', word };
    case 'ended':
    case 'failed':
    case 'stopped':
    case 'refused':
      return { status: callOutcome(call), word };
    default:
      return { status: statusFromCall(call.status), word };
  }
}
