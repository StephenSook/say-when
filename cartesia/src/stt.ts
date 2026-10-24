// Browser: Ink-2 speech to text on the partner's phone, over the turns WebSocket with an access token.
// Audio streams only while the partner holds the button, because Ink-2 bills every second sent, silence included.

import { INK_MODEL } from './constants.js';
import { emit, redact, type OnEvent } from './events.js';
import { Downsampler, PcmChunker, floatToPcm16 } from './pcm.js';
import {
    browserSocketFactory,
    checkAccessToken,
    realTimers,
    SOCKET_OPEN,
    socketUrl,
    waitForOpen,
    withTimeout,
    type SocketFactory,
    type SocketLike,
    type Timers,
} from './ws.js';

/** 16-bit PCM at 16 kHz. Cartesia's audio input guide says downsampling to this costs little accuracy. */
export const STT_ENCODING = 'pcm_s16le';
export const STT_SAMPLE_RATE = 16000;
/** The STT API reference suggests sending audio in chunks of about 100 ms. */
export const STT_CHUNK_MS = 100;

export interface TurnSettings {
    startThreshold: number;
    eagerEndThreshold: number;
    endThreshold: number;
    endTimeoutMs: number;
}

/** The three profiles on Cartesia's Turn Detection page. Balanced is the server default. */
export const TURN_PROFILES = {
    balanced: { startThreshold: 0.8, eagerEndThreshold: 0.6, endThreshold: 0.3, endTimeoutMs: 5600 },
    responsive: { startThreshold: 0.7, eagerEndThreshold: 0.6, endThreshold: 0.4, endTimeoutMs: 4500 },
    patient: { startThreshold: 0.8, eagerEndThreshold: 0.3, endThreshold: 0.1, endTimeoutMs: 8000 },
} as const satisfies Record<string, TurnSettings>;

/** Ranges and ordering from the turns WebSocket reference. Returns a problem, or null when the settings are valid. */
export function checkTurnSettings(turn: TurnSettings): string | null {
    const within = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max;
    if (!within(turn.startThreshold, 0.5, 0.9)) return 'The start threshold must be 0.5 to 0.9.';
    if (!within(turn.eagerEndThreshold, 0.3, 0.8)) return 'The eager end threshold must be 0.3 to 0.8.';
    if (!within(turn.endThreshold, 0.05, 0.5)) return 'The end threshold must be 0.05 to 0.5.';
    if (!within(turn.endTimeoutMs, 640, 11200)) return 'The end timeout must be 640 to 11200 ms.';
    if (!(turn.startThreshold > turn.eagerEndThreshold && turn.eagerEndThreshold > turn.endThreshold)) {
        return 'Thresholds must go start, then eager end, then end, from high to low.';
    }
    return null;
}

/** The turns WebSocket URL. Keyterms repeat as `keyterm`, with spaces sent as %20. */
export function sttUrl(token: string, options: { keyterms?: readonly string[]; turn?: TurnSettings; model?: string } = {}): string {
    const params: [string, string][] = [
        ['model', options.model ?? INK_MODEL],
        ['encoding', STT_ENCODING],
        ['sample_rate', String(STT_SAMPLE_RATE)],
    ];
    for (const term of options.keyterms ?? []) params.push(['keyterm', term]);
    if (options.turn) {
        const problem = checkTurnSettings(options.turn);
        if (problem) throw new RangeError(problem);
        params.push(
            ['turn_start_threshold', String(options.turn.startThreshold)],
            ['turn_eager_end_threshold', String(options.turn.eagerEndThreshold)],
            ['turn_end_threshold', String(options.turn.endThreshold)],
            ['turn_end_timeout_ms', String(options.turn.endTimeoutMs)],
        );
    }
    return socketUrl('/stt/turns/websocket', checkAccessToken(token), params);
}

/** Where audio comes from: the microphone in the browser, a fake in tests. */
export interface AudioSource {
    /** Starts capture and calls onChunk with 16 kHz 16-bit PCM. */
    start(onChunk: (pcm: Uint8Array) => void): Promise<void>;
    /** Stops capture. Any partial chunk still held is delivered through onChunk before this returns. */
    stop(): void;
}

// An AudioWorklet that hands each mono block to the page, as in Cartesia's browser STT example.
const CAPTURE_WORKLET = `
class ElevenCapture extends AudioWorkletProcessor {
    process(inputs) {
        const channel = inputs[0] && inputs[0][0];
        if (channel) this.port.postMessage(channel.slice(0));
        return true;
    }
}
registerProcessor('neurolingo-capture', ElevenCapture);
`;

