/**
 * Cues: what the wearer hears when the module emits a `cue_event` (docs/station.md 2.13 and 2.14).
 *
 * `cue_event` rows are broadcast and never stored, so only `onInsert` fires, and only rows of the active session
 * count. The station reads them after the whole transaction applied (the same update's `scan_state` decides between a
 * chime and a sentence). Priorities:
 *   1. Safety cues interrupt everything: stop the options channel (options, prompts, read-backs) and the phrase
 *      channel, then speak.
 *   2. A read-back is never interrupted except by a safety cue or by its own errand or call leaving Previewed or
 *      Prepared.
 *   3. Mid-scan cues are chimes, not speech: the next option starts in the same transaction.
 *   4. Info phrases play on the phrase channel only while the options channel is silent; one older than 3 s when the
 *      earpiece frees up is dropped.
 */
import type { InputMode } from '../role/storage';
import type { ChimeName } from '../voice/audio';
import type { Channel, ClipLike } from './earpiece';
import type { HeardPhase } from './heard';
import { inputOffPhrase, type PhraseKey } from './phrases';

/** A `cue_event` row, reduced. Ids are 0 when the cue has none. */
export interface CueLite {
  sessionId: bigint;
  kind: string;
  reason: string;
  questionId: bigint;
  optionId: bigint;
  errandId: bigint;
  callId: bigint;
}

export type CueAction =
  | { type: 'safety'; phrase: PhraseKey }
  | { type: 'info'; phrase: PhraseKey }
  /** A reason sentence from the errand or call row, synthesized on demand (Actor sentences are written to be spoken). */
  | { type: 'info_text'; text: string; fallback: PhraseKey }
  | { type: 'chime'; chime: ChimeName }
  | { type: 'none' };

export interface CueContext {
  mode: InputMode;
  /** The scan's phase after the cue's transaction applied, or null with no scan. */
  phase: HeardPhase | null;
  /** A read-back is being prepared or played. */
  readbackActive: boolean;
  /** `my_session.errand.reason` and `.call.reason`: sentences the module may store with a refusal. */
  errandReason: string;
  callReason: string;
}

const PAUSE_PHRASE: Readonly<Record<string, PhraseKey>> = {
  stop: 'paused',
  idle: 'pausedIdle',
  operator: 'pausedHelper',
  headset_lost: 'signalLost',
};

/** The earpiece's answer to one cue (docs/station.md 2.13, every kind the module emits). */
export function cueAction(cue: Pick<CueLite, 'kind' | 'reason' | 'callId'>, ctx: CueContext): CueAction {
  switch (cue.kind) {
    case 'paused':
      if (cue.reason === 'headset_off') return { type: 'safety', phrase: inputOffPhrase(ctx.mode) };
      return { type: 'safety', phrase: PAUSE_PHRASE[cue.reason] ?? 'paused' };
    case 'call_cancelling':
      return { type: 'safety', phrase: 'hangingUp' };
    case 'too_late':
      return { type: 'safety', phrase: 'tooLate' };
    case 'resumed':
      return ctx.phase === 'idle' || ctx.phase === null ? { type: 'info', phrase: 'resumed' } : { type: 'chime', chime: 'on' };
    case 'again':
    case 'more_options':
    case 'menu_open':
      return { type: 'chime', chime: 'on' };
    case 'picked':
      return { type: 'chime', chime: 'counted' };
    case 'veto_cancelled':
      return ctx.phase === 'idle' || ctx.phase === null ? { type: 'info', phrase: 'cancelled' } : { type: 'chime', chime: 'off' };
    case 'reply_released':
      return { type: 'none' };
    case 'none':
      return { type: 'info', phrase: 'noneOfThese' };
    case 'no_pick':
      return { type: 'info', phrase: 'noPick' };
    case 'not_ready':
      return { type: 'info', phrase: 'oneMoment' };
    case 'say_confirm':
      return ctx.readbackActive ? { type: 'none' } : { type: 'info', phrase: 'sayConfirm' };
    case 'confirmed':
      return { type: 'info', phrase: 'confirmed' };
    case 'errand_preparing':
      return { type: 'info', phrase: 'preparing' };
    case 'errand_sent':
      return { type: 'info', phrase: 'sent' };
    case 'errand_unknown':
      return { type: 'info', phrase: 'unknownOutcome' };
    case 'not_sent':
      if (cue.reason === 'window_closed') return { type: 'info', phrase: 'windowClosed' };
      if (cue.reason === 'readback_not_finished') return { type: 'info', phrase: 'readbackLate' };
      return { type: 'info', phrase: cue.callId !== 0n ? 'noCall' : 'notSent' };
    case 'errand_refused':
    case 'errand_failed':
      return ctx.errandReason.trim() !== '' ? { type: 'info_text', text: ctx.errandReason, fallback: 'notSent' } : { type: 'info', phrase: 'notSent' };
    case 'call_refused':
      return ctx.callReason.trim() !== '' ? { type: 'info_text', text: ctx.callReason, fallback: 'noCall' } : { type: 'info', phrase: 'noCall' };
    case 'call_ended':
      return { type: 'info', phrase: 'callEnded' };
    case 'question_waiting':
      return { type: 'info', phrase: 'questionWaiting' };
    case 'failed':
      return { type: 'info', phrase: 'noOptions' };
    default:
      return { type: 'none' };
  }
}

