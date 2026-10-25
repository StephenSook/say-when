/**
 * What the partner phone shows, worked out from the rows (docs/ui.md "Screen 4: Partner phone view").
 * Pure: no React and no clock, so every state can be checked in a test.
 *
 * Privacy (docs/spacetime.md `partner_view`): the phone never shows the words of the options. It shows
 * how far along the question is, which option number is in the earpiece, and the reply once it is
 * released. Errands and calls appear only as what is happening ("Waiting for them to confirm."), never
 * as their contents.
 *
 * The status sentence, newest first:
 * 1. Paused or the input off: "Paused. Please wait." or "Headset off. Please wait." ("Input off" for keys or a switch)
 * 2. An option in the earpiece: "They are choosing, option 2 of 4."
 * 3. YES on a reply, inside the short veto: "They picked an answer."
 * 4. The newest pick and the errand or call it started: "They answered.", "Waiting for them to confirm."
 * 5. The scan ended with no pick: "They chose none of these.", "No pick. Nothing was said or sent."
 * 6. A step that failed and nothing moved past: "Could not draft options. Ask again."
 * 7. Before the options are read: "Listening.", "Looking it up.", "Getting options ready."
 */
import type { Step } from '@/components/ui/StepList';
import { commandSignal, offWord, signalPhrase } from '@/lib/commands';
import { spokenReply, type SpokenReply } from '@/lib/data/derive';
import type {
  AnswerOption,
  CallRequest,
  Errand,
  InputKind,
  OptionKind,
  PipelineEvent,
  PipelineEventOf,
  Question,
  SafetyState,
  ScanState,
  Stage,
  StageError,
} from '@/lib/data/types';
import { formatClock, maskPhoneNumbers } from '@/lib/format';

/** How the status sentence looks. Every tone other than 'plain' also gets an icon, so color is never alone. */
export type StatusTone = 'plain' | 'done' | 'waiting' | 'stopped' | 'paused' | 'failed';

export type StatusIcon = 'none' | 'check' | 'hourglass' | 'pause' | 'cross' | 'no_entry';

export interface PartnerStatus {
  /** Changes only when the state changes in a way worth saying aloud, not on every option. */
  key: string;
  text: string;
  tone: StatusTone;
  icon: StatusIcon;
  /** What a screen reader hears when `key` changes. */
  announce: string;
  /** The raw error, for a tooltip. */
  title: string | null;
}

export interface PartnerAsked {
  text: string;
  /** false for "Question 7", when the question's words are not shared. */
  quoted: boolean;
}

export interface PartnerAnswer {
  text: string;
  /** true: the reply the person picked, in their words. false: a placeholder or a short note. */
  isReply: boolean;
  /** For a reply: 'saying' until it has been said out loud, then 'said' with the clock time. */
  spoken: { state: 'saying' } | { state: 'said'; at: string } | null;
}

export interface PartnerView {
  status: PartnerStatus;
  /** The muted line under the status sentence, such as "Please wait. They are listening to the options." */
  hint: string | null;
  /** "You asked" with the question. null before the words are known, and for a turn from the person's own menu. */
  asked: PartnerAsked | null;
  /** Heard you, Looked it up, Reading options, Answer. Empty before the first question. */
  steps: Step[];
  /** "Their answer". null before the first question. */
  answer: PartnerAnswer | null;
}

export interface PartnerInput {
  /** The newest question. */
  question: Question | null;
  /** That question's pipeline events, oldest first. */
  events: readonly PipelineEvent[];
  /** Every option row, all versions. */
  options: readonly AnswerOption[];
  errands: readonly Errand[];
  calls: readonly CallRequest[];
  scan: ScanState | null;
  safety: SafetyState;
  /** The session's input: only a headset session names the jaw clench or says "Headset off". */
  input: InputKind;
  /** true once the phone can send a typed question, so the empty state can say "or type it here". */
  canType: boolean;
}

