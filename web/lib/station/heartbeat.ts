/**
 * The station's heartbeat (docs/station.md 2.3 and 2.8): `heartbeat(beat_seq, decoder_healthy)` every
 * `config.heartbeat_ms` (500 by default) while this station owns the active session and its earpiece runs.
 *
 * - `decoder_healthy` means "the person's input path is live" for the session's mode:
 *     headset    the decoder socket is open, its last health message is at most 500 ms old, and it said true
 *     keyboard   the page is visible
 *     switch     the page is visible and focused; a focus loss counts only after 2 s
 * - Ticks come from a Web Worker, because Chrome slows main-thread timers in hidden or covered windows (UNTESTED,
 *   docs/station.md 5.2); `setInterval` is the fallback.
 * - `beat_seq` starts at `Date.now()` when the page loads and adds 1 per beat, so it keeps rising across reloads.
 * - A change from healthy to not healthy sends one extra beat at once instead of waiting for the next tick.
 * - Beats are skipped, never queued, while the connection is down. They stop when a beat is refused with
 *   `not the session station`, `no active session` or `not allowed`; when the earpiece stops running the station
 *   stops beating, the lease lapses and the module pauses (HeadsetLost): the safe outcome.
 * - Each beat is timed from the call to its answer; the median of the last 20 is the round trip, and half of it is
 *   the one-way estimate added to every command's onset age. A beat with no answer after 3 s marks a problem.
 */
import { callErrorKind, isSenderMessage, SENDER_MESSAGES } from '../role/calls';
import type { InputMode } from '../role/storage';

/** A focus loss in switch mode counts only after this long (a click elsewhere and straight back is not "input off"). */
export const FOCUS_GRACE_MS = 2_000;
/** A beat with no answer after this long marks "Connection problem". */
export const BEAT_ANSWER_TIMEOUT_MS = 3_000;
/** The round trip is the median of this many beats. */
export const RTT_SAMPLES = 20;
/** `config.heartbeat_ms` allows 200 to 2000. */
export const HEARTBEAT_RANGE = { min: 200, max: 2_000, fallback: 500 } as const;

export interface InputHealthInputs {
  mode: InputMode;
  /** The decoder bridge's `healthyNow()`. */
  decoderHealthy: boolean;
  /** `document.visibilityState === 'visible'`. */
  visible: boolean;
  /** `document.hasFocus()`. */
  focused: boolean;
  /** When the window last lost focus, on the station clock; null while focused. */
  blurredAt: number | null;
  now: number;
}

/** The `decoder_healthy` value for the session's input mode (docs/station.md 2.3). */
export function inputHealthy(inputs: InputHealthInputs): boolean {
  switch (inputs.mode) {
    case 'headset':
      return inputs.decoderHealthy;
    case 'keyboard':
      return inputs.visible;
    case 'switch':
      if (!inputs.visible) return false;
      if (inputs.focused) return true;
      return inputs.blurredAt !== null && inputs.now - inputs.blurredAt < FOCUS_GRACE_MS;
  }
}

/** `config.heartbeat_ms`, kept inside the module's allowed range. */
export function heartbeatInterval(ms: number | null | undefined): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return HEARTBEAT_RANGE.fallback;
  return Math.min(HEARTBEAT_RANGE.max, Math.max(HEARTBEAT_RANGE.min, Math.round(ms)));
}

