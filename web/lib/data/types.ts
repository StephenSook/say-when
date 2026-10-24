/**
 * Data types for the Eleven dashboard and the partner phone view.
 *
 * DRAFT until PLAN 1.2 locks the contracts. These follow "Shared Contracts" in PLAN.md (D11 command
 * names) and fill the gaps listed at the end of docs/ui.md ("Contract gaps for PLAN 1.2"). Anything
 * marked "draft" is not in PLAN.md yet. lib/data/spacetime-map.ts (`boardRows`) maps the live module's
 * generated rows onto these types, so the screens read live rows and the sample replay alike.
 *
 * Conventions:
 * - Times on rows (`at`, `askedAt`, `createdAt`, ...) are epoch milliseconds.
 * - Times inside producer payloads (`fetchedAt` on search rows and sources) are ISO 8601
 *   strings, exactly as apify/client and moss emit them. lib/format.ts reads both.
 * - Every list is sorted oldest first.
 * - Never put a phone number in these types. Screens show a contact's name only.
 * - Memory text never appears unless the person marked that memory shareable (MossHit.sharedText).
 */

/** Where the screens get their rows. */
export type SourceMode = 'spacetime' | 'replay' | 'none';

/** The connection chip states in docs/ui.md. */
export type Connection = 'connecting' | 'live' | 'reconnecting' | 'offline';

/** Why the screens are not live, for the one sentence under the header. */
export type OfflineReason =
  /** No SpacetimeDB settings and no sample replay. */
  | 'not-configured'
  /** SpacetimeDB settings exist, but this build has no generated table bindings yet. */
  | 'no-bindings'
  /** The server could not be reached, or the connection dropped for more than 10 s. */
  | 'network'
  /** Connected, but the server rejected the subscription. */
  | 'subscription';

export type Stage = 'listen' | 'search' | 'retrieve' | 'plan' | 'speak' | 'select' | 'errand' | 'call';

/** Stages in pipeline order. */
export const STAGES: readonly Stage[] = ['listen', 'search', 'retrieve', 'plan', 'speak', 'select', 'errand', 'call'];

export type PipelineStatus = 'started' | 'ok' | 'error';

/**
 * PLAN.md D11 command names. The person gives four of them:
 * - YES (imagine squeezing the right fist): pick this option, or answer yes. While idle, it opens the person's menu.
 * - NO (imagine squeezing the left fist): skip this option, or answer no.
 * - CONFIRM (double jaw clench): the only way anything leaves the room, after the read-back.
 * - STOP (long jaw clench, about 1 s): cancel, none of these, hang up, pause.
 * HEADSET_OFF is a system event, not a command: the headset lost contact. Like the 2-minute idle
 * auto-pause, it cancels anything pending.
 */
export type CommandName = 'YES' | 'NO' | 'CONFIRM' | 'STOP' | 'HEADSET_OFF';

/** The four commands a person gives on purpose. */
export type PersonCommand = Exclude<CommandName, 'HEADSET_OFF'>;

/** The person's four commands, in the order the command strip shows them. */
export const PERSON_COMMANDS: readonly PersonCommand[] = ['YES', 'NO', 'CONFIRM', 'STOP'];

/** Every command event name, the system's HEADSET_OFF included. */
export const COMMANDS: readonly CommandName[] = [...PERSON_COMMANDS, 'HEADSET_OFF'];

/** 'reply', 'errand' and 'call' are offered by Claude; 'menu' items are made by the module (the person's own menu). */
export type OptionKind = 'reply' | 'errand' | 'call' | 'menu';

/** One sentence for the screen plus the raw error text for a `title` tooltip (docs/ui.md). */
export interface StageError {
  sentence: string;
  raw?: string;
}

/** Where a fact came from: the `sources` entry on an option row (PLAN.md Option row). */
export interface SourceRef {
  /** 'web', 'maps' or 'memory'. */
  source: string;
  url?: string;
  placeId?: string;
  /** ISO 8601. */
  fetchedAt: string;
}