export const PARTNER_TEXT = {
  empty: 'Ask a question out loud.',
  emptyCanType: 'Ask a question out loud, or type it here.',
  paused: 'Paused. Please wait.',
  headsetOff: 'Headset off. Please wait.',
  inputOff: 'Input off. Please wait.',
  nothingWillBeSent: 'Nothing will be sent.',
  listening: 'Listening.',
  lookingUp: 'Looking it up.',
  drafting: 'Getting options ready.',
  pleaseWait: 'Please wait.',
  listeningToOptions: 'Please wait. They are listening to the options.',
  hearingAgain: 'Please wait. They are hearing the options again.',
  picked: 'They picked an answer.',
  answered: 'They answered.',
  waitingForPick: 'Shows here once they pick.',
  noAnswer: 'No answer this time.',
} as const;

/** A pick lands a moment before the errand or call row it starts; allow for clocks that differ a little. */
const ACTION_SLACK_MS = 2_000;

type Hold = 'paused' | 'headset_off';

type Ev<S extends Stage> = PipelineEventOf<S>;

interface Pick {
  at: number;
  optionId: string | null;
  kind: OptionKind;
}

interface Facts {
  question: Question;
  options: readonly AnswerOption[];
  errands: readonly Errand[];
  calls: readonly CallRequest[];
  /** The scan clock, only while it is on this question. */
  scan: ScanState | null;
  newest: PipelineEvent | null;
  listen: Ev<'listen'> | null;
  search: Ev<'search'> | null;
  retrieve: Ev<'retrieve'> | null;
  plan: Ev<'plan'> | null;
  /** The newest option read into the earpiece (never the reply said out loud). */
  speak: Ev<'speak'> | null;
  firstSpeak: Ev<'speak'> | null;
  lastSelect: Ev<'select'> | null;
  firstPick: Pick | null;
  lastPick: Pick | null;
  /** The options being read are follow-ups after a pick (an errand, a call, "Nothing else"; PLAN D11). */
  followUp: boolean;
  reply: SpokenReply | null;
  input: InputKind;
}

interface Sentence {
  status: PartnerStatus;
  hint: string | null;
}

export function buildPartnerView(input: PartnerInput): PartnerView {
  const hold = holdFor(input.safety, input.scan);
  const question = input.question;
  if (!question) {
    const status = hold ? holdStatus(hold, 'none', input.input) : makeStatus('empty', input.canType ? PARTNER_TEXT.emptyCanType : PARTNER_TEXT.empty, 'plain', 'none', '');
    return { status, hint: hold ? PARTNER_TEXT.nothingWillBeSent : null, asked: null, steps: [], answer: null };
  }
  const facts = readFacts(input, question);
  const sentence = hold ? { status: holdStatus(hold, question.id, input.input), hint: PARTNER_TEXT.nothingWillBeSent } : sentenceFor(facts);
  return {
    status: sentence.status,
    hint: sentence.hint,
    asked: askedFor(facts),
    steps: stepsFor(facts, hold),
    answer: answerFor(facts),
  };
}

// Reading the rows

function readFacts(input: PartnerInput, question: Question): Facts {
  const events = input.events;
  const scan = input.scan && input.scan.questionId === question.id ? input.scan : null;
  const earpiece = (event: Ev<'speak'>) => event.detail.channel !== 'aloud';
  const ok = (event: Ev<'select'>) => event.status === 'ok';

  const plan = newestOf(events, 'plan');
  const firstSelectOk = oldestOf(events, 'select', ok);
  const lastSelectOk = newestOf(events, 'select', ok);
  const scanPick = pickFromScan(scan, input.options);
  const firstPick = firstSelectOk ? pickFromSelect(firstSelectOk, input.options) : scanPick;
  const selectPick = lastSelectOk ? pickFromSelect(lastSelectOk, input.options) : null;
  const lastPick = newerPick(selectPick, scanPick);
  const reply = spokenReply(question);
  // Options read after a released reply, or drafted after a pick, are follow-ups.
  const followUp = reply !== null || (firstPick !== null && plan !== null && (plan.at >= firstPick.at || plan.detail.followUp === true));

  return {
    question,
    options: input.options,
    errands: input.errands,
    calls: input.calls,
    scan,
    newest: events.length > 0 ? (events[events.length - 1] ?? null) : null,
    listen: newestOf(events, 'listen'),
    search: newestOf(events, 'search'),
    retrieve: newestOf(events, 'retrieve'),
    plan,
    speak: newestOf(events, 'speak', earpiece),
    firstSpeak: oldestOf(events, 'speak', earpiece),
    lastSelect: newestOf(events, 'select'),
    firstPick,
    lastPick,
    followUp,
    reply,
    input: input.input,
  };
}