/** Microphone capture with getUserMedia and an AudioWorklet, downsampled to 16 kHz 16-bit mono. */
export class MicCapture implements AudioSource {
    private stream: MediaStream | null = null;
    private context: AudioContext | null = null;
    private node: AudioWorkletNode | null = null;
    private sourceNode: MediaStreamAudioSourceNode | null = null;
    private chunker: PcmChunker | null = null;
    private onChunk: ((pcm: Uint8Array) => void) | null = null;
    private stopped = false;

    async start(onChunk: (pcm: Uint8Array) => void): Promise<void> {
        this.onChunk = onChunk;
        if (!globalThis.navigator?.mediaDevices?.getUserMedia) throw new Error('This page cannot use the microphone (it needs HTTPS).');
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        this.stream = stream;
        if (this.stopped) return this.release();
        // The context runs at the hardware rate (often 48 kHz); the Downsampler brings it to 16 kHz.
        const context = new AudioContext();
        this.context = context;
        const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }));
        try {
            await context.audioWorklet.addModule(url);
        } finally {
            URL.revokeObjectURL(url);
        }
        if (this.stopped) return this.release();
        const downsampler = new Downsampler(context.sampleRate, STT_SAMPLE_RATE);
        const chunker = new PcmChunker((STT_SAMPLE_RATE * 2 * STT_CHUNK_MS) / 1000);
        this.chunker = chunker;
        const node = new AudioWorkletNode(context, 'neurolingo-capture');
        node.port.onmessage = (event: MessageEvent<Float32Array>) => {
            if (this.stopped) return;
            for (const chunk of chunker.push(floatToPcm16(downsampler.push(event.data)))) onChunk(chunk);
        };
        this.node = node;
        const sourceNode = context.createMediaStreamSource(stream);
        sourceNode.connect(node);
        // Not connected to the speakers: the partner should not hear themselves.
        this.sourceNode = sourceNode;
    }

    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        const rest = this.chunker?.flush();
        if (rest && rest.byteLength > 0) this.onChunk?.(rest);
        this.release();
    }

    private release(): void {
        try {
            this.sourceNode?.disconnect();
            this.node?.disconnect();
        } catch {
            // Already disconnected.
        }
        if (this.node) this.node.port.onmessage = null;
        for (const track of this.stream?.getTracks() ?? []) track.stop();
        void this.context?.close().catch(() => undefined);
        this.sourceNode = null;
        this.node = null;
        this.stream = null;
        this.context = null;
    }
}

export interface ListenOptions {
    /** Returns a short-lived access token with the STT grant, minted on a server. */
    getToken: () => Promise<string>;
    /** From buildKeyterms(): household names first, then the current Apify place names. */
    keyterms?: readonly string[];
    /** Unset keeps the server default (Balanced). TURN_PROFILES.patient suits a partner who pauses to think. */
    turn?: TurnSettings;
    /** "turn_end" (default) finishes on the first turn end; "release" waits for the partner to let go of the button. */
    endOn?: 'turn_end' | 'release';
    /** Hard stop for a stuck button, so the stream cannot keep billing. */
    maxMs?: number;
    /**
     * After the close command, how long to wait for the server's last events. Default 5000. After a release or the
     * time limit, releaseDeadlineMs still ends the session no later than that.
     */
    drainMs?: number;
    audio?: AudioSource;
    socket?: SocketFactory;
    timers?: Timers;
    now?: () => number;
    onPartial?: (text: string) => void;
    /** Ink-2 predicts the partner may be done: a safe moment to start work early. */
    onEagerEnd?: (text: string) => void;
    /** The partner kept talking after an eager end: cancel that early work. */
    onResume?: () => void;
    onTurn?: (text: string) => void;
    onEvent?: OnEvent;
    /** Gives up on getToken() after this long. */
    tokenTimeoutMs?: number;
    /** After the button is let go (or the time limit), the session ends no later than this, connected or not. */
    releaseDeadlineMs?: number;
}

export type ListenResult =
    | { ok: true; text: string; turns: number; complete: boolean; reason: 'turn_end' | 'release' | 'timeout' | 'closed'; ms: number }
    | { ok: false; reason: 'aborted' | 'error' | 'no_speech'; message: string; ms: number };

export interface Listening {
    /** The partner let go of the button: stop the mic now, then collect the last events. */
    release(): void;
    /** Throw it away: stop the mic and close the socket. */
    abort(): void;
    readonly done: Promise<ListenResult>;
}

/** Most audio held while the socket opens: about 5 seconds. */
const MAX_PENDING_CHUNKS = 50;

/**
 * The default drainMs. In a live test on Oct 24 a slow Ink-2 final transcript arrived 3.5 s after the close command,
 * and the old 3 s wait cut the question to "What should we have for".
 */
const DEFAULT_DRAIN_MS = 5000;

