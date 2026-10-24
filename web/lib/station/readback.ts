/**
 * Read-backs, `report_readback_done` and the confirm window (docs/station.md 2.11).
 *
 * 1. Start when `my_session.errand` is Previewed with a 16-hex `preview_digest` and a read-back text, or when
 *    `my_session.call` is Prepared with `script_digest` and a text, and this page has not finished that read-back.
 *    One at a time; an errand comes before a call, as in the module.
 * 2. Say it in the assistant voice with the mode's confirm sentence on the end, on the options channel.
 * 3. Stop it at once, and report nothing, when the errand or call leaves Previewed or Prepared, a pause cue arrives,
 *    or the session ends.
 * 4. Done only when playback ends on its own: record the digest (CONFIRM carries it), then call
 *    `report_readback_done`. A read-back that was cut off never records a digest, so CONFIRM fails closed.
 * 5. `quiet_hold_ms` after the report resolved: the "window open" chime and the countdown bar. Starting from the
 *    server's commit means the chime never comes before the real opening. An early CONFIRM restarts the hold in the
 *    module; when `confirm_opens_at` changes, the chime and bar restart from that update's arrival.
 * 6. A read-back longer than the time left before `readback_deadline_ms` is not started: "That request is too long to
 *    read back. Nothing will be sent." and the module's timer stops it.
 */
import { callErrorKind, callErrorText, sendWithResend } from '../role/calls';
import type { InputMode } from '../role/storage';
import type { ChimeName } from '../voice/audio';
import { readbackKey } from './commands';
import type { Channel, ClipLike, SynthJob } from './earpiece';
import { phraseText } from './phrases';

/** What a read-back says: the Actor's text, then "To send it, {act}. To cancel, do nothing." for the input mode. */
export function readbackSegments(text: string, mode: InputMode): [string, string] {
  return [text, phraseText('confirmTail', mode)];
}

/** `my_session.errand` or `.call`, reduced. `status` is the binding's tag. */
export interface WorkLite {
  kind: 'errand' | 'call';
  id: bigint;
  status: string;
  readBackText: string;
  /** `preview_digest` for an errand, `script_digest` for a call. */
  digest: string;
  confirmOpensAt: bigint | null;
  confirmClosesAt: bigint | null;
  reasonCode: string;
  reason: string;
}

const ERRAND_DIGEST_RE = /^[0-9a-f]{16}$/;

/** The work whose read-back should play now: the errand first, then the call (docs/station.md 2.11 step 1). */
export function readbackCandidate(errand: WorkLite | null, call: WorkLite | null): WorkLite | null {
  if (errand && errand.status === 'Previewed' && ERRAND_DIGEST_RE.test(errand.digest) && errand.readBackText.trim() !== '') return errand;
  if (call && call.status === 'Prepared' && call.digest.trim() !== '' && call.readBackText.trim() !== '') return call;
  return null;
}

/** The status in which a read-back plays: Previewed for an errand, Prepared for a call. */
export function readbackStatus(kind: 'errand' | 'call'): string {
  return kind === 'errand' ? 'Previewed' : 'Prepared';
}

export type ReadbackPhase =
  | 'idle'
  /** Synthesizing the read-back. */
  | 'preparing'
  | 'playing'
  /** Played to the end; `report_readback_done` is on its way. */
  | 'reporting'
  /** Reported; waiting `quiet_hold_ms` before the window chime. */
  | 'hold'
  /** The confirm window is open. */
  | 'window'
  | 'too_long'
  | 'late'
  | 'failed';

export interface ReadbackState {
  phase: ReadbackPhase;
  kind: 'errand' | 'call' | null;
  id: bigint | null;
  /** When the window opened locally, on the station clock. */
  windowStartedAt: number | null;
  windowMs: number;
  /** One sentence for the screen, or null. */
  message: string | null;
}

export interface ReadbackTiming {
  readbackDeadlineMs: number;
  quietHoldMs: number;
  confirmWindowMs: number;
}

export interface ReadbackDeps<Clip extends ClipLike = ClipLike> {
  now(): number;
  /** The read-back utterance: the text, then the mode's confirm sentence, in the assistant voice. */
  synth(text: string): SynthJob<Clip>;
  channel: Channel<Clip>;
  report(args: { kind: 'errand' | 'call'; id: bigint; digest: string }): Promise<void>;
  waitForLive(timeoutMs: number): Promise<boolean>;
  chime(name: ChimeName): void;
  timing(): ReadbackTiming;
  /** Say "That request is too long to read back. Nothing will be sent." */
  sayTooLong(): void;
  /** The errand or call was stopped because a new question came in: say "A new question came in. Nothing was sent." */
  sayInterrupted?(): void;
  onVoiceError?(error: unknown): void;
  onChange?(): void;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  sleep?(ms: number): Promise<void>;
}