function newestOf<S extends Stage>(events: readonly PipelineEvent[], stage: S, keep?: (event: Ev<S>) => boolean): Ev<S> | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event && event.stage === stage && (!keep || keep(event as Ev<S>))) return event as Ev<S>;
  }
  return null;
}

function oldestOf<S extends Stage>(events: readonly PipelineEvent[], stage: S, keep?: (event: Ev<S>) => boolean): Ev<S> | null {
  for (const event of events) {
    if (event.stage === stage && (!keep || keep(event as Ev<S>))) return event as Ev<S>;
  }
  return null;
}

function findNewest<T>(rows: readonly T[], keep: (row: T) => boolean): T | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row !== undefined && keep(row)) return row;
  }
  return null;
}

function pickFromSelect(event: Ev<'select'>, options: readonly AnswerOption[]): Pick {
  const optionId = event.detail.optionId ?? null;
  const option = optionId === null ? undefined : options.find((o) => o.id === optionId);
  return { at: event.at, optionId, kind: event.detail.kind ?? option?.kind ?? 'reply' };
}

function pickFromScan(scan: ScanState | null, options: readonly AnswerOption[]): Pick | null {
  if (!scan || scan.outcome !== 'picked' || scan.pickedOptionId === null) return null;
  const optionId = scan.pickedOptionId;
  const option = options.find((o) => o.id === optionId);
  return { at: scan.stepStartedAt, optionId, kind: option?.kind ?? 'reply' };
}

function newerPick(a: Pick | null, b: Pick | null): Pick | null {
  if (!a) return b;
  if (!b) return a;
  return b.at > a.at ? b : a;
}

function holdFor(safety: SafetyState, scan: ScanState | null): Hold | null {
  if (safety.state === 'headset_off') return 'headset_off';
  if (safety.state === 'paused' || scan?.phase === 'paused') return 'paused';
  return null;
}

function isReading(scan: ScanState | null): boolean {
  return scan !== null && scan.outcome === null && (scan.phase === 'reading' || scan.phase === 'window');
}

function countOptions(options: readonly AnswerOption[], questionId: string, version: number): number {
  let count = 0;
  for (const option of options) {
    if (option.questionId === questionId && option.version === version) count++;
  }
  return count;
}

function errandFor(pick: Pick, f: Facts): Errand | null {
  if (pick.optionId !== null) {
    const byOption = findNewest(f.errands, (e) => e.optionId === pick.optionId);
    if (byOption) return byOption;
  }
  if (pick.kind !== 'errand') return null;
  return findNewest(f.errands, (e) => e.questionId === f.question.id && e.createdAt >= pick.at - ACTION_SLACK_MS);
}

function callFor(pick: Pick, f: Facts): CallRequest | null {
  if (pick.optionId !== null) {
    const byOption = findNewest(f.calls, (c) => c.optionId === pick.optionId);
    if (byOption) return byOption;
  }
  if (pick.kind !== 'call') return null;
  return findNewest(f.calls, (c) => c.questionId === f.question.id && c.createdAt >= pick.at - ACTION_SLACK_MS);
}

/** One plain sentence from a row, with any phone number hidden. null when empty. */
function plain(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  return trimmed ? maskPhoneNumbers(trimmed) : null;
}

function errorTitle(error: StageError | undefined): string | null {
  return error?.raw ?? error?.sentence ?? null;
}

// The status sentence

function makeStatus(
  key: string,
  text: string,
  tone: StatusTone = 'plain',
  icon: StatusIcon = 'none',
  announce: string = text,
  title: string | null = null,
): PartnerStatus {
  return { key, text, tone, icon, announce, title };
}

function holdStatus(hold: Hold, questionId: string, input: InputKind): PartnerStatus {
  return hold === 'headset_off'
    ? makeStatus(`${questionId}:headset-off`, input === 'headset' ? PARTNER_TEXT.headsetOff : PARTNER_TEXT.inputOff, 'paused', 'cross')
    : makeStatus(`${questionId}:paused`, PARTNER_TEXT.paused, 'paused', 'pause');
}