export function firstBeatSeq(wallNow: number = Date.now()): bigint {
  return BigInt(Math.max(0, Math.floor(wallNow)));
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ---------- The tick ----------

export interface Ticker {
  start(intervalMs: number, onTick: () => void): void;
  stop(): void;
}

/** The worker's whole program: post a tick every N ms; a message re-arms it, 0 stops it. */
export const TICK_WORKER_SOURCE =
  'let t = null; self.onmessage = (e) => { if (t !== null) clearInterval(t); t = null; const ms = Number(e.data); if (ms > 0) t = setInterval(() => self.postMessage(0), ms); };';

/** A ticker on `setInterval`, for tests and for browsers without workers. */
export function intervalTicker(): Ticker {
  let handle: ReturnType<typeof setInterval> | null = null;
  return {
    start(intervalMs, onTick) {
      if (handle !== null) clearInterval(handle);
      handle = setInterval(onTick, intervalMs);
    },
    stop() {
      if (handle !== null) clearInterval(handle);
      handle = null;
    },
  };
}

/**
 * A ticker on a dedicated Web Worker made from a Blob, so no bundler setting is involved. Falls back to
 * `setInterval` when the browser refuses the worker.
 */
export function workerTicker(): Ticker {
  let worker: Worker | null = null;
  let url: string | null = null;
  const fallback = intervalTicker();
  let usingFallback = false;
  const stopWorker = () => {
    if (worker) {
      worker.onmessage = null;
      worker.terminate();
    }
    worker = null;
    if (url) URL.revokeObjectURL(url);
    url = null;
  };
  return {
    start(intervalMs, onTick) {
      stopWorker();
      fallback.stop();
      usingFallback = false;
      try {
        if (typeof Worker !== 'function' || typeof Blob !== 'function') throw new Error('No workers here.');
        url = URL.createObjectURL(new Blob([TICK_WORKER_SOURCE], { type: 'text/javascript' }));
        worker = new Worker(url);
        worker.onmessage = () => onTick();
        worker.postMessage(intervalMs);
      } catch {
        stopWorker();
        usingFallback = true;
        fallback.start(intervalMs, onTick);
      }
    },
    stop() {
      stopWorker();
      if (usingFallback) fallback.stop();
      usingFallback = false;
    },
  };
}

// ---------- The beats ----------

export interface HeartbeatDeps {
  send(beatSeq: bigint, decoderHealthy: boolean): Promise<void>;
  /** `decoder_healthy` right now. */
  healthy(): boolean;
  /** The connection is live, this station owns (or is claiming) the session, and the earpiece runs (or silent mode). */
  canBeat(): boolean;
  ticker: Ticker;
  /** The station clock (performance.now). */
  now(): number;
  /** Defaults to `Date.now()` at creation. */
  firstSeq?: bigint;
  /** A beat answered: the station owns the session. */
  onBeatOk?(): void;
  /** A beat was refused with one of the three session refusals; beating has stopped. */
  onRefused?(error: unknown): void;
  onChange?(): void;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export interface HeartbeatState {
  armed: boolean;
  intervalMs: number;
  beats: number;
  /** The `decoder_healthy` value of the newest beat sent. */
  lastHealthy: boolean | null;
  /** When a beat was last answered, on the station clock. */
  lastOkAt: number | null;
  /** A beat went unanswered for 3 s. */
  problem: boolean;
  rttMedianMs: number | null;
  /** The refusal that stopped the beats, for the screen. */
  refusedText: string | null;
}

export class Heartbeat {
  private seq: bigint;
  private samples: number[] = [];
  private outstanding = new Map<bigint, unknown>();
  private lastInputHealthy: boolean | null = null;
  private current: HeartbeatState;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: HeartbeatDeps) {
    this.seq = deps.firstSeq ?? firstBeatSeq();
    this.setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.current = {
      armed: false,
      intervalMs: HEARTBEAT_RANGE.fallback,
      beats: 0,
      lastHealthy: null,
      lastOkAt: null,
      problem: false,
      rttMedianMs: null,
      refusedText: null,
    };
  }

  getState(): HeartbeatState {
    return this.current;
  }

  /** The next `beat_seq` (for tests and the screen). */
  nextSeq(): bigint {
    return this.seq;
  }

  /** Start ticking every `intervalMs` (re-arm when `config.heartbeat_ms` changes). */
  arm(intervalMs: number): void {
    const ms = heartbeatInterval(intervalMs);
    if (this.current.armed && this.current.intervalMs === ms) return;
    this.deps.ticker.start(ms, () => this.beat());
    this.set({ armed: true, intervalMs: ms, refusedText: null });
  }

  disarm(): void {
    if (!this.current.armed) return;
    this.deps.ticker.stop();
    for (const timer of this.outstanding.values()) this.clearTimer(timer);
    this.outstanding.clear();
    this.lastInputHealthy = null;
    this.set({ armed: false, problem: false });
  }

  /** One beat now, if beating is allowed (the first beat after Start session or Continue, and every tick). */
  beat(): boolean {
    if (!this.deps.canBeat()) return false;
    const healthy = this.deps.healthy();
    this.lastInputHealthy = healthy;
    const seq = this.seq;
    this.seq += 1n;
    const sentAt = this.deps.now();
    const timer = this.setTimer(() => {
      if (this.outstanding.has(seq)) this.set({ problem: true });
    }, BEAT_ANSWER_TIMEOUT_MS);
    this.outstanding.set(seq, timer);
    this.set({ beats: this.current.beats + 1, lastHealthy: healthy });
    let call: Promise<void>;
    try {
      call = this.deps.send(seq, healthy);
    } catch (error) {
      call = Promise.reject(error);
    }
    call.then(
      () => this.answered(seq, sentAt),
      (error: unknown) => this.refused(seq, error),
    );
    return true;
  }

  /** The input may have changed (a decoder message, a socket close, visibility, focus). Healthy to not: one beat now. */
  inputChanged(): boolean {
    const healthy = this.deps.healthy();
    const was = this.lastInputHealthy;
    if (was === true && !healthy && this.current.armed) return this.beat();
    if (was !== null) this.lastInputHealthy = healthy;
    return false;
  }

  /** Half the median round trip, or 0 before any beat was answered. */
  oneWayMs(): number {
    const rtt = this.current.rttMedianMs;
    return rtt === null ? 0 : rtt / 2;
  }

  private answered(seq: bigint, sentAt: number): void {
    const timer = this.outstanding.get(seq);
    if (timer !== undefined) this.clearTimer(timer);
    this.outstanding.delete(seq);
    this.samples.push(Math.max(0, this.deps.now() - sentAt));
    if (this.samples.length > RTT_SAMPLES) this.samples.shift();
    this.set({ lastOkAt: this.deps.now(), problem: this.outstanding.size > 0 && this.current.problem, rttMedianMs: median(this.samples) });
    this.deps.onBeatOk?.();
  }

  private refused(seq: bigint, error: unknown): void {
    const timer = this.outstanding.get(seq);
    if (timer !== undefined) this.clearTimer(timer);
    this.outstanding.delete(seq);
    const sessionRefusal =
      isSenderMessage(error, SENDER_MESSAGES.notSessionStation) ||
      isSenderMessage(error, SENDER_MESSAGES.noActiveSession) ||
      isSenderMessage(error, SENDER_MESSAGES.notAllowed);
    if (sessionRefusal) {
      this.disarm();
      this.set({ refusedText: error instanceof Error ? error.message : String(error) });
      this.deps.onRefused?.(error);
      return;
    }
    const kind = callErrorKind(error);
    // A beat lost to the connection is skipped, never queued; the lease decides what the module does.
    if (kind !== 'disconnected' && kind !== 'unknown_result') console.error('NeuroLingo: a heartbeat failed', error);
  }

  private set(patch: Partial<HeartbeatState>): void {
    this.current = { ...this.current, ...patch };
    this.deps.onChange?.();
  }
}
