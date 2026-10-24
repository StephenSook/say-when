/**
 * The decoder bridge (docs/station.md 2.4): a WebSocket client to Shashank's decoder on `ws://127.0.0.1:<port>`.
 * The decoder never calls SpacetimeDB; the station relays its commands and reports its health in heartbeats.
 *
 * Contract (PLAN Shared Contracts, docs/spacetime.md Appendix A):
 *   { "type": "gesture", "id": "<uuid>", "command": "YES", "onsetAgeMs": 840, "confidence": 0.82, "source": "imagery" }
 *   { "type": "health", "decoderHealthy": true }       at least every 250 ms
 *
 * - Open in headset mode only, as soon as the page is paired, so health shows before Start session.
 * - On close or error: wait 500 ms, 1 s, 2 s, then every 2 s, for as long as headset mode lasts.
 * - Text frames only, one JSON object each. Health is fresh for 500 ms (two missed messages).
 * - A bad id gets a fresh UUID so a STOP is never lost; a bad source becomes `decoder`; a missing or negative onset
 *   age is 0; confidence is clamped to 0 to 1 (missing is 0). An unknown type is ignored and counted; a command
 *   that is not one of the five words is dropped, counted and shown as "Bad decoder message".
 * - Nothing is sent back: the contract has no ack.
 */
import { GESTURE_ID_RE, isStationCommand, SOURCE_RE, type CommandInput, type StationCommand } from './commands';

export const DECODER_HOST = '127.0.0.1';

/** Health is fresh for this long: two missed messages at the contract's 250 ms. */
export const HEALTH_FRESH_MS = 500;

/** Waits between reconnects; the last one repeats forever. */
export const DECODER_RETRY_MS: readonly number[] = [500, 1_000, 2_000];

/**
 * A socket still connecting after this long is slow. On loopback that almost always means Chrome is waiting for the
 * operator to answer its local network permission prompt: from an https page, Chrome 156 holds a ws://127.0.0.1
 * socket in CONNECTING, with no error, until someone clicks Allow (docs/station.md 5.1, run Oct 24).
 */
export const DECODER_SLOW_CONNECT_MS = 3_000;

export function decoderUrl(port: number): string {
  return `ws://${DECODER_HOST}:${port}`;
}

export type DecoderFrame =
  | { kind: 'health'; healthy: boolean }
  | {
      kind: 'gesture';
      command: StationCommand;
      /** The decoder's id, or null when it failed the module's check and a new one must be made. */
      gestureId: string | null;
      idReplaced: boolean;
      source: string;
      confidence: number;
      onsetAgeMs: number;
    }
  /** Not counted as bad: a binary frame or a message type this station does not know. */
  | { kind: 'ignored'; reason: 'binary' | 'unknown_type' }
  /** Shown as "Bad decoder message". */
  | { kind: 'bad'; reason: 'not_json' | 'bad_command' };

