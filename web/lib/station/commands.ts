/**
 * From a command to a `gesture(...)` call (docs/station.md 2.7). Every command from every input goes through one
 * sender: the decoder (headset mode), the keyboard test keys, or a USB switch.
 *
 * 1. Play the command's tick at once. It says "your signal reached the station", not "it counted".
 * 2. Build the arguments: the heard step and option at the onset (lib/station/heard.ts), the read-back digest for
 *    CONFIRM, the source, and `onset_age_ms` = now - onset + the one-way estimate (a larger age only makes the
 *    module's quiet-hold check stricter, so the error falls on the safe side).
 * 3. Call `gesture`. A SenderError is never retried. A DisconnectedError or UnknownCallResultError is sent again with
 *    the same id once the connection is back, while the onset is under 3 s old (YES, NO, CONFIRM) or 30 s (STOP,
 *    HEADSET_OFF); a repeated id with the same command returns quietly in the module.
 * 4. Read the outcome from `my_session.last_gesture_id` and `last_gesture_outcome`, waiting at most 1 s for it.
 */
import { ignoredReasonWords } from '../data/spacetime-map';
import { callErrorKind, callErrorText, isSenderMessage, SENDER_MESSAGES, sendWithResend } from '../role/calls';
import type { ChimeName } from '../voice/audio';
import type { Heard } from './heard';

export const STATION_COMMANDS = ['YES', 'NO', 'CONFIRM', 'STOP', 'HEADSET_OFF'] as const;
export type StationCommand = (typeof STATION_COMMANDS)[number];

export function isStationCommand(value: unknown): value is StationCommand {
  return typeof value === 'string' && (STATION_COMMANDS as readonly string[]).includes(value);
}

/** The module's checks (spacetime/src/gesture.ts GESTURE_ID_RE and SOURCE_RE). */
export const GESTURE_ID_RE = /^[A-Za-z0-9:_-]{1,64}$/;
export const SOURCE_RE = /^[a-z_]{1,16}$/;

/** `onset_age_ms` is clamped to 0 to 10 minutes. */
export const MAX_ONSET_AGE_MS = 600_000;

/** How long a command may wait for the connection to come back before it is dropped as "Not sent: connection". */
export function resendWindowMs(command: StationCommand): number {
  return command === 'STOP' || command === 'HEADSET_OFF' ? 30_000 : 3_000;
}

/** How long to wait for `my_session` to name this command's outcome after the call resolved. */
export const OUTCOME_WAIT_MS = 1_000;

/** The tick each command plays when it reaches the station (Appendix A). HEADSET_OFF uses the STOP tone. */
export const COMMAND_CHIME: Readonly<Record<StationCommand, ChimeName>> = {
  YES: 'yes',
  NO: 'no',
  CONFIRM: 'confirm',
  STOP: 'stop',
  HEADSET_OFF: 'stop',
};

/** A fresh id for a key or switch press, or for a decoder message whose id failed the module's check. */
export function newGestureId(): string {
  const cryptoLike = globalThis.crypto as (Crypto & { randomUUID?: () => string }) | undefined;
  if (cryptoLike && typeof cryptoLike.randomUUID === 'function') return cryptoLike.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoLike && typeof cryptoLike.getRandomValues === 'function') cryptoLike.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** One command as an input produced it. */
export interface CommandInput {
  command: StationCommand;
  /** The decoder's id when it passed the check; null for keys, the switch, or a replaced decoder id. */
  gestureId: string | null;
  /** `key`, `switch`, or the decoder's own source (`imagery`, `jaw`, ...). */
  source: string;
  /** 0 to 1. Keys and the switch send 1. */
  confidence: number;
  /** The onset on the station's clock (performance.now): the keydown, or the decoder's receive time minus its age. */
  onsetLocal: number;
  via: 'decoder' | 'key' | 'switch';
  /** The decoder sent an id the module would refuse, so a new one was used. */
  idReplaced?: boolean;
}