export interface Question {
  id: string;
  sessionId: string;
  /** 1-based count in the session, for "Question 7". draft */
  number: number;
  /**
   * The partner's words. null while the partner is still talking, or when the board does not share
   * question text (docs/spacetime.md `public_board`); then the screen shows "Question 7".
   */
  text: string | null;
  /** 'typed' needs a reducer for a typed question (docs/ui.md gap 7); 'menu' is a turn from the person's own menu. draft */
  via: 'voice' | 'typed' | 'menu';
  /** 'partner': the partner asked. 'menu': YES while idle opened the person's menu (D11). */
  origin: 'partner' | 'menu';
  askedAt: number;
  /** The reply said out loud after YES (docs/ui.md gap 6). null until the pick is released. draft */
  replyText: string | null;
  /** When the reply was said out loud. null until then. draft */
  spokenAt: number | null;
}

/** Place facts from apify/client. The place phone number is left out on purpose. */
export interface PlaceFacts {
  rating?: number;
  reviews?: number;
  openNow?: boolean;
  wheelchairEntrance?: true;
  address?: string;
  category?: string;
}

/** One Apify row (apify/client "Search rows"). */
export interface SearchRow {
  id: string;
  source: 'web' | 'maps';
  title: string;
  /** A short summary or excerpt. Maps rows carry a plain summary of their facts. */
  text?: string;
  url?: string;
  placeId?: string;
  /** ISO 8601. */
  fetchedAt: string;
  rank?: number;
  facts?: PlaceFacts;
}

/** A memory's category: a stated preference, or a reply the person confirmed before (moss MemoryType). */
export type MemoryType = 'pref' | 'reply';

/**
 * One Moss hit (docs/ui.md "Retrieve").
 * - A web hit shows its `text`.
 * - A memory hit shows its text only when the person marked that memory shareable, and then the
 *   text arrives as `sharedText`. Every other memory reads "Private memory" with its category.
 *   Memory text never reaches SpacetimeDB or a screen unless it was shared (moss/README.md).
 * Screens read hits through `hitDisplay` in lib/data/derive.ts, which applies this rule.
 */
export interface MossHit {
  id: string;
  origin: 'memory' | 'web';
  /** Memory hits only: the category. */
  memoryType?: MemoryType;
  /** Memory hits only: the memory's text, present only when the person marked it shareable. */
  sharedText?: string;
  score: number;
  /** Web hits only: the passage, or its title. Never set on a memory hit. */
  text?: string;
  /** Web hits only: where the passage came from. */
  source?: SourceRef;
  /** Memory hits only: when the item was saved. */
  savedAt?: number;
}

/**
 * Word timings from Cartesia, measured from the start of the clip (cartesia/src/tts.ts). On live data they come from
 * the module's `board_word_timings` (docs/spacetime.md 14), which keeps the numbers only, never the words, so `word`
 * is absent there: the screen places the i-th timing on the i-th word it shows.
 */
export interface WordTiming {
  word?: string;
  startMs: number;
  endMs: number;
}

/** What every stage's detail can carry. */
export interface DetailBase {
  /**
   * The producer's short step label from a fixed vocabulary, the words the module writes into
   * `pipeline_event.detail` (docs/spacetime.md 11.4): "heard", "web partial", "none of these",
   * "failed: timeout". Content-free, so it is safe on any screen.
   */
  label?: string;
  error?: StageError;
}

export interface ListenDetail extends DetailBase {
  words?: string;
  wordCount?: number;
}

export interface SearchDetail extends DetailBase {
  /** false when the question needs no outside facts and the search is skipped (PLAN D8). */
  needsWeb?: boolean;
  /** Why it searched or skipped, in one sentence (apify/client classifyQuestion). */
  reason?: string;
  /** How many searches ran, for "6 rows from 2 searches". */
  searches?: number;
  rowCount?: number;
  rows?: SearchRow[];
  /** true when some results were dropped. */
  partial?: boolean;
}