function failed(key: string, text: string, error: StageError | undefined): Sentence {
  return { status: makeStatus(key, text, 'failed', 'cross', text, errorTitle(error)), hint: null };
}

function sentenceFor(f: Facts): Sentence {
  const id = f.question.id;
  const scan = f.scan;

  if (scan && isReading(scan)) {
    let text: string;
    if (scan.answerMode === 'yes_no') {
      text = 'They are answering yes or no.';
    } else {
      // "option 2 of 4": the number only, never the option's words.
      const count = countOptions(f.options, id, scan.version);
      const cursor = scan.cursor;
      const where = cursor === null ? '' : count >= cursor ? `, option ${cursor} of ${count}` : `, option ${cursor}`;
      if (f.question.origin === 'menu' || scan.mode === 'menu') text = `They are choosing from their own menu${where}.`;
      else if (f.followUp) text = `They are choosing what to do next${where}.`;
      else text = `They are choosing${where}.`;
    }
    let hint: string = PARTNER_TEXT.listeningToOptions;
    if (scan.answerMode === 'yes_no') hint = PARTNER_TEXT.pleaseWait;
    else if (scan.pass > 1) hint = PARTNER_TEXT.hearingAgain;
    return { status: makeStatus(`${id}:choosing:${scan.version}:${scan.pass}`, text), hint };
  }

  if (scan && scan.phase === 'veto') return { status: makeStatus(`${id}:veto`, PARTNER_TEXT.picked), hint: null };

  if (f.lastPick) return pickSentence(f, f.lastPick);

  // A reply was released even though no pick row is here (a source that writes no select events).
  if (f.reply) return answeredSentence(f);

  if (scan && scan.outcome !== null && scan.outcome !== 'picked') return outcomeSentence(id, scan.outcome);

  const failure = failureFor(f);
  if (failure) return failure;

  // The options are in the earpiece, but the scan clock row has not caught up.
  if (f.speak) return { status: makeStatus(`${id}:choosing`, 'They are choosing.'), hint: PARTNER_TEXT.listeningToOptions };
  if (f.plan) return { status: makeStatus(`${id}:drafting`, PARTNER_TEXT.drafting), hint: PARTNER_TEXT.pleaseWait };
  if (f.search || f.retrieve || f.listen?.status === 'ok' || f.question.text) {
    return { status: makeStatus(`${id}:lookup`, PARTNER_TEXT.lookingUp), hint: PARTNER_TEXT.pleaseWait };
  }
  return { status: makeStatus(`${id}:listening`, PARTNER_TEXT.listening), hint: null };
}

/** The newest failure that nothing has moved past. */
function failureFor(f: Facts): Sentence | null {
  const id = f.question.id;
  if (f.speak?.status === 'error') return failed(`${id}:failed:speak`, 'Could not read the options. Ask again.', f.speak.detail.error);
  if (f.plan?.status === 'error') return failed(`${id}:failed:plan`, 'Could not draft options. Ask again.', f.plan.detail.error);
  if (f.plan || f.speak) return null;
  if (f.retrieve?.status === 'error') return failed(`${id}:failed:lookup`, 'Could not look that up. Ask again.', f.retrieve.detail.error);
  // A failed web search alone is not the end: memory can still answer (PLAN D8). Only if nothing followed it.
  if (f.search?.status === 'error' && !f.retrieve && f.newest === f.search) {
    return failed(`${id}:failed:lookup`, 'Could not look that up. Ask again.', f.search.detail.error);
  }
  if (f.search || f.retrieve) return null;
  if (f.listen?.status === 'error') return failed(`${id}:failed:listen`, 'Could not hear that. Ask again.', f.listen.detail.error);
  return null;
}