/** The generated `gesture` reducer's arguments. */
export interface GestureArgs {
  gestureId: string;
  command: StationCommand;
  heardStepSeq: bigint;
  heardOptionId: bigint;
  heardDigest: string;
  confidence: number;
  source: string;
  onsetAgeMs: number;
}

/** now - onset + the one-way estimate, rounded and clamped to 0 to 600000. */
export function onsetAge(now: number, onsetLocal: number, oneWayMs: number): number {
  const raw = now - onsetLocal + (Number.isFinite(oneWayMs) ? Math.max(0, oneWayMs) : 0);
  if (!Number.isFinite(raw)) return 0;
  return Math.min(MAX_ONSET_AGE_MS, Math.max(0, Math.round(raw)));
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function buildGestureArgs(input: CommandInput, gestureId: string, heard: Heard, digest: string, now: number, oneWayMs: number): GestureArgs {
  return {
    gestureId,
    command: input.command,
    heardStepSeq: heard.stepSeq,
    heardOptionId: heard.optionId,
    heardDigest: input.command === 'CONFIRM' ? digest.slice(0, 64) : '',
    confidence: clampConfidence(input.confidence),
    source: SOURCE_RE.test(input.source) ? input.source : 'decoder',
    onsetAgeMs: onsetAge(now, input.onsetLocal, oneWayMs),
  };
}

// ---------- The read-back digest for CONFIRM ----------

/** `my_session.errand` and `.call`, reduced to what the digest choice needs (status tags as the bindings name them). */
export interface PendingWorkLite {
  errand?: { errandId: bigint; status: string } | null;
  call?: { callId: bigint; status: string } | null;
}

const ERRAND_CONFIRMABLE = new Set(['Drafted', 'Previewed', 'AwaitingConfirm', 'Confirmed']);
const CALL_CONFIRMABLE = new Set(['Prepared', 'AwaitingConfirm', 'Confirmed']);

export function readbackKey(kind: 'errand' | 'call', id: bigint): string {
  return `${kind}:${id.toString()}`;
}

/**
 * The digest of the read-back this station finished playing for the errand (first) or the call, in the module's own
 * order (spacetime/src/gesture.ts `onConfirm`). '' when none finished, which the module refuses: fail closed.
 */
export function confirmDigest(work: PendingWorkLite | null, played: ReadonlyMap<string, string>): string {
  if (!work) return '';
  if (work.errand && ERRAND_CONFIRMABLE.has(work.errand.status)) return played.get(readbackKey('errand', work.errand.errandId)) ?? '';
  if (work.call && CALL_CONFIRMABLE.has(work.call.status)) return played.get(readbackKey('call', work.call.callId)) ?? '';
  return '';
}

// ---------- Outcomes ----------

/** The command list's words for a module outcome such as `accepted:pick` or `ignored:refractory`. */
export function outcomeWords(outcome: string, rank: number | null): string {
  const option = rank !== null && rank > 0 ? `option ${rank}` : 'the option';
  if (outcome.startsWith('ignored:')) return `Ignored: ${ignoredReasonWords(outcome.slice('ignored:'.length)).replace(/\.$/, '')}`;
  if (!outcome.startsWith('accepted:')) return outcome === '' ? 'Sent' : outcome;
  const action = outcome.slice('accepted:'.length);
  if (action === 'pick') return `Picked ${option}`;
  if (action === 'pick_errand') return `Picked ${option}, a request`;
  if (action === 'pick_call') return `Picked ${option}, a phone call`;
  if (action === 'menu_item') return `Picked menu item ${rank ?? ''}`.trim();
  if (action === 'menu_open') return 'Opened the menu';
  if (action === 'answer_yes') return 'Answered yes';
  if (action === 'answer_no') return 'Answered no';
  if (action === 'skip') return `Skipped ${option}`;
  if (action === 'veto_cancel') return 'Cancelled the pick';
  if (action === 'confirm') return 'Confirmed';
  if (action === 'pause') return 'Paused';
  if (action === 'resume') return 'Resumed';
  if (action === 'hang_up') return 'Hung up';
  if (action.startsWith('stop_errand')) return 'Stopped the request';
  if (action.startsWith('stop_call')) return 'Stopped the phone call';
  if (action.startsWith('stop_reply')) return 'Cancelled. Nothing was said';
  if (action.startsWith('none')) return 'None of these';
  if (action.startsWith('stop')) return 'Stopped';
  return 'Counted';
}

export type OutcomeFeedback = { chime: 'notCounted' } | { phrase: 'tooSoon' } | null;

/**
 * What the earpiece adds for an outcome (docs/station.md 2.7 step 6). Accepted picks and answers get the module's
 * `picked` cue; `not_ready`, `yes_is_not_confirm` and `too_late` get the module's own cues; the rest stay silent.
 */
export function outcomeFeedback(outcome: string): OutcomeFeedback {
  switch (outcome) {
    case 'ignored:quiet_hold':
      return { phrase: 'tooSoon' };
    case 'ignored:stale_step':
    case 'ignored:heard_mismatch':
    case 'ignored:no_contact':
    case 'ignored:digest_mismatch':
      return { chime: 'notCounted' };
    default:
      return null;
  }
}

// ---------- Repeats from the decoder ----------

/** The last `limit` relayed decoder ids, so a repeated message is not relayed twice. */
export class RecentIds {
  private readonly order: string[] = [];
  private readonly set = new Set<string>();
  constructor(private readonly limit = 500) {}
  has(id: string): boolean {
    return this.set.has(id);
  }
  add(id: string): void {
    if (this.set.has(id)) return;
    this.set.add(id);
    this.order.push(id);
    while (this.order.length > this.limit) this.set.delete(this.order.shift()!);
  }
  get size(): number {
    return this.set.size;
  }
}

// ---------- The sender ----------

export type CommandEntryStatus = 'sending' | 'accepted' | 'ignored' | 'not_sent' | 'refused' | 'unknown';

export interface CommandEntry {
  gestureId: string;
  command: StationCommand;
  source: string;
  via: CommandInput['via'];
  /** Wall clock time of the onset, for the screen. */
  at: number;
  status: CommandEntryStatus;
  words: string;
  outcome: string | null;
  idReplaced: boolean;
  /** The refusal or connection error, for a tooltip. */
  errorText: string | null;
}

export interface CommandSenderDeps {
  /** The station's clock (performance.now). */
  now(): number;
  /** Date.now, for the times on screen. */
  wallNow(): number;
  heardAt(onset: number): Heard;
  digest(): string;
  oneWayMs(): number;
  send(args: GestureArgs): Promise<void>;
  waitForLive(timeoutMs: number): Promise<boolean>;
  chime(name: ChimeName): void;
  feedback(feedback: Exclude<OutcomeFeedback, null>): void;
  /** The rank of an option id in `my_options`, for "Picked option 2". */
  rankOf(optionId: bigint): number | null;
  /** The module refused with `not allowed`, `not the session station` or `no active session`. */
  sessionRefused?(error: unknown): void;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  sleep?(ms: number): Promise<void>;
  onChange?(): void;
}

/** Keeps the newest commands for the screen. */
export const COMMAND_LIST_SIZE = 12;

export class CommandSender {
  private list: CommandEntry[] = [];
  private readonly relayed = new RecentIds(500);
  private readonly seen = new Map<string, string>();
  private readonly waiting = new Map<string, { resolve: (outcome: string | null) => void; timer: unknown }>();
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: CommandSenderDeps) {
    this.setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Newest first. */
  entries(): readonly CommandEntry[] {
    return this.list;
  }

  clear(): void {
    this.list = [];
    this.deps.onChange?.();
  }

  /** Relays one command. Returns false for a repeated decoder id. */
  relay(input: CommandInput): boolean {
    if (input.gestureId !== null) {
      if (this.relayed.has(input.gestureId)) return false;
      this.relayed.add(input.gestureId);
    }
    const gestureId = input.gestureId ?? newGestureId();
    this.deps.chime(COMMAND_CHIME[input.command]);
    const heard = this.deps.heardAt(input.onsetLocal);
    const digest = input.command === 'CONFIRM' ? this.deps.digest() : '';
    const rank = heard.optionId !== 0n ? this.deps.rankOf(heard.optionId) : null;
    const entry: CommandEntry = {
      gestureId,
      command: input.command,
      source: SOURCE_RE.test(input.source) ? input.source : 'decoder',
      via: input.via,
      at: this.deps.wallNow() - Math.max(0, this.deps.now() - input.onsetLocal),
      status: 'sending',
      words: 'Sending',
      outcome: null,
      idReplaced: input.idReplaced === true,
      errorText: null,
    };
    this.push(entry);

    const sent = sendWithResend(
      () => this.deps.send(buildGestureArgs(input, gestureId, heard, digest, this.deps.now(), this.deps.oneWayMs())),
      {
        maxAgeMs: resendWindowMs(input.command),
        startedAt: input.onsetLocal,
        waitForLive: (ms) => this.deps.waitForLive(ms),
        now: () => this.deps.now(),
        sleep: this.deps.sleep,
      },
    );
    sent.then(
      () => this.awaitOutcome(gestureId).then((outcome) => this.settle(gestureId, outcome, rank)),
      (error: unknown) => this.failed(gestureId, error),
    );
    return true;
  }

  /** Every `my_session` update: the newest gesture's id and outcome. */
  noteOutcome(gestureId: string, outcome: string): void {
    if (gestureId === '' || outcome === '') return;
    this.seen.set(gestureId, outcome);
    if (this.seen.size > 200) this.seen.delete(this.seen.keys().next().value as string);
    const waiter = this.waiting.get(gestureId);
    if (waiter) {
      this.clearTimer(waiter.timer);
      this.waiting.delete(gestureId);
      waiter.resolve(outcome);
    }
  }

  private awaitOutcome(gestureId: string): Promise<string | null> {
    const known = this.seen.get(gestureId);
    if (known !== undefined) return Promise.resolve(known);
    return new Promise((resolve) => {
      const timer = this.setTimer(() => {
        this.waiting.delete(gestureId);
        resolve(null);
      }, OUTCOME_WAIT_MS);
      this.waiting.set(gestureId, { resolve, timer });
    });
  }

  private settle(gestureId: string, outcome: string | null, rank: number | null): void {
    if (outcome === null) {
      this.update(gestureId, { status: 'unknown', words: 'Sent. The outcome was not seen' });
      return;
    }
    const accepted = outcome.startsWith('accepted:');
    this.update(gestureId, { status: accepted ? 'accepted' : 'ignored', words: outcomeWords(outcome, rank), outcome });
    const feedback = outcomeFeedback(outcome);
    if (feedback) this.deps.feedback(feedback);
  }

  private failed(gestureId: string, error: unknown): void {
    const kind = callErrorKind(error);
    const text = callErrorText(error);
    if (kind === 'disconnected' || kind === 'unknown_result') {
      this.update(gestureId, { status: 'not_sent', words: 'Not sent: connection', errorText: text });
      return;
    }
    this.update(gestureId, { status: 'refused', words: `Refused: ${text}`, errorText: text });
    if (
      isSenderMessage(error, SENDER_MESSAGES.notAllowed) ||
      isSenderMessage(error, SENDER_MESSAGES.notSessionStation) ||
      isSenderMessage(error, SENDER_MESSAGES.noActiveSession)
    ) {
      this.deps.sessionRefused?.(error);
    }
  }

  private push(entry: CommandEntry): void {
    this.list = [entry, ...this.list].slice(0, COMMAND_LIST_SIZE);
    this.deps.onChange?.();
  }

  private update(gestureId: string, patch: Partial<CommandEntry>): void {
    let changed = false;
    this.list = this.list.map((entry) => {
      if (entry.gestureId !== gestureId) return entry;
      changed = true;
      return { ...entry, ...patch };
    });
    if (changed) this.deps.onChange?.();
  }
}