export interface RetrieveDetail extends DetailBase {
  hitCount?: number;
  hits?: MossHit[];
  /** Moss's own time, next to the wall time in `ms`. */
  mossMs?: number;
}

export interface PlanDetail extends DetailBase {
  /** The option version this run wrote. */
  version?: number;
  optionCount?: number;
  /** true when these are follow-up options after a pick, such as an errand or a call. draft */
  followUp?: boolean;
}

/**
 * A speak step. Since module v2 (docs/spacetime.md 14) every read in the earpiece is its own `started` step, labelled
 * "reading option" (or "yes or no prompt"), whose counts name the option (`optionId`, `rank`; neither for the prompt),
 * the `pass`, the scan's `stepSeq` and the planned `durationMs`. The scan's own "scan ended" step closes the run.
 */
export interface SpeakDetail extends DetailBase {
  optionId?: string;
  /** 1-based. Absent for the yes or no prompt. */
  rank?: number;
  /** Which pass through the options this read belongs to, 1-based. */
  pass?: number;
  /** The scan step this read began at (`scan_state.step_seq`). */
  stepSeq?: number;
  /** true when `durationMs` is planned from an estimated clip length, not a measured clip. */
  estimated?: boolean;
  text?: string;
  /** 'earpiece' is heard by the person only; 'aloud' is the spoken reply the room hears. */
  channel?: 'earpiece' | 'aloud';
  /** Cartesia tone of the option being read: 'neutral', 'calm', 'warm', 'sad' or 'firm'. draft */
  tone?: string;
  /** Play button only when this is set (docs/ui.md). */
  clipUrl?: string;
  durationMs?: number;
  /** Cartesia word timings for the clip. They drive the word mark on Live conversation (PLAN D10). */
  words?: WordTiming[];
  /** The read was cut short by this command (NO, STOP or HEADSET_OFF). */
  stoppedBy?: CommandName;
}

/** A select step is the pick itself: since module v2 it is written only for a pick, naming the option (docs/spacetime.md 14). */
export interface SelectDetail extends DetailBase {
  optionId?: string;
  rank?: number;
  pass?: number;
  text?: string;
  kind?: OptionKind;
}

export interface ErrandDetail extends DetailBase {
  errandId?: string;
}

export interface CallDetail extends DetailBase {
  callId?: string;
}

export interface StageDetailMap {
  listen: ListenDetail;
  search: SearchDetail;
  retrieve: RetrieveDetail;
  plan: PlanDetail;
  speak: SpeakDetail;
  select: SelectDetail;
  errand: ErrandDetail;
  call: CallDetail;
}

/** PLAN.md Pipeline event, with `question_id` added (docs/ui.md gap 1) and `detail` parsed per stage. */
export type PipelineEvent = {
  [S in Stage]: {
    id: string;
    sessionId: string;
    questionId: string;
    stage: S;
    status: PipelineStatus;
    detail: StageDetailMap[S];
    /** Final time for this step. null while `started`; count up from `at` instead. */
    ms: number | null;
    at: number;
  };
}[Stage];

/** The event type for one stage, so `detail` is typed: `PipelineEventOf<'search'>`. */
export type PipelineEventOf<S extends Stage> = Extract<PipelineEvent, { stage: S }>;

/**
 * PLAN.md Option row. Errands and calls are options too (D11): Claude offers them as follow-up
 * options, YES picks one, the read-back plays, and only a fresh CONFIRM sends it.
 */
export interface AnswerOption {
  id: string;
  questionId: string;
  version: number;
  /** 1-based reading order. */
  rank: number;
  text: string;
  kind: OptionKind;
  /** Cartesia tone for this option (PLAN D10): 'neutral', 'calm', 'warm', 'sad' or 'firm'. draft */
  tone: string | null;
  sources: SourceRef[];
}