function outcomeSentence(id: string, outcome: Exclude<ScanState['outcome'], 'picked' | null>): Sentence {
  switch (outcome) {
    case 'none':
      return { status: makeStatus(`${id}:none`, 'They chose none of these.', 'stopped', 'pause'), hint: 'Try asking another way.' };
    case 'no_pick':
      return { status: makeStatus(`${id}:no-pick`, 'No pick. Nothing was said or sent.', 'stopped', 'pause'), hint: null };
    case 'stopped':
      return { status: makeStatus(`${id}:stopped`, 'Stopped. Nothing was said or sent.', 'stopped', 'pause'), hint: null };
    case 'cancelled':
      return { status: makeStatus(`${id}:cancelled`, 'This question was cancelled.', 'stopped', 'pause'), hint: null };
  }
}

function pickSentence(f: Facts, pick: Pick): Sentence {
  const id = f.question.id;
  // Keyed by the words, not the status, so two statuses with one sentence are announced once.
  const errand = errandFor(pick, f);
  if (errand) {
    const s = errandSentence(errand, f.input);
    return { status: makeStatus(`${id}:errand:${errand.id}:${s.text}`, s.text, s.tone, s.icon), hint: s.hint };
  }
  const call = callFor(pick, f);
  if (call) {
    const s = callSentence(call, f.input);
    return { status: makeStatus(`${id}:call:${call.id}:${s.text}`, s.text, s.tone, s.icon), hint: s.hint };
  }
  if (pick.kind === 'errand') return { status: makeStatus(`${id}:errand-picked`, 'They chose an errand.'), hint: 'Getting it ready. Nothing is sent yet.' };
  if (pick.kind === 'call') return { status: makeStatus(`${id}:call-picked`, 'They chose a call.'), hint: 'Getting it ready. No call is made yet.' };
  if (pick.kind === 'menu') return { status: makeStatus(`${id}:menu-picked`, 'They picked from their menu.', 'done', 'check'), hint: null };
  return answeredSentence(f);
}

/** "They answered." Screen readers hear the reply itself once its words are here. */
function answeredSentence(f: Facts): Sentence {
  const id = f.question.id;
  const reply = f.reply?.text ?? null;
  return {
    status: makeStatus(`${id}:answered:${reply ? 'words' : 'no-words'}`, PARTNER_TEXT.answered, 'done', 'check', reply ? `They answered: "${reply}"` : PARTNER_TEXT.answered),
    hint: null,
  };
}

interface Line {
  text: string;
  tone: StatusTone;
  icon: StatusIcon;
  hint: string | null;
}

function line(text: string, hint: string | null = null, tone: StatusTone = 'plain', icon: StatusIcon = 'none'): Line {
  return { text, tone, icon, hint };
}

/**
 * The confirm hints. Only a headset session names the single jaw clench; a key or a switch press is named as itself, and
 * an unknown input names no signal.
 */
function confirmHints(input: InputKind, what: 'request' | 'call'): { waiting: string; confirmed: string } {
  const phrase = signalPhrase('CONFIRM', input);
  const nothing = what === 'call' ? 'No call is made' : 'Nothing is sent';
  const waiting = input === 'headset' ? `${nothing} without their ${commandSignal('CONFIRM', input)}.` : `${nothing} until they confirm.`;
  return { waiting, confirmed: phrase === null ? 'They confirmed.' : `They confirmed with ${phrase}.` };
}

/** Content-free errand progress. The form's name and values stay off the phone. */
function errandSentence(errand: Errand, input: InputKind): Line {
  const reason = plain(errand.reason);
  const hints = confirmHints(input, 'request');
  switch (errand.status) {
    case 'preparing':
      return line('Getting their request ready.', 'Nothing is sent yet.');
    case 'previewed':
    case 'reading_back':
      return line('Reading their request back to them.', 'Nothing is sent yet.');
    case 'awaiting_confirm':
      return line('Waiting for them to confirm.', hints.waiting, 'waiting', 'hourglass');
    case 'confirmed':
    case 'submitting':
      return line('Sending their request.', hints.confirmed);
    case 'sent':
      return line('Their request was sent.', null, 'done', 'check');
    case 'stopped':
      return line('Not sent.', reason, 'stopped', 'pause');
    case 'refused':
      return line('Not sent.', reason ?? 'A safety rule stopped it.', 'stopped', 'no_entry');
    case 'failed':
      return line('The request failed.', reason ?? 'Nothing was sent.', 'failed', 'cross');
    case 'unknown_outcome':
      return line('The request may not have gone through.', 'It was not sent again.', 'failed', 'cross');
  }
}