class ListenSession implements Listening {
    readonly done: Promise<ListenResult>;
    private resolveDone: (result: ListenResult) => void = () => undefined;
    private readonly audio: AudioSource;
    private readonly timers: Timers;
    private readonly now: () => number;
    private readonly startedAt: number;
    private socket: SocketLike | null = null;
    private opened = false;
    private pending: Uint8Array[] = [];
    private readonly turns: string[] = [];
    private lastPartial = '';
    private streaming = true;
    private finished = false;
    private closeSent = false;
    private stopReason: 'turn_end' | 'release' | 'timeout' | 'closed' | null = null;
    private maxTimer: unknown = null;
    private drainTimer: unknown = null;
    private deadlineTimer: unknown = null;
    private audioBytes = 0;
    private droppedChunks = 0;

    constructor(private readonly options: ListenOptions) {
        this.done = new Promise<ListenResult>((resolve) => {
            this.resolveDone = resolve;
        });
        this.audio = options.audio ?? new MicCapture();
        this.timers = options.timers ?? realTimers;
        this.now = options.now ?? Date.now;
        this.startedAt = this.now();
        emit(options.onEvent, { stage: 'listen', status: 'started', detail: 'listening', ms: 0 });
        this.maxTimer = this.timers.set(() => this.stopStreaming('timeout'), options.maxMs ?? 30_000);
        void this.begin();
    }

    release(): void {
        this.stopStreaming('release');
    }

    abort(): void {
        this.fail('aborted', 'Stopped before anything was sent.');
    }

    private async begin(): Promise<void> {
        // Start the mic first: the partner is already talking while the socket opens.
        this.audio.start((chunk) => this.onAudio(chunk)).catch(() => this.fail('error', 'The microphone did not start.'));
        let socket: SocketLike;
        try {
            const token = await withTimeout(this.options.getToken(), this.options.tokenTimeoutMs ?? 10_000, this.timers, 'No speech token arrived in time.');
            // Finished already (released past the deadline, aborted, or failed): open nothing and send nothing.
            if (this.finished) return;
            socket = (this.options.socket ?? browserSocketFactory)(
                sttUrl(token, { keyterms: this.options.keyterms, turn: this.options.turn }),
            );
        } catch (error) {
            this.fail('error', error instanceof Error ? error.message : 'Could not start speech to text.');
            return;
        }
        this.socket = socket;
        socket.addEventListener('message', (event) => this.onMessage(event.data));
        socket.addEventListener('close', () => this.onClose());
        try {
            await waitForOpen(socket, 10_000, this.timers);
        } catch {
            this.fail('error', 'Could not connect to speech to text.');
            return;
        }
        if (this.finished) {
            this.closeSocket();
            return;
        }
        this.opened = true;
        emit(this.options.onEvent, { stage: 'listen', status: 'started', detail: 'socket open', ms: this.now() - this.startedAt });
        for (const chunk of this.pending) this.sendAudio(chunk);
        this.pending = [];
        if (!this.streaming) this.sendClose();
    }

    private onAudio(chunk: Uint8Array): void {
        if (!this.streaming || this.finished) return;
        if (this.socket && this.socket.readyState === SOCKET_OPEN) {
            this.sendAudio(chunk);
            return;
        }
        this.pending.push(chunk);
        if (this.pending.length > MAX_PENDING_CHUNKS) {
            this.pending.shift();
            this.droppedChunks++;
        }
    }

    private sendAudio(chunk: Uint8Array): void {
        try {
            this.socket?.send(chunk);
            this.audioBytes += chunk.byteLength;
        } catch {
            // The socket is closing; onClose finishes the session.
        }
    }

    private sendClose(): void {
        if (this.closeSent || !this.socket || this.socket.readyState !== SOCKET_OPEN) return;
        this.closeSent = true;
        try {
            // The server processes buffered audio into final events, then closes the socket itself.
            this.socket.send(JSON.stringify({ type: 'close' }));
        } catch {
            return;
        }
        this.drainTimer = this.timers.set(() => this.finish(), this.options.drainMs ?? DEFAULT_DRAIN_MS);
    }

    private stopStreaming(reason: 'turn_end' | 'release' | 'timeout'): void {
        if (!this.streaming || this.finished) return;
        this.stopReason = reason;
        try {
            // Stop while still streaming, so the mic's last partial chunk is sent before the close command.
            this.audio.stop();
        } catch {
            // Already stopped.
        }
        this.streaming = false;
        this.timers.clear(this.maxTimer);
        this.sendClose();
        if (reason === 'turn_end') {
            this.finish();
            return;
        }
        // A hard end, whether or not the socket ever opened: a stalled token cannot leave the session hanging.
        this.deadlineTimer = this.timers.set(() => {
            if (this.opened) this.finish();
            else this.fail('error', 'Speech to text did not connect in time.');
        }, this.options.releaseDeadlineMs ?? 5000);
    }

