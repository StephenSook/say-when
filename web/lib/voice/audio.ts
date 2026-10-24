/**
 * Starting audio with a tap, the chimes, and watching the output (docs/station.md 2.9 "Start audio", 5.3, 5.5,
 * Appendix A; 7.2 C4).
 *
 * - Chrome starts an AudioContext only after a user gesture, so the page makes its one AudioContext inside the click
 *   or key handler of a "Start audio" button, calls `resume()`, and plays one short tick so the operator hears the
 *   earpiece. After a reload the page needs that tap again; until then the station sends no heartbeats, so the
 *   module pauses: the safe outcome. (UNTESTED in a browser: docs/station.md 5.3.)
 * - The same tap asks for a screen wake lock where the browser offers one (UNVERIFIED).
 * - When the audio devices change (an earpiece unplugged), the browser may move the sound to the laptop speakers,
 *   into the room. By default this suspends the context and asks for the tap again; the station stops beating until
 *   then. (Whether `devicechange` fires on unplug is UNTESTED: docs/station.md 5.5.)
 * - Chimes are short sine beeps at a low gain, straight into the destination, so they mix over speech instead of
 *   cutting it. Words come from Cartesia, never from here.
 */

export type AudioStartState =
  /** No AudioContext yet: the page needs a tap. */
  | 'locked'
  | 'starting'
  | 'running'
  /** The browser suspended the context (a reload, a lock screen, or Safari's interruption). Needs a tap. */
  | 'suspended'
  /** The audio devices changed. Needs a tap, after checking the earpiece. */
  | 'device_changed'
  | 'closed'
  | 'failed'
  /** This browser has no Web Audio. */
  | 'unsupported';

export type WakeLockState = 'off' | 'held' | 'refused' | 'unsupported';

export interface AudioUnlockSnapshot {
  state: AudioStartState;
  /** Raw error text, for a `title` tooltip only. */
  errorText: string | null;
  startedAt: number | null;
  deviceChangedAt: number | null;
  wakeLock: WakeLockState;
  /** (outputLatency + baseLatency) in ms when the browser gives them, else 0 (docs/station.md 2.6; UNVERIFIED values). */
  latencyMs: number;
}

/** The parts of an AudioContext this file uses, so tests can pass a fake. */
export interface UnlockContextLike {
  readonly state: string;
  readonly currentTime: number;
  readonly destination: unknown;
  readonly baseLatency?: number;
  readonly outputLatency?: number;
  onstatechange: (() => void) | null;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
  createOscillator(): OscillatorLike;
  createGain(): GainLike;
}