/** An info phrase that waited longer than this for the earpiece is dropped. */
export const INFO_MAX_WAIT_MS = 3_000;
/** How often a waiting info phrase looks whether the earpiece is free. */
export const INFO_POLL_MS = 100;

export interface CueSpeakerDeps<Clip extends ClipLike = ClipLike> {
  now(): number;
  phrase(key: PhraseKey): Promise<Clip>;
  text(text: string): Promise<Clip>;
  options: Channel<Clip>;
  prompts: Channel<Clip>;
  chime(name: ChimeName): void;
  /** Stop a read-back without reporting it. */
  stopReadback(): void;
  /** Forget a late option clip, so it does not start after the safety sentence. */
  stopOptions(): void;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

type Spoken = { phrase: PhraseKey } | { text: string; fallback: PhraseKey };

/** Plays cue actions and the station's own sentences with the priorities above. */
export class CueSpeaker<Clip extends ClipLike = ClipLike> {
  private queue: Array<{ spoken: Spoken; at: number }> = [];
  private timer: unknown = null;
  /** Bumped by each safety sentence, so an older one that finishes synthesizing late does not play. */
  private safetySeq = 0;
  /** An info sentence is being voiced or played. */
  private speaking = false;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: CueSpeakerDeps<Clip>) {
    this.setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  handle(action: CueAction): void {
    switch (action.type) {
      case 'safety':
        this.safety(action.phrase);
        return;
      case 'info':
        this.info({ phrase: action.phrase });
        return;
      case 'info_text':
        this.info({ text: action.text, fallback: action.fallback });
        return;
      case 'chime':
        this.deps.chime(action.chime);
        return;
      case 'none':
        return;
    }
  }

  /** Stop everything, then say it (docs/station.md 2.13 rule 1). */
  safety(phrase: PhraseKey): void {
    const seq = ++this.safetySeq;
    this.queue = [];
    this.deps.stopReadback();
    this.deps.stopOptions();
    this.deps.options.stop();
    this.deps.prompts.stop();
    this.deps.phrase(phrase).then(
      (clip) => {
        if (seq !== this.safetySeq) return;
        void this.deps.prompts.play(clip, 'phrase').catch(() => {});
      },
      (error: unknown) => console.error('Eleven: a safety sentence could not be voiced', error),
    );
  }

  /** Say it once the earpiece is free, or drop it after 3 s (rule 4). */
  info(spoken: Spoken): void {
    this.queue.push({ spoken, at: this.deps.now() });
    this.drain();
  }

  /** Waiting info phrases, for tests. */
  waiting(): number {
    return this.queue.length;
  }

  clear(): void {
    this.queue = [];
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private drain(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    const now = this.deps.now();
    if (!this.speaking && !this.deps.options.busy() && !this.deps.prompts.busy()) {
      while (this.queue.length > 0) {
        const next = this.queue.shift()!;
        if (now - next.at > INFO_MAX_WAIT_MS) continue;
        this.say(next.spoken);
        break;
      }
    }
    if (this.queue.length > 0) this.timer = this.setTimer(() => this.drain(), INFO_POLL_MS);
  }

  private say(spoken: Spoken): void {
    const seq = this.safetySeq;
    this.speaking = true;
    const done = () => {
      this.speaking = false;
      if (this.queue.length > 0) this.drain();
    };
    const clip = 'phrase' in spoken ? this.deps.phrase(spoken.phrase) : this.deps.text(spoken.text).catch(() => this.deps.phrase(spoken.fallback));
    clip.then(
      (c) => {
        // A safety sentence or a new read took the earpiece meanwhile: this sentence is dropped rather than cut in.
        if (seq !== this.safetySeq || this.deps.options.busy()) {
          done();
          return;
        }
        this.deps.prompts.play(c, 'phrase').then(done, done);
      },
      (error: unknown) => {
        console.error('Eleven: a sentence could not be voiced', error);
        done();
      },
    );
  }
}
