/**
 * The Screen 1 connection to the local bridge (ws://127.0.0.1:8766 only, never 8765). It keeps the latest values in
 * plain mutable buffers that the 3D scene and the strip read inside requestAnimationFrame, and tells React only when
 * a summary changes (at most 10 times a second), as the brief asks. On close it clears everything, so a gray screen
 * never shows a frozen number, and retries after 250 ms, doubling to a 2 s cap.
 *
 * The WebSocket constructor and the timers are injectable, so tests run without a browser.
 */
import { headsetOffNow, nextBackoff, type BrainInput } from './model';
import {
  BASELINE_COMMAND,
  DEFAULT_VIZ_URL,
  MAX_FILTER_BANDS,
  filterBankFits,
  parseVizMessage,
  type FilterBand,
  type Side,
  type VizMarker,
  type VizMeta,
  type VizMi,
  type VizQuality,
  type VizSpec,
} from './protocol';

/** 20 s of 10 Hz summaries for the strip. */
export const HISTORY = 200;
export const MAX_MARKERS = 30;

function bandRings(): Float32Array[] {
  return Array.from({ length: MAX_FILTER_BANDS }, () => new Float32Array(HISTORY).fill(Number.NaN));
}

function bandValue(values: (number | null)[] | undefined, band: number): number {
  const v = values?.[band];
  return typeof v === 'number' ? v : Number.NaN;
}

/** A fixed-size history of the 10 Hz summaries, oldest first when read with `ordered`. */
export class MiHistory {
  readonly t = new Float64Array(HISTORY);
  readonly c3mu = new Float32Array(HISTORY);
  readonly c3beta = new Float32Array(HISTORY);
  readonly c4mu = new Float32Array(HISTORY);
  readonly c4beta = new Float32Array(HISTORY);
  readonly emg = new Float32Array(HISTORY);
  readonly gate = new Uint8Array(HISTORY);
  /**
   * ERD% per filter-bank band, one ring per band index (the order of meta.filterBank) for each side, written at the
   * same index as `t`. NaN where the value was null, the frame had no fb, or fb was ignored. Read with bandSeries.
   */
  readonly bandC3: Float32Array[] = bandRings();
  readonly bandC4: Float32Array[] = bandRings();
  /** Next write index. */
  head = 0;
  count = 0;
  private bands = 0;

  /** How many filter-bank bands the stored history holds: 0 until a frame with a usable fb arrives. */
  get bandCount(): number {
    return this.bands;
  }

  push(mi: VizMi): void {
    const i = this.head;
    this.t[i] = mi.t;
    this.c3mu[i] = mi.c3.mu;
    this.c3beta[i] = mi.c3.beta;
    this.c4mu[i] = mi.c4.mu;
    this.c4beta[i] = mi.c4.beta;
    this.emg[i] = mi.emg ?? Number.NaN;
    this.gate[i] = mi.emgGate ? 1 : 0;
    const fb = mi.fb;
    if (fb) this.bands = Math.min(MAX_FILTER_BANDS, fb.c3.length);
    for (let b = 0; b < MAX_FILTER_BANDS; b++) {
      this.bandC3[b][i] = bandValue(fb?.c3, b);
      this.bandC4[b][i] = bandValue(fb?.c4, b);
    }
    this.head = (i + 1) % HISTORY;
    this.count = Math.min(HISTORY, this.count + 1);
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.clearBands();
  }

  /** Forget the band rows only, for a new filter bank: old values would sit under the wrong band. */
  clearBands(): void {
    for (const ring of this.bandC3) ring.fill(Number.NaN);
    for (const ring of this.bandC4) ring.fill(Number.NaN);
    this.bands = 0;
  }

  /** Index of the k-th oldest sample still held. */
  index(k: number): number {
    return (this.head - this.count + k + HISTORY) % HISTORY;
  }

  /** One series in time order, for the charts. */
  ordered(series: Float32Array | Float64Array): number[] {
    const out: number[] = new Array(this.count);
    for (let k = 0; k < this.count; k++) out[k] = series[this.index(k)];
    return out;
  }

  /**
   * One filter-bank band at one side, oldest first: the same order and length as ordered(this.t). NaN where the value
   * was null or missing. An index outside 0..MAX_FILTER_BANDS-1 gives all NaN.
   */
  bandSeries(side: Side, index: number): number[] {
    if (!Number.isInteger(index) || index < 0 || index >= MAX_FILTER_BANDS) return new Array<number>(this.count).fill(Number.NaN);
    return this.ordered((side === 'c3' ? this.bandC3 : this.bandC4)[index]);
  }
}

/** Same bands in the same order (labels may change). */
function sameFilterBank(a: FilterBand[] | null, b: FilterBand[] | null): boolean {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((band, i) => band.id === b[i].id && band.lo === b[i].lo && band.hi === b[i].hi);
}