/** Content-free call progress. The contact and the script stay off the phone. */
function callSentence(call: CallRequest, input: InputKind): Line {
  const reason = plain(call.reason);
  const hints = confirmHints(input, 'call');
  const endReason = plain(call.endReason);
  // A hang-up was asked for and the line has not dropped yet (docs/spacetime.md `cancel_requested`).
  const live = call.status === 'confirmed' || call.status === 'dialing' || call.status === 'ringing' || call.status === 'connected';
  if (call.cancelRequested === true && live) return line('Hanging up.', null, 'stopped', 'pause');
  switch (call.status) {
    case 'prepared':
      return line('Reading the call back to them.', 'No call is made yet.');
    case 'awaiting_confirm':
      return line('Waiting for them to confirm the call.', hints.waiting, 'waiting', 'hourglass');
    case 'confirmed':
    case 'dialing':
      return line('Calling.', hints.confirmed);
    case 'ringing':
      return line('Ringing.');
    case 'connected':
      return line('On the call.');
    case 'ended':
      if (call.result === 'no_answer') return line('No answer.', endReason, 'stopped', 'pause');
      if (call.result === 'busy') return line('The line was busy.', endReason, 'stopped', 'pause');
      if (call.result === 'voicemail') return line('It went to voicemail.', endReason, 'stopped', 'pause');
      return call.startedAt !== null ? line('The call ended.', endReason, 'done', 'check') : line('The call ended.', endReason, 'stopped', 'pause');
    case 'failed':
      return line('The call failed.', reason ?? endReason, 'failed', 'cross');
    case 'stopped':
      return line('No call was made.', reason, 'stopped', 'pause');
    case 'refused':
      return line('No call was made.', reason ?? 'A safety rule stopped it.', 'stopped', 'no_entry');
  }
}

// "You asked" and "Their answer"

function askedFor(f: Facts): PartnerAsked | null {
  const q = f.question;
  if (q.origin === 'menu') return null;
  const text = q.text?.trim();
  if (text) return { text, quoted: true };
  if (f.listen?.status === 'ok' || q.via === 'typed') return { text: `Question ${q.number}`, quoted: false };
  return null;
}

function note(text: string): PartnerAnswer {
  return { text, isReply: false, spoken: null };
}

function answerFor(f: Facts): PartnerAnswer {
  if (f.reply) {
    return {
      text: f.reply.text,
      isReply: true,
      spoken: f.reply.spokenAt !== null ? { state: 'said', at: formatClock(f.reply.spokenAt) } : { state: 'saying' },
    };
  }
  const pick = f.firstPick;
  if (pick?.kind === 'errand') return note('They chose an errand.');
  if (pick?.kind === 'call') return note('They chose a call.');
  if (pick?.kind === 'menu') return note('They picked from their menu.');
  // A reply was picked, but its words are not shared with this screen.
  if (pick) return note('They answered out loud.');
  const outcome = f.scan?.outcome ?? null;
  if (outcome !== null && outcome !== 'picked') return note(PARTNER_TEXT.noAnswer);
  return note(PARTNER_TEXT.waitingForPick);
}

// The steps: Heard you, Looked it up, Reading options, Answer

function stepsFor(f: Facts, hold: Hold | null): Step[] {
  const steps: Step[] = [];
  // A turn from the person's own menu has no partner question to hear or look up.
  if (f.question.origin !== 'menu') steps.push(heardStep(f), lookedUpStep(f));
  steps.push(readingStep(f, hold), answerStep(f));
  return steps;
}

function heardStep(f: Facts): Step {
  const key = 'heard';
  const label = f.question.via === 'typed' ? 'Got your question' : 'Heard you';
  const listen = f.listen;
  if (listen?.status === 'error') return { key, label, status: 'failed' };
  if (listen?.status === 'ok') return { key, label, status: 'done', time: formatClock(listen.at) };
  if (listen?.status === 'started') return { key, label, status: 'working' };
  if (f.question.text) return { key, label, status: 'done', time: formatClock(f.question.askedAt) };
  return { key, label, status: 'not_started' };
}