export type ErrandStatus =
  /** YES picked the errand option; the form-errand Actor is filling the form in a browser. */
  | 'preparing'
  /** The form is filled and the preview screenshot exists. Nothing is sent. */
  | 'previewed'
  /** The read-back is playing in the earpiece. */
  | 'reading_back'
  /** The read-back finished; the confirm window is open, waiting for CONFIRM (a double jaw clench). */
  | 'awaiting_confirm'
  /** A CONFIRM matched to the read-back digest arrived; the agent has not claimed it yet. */
  | 'confirmed'
  /** The agent is sending the form. */
  | 'submitting'
  | 'sent'
  /** The send did not report back in time. Nothing is ever sent again (docs/spacetime.md 4.3). */
  | 'unknown_outcome'
  /** NO, STOP, headset off, the idle auto-pause, or the window ran out. Nothing was sent. */
  | 'stopped'
  /** A safety rule said no on purpose (CAPTCHA, login, a form not on the allowlist). */
  | 'refused'
  | 'failed';

/** One value the form-errand Actor read back off the filled page. */
export interface ReadBackItem {
  label: string;
  value: string;
  /** Where the value came from, for example 'memory'. Echoed, never typed into the form. */
  source?: string;
}

/** PLAN.md Errand row plus the draft fields the Agents screen needs (docs/ui.md gaps 5 and 8). */
export interface Errand {
  id: string;
  questionId: string | null;
  /** The errand option YES picked. Look its text up in the option rows. draft */
  optionId: string | null;
  /** The form's title, for example "Care team request". */
  form: string;
  status: ErrandStatus;
  /** 16 hex characters. Show the first 8, the full value in a tooltip. */
  previewDigest: string | null;
  readBackText: string | null;
  readBack: ReadBackItem[];
  confirmationText: string | null;
  screenshotUrl: string | null;
  /** When the confirm window closes. The countdown bar shows only when this is set. draft */
  confirmClosesAt: number | null;
  /**
   * When the confirm window opens: the read-back's end plus the quiet hold, moved again if a CONFIRM came too soon
   * (docs/spacetime.md 4.3). The countdown runs from here. Absent: from `readAloudAt`.
   */
  confirmOpensAt?: number | null;
  /** One plain sentence for Stopped, Refused or Failed. draft */
  reason: string | null;
  /** The Actor's refusal code, such as 'captcha' or 'not_allowed'. draft */
  reasonCode: string | null;
  /** The CONFIRM command event that released this errand. draft */
  confirmCommandId: string | null;
  /** The NO, STOP or HEADSET_OFF command event that stopped it. null for a timeout. draft */
  stopCommandId: string | null;
  /** YES picked the errand option. */
  createdAt: number;
  /** The form was filled in a browser and the preview screenshot exists. */
  previewedAt: number | null;
  /** How long filling the form took. */
  previewMs: number | null;
  /** The read-back finished playing in the earpiece; the confirm window opened. */
  readAloudAt: number | null;
  confirmedAt: number | null;
  sentAt: number | null;
  /** When it was stopped, refused or failed. */
  endedAt: number | null;
}

export type CallStatus =
  /** YES picked the call option; the script is ready (`scriptDigest` set) and is being read back in the earpiece. */
  | 'prepared'
  /** The read-back finished; the confirm window is open, waiting for CONFIRM. */
  | 'awaiting_confirm'
  /** A CONFIRM matched to the script digest arrived; the agent has not dialed yet. */
  | 'confirmed'
  | 'dialing'
  /** Our own event: Cartesia's call status has no ringing (docs/ui.md gap 9). */
  | 'ringing'
  | 'connected'
  /** The call happened and ended; `result` and `endReason` say how. */
  | 'ended'
  | 'failed'
  /** Never dialed: NO, STOP, headset off, the idle auto-pause, or the window ran out. */
  | 'stopped'
  /** A safety rule said no on purpose (no consent on file, the do-not-call list). */
  | 'refused';

/** How a call ended (cartesia/src/call.ts CallResult). A STOP that hangs up is 'cancelled'. */
export type CallResult = 'answered' | 'no_answer' | 'busy' | 'voicemail' | 'cancelled' | 'failed' | 'refused' | 'unknown';