/** The window's length from the row's own opening and closing times (a duration, never a clock difference), else the config. */
export function windowLength(work: Pick<WorkLite, 'confirmOpensAt' | 'confirmClosesAt'>, fallbackMs: number): number {
  const opens = work.confirmOpensAt;
  const closes = work.confirmClosesAt;
  return opens !== null && closes !== null && closes > opens ? Number((closes - opens) / 1000n) : fallbackMs;
}

/** report_readback_done is retried after a disconnect for this long. */
export const READBACK_REPORT_RESEND_MS = 30_000;

interface Active<Clip extends ClipLike> {
  work: WorkLite;
  arrival: number;
  job: SynthJob<Clip> | null;
  opensAt: bigint | null;
}

export class Readback<Clip extends ClipLike = ClipLike> {
  /** readbackKey -> the digest of the read-back this station finished playing. */
  readonly played = new Map<string, string>();
  private readonly finished = new Set<string>();
  private readonly seenAt = new Map<string, number>();
  private readonly announced = new Set<string>();
  private active: Active<Clip> | null = null;
  private holdTimer: unknown = null;
  private state: ReadbackState = { phase: 'idle', kind: null, id: null, windowStartedAt: null, windowMs: 0, message: null };
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: ReadbackDeps<Clip>) {
    this.setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  getState(): ReadbackState {
    return this.state;
  }

  /** Every `my_session` change: the errand and call as they are now, and when the update arrived. */
  update(errand: WorkLite | null, call: WorkLite | null, arrival: number): void {
    for (const work of [errand, call]) {
      if (!work) continue;
      if (work.status === readbackStatus(work.kind)) {
        const seen = `${readbackKey(work.kind, work.id)}:${work.digest}`;
        if (!this.seenAt.has(seen)) this.seenAt.set(seen, arrival);
      }
      if (work.status === 'Stopped' && work.reasonCode === 'interrupted') {
        const k = readbackKey(work.kind, work.id);
        if (!this.announced.has(k)) {
          this.announced.add(k);
          this.deps.sayInterrupted?.();
        }
      }
    }

    const active = this.active;
    if (active) {
      const now = active.work.kind === 'errand' ? errand : call;
      const same = now !== null && now.id === active.work.id;
      const phase = this.state.phase;
      if (phase === 'preparing' || phase === 'playing') {
        if (!same || now.status !== readbackStatus(now.kind) || now.digest !== active.work.digest) this.stop();
      } else if (phase === 'reporting' || phase === 'hold' || phase === 'window') {
        const replaced = same && now.status === readbackStatus(now.kind) && now.digest !== active.work.digest;
        if (!same || replaced || (now.status !== 'AwaitingConfirm' && now.status !== readbackStatus(now.kind))) {
          this.clearHold();
          this.active = null;
          this.set({ phase: 'idle', kind: null, id: null, windowStartedAt: null, message: null });
        } else if (now.status === 'AwaitingConfirm' && phase !== 'reporting' && active.opensAt !== null && now.confirmOpensAt !== active.opensAt) {
          // An early CONFIRM restarted the module's quiet hold: restart the chime and the bar from this arrival.
          active.opensAt = now.confirmOpensAt;
          active.work = now;
          this.hold(arrival);
        } else if (now.status === 'AwaitingConfirm') {
          active.opensAt = now.confirmOpensAt;
          active.work = now;
          if (phase !== 'reporting') this.set({ windowMs: windowLength(now, this.deps.timing().confirmWindowMs) });
        }
      }
    }

    if (this.active) return;
    const next = readbackCandidate(errand, call);
    if (!next || this.finished.has(this.finishKey(next))) return;
    this.begin(next);
  }

  /** A pause cue, a safety cue or the session ending: stop at once and report nothing. */
  stop(): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    this.clearHold();
    active.job?.cancel();
    this.deps.channel.stop(['readback']);
    this.set({ phase: 'idle', kind: null, id: null, windowStartedAt: null, message: null });
  }

  /** A new session: forget everything that belonged to the old one. */
  reset(): void {
    this.stop();
    this.played.clear();
    this.finished.clear();
    this.seenAt.clear();
    this.announced.clear();
  }

  private finishKey(work: WorkLite): string {
    return `${readbackKey(work.kind, work.id)}:${work.digest}`;
  }

  private begin(work: WorkLite): void {
    const k = readbackKey(work.kind, work.id);
    // A digest from an older read-back of this errand or call no longer matches what will be heard.
    if (this.played.get(k) !== work.digest) this.played.delete(k);
    const arrival = this.seenAt.get(this.finishKey(work)) ?? this.deps.now();
    let job: SynthJob<Clip>;
    try {
      job = this.deps.synth(work.readBackText);
    } catch (error) {
      this.finished.add(this.finishKey(work));
      this.set({ phase: 'failed', kind: work.kind, id: work.id, message: 'Could not voice the read-back. Nothing will be sent.' });
      this.deps.onVoiceError?.(error);
      return;
    }
    const active: Active<Clip> = { work, arrival, job, opensAt: null };
    this.active = active;
    this.set({ phase: 'preparing', kind: work.kind, id: work.id, windowStartedAt: null, message: null });
    job.done.then(
      (clip) => this.ready(active, clip),
      (error: unknown) => {
        if (this.active !== active) return;
        this.active = null;
        if (error instanceof Error && error.name === 'TtsCancelled') {
          this.set({ phase: 'idle', kind: null, id: null, message: null });
          return;
        }
        this.finished.add(this.finishKey(work));
        this.set({ phase: 'failed', message: 'Could not voice the read-back. Nothing will be sent.' });
        this.deps.onVoiceError?.(error);
      },
    );
  }

  private ready(active: Active<Clip>, clip: Clip): void {
    if (this.active !== active) return;
    active.job = null;
    const { readbackDeadlineMs } = this.deps.timing();
    const left = readbackDeadlineMs - (this.deps.now() - active.arrival);
    if (clip.durationMs > left) {
      this.active = null;
      this.finished.add(this.finishKey(active.work));
      this.set({ phase: 'too_long', message: 'The read-back is too long for the time left. Nothing will be sent.' });
      this.deps.sayTooLong();
      return;
    }
    this.set({ phase: 'playing' });
    this.deps.channel.play(clip, 'readback').then(
      (how) => {
        if (this.active !== active) return;
        if (how !== 'ended') {
          // Cut off: no digest, no report. A later update may start it again if it is still waiting.
          this.active = null;
          this.set({ phase: 'idle', kind: null, id: null, message: null });
          return;
        }
        this.ended(active);
      },
      () => {
        if (this.active !== active) return;
        this.active = null;
        this.set({ phase: 'failed', message: 'Could not play the read-back. Nothing will be sent.' });
      },
    );
  }

  private ended(active: Active<Clip>): void {
    const work = active.work;
    this.played.set(readbackKey(work.kind, work.id), work.digest);
    this.finished.add(this.finishKey(work));
    this.set({ phase: 'reporting' });
    sendWithResend(() => this.deps.report({ kind: work.kind, id: work.id, digest: work.digest }), {
      maxAgeMs: READBACK_REPORT_RESEND_MS,
      waitForLive: (ms) => this.deps.waitForLive(ms),
      now: () => this.deps.now(),
      sleep: this.deps.sleep,
    }).then(
      () => {
        if (this.active !== active) return;
        this.hold(this.deps.now());
      },
      (error: unknown) => {
        if (this.active !== active) return;
        this.active = null;
        const text = callErrorText(error);
        const kind = callErrorKind(error);
        let message: string | null = null;
        let phase: ReadbackPhase = 'idle';
        if (kind === 'sender' && text.startsWith('read-back deadline passed')) {
          phase = 'late';
          message = 'The read-back took too long.';
        } else if (kind === 'sender' && (text.startsWith('digest mismatch') || text.includes('not waiting for a read-back'))) {
          message = null;
        } else if (kind === 'disconnected' || kind === 'unknown_result') {
          message = 'Could not report the read-back: connection.';
        } else {
          message = `The read-back report was refused: ${text}`;
        }
        this.set({ phase, message });
      },
    );
  }

  /** The quiet hold, then the window chime and the countdown, from `from` on the station clock. */
  private hold(from: number): void {
    const active = this.active;
    if (!active) return;
    this.clearHold();
    const { quietHoldMs, confirmWindowMs } = this.deps.timing();
    this.set({ phase: 'hold', windowStartedAt: null, windowMs: windowLength(active.work, confirmWindowMs) });
    const wait = Math.max(0, from + quietHoldMs - this.deps.now());
    this.holdTimer = this.setTimer(() => {
      this.holdTimer = null;
      if (this.active !== active) return;
      this.deps.chime('windowOpen');
      this.set({ phase: 'window', windowStartedAt: this.deps.now() });
    }, wait);
  }

  private clearHold(): void {
    if (this.holdTimer !== null) this.clearTimer(this.holdTimer);
    this.holdTimer = null;
  }

  private set(patch: Partial<ReadbackState>): void {
    this.state = { ...this.state, ...patch };
    this.deps.onChange?.();
  }
}