function lookedUpStep(f: Facts): Step {
  const key = 'looked-up';
  const label = 'Looked it up';
  const { search, retrieve } = f;
  const searchSkipped = search?.detail.needsWeb === false;
  const searchRunning = search?.status === 'started' && !searchSkipped;
  const searchFailed = search?.status === 'error' && !searchSkipped;
  const later = f.plan !== null || f.speak !== null || f.lastPick !== null || f.reply !== null;

  // A failed memory recall does not stop the turn: once options came, the lookup is done without it, like a failed search.
  if (retrieve?.status === 'error') {
    if (later) return { key, label, status: 'done', statusWord: searchFailed ? 'Done without a lookup' : 'Done without the memory lookup' };
    return f.newest === retrieve ? { key, label, status: 'failed' } : { key, label, status: 'working' };
  }
  if (searchRunning || retrieve?.status === 'started') return { key, label, status: 'working' };
  if (retrieve?.status === 'ok') {
    const at = Math.max(retrieve.at, search?.at ?? 0);
    return { key, label, status: 'done', time: formatClock(at), statusWord: searchFailed ? 'Done without the web search' : undefined };
  }
  if (searchFailed) {
    if (later) return { key, label, status: 'done', statusWord: 'Done without the web search' };
    return f.newest === search ? { key, label, status: 'failed' } : { key, label, status: 'working' };
  }
  if (search) return later ? { key, label, status: 'done', time: formatClock(search.at) } : { key, label, status: 'working' };
  return later ? { key, label, status: 'not_started', statusWord: 'Skipped' } : { key, label, status: 'not_started' };
}

function readingStep(f: Facts, hold: Hold | null): Step {
  const key = 'reading';
  const scan = f.scan;
  const label = scan?.answerMode === 'yes_no' ? 'Asking yes or no' : 'Reading options';
  if (f.firstPick) return { key, label, status: 'done', time: formatClock(f.firstPick.at) };
  if (f.reply) return { key, label, status: 'done' };
  if (scan?.phase === 'veto') return { key, label, status: 'done', time: formatClock(scan.stepStartedAt) };
  if (f.speak?.status === 'error' && !isReading(scan)) return { key, label, status: 'failed' };
  if (f.plan?.status === 'error' && !f.speak) return { key, label, status: 'failed' };
  if (scan?.outcome === 'none' || scan?.outcome === 'no_pick') return { key, label, status: 'done', time: formatClock(scan.stepStartedAt) };
  if (scan?.outcome === 'stopped') return { key, label, status: 'stopped', statusWord: 'Stopped' };
  if (scan?.outcome === 'cancelled') return { key, label, status: 'stopped', statusWord: 'Cancelled' };
  const started = isReading(scan) || f.firstSpeak !== null;
  if (started && hold) return { key, label, status: 'stopped', statusWord: hold === 'headset_off' ? offWord(f.input) : 'Paused' };
  if (started) return { key, label, status: 'working' };
  return { key, label, status: 'not_started' };
}

function answerStep(f: Facts): Step {
  const key = 'answer';
  const label = 'Answer';
  const scan = f.scan;
  if (f.firstPick || f.reply) {
    // A reply that has been said out loud is timed by when it was said; anything else by the pick.
    const at = f.reply?.spokenAt ?? f.firstPick?.at ?? null;
    return { key, label, status: 'done', time: at === null ? undefined : formatClock(at) };
  }
  if (scan?.phase === 'veto') return { key, label, status: 'working', statusWord: 'Picked' };
  if (f.lastSelect?.status === 'error') return { key, label, status: 'failed' };
  switch (scan?.outcome) {
    case 'none':
      return { key, label, status: 'stopped', statusWord: 'None of these' };
    case 'no_pick':
      return { key, label, status: 'stopped', statusWord: 'No pick' };
    case 'stopped':
      return { key, label, status: 'stopped', statusWord: 'Stopped' };
    case 'cancelled':
      return { key, label, status: 'stopped', statusWord: 'Cancelled' };
    default:
      return { key, label, status: 'not_started' };
  }
}