export interface TranscriptLine {
  id: string;
  role: 'assistant' | 'recipient';
  text: string;
  at: number;
}

/** PLAN.md Call request plus the draft fields the Agents screen needs (docs/ui.md gaps 5, 6, 8 and 9). */
export interface CallRequest {
  id: string;
  questionId: string | null;
  /** The call option YES picked. Look its text up in the option rows. draft */
  optionId: string | null;
  /** A name only. Never a phone number. */
  contactName: string;
  scriptDigest: string | null;
  /** The script read back to the person before the confirm. draft */
  readBackText: string | null;
  status: CallStatus;
  result: CallResult | null;
  /** Plain words, for example "No answer after 25 s" or "The person hung up with STOP." */
  endReason: string | null;
  /** One plain sentence for Stopped or Refused. draft */
  reason: string | null;
  /** The module's code for that reason, such as 'window_closed' or 'confirm_expired'. Absent when the source does not say. */
  reasonCode?: string | null;
  /**
   * The call agent put this contact on hold until someone checks (an opt-out or an unreadable hold file;
   * docs/spacetime.md 14, `board_calls.held`). Absent when the source does not say.
   */
  held?: boolean;
  /** The recipient agreed to be called and to have the transcript shown. draft */
  consentOnFile: boolean;
  /** The script finished playing in the earpiece; the confirm window opened. draft */
  readAloudAt: number | null;
  /** When the confirm window closes. The countdown bar shows only when this is set. draft */
  confirmClosesAt: number | null;
  /** When the confirm window opens (after the quiet hold). The countdown runs from here. Absent: from `readAloudAt`. */
  confirmOpensAt?: number | null;
  /** The CONFIRM command event that released this call. draft */
  confirmCommandId: string | null;
  /** The NO, STOP or HEADSET_OFF command event that stopped it before dialing, or hung it up. draft */
  stopCommandId: string | null;
  /**
   * STOP, HEADSET_OFF, the idle auto-pause or the operator asked the call agent to hang up a call
   * that is dialing, ringing or connected; it reports Ended once the line drops (docs/spacetime.md
   * `call_request.cancel_requested`). Absent when the source does not say.
   */
  cancelRequested?: boolean;
  createdAt: number;
  confirmedAt: number | null;
  dialedAt: number | null;
  /** Start of the ring timer. Our own event: Cartesia has no ringing status (docs/ui.md gap 9). */
  ringingAt: number | null;
  /** Connected; the live duration counts from here. */
  startedAt: number | null;
  endedAt: number | null;
  transcript: TranscriptLine[];
}

/** PLAN.md Command event (D11). Ignored repeats are kept so the event feed can show the debounce. */
export interface CommandEvent {
  id: string;
  command: CommandName;
  at: number;
  accepted: boolean;
  /** Why the signal was ignored, for example "Repeat inside the refractory time". null when accepted. */
  ignoredReason: string | null;
  /** The decoder's confidence, 0 to 1. null for HEADSET_OFF, which is a system event. */
  confidence: number | null;
  questionId: string | null;
  /** The option the person heard when YES or NO landed (D12: matched to the step they heard). draft */
  optionId: string | null;
}

/**
 * The scan clock's phase (docs/spacetime.md 4.1):
 * - 'idle': nothing is being read (before a question, after a scan ends, after a reply is released).
 * - 'preparing': the options are being drafted or their clips made.
 * - 'reading': the option under the cursor is playing in the earpiece.
 * - 'window': its audio ended and the response window is open: YES picks, NO skips, silence moves on.
 * - 'veto': YES picked a reply; for a moment (about 0.7 s) NO or STOP can still cancel it before it is said out loud.
 * - 'paused': STOP while idle, HEADSET_OFF, the idle auto-pause or the operator. YES resumes.
 */
export type ScanPhase = 'idle' | 'preparing' | 'reading' | 'window' | 'veto' | 'paused';