/** One frame from the decoder, checked against every rule of docs/station.md 2.4. Never throws. */
export function parseDecoderFrame(data: unknown): DecoderFrame {
  if (typeof data !== 'string') return { kind: 'ignored', reason: 'binary' };
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return { kind: 'bad', reason: 'not_json' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { kind: 'bad', reason: 'not_json' };
  const message = value as Record<string, unknown>;
  if (message.type === 'health') return { kind: 'health', healthy: message.decoderHealthy === true };
  if (message.type !== 'gesture') return { kind: 'ignored', reason: 'unknown_type' };
  if (!isStationCommand(message.command)) return { kind: 'bad', reason: 'bad_command' };
  const idOk = typeof message.id === 'string' && GESTURE_ID_RE.test(message.id);
  const age = typeof message.onsetAgeMs === 'number' && Number.isFinite(message.onsetAgeMs) && message.onsetAgeMs > 0 ? message.onsetAgeMs : 0;
  const confidence = typeof message.confidence === 'number' && Number.isFinite(message.confidence) ? Math.min(1, Math.max(0, message.confidence)) : 0;
  return {
    kind: 'gesture',
    command: message.command,
    gestureId: idOk ? (message.id as string) : null,
    idReplaced: !idOk,
    source: typeof message.source === 'string' && SOURCE_RE.test(message.source) ? message.source : 'decoder',
    confidence,
    onsetAgeMs: age,
  };
}

/** The parts of a browser WebSocket the bridge uses, so tests can pass a fake. */
export interface DecoderSocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

export type DecoderSocketFactory = (url: string) => DecoderSocketLike;

export type DecoderStatus = 'off' | 'connecting' | 'open' | 'closed';

/** What the screen says about the decoder (docs/station.md 2.4, "Decoder health chip"). */
export type DecoderHealthWord = 'off' | 'connecting' | 'not_found' | 'silent' | 'not_ready' | 'healthy';

export interface DecoderState {
  status: DecoderStatus;
  port: number;
  /** The last health message: what it said and when it arrived (station clock). */
  healthy: boolean | null;
  healthAt: number | null;
  badMessages: number;
  ignoredMessages: number;
  /** Commands whose decoder id was replaced; the decoder's log can no longer be matched to them. */
  idsReplaced: number;
  /** When the last bad message arrived, for a short-lived line on screen. */
  lastBadAt: number | null;
  lastIdReplacedAt: number | null;
  /** Raw error text, for a tooltip. */
  errorText: string | null;
  /** The current socket has been connecting for DECODER_SLOW_CONNECT_MS or more. */
  slowConnect: boolean;
}

export interface DecoderBridgeOptions {
  port: number;
  /** A command, with its onset on the station's clock. */
  onCommand: (input: CommandInput) => void;
  /** Any change worth redrawing: open, closed, health changed or went stale, a bad message. */
  onChange?: () => void;
  socket?: DecoderSocketFactory;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const OPEN = 1;

function defaultSocket(url: string): DecoderSocketLike {
  return new WebSocket(url) as unknown as DecoderSocketLike;
}

export class DecoderBridge {
  private state: DecoderState;
  private socket: DecoderSocketLike | null = null;
  private running = false;
  private failures = 0;
  private retryTimer: unknown = null;
  private freshTimer: unknown = null;
  private slowTimer: unknown = null;
  private lastWord: DecoderHealthWord = 'off';
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly factory: DecoderSocketFactory;

  constructor(private readonly options: DecoderBridgeOptions) {
    this.now = options.now ?? (() => performance.now());
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.factory = options.socket ?? defaultSocket;
    this.state = {
      status: 'off',
      port: options.port,
      healthy: null,
      healthAt: null,
      badMessages: 0,
      ignoredMessages: 0,
      idsReplaced: 0,
      lastBadAt: null,
      lastIdReplacedAt: null,
      errorText: null,
      slowConnect: false,
    };
  }

  getState(): DecoderState {
    return this.state;
  }

  /** Connect and keep reconnecting until stop(). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.failures = 0;
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.retryTimer = this.clear(this.retryTimer);
    this.freshTimer = this.clear(this.freshTimer);
    this.slowTimer = this.clear(this.slowTimer);
    this.dropSocket();
    this.set({ status: 'off', healthy: null, healthAt: null, slowConnect: false });
  }

  /** A new port from the setup screen: reconnect to it at once. */
  setPort(port: number): void {
    if (port === this.state.port) return;
    this.set({ port });
    if (!this.running) return;
    this.retryTimer = this.clear(this.retryTimer);
    this.slowTimer = this.clear(this.slowTimer);
    this.dropSocket();
    this.failures = 0;
    this.connect();
  }

  /** The socket is open, the last health message is at most 500 ms old, and it said true. */
  healthyNow(now = this.now()): boolean {
    const s = this.state;
    return s.status === 'open' && s.healthy === true && s.healthAt !== null && now - s.healthAt <= HEALTH_FRESH_MS;
  }

  healthWord(now = this.now()): DecoderHealthWord {
    const s = this.state;
    if (s.status === 'off') return 'off';
    if (s.status === 'connecting' && this.failures === 0) return 'connecting';
    if (s.status !== 'open') return 'not_found';
    if (s.healthAt === null || now - s.healthAt > HEALTH_FRESH_MS) return 'silent';
    return s.healthy ? 'healthy' : 'not_ready';
  }

  private clear(handle: unknown): null {
    if (handle !== null) this.clearTimer(handle);
    return null;
  }

  private set(patch: Partial<DecoderState>): void {
    this.state = { ...this.state, ...patch };
    this.changed();
  }

  private changed(): void {
    this.lastWord = this.healthWord();
    this.options.onChange?.();
  }

  private dropSocket(): void {
    const old = this.socket;
    this.socket = null;
    if (!old) return;
    old.onopen = null;
    old.onclose = null;
    old.onerror = null;
    old.onmessage = null;
    try {
      old.close();
    } catch {
      // Already closed.
    }
  }

  private connect(): void {
    if (!this.running) return;
    let socket: DecoderSocketLike;
    try {
      socket = this.factory(decoderUrl(this.state.port));
    } catch (error) {
      this.set({ status: 'closed', errorText: error instanceof Error ? error.message : String(error) });
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    this.set({ status: 'connecting', slowConnect: false });
    this.slowTimer = this.clear(this.slowTimer);
    this.slowTimer = this.setTimer(() => {
      this.slowTimer = null;
      if (this.socket === socket && this.state.status === 'connecting') this.set({ slowConnect: true });
    }, DECODER_SLOW_CONNECT_MS);
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.failures = 0;
      this.slowTimer = this.clear(this.slowTimer);
      this.set({ status: 'open', errorText: null, healthy: null, healthAt: null, slowConnect: false });
      this.watchFreshness();
    };
    socket.onmessage = (event) => {
      if (this.socket === socket) this.onFrame(event.data);
    };
    const lost = () => {
      if (this.socket !== socket) return;
      this.dropSocket();
      this.freshTimer = this.clear(this.freshTimer);
      this.slowTimer = this.clear(this.slowTimer);
      this.set({ status: 'closed', healthy: null, healthAt: null, slowConnect: false });
      this.scheduleRetry();
    };
    socket.onclose = lost;
    socket.onerror = lost;
  }

  private scheduleRetry(): void {
    if (!this.running || this.retryTimer !== null) return;
    const wait = DECODER_RETRY_MS[Math.min(this.failures, DECODER_RETRY_MS.length - 1)] ?? 2_000;
    this.failures++;
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      this.connect();
    }, wait);
  }

  /** While open, look every 250 ms whether health went stale, so "Decoder silent" shows without a message. */
  private watchFreshness(): void {
    this.freshTimer = this.clear(this.freshTimer);
    const tick = () => {
      this.freshTimer = null;
      if (!this.running || this.state.status !== 'open') return;
      if (this.healthWord() !== this.lastWord) this.changed();
      this.freshTimer = this.setTimer(tick, 250);
    };
    this.freshTimer = this.setTimer(tick, 250);
  }

  private onFrame(data: unknown): void {
    const receivedAt = this.now();
    const frame = parseDecoderFrame(data);
    switch (frame.kind) {
      case 'health': {
        const before = this.lastWord;
        this.state = { ...this.state, healthy: frame.healthy, healthAt: receivedAt };
        if (this.healthWord(receivedAt) !== before) this.changed();
        return;
      }
      case 'ignored':
        this.state = { ...this.state, ignoredMessages: this.state.ignoredMessages + 1 };
        return;
      case 'bad':
        this.set({ badMessages: this.state.badMessages + 1, lastBadAt: receivedAt });
        return;
      case 'gesture':
        if (frame.idReplaced) this.set({ idsReplaced: this.state.idsReplaced + 1, lastIdReplacedAt: receivedAt });
        this.options.onCommand({
          command: frame.command,
          gestureId: frame.gestureId,
          source: frame.source,
          confidence: frame.confidence,
          onsetLocal: receivedAt - frame.onsetAgeMs,
          via: 'decoder',
          idReplaced: frame.idReplaced,
        });
        return;
    }
  }
}