export interface VizState {
  connected: boolean;
  meta: VizMeta | null;
  mi: VizMi | null;
  /** Browser clock, ms. */
  miAt: number | null;
  lastAt: number | null;
  spec: VizSpec | null;
  quality: VizQuality | null;
  /** Newest last. */
  markers: VizMarker[];
  /** Browser clock (ms) when each marker arrived, same order. */
  markerAt: number[];
  history: MiHistory;
  /** Bumped on every change React should see. */
  version: number;
}

export function emptyState(): VizState {
  return {
    connected: false,
    meta: null,
    mi: null,
    miAt: null,
    lastAt: null,
    spec: null,
    quality: null,
    markers: [],
    markerAt: [],
    history: new MiHistory(),
    version: 0,
  };
}

/** What the screen rules need from the stream, at browser time `now` (ms). One place, so the words and the 3D scene agree. */
export function brainInputOf(state: VizState, now: number, idle = false): BrainInput {
  const contact = state.quality?.contact ?? null;
  return {
    connected: state.connected,
    meta: state.meta,
    mi: state.mi,
    miAt: state.miAt,
    lastAt: state.lastAt,
    now,
    contact,
    headsetOff: headsetOffNow(state.markers, state.markerAt, contact, now),
    idle,
  };
}

/** Everything the bridge told us is forgotten: used on every close. */
export function resetState(state: VizState): void {
  state.connected = false;
  state.meta = null;
  state.mi = null;
  state.miAt = null;
  state.lastAt = null;
  state.spec = null;
  state.quality = null;
  state.markers = [];
  state.markerAt = [];
  state.history.clear();
  state.version++;
}

/** Apply one text frame. Returns true when it was a message we use. */
export function applyFrame(state: VizState, raw: string, now: number): boolean {
  const msg = parseVizMessage(raw);
  if (!msg) return false;
  state.lastAt = now;
  switch (msg.type) {
    case 'viz.meta':
      if (!sameFilterBank(state.meta?.filterBank ?? null, msg.filterBank)) state.history.clearBands();
      state.meta = msg;
      break;
    case 'viz.mi': {
      // Until viz.meta arrives the numbers have no meaning on screen (source, baseline, bands unknown).
      if (!state.meta) return false;
      // fb that does not have one entry per meta.filterBank band is dropped; the rest of the frame still counts.
      const mi = msg.fb && !filterBankFits(state.meta, msg.fb) ? { ...msg, fb: null } : msg;
      state.mi = mi;
      state.miAt = now;
      state.history.push(mi);
      break;
    }
    case 'viz.spec':
      state.spec = msg;
      break;
    case 'viz.quality':
      state.quality = msg;
      break;
    case 'viz.marker':
      if (state.markers.some((m) => m.id === msg.id)) return false;
      state.markers.push(msg);
      state.markerAt.push(now);
      if (state.markers.length > MAX_MARKERS) {
        state.markers.shift();
        state.markerAt.shift();
      }
      break;
  }
  state.version++;
  return true;
}

interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  readonly readyState: number;
  send(data: string): void;
  close(): void;
}

export interface StreamDeps {
  createSocket: (url: string) => SocketLike;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
}

const OPEN = 1;

export class VizStream {
  readonly state: VizState = emptyState();
  private socket: SocketLike | null = null;
  private retryTimer: unknown = null;
  private backoff: number | null = null;
  private stopped = true;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly url: string = DEFAULT_VIZ_URL,
    private readonly deps: StreamDeps = browserDeps(),
  ) {}

  /** Called after every change React should know about. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer !== null) this.deps.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
      try {
        socket.close();
      } catch {
        // already closed
      }
    }
    resetState(this.state);
    this.emit();
  }

  /** Ask the bridge for a fresh rest baseline. False when there is no open connection. */
  recordBaseline(): boolean {
    if (!this.socket || this.socket.readyState !== OPEN) return false;
    this.socket.send(BASELINE_COMMAND);
    return true;
  }

  /** The delay the next retry will use, for tests. */
  get retryDelay(): number | null {
    return this.backoff;
  }

  private connect(): void {
    let socket: SocketLike;
    try {
      socket = this.deps.createSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.backoff = null;
      this.state.connected = true;
      this.state.version++;
      this.emit();
    };
    socket.onmessage = (ev) => {
      // Binary trace frames are a stretch goal; ignore them for now.
      if (typeof ev.data !== 'string') return;
      if (applyFrame(this.state, ev.data, this.deps.now())) this.emit();
    };
    socket.onerror = () => {
      // onclose follows and does the work.
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      resetState(this.state);
      this.emit();
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    this.backoff = nextBackoff(this.backoff);
    this.retryTimer = this.deps.setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this.connect();
    }, this.backoff);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function browserDeps(): StreamDeps {
  return {
    createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => performance.now(),
  };
}