/**
 * How a scan ended. null while it is still running. draft
 * - 'picked': YES on `pickedOptionId` (after the veto, for a reply).
 * - 'none': STOP, none of these.
 * - 'no_pick': the passes ran out ("No pick. Nothing was said or sent.").
 * - 'stopped': STOP during the veto or while preparing, headset off, or the idle auto-pause.
 * - 'cancelled': the partner cancelled the question.
 */
export type ScanOutcome = 'picked' | 'none' | 'no_pick' | 'stopped' | 'cancelled';

/**
 * The scan clock (docs/ui.md gap 4, PLAN D12, docs/spacetime.md `scan_state`): which option is in the
 * earpiece and how long is left. NO skips the option under the cursor, and silence moves on when the
 * window closes. Neither ends the scan.
 */
export interface ScanState {
  questionId: string;
  /** The option version being scanned. 0 before the first options exist. */
  version: number;
  /** 'answer': the question's options. 'menu': the person's own menu, opened by YES while idle. */
  mode: 'answer' | 'menu';
  /** 'pick': read the options one by one. 'yes_no': one "Yes or no?" prompt; YES answers yes, NO answers no. */
  answerMode: 'pick' | 'yes_no';
  phase: ScanPhase;
  /** Rank (1-based) of the option under the cursor. null when the scan is not on an option. */
  cursor: number | null;
  /** When the current phase started, for the time-left bar. */
  stepStartedAt: number;
  /** When the current phase ends: the audio end while reading, the window close in the window, the veto end. */
  stepEndsAt: number;
  /** 1-based. */
  pass: number;
  maxPasses: number;
  /** null while scanning. Once set, the scan has ended: stop the countdown and ignore `stepEndsAt`. */
  outcome: ScanOutcome | null;
  /** Set by YES: during the veto, and after the pick, through a later pause and the end of the session. */
  pickedOptionId: string | null;
}

/**
 * The headset safety state behind the shell banner and the headset chip. draft (docs/ui.md gap 3)
 * 'paused': STOP while idle, the 2-minute idle auto-pause, the operator, or lost heartbeats.
 * 'headset_off': HEADSET_OFF. Both cancel anything pending, so the room must see them. YES resumes.
 * (A STOP that hangs up a call or cancels a scan does not pause; docs/spacetime.md 4.2.)
 */
export interface SafetyState {
  state: 'unknown' | 'ok' | 'paused' | 'headset_off';
  since: number | null;
}

/**
 * Where the board session's commands come from (docs/station.md 2.3, request W1): the station's input mode, read from
 * the session label (`headset-demo`, `keyboard-test`, `switch-demo`, ...). Keyboard and switch commands are key and
 * switch presses, never headset signals, so the screens name the true input. 'unknown' when no label says it (no
 * session yet, or a label without a mode): then no screen names a brain or jaw signal.
 */
export type InputKind = 'headset' | 'keyboard' | 'switch' | 'unknown';

/** Every row the screens read, sorted oldest first. */
export interface DataRows {
  questions: readonly Question[];
  pipelineEvents: readonly PipelineEvent[];
  options: readonly AnswerOption[];
  errands: readonly Errand[];
  calls: readonly CallRequest[];
  commands: readonly CommandEvent[];
  scan: ScanState | null;
  safety: SafetyState;
  /** The board session's input mode, from its label. */
  input: InputKind;
}

/** What a data source reports: its mode, the connection, and the rows. */
export interface SourceState {
  mode: SourceMode;
  connection: Connection;
  /** true once the first full set of rows has arrived. Stays true while reconnecting, so cached rows stay on screen. */
  ready: boolean;
  reason: OfflineReason | null;
  /** Raw error text for a `title` tooltip. */
  errorText: string | null;
  /** When `connection` last changed. 0 before the source starts. */
  since: number;
  rows: DataRows;
}

export const EMPTY_ROWS: DataRows = Object.freeze({
  questions: [],
  pipelineEvents: [],
  options: [],
  errands: [],
  calls: [],
  commands: [],
  scan: null,
  safety: Object.freeze({ state: 'unknown', since: null }),
  input: 'unknown',
}) as DataRows;