    private onMessage(data: unknown): void {
        if (this.finished || typeof data !== 'string') return;
        let parsed: unknown;
        try {
            parsed = JSON.parse(data);
        } catch {
            return;
        }
        if (!parsed || typeof parsed !== 'object') return;
        const message = parsed as Record<string, unknown>;
        const transcript = typeof message.transcript === 'string' ? message.transcript : '';
        switch (message.type) {
            case 'turn.update':
                this.lastPartial = transcript;
                this.call(this.options.onPartial, transcript);
                return;
            case 'turn.eager_end':
                this.lastPartial = transcript;
                this.call(this.options.onEagerEnd, transcript);
                return;
            case 'turn.resume':
                this.call(this.options.onResume);
                return;
            case 'turn.end': {
                this.lastPartial = '';
                const text = transcript.trim();
                if (text) {
                    this.turns.push(text);
                    this.call(this.options.onTurn, text);
                }
                if (this.options.endOn !== 'release' && this.turns.length > 0) {
                    if (this.streaming) this.stopStreaming('turn_end');
                    else this.finish();
                }
                return;
            }
            case 'error': {
                const title = typeof message.title === 'string' ? message.title : 'Speech to text error';
                const detail = typeof message.message === 'string' ? message.message : '';
                this.fail('error', redact(detail ? `${title}: ${detail}` : title));
                return;
            }
            default:
                // connected and turn.start carry no text.
                return;
        }
    }

    private onClose(): void {
        if (this.finished) return;
        if (!this.opened) {
            this.fail('error', 'Could not connect to speech to text.');
            return;
        }
        if (this.streaming) {
            try {
                this.audio.stop();
            } catch {
                // Already stopped.
            }
            this.streaming = false;
            this.stopReason = 'closed';
        }
        this.finish();
    }

    private finish(): void {
        if (this.finished) return;
        this.finished = true;
        this.clearTimers();
        const ms = this.now() - this.startedAt;
        const parts = [...this.turns];
        let complete = true;
        // A turn that never reached turn.end still counts: Ink-2 never revises text it has sent.
        if (this.lastPartial.trim()) {
            parts.push(this.lastPartial.trim());
            complete = false;
        }
        // Turn transcripts carry no separator spaces, so the docs say to join them with one.
        const text = parts.join(' ');
        const counts = { turns: this.turns.length, audioMs: Math.round(this.audioBytes / ((STT_SAMPLE_RATE * 2) / 1000)), droppedChunks: this.droppedChunks };
        if (!text) {
            emit(this.options.onEvent, { stage: 'listen', status: 'error', detail: 'no speech', ms, counts });
            this.resolveDone({ ok: false, reason: 'no_speech', message: 'No speech was heard.', ms });
        } else {
            emit(this.options.onEvent, { stage: 'listen', status: 'ok', detail: complete ? 'turn end' : 'partial turn', ms, counts });
            this.resolveDone({ ok: true, text, turns: this.turns.length, complete, reason: this.stopReason ?? 'closed', ms });
        }
        // Give the server a moment to close after the close command, then close it ourselves.
        if (this.socket && this.socket.readyState === SOCKET_OPEN) {
            if (this.closeSent) this.timers.set(() => this.closeSocket(), this.options.drainMs ?? DEFAULT_DRAIN_MS);
            else this.closeSocket();
        }
    }

    private fail(reason: 'aborted' | 'error', message: string): void {
        if (this.finished) return;
        this.finished = true;
        this.clearTimers();
        if (this.streaming) {
            this.streaming = false;
            try {
                this.audio.stop();
            } catch {
                // Already stopped.
            }
        }
        this.closeSocket();
        const ms = this.now() - this.startedAt;
        emit(this.options.onEvent, { stage: 'listen', status: reason === 'aborted' ? 'ok' : 'error', detail: reason, ms });
        this.resolveDone({ ok: false, reason, message: redact(message), ms });
    }

    private closeSocket(): void {
        const socket = this.socket;
        if (!socket || socket.readyState > SOCKET_OPEN) return;
        try {
            socket.close(1000, 'done');
        } catch {
            // Already closed.
        }
    }

    private clearTimers(): void {
        this.timers.clear(this.maxTimer);
        this.timers.clear(this.drainTimer);
        this.timers.clear(this.deadlineTimer);
        this.maxTimer = null;
        this.drainTimer = null;
        this.deadlineTimer = null;
    }

    private call<T extends unknown[]>(callback: ((...args: T) => void) | undefined, ...args: T): void {
        try {
            callback?.(...args);
        } catch {
            // A page callback must not stop transcription.
        }
    }
}

/** Starts listening when the partner presses the button. Call release() when they let go. */
export function listen(options: ListenOptions): Listening {
    return new ListenSession(options);
}