export interface OscillatorLike {
  type: string;
  frequency: { setValueAtTime(value: number, time: number): unknown };
  connect(destination: unknown): unknown;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface GainLike {
  gain: {
    setValueAtTime(value: number, time: number): unknown;
    linearRampToValueAtTime(value: number, time: number): unknown;
  };
  connect(destination: unknown): unknown;
}

interface WakeLockSentinelLike {
  release(): Promise<void>;
}

/** The parts of `navigator` this file uses. */
export interface NavigatorLike {
  mediaDevices?: {
    addEventListener(type: 'devicechange', listener: () => void): void;
    removeEventListener(type: 'devicechange', listener: () => void): void;
  };
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
}

export interface AudioUnlockOptions {
  /** Makes the AudioContext. Defaults to `new AudioContext()`. */
  createContext?: () => UnlockContextLike;
  navigator?: NavigatorLike | null;
  /** Ask for a screen wake lock on the tap. Default true. */
  wakeLock?: boolean;
  /** Play one tick when audio starts, so the operator hears the output. Default true. */
  tick?: boolean;
  /** What a change in audio devices does: suspend and ask for a tap (default), or only report it. */
  onDeviceChange?: 'suspend' | 'report';
  now?: () => number;
}

export interface AudioUnlock {
  getState(): AudioUnlockSnapshot;
  subscribe(listener: () => void): () => void;
  /** Call from a click or key handler. Makes or resumes the one AudioContext and plays one tick. */
  start(): Promise<AudioStartState>;
  /** The AudioContext once started, for the chimes. Null before the first tap. */
  context(): UnlockContextLike | null;
  /** The same context typed as the browser's AudioContext, for `new AudioOut(ctx)` from lib/cartesia. */
  audioContext(): AudioContext | null;
  /** True while the context runs and no device change is waiting for a tap. */
  running(): boolean;
  /** Plays a chime now, if audio runs. Returns false otherwise. */
  chime(name: ChimeName): boolean;
  close(): void;
}

// ---------- Chimes (docs/station.md Appendix A) ----------

export type ChimeName = 'yes' | 'no' | 'confirm' | 'stop' | 'counted' | 'notCounted' | 'on' | 'off' | 'windowOpen';

export interface ChimeTone {
  hz: number;
  ms: number;
  /** Gap before the next tone, in ms. */
  gapMs?: number;
}

/** Each chime as a list of tones played one after the other. */
export const CHIMES: Readonly<Record<ChimeName, readonly ChimeTone[]>> = {
  /** YES relayed */
  yes: [{ hz: 1200, ms: 40 }],
  /** NO relayed */
  no: [{ hz: 500, ms: 40 }],
  /** CONFIRM relayed: twice, 80 ms apart */
  confirm: [
    { hz: 900, ms: 40, gapMs: 80 },
    { hz: 900, ms: 40 },
  ],
  /** STOP relayed */
  stop: [{ hz: 300, ms: 250 }],
  /** A pick or an answer was accepted */
  counted: [{ hz: 1500, ms: 60 }],
  /** A command did not count (docs/station.md 2.7) */
  notCounted: [
    { hz: 250, ms: 50, gapMs: 50 },
    { hz: 250, ms: 50 },
  ],
  /** again, more_options, menu_open, resumed mid-scan */
  on: [
    { hz: 700, ms: 60 },
    { hz: 1000, ms: 60 },
  ],
  /** veto_cancelled mid-scan */
  off: [
    { hz: 1000, ms: 60 },
    { hz: 600, ms: 60 },
  ],
  /** The confirm window opened (docs/station.md 2.11) */
  windowOpen: [{ hz: 1100, ms: 80 }],
};

/** A quiet level, so a chime mixes under speech. */
export const CHIME_GAIN = 0.08;

/** Fade in and out over 5 ms, so a beep does not click. */
const RAMP_S = 0.005;

/** Schedules a chime on the context, starting `leadS` from now. Returns its length in ms. */
export function playChime(ctx: UnlockContextLike, name: ChimeName, gain = CHIME_GAIN, leadS = 0.01): number {
  let at = ctx.currentTime + leadS;
  const start = at;
  for (const tone of CHIMES[name]) {
    const seconds = tone.ms / 1000;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(tone.hz, at);
    amp.gain.setValueAtTime(0, at);
    amp.gain.linearRampToValueAtTime(gain, at + RAMP_S);
    amp.gain.setValueAtTime(gain, at + Math.max(RAMP_S, seconds - RAMP_S));
    amp.gain.linearRampToValueAtTime(0, at + seconds);
    osc.connect(amp);
    amp.connect(ctx.destination);
    osc.start(at);
    osc.stop(at + seconds);
    at += seconds + (tone.gapMs ?? 0) / 1000;
  }
  return Math.round((at - start) * 1000);
}

/** Output latency in ms from the context, 0 when the browser does not give it. */
export function contextLatencyMs(ctx: Pick<UnlockContextLike, 'baseLatency' | 'outputLatency'> | null): number {
  if (!ctx) return 0;
  const base = typeof ctx.baseLatency === 'number' && Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0;
  const output = typeof ctx.outputLatency === 'number' && Number.isFinite(ctx.outputLatency) ? ctx.outputLatency : 0;
  return Math.max(0, Math.round((base + output) * 1000));
}

function defaultCreateContext(): UnlockContextLike {
  const Ctor = (globalThis as { AudioContext?: new () => UnlockContextLike; webkitAudioContext?: new () => UnlockContextLike }).AudioContext
    ?? (globalThis as { webkitAudioContext?: new () => UnlockContextLike }).webkitAudioContext;
  if (typeof Ctor !== 'function') throw new Error('This browser has no Web Audio.');
  return new Ctor();
}

function defaultNavigator(): NavigatorLike | null {
  return typeof navigator === 'undefined' ? null : (navigator as unknown as NavigatorLike);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}

function fromContextState(state: string): AudioStartState {
  if (state === 'running') return 'running';
  if (state === 'closed') return 'closed';
  return 'suspended';
}

export function createAudioUnlock(options: AudioUnlockOptions = {}): AudioUnlock {
  const now = options.now ?? Date.now;
  const nav = options.navigator === undefined ? defaultNavigator() : options.navigator;
  const createContext = options.createContext ?? defaultCreateContext;
  const onDeviceChange = options.onDeviceChange ?? 'suspend';
  let ctx: UnlockContextLike | null = null;
  let wakeSentinel: WakeLockSentinelLike | null = null;
  let watching = false;
  let snapshot: AudioUnlockSnapshot = {
    state: 'locked',
    errorText: null,
    startedAt: null,
    deviceChangedAt: null,
    wakeLock: 'off',
    latencyMs: 0,
  };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<AudioUnlockSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of [...listeners]) listener();
  };

  const onStateChange = () => {
    if (!ctx) return;
    // A device change waits for the tap whatever the context does meanwhile; only start() clears it.
    if (snapshot.state === 'device_changed' && ctx.state !== 'closed') {
      set({ latencyMs: contextLatencyMs(ctx) });
      return;
    }
    set({ state: fromContextState(ctx.state), latencyMs: contextLatencyMs(ctx) });
  };

  const onDevices = () => {
    if (!ctx || snapshot.state === 'locked') return;
    if (onDeviceChange === 'report') {
      set({ deviceChangedAt: now() });
      return;
    }
    set({ state: 'device_changed', deviceChangedAt: now() });
    ctx.suspend().catch(() => {
      // Suspending a closed context fails; the state already says a tap is needed.
    });
  };

  const watchDevices = () => {
    if (watching || !nav?.mediaDevices) return;
    try {
      nav.mediaDevices.addEventListener('devicechange', onDevices);
      watching = true;
    } catch {
      // No device events in this browser: docs/station.md 5.5 says use a wired earpiece.
    }
  };

  const requestWakeLock = async () => {
    if (options.wakeLock === false) return;
    if (!nav?.wakeLock) {
      set({ wakeLock: 'unsupported' });
      return;
    }
    if (wakeSentinel) return;
    try {
      wakeSentinel = await nav.wakeLock.request('screen');
      set({ wakeLock: 'held' });
    } catch {
      set({ wakeLock: 'refused' });
    }
  };

  return {
    getState: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async start() {
      if (snapshot.state === 'starting') return snapshot.state;
      if (!ctx) {
        try {
          ctx = createContext();
        } catch (error) {
          set({ state: 'unsupported', errorText: errorText(error) });
          return snapshot.state;
        }
        ctx.onstatechange = onStateChange;
        watchDevices();
      }
      set({ state: 'starting', errorText: null });
      // Ask for the wake lock inside the same gesture; it does not hold up the audio.
      void requestWakeLock();
      try {
        await ctx.resume();
      } catch (error) {
        set({ state: 'failed', errorText: errorText(error) });
        return snapshot.state;
      }
      const state = fromContextState(ctx.state);
      set({ state, startedAt: state === 'running' ? now() : snapshot.startedAt, latencyMs: contextLatencyMs(ctx) });
      if (state === 'running' && options.tick !== false) {
        try {
          playChime(ctx, 'yes');
        } catch {
          // A tick that cannot play is not worth failing the start for.
        }
      }
      return snapshot.state;
    },
    context: () => ctx,
    audioContext: () => ctx as unknown as AudioContext | null,
    running: () => snapshot.state === 'running' && ctx !== null && ctx.state === 'running',
    chime(name) {
      if (!ctx || snapshot.state !== 'running' || ctx.state !== 'running') return false;
      try {
        playChime(ctx, name);
        return true;
      } catch {
        return false;
      }
    },
    close() {
      if (watching && nav?.mediaDevices) {
        try {
          nav.mediaDevices.removeEventListener('devicechange', onDevices);
        } catch {
          // Already gone.
        }
      }
      watching = false;
      const sentinel = wakeSentinel;
      wakeSentinel = null;
      if (sentinel) sentinel.release().catch(() => {});
      const old = ctx;
      ctx = null;
      if (old) {
        old.onstatechange = null;
        old.close().catch(() => {});
      }
      set({ state: 'locked', startedAt: null, wakeLock: 'off', latencyMs: 0 });
    },
  };
}
