// Browser: Sonic 3.6 over the TTS WebSocket, authenticated with an access token (never an API key).

import { SONIC_MODEL } from './constants.js';
import { emit, redact, type OnEvent } from './events.js';
import { base64ToBytes, bytesPerSample, concatBytes, pcmDurationMs, pcmToFloat32, type PcmEncoding } from './pcm.js';
import type { Utterance, UtteranceKind } from './tones.js';
import {
    browserSocketFactory,
    checkAccessToken,
    realTimers,
    SOCKET_OPEN,
    socketUrl,
    uniqueId,
    waitForOpen,
    type SocketFactory,
    type SocketLike,
    type Timers,
} from './ws.js';

export type SampleRate = 8000 | 16000 | 22050 | 24000 | 44100 | 48000;

export interface OutputFormat {
    encoding: PcmEncoding;
    sampleRate: SampleRate;
}

/** Raw 16-bit PCM at 24 kHz, as in Cartesia's caching guide. Headerless, so clips splice without clicks. */
export const DEFAULT_FORMAT: OutputFormat = { encoding: 'pcm_s16le', sampleRate: 24000 };

/** Whole text known up front: send it with no server buffering (the buffering guide's "custom buffering"). */
export const WHOLE_TEXT_BUFFER_MS = 0;
/** Our pick for token streaming. Cartesia's default is 3000 ms and the allowed range is 0 to 5000. */
export const TOKEN_STREAM_BUFFER_MS = 1000;

export interface WordTiming {
    word: string;
    startMs: number;
    endMs: number;
}

export interface Clip {
    contextId: string;
    kind: UtteranceKind;
    pcm: Uint8Array;
    encoding: PcmEncoding;
    sampleRate: SampleRate;
    /** Measured from the audio bytes and the sample rate. The scan clock uses it as dwell time. */
    durationMs: number;
    words: WordTiming[];
    /** From sending the request to the first audio chunk; null if no audio came. */
    firstAudioMs: number | null;
    totalMs: number;
}

export class TtsCancelled extends Error {
    constructor() {
        super('Cancelled.');
        this.name = 'TtsCancelled';
    }
}

export class TtsError extends Error {
    constructor(
        message: string,
        readonly statusCode: number | null,
        readonly errorCode: string | null,
    ) {
        super(redact(message).slice(0, 300));
        this.name = 'TtsError';
    }
}

export interface TtsJob {
    readonly contextId: string;
    readonly done: Promise<Clip>;
    cancel(): void;
}

export interface TtsStream extends TtsJob {
    /** Adds text to the context with continue: true. Text is concatenated verbatim, so keep the spaces. */
    push(text: string): Promise<void>;
    /** Ends the context with an empty transcript and continue: false (plus a laugh if the utterance asks for one). */
    end(): Promise<void>;
}

export interface TtsPlayerOptions {
    /** Returns a short-lived access token with the TTS grant, minted on a server. */
    getToken: () => Promise<string>;
    socket?: SocketFactory;
    /** Defaults to sonic-3.6. Pin SONIC_SNAPSHOT for cached clips once it has been tried live. */
    modelId?: string;
    format?: OutputFormat;
    /** Sent on every request when set. */
    pronunciationDictId?: string;
    /** Contexts generating at once. The Free plan allows 2 concurrent TTS contexts, so the default is 1. */
    maxActive?: 1 | 2;
    /** Fails a generation when nothing arrives for this long. */
    idleTimeoutMs?: number;
    openTimeoutMs?: number;
    onEvent?: OnEvent;
    timers?: Timers;
    now?: () => number;
}

/** The JSON message for one generation request. Pure, so tests check the exact wire shape. */
export function generationRequest(
    u: Utterance,
    contextId: string,
    transcript: string,
    options: { modelId: string; format: OutputFormat; pronunciationDictId?: string; continue: boolean; maxBufferDelayMs: number },
): Record<string, unknown> {
    const message: Record<string, unknown> = {
        model_id: options.modelId,
        transcript,
        voice: u.voiceId,
        output_format: { container: 'raw', encoding: options.format.encoding, sample_rate: options.format.sampleRate },
        context_id: contextId,
        continue: options.continue,
        max_buffer_delay_ms: options.maxBufferDelayMs,
        add_timestamps: true,
        // Original rather than normalized word timings, so the highlight matches the words on screen.
        use_normalized_timestamps: false,
    };
    // A request sets language or locale, never both.
    if (u.locale !== undefined) message.locale = u.locale;
    else message.language = u.language ?? 'en';
    if (options.pronunciationDictId) message.pronunciation_dict_id = options.pronunciationDictId;
    const config: Record<string, unknown> = {};
    if (u.generationConfig.emotion !== undefined) config.emotion = u.generationConfig.emotion;
    if (u.generationConfig.speed !== undefined) config.speed = u.generationConfig.speed;
    if (u.generationConfig.volume !== undefined) config.volume = u.generationConfig.volume;
    if (Object.keys(config).length > 0) message.generation_config = config;
    return message;
}

/** Index of the word being heard `ms` into a clip, or -1 before the first word starts. */
export function wordAt(words: readonly WordTiming[], ms: number): number {
    let index = -1;
    for (let i = 0; i < words.length; i++) {
        if ((words[i]?.startMs ?? Infinity) <= ms) index = i;
        else break;
    }
    return index;
}

function addWords(target: WordTiming[], raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const { words, start, end } = raw as { words?: unknown; start?: unknown; end?: unknown };
    if (!Array.isArray(words) || !Array.isArray(start) || !Array.isArray(end)) return;
    const n = Math.min(words.length, start.length, end.length);
    for (let i = 0; i < n; i++) {
        const word: unknown = words[i];
        const s: unknown = start[i];
        const e: unknown = end[i];
        if (typeof word === 'string' && typeof s === 'number' && typeof e === 'number') {
            target.push({ word, startMs: Math.round(s * 1000), endMs: Math.round(e * 1000) });
        }
    }
}

function errorFromMessage(message: Record<string, unknown>): TtsError {
    const title = typeof message.title === 'string' ? message.title : 'Speech error';
    const detail = typeof message.message === 'string' ? message.message : '';
    return new TtsError(
        detail ? `${title}: ${detail}` : title,
        typeof message.status_code === 'number' ? message.status_code : null,
        typeof message.error_code === 'string' ? message.error_code : null,
    );
}

function streamText(text: string): string {
    // Chunks are joined verbatim, so only markup characters go; spaces stay exactly as given.
    return String(text).replace(/[<>[\]{}]/g, '');
}

interface LiveContext {
    id: string;
    kind: UtteranceKind;
    sentAt: number;
    firstAudioAt: number | null;
    chunks: Uint8Array[];
    words: WordTiming[];
    timer: unknown;
    onAudio: ((pcm: Uint8Array) => void) | undefined;
    resolve: (clip: Clip) => void;
    reject: (error: Error) => void;
}

interface Waiter {
    resolve: () => void;
    reject: (error: Error) => void;
}

interface JobControl {
    cancelled: boolean;
    onCancel: (() => void) | null;
}

/**
 * Generates speech one context at a time over one WebSocket. Each option gets its own context, so each can carry
 * its own emotion, as Cartesia's emotion guide recommends.
 */
export class TtsPlayer {
    readonly modelId: string;
    readonly format: OutputFormat;
    private readonly factory: SocketFactory;
    private readonly timers: Timers;
    private readonly now: () => number;
    private readonly maxActive: number;
    private readonly idleTimeoutMs: number;
    private readonly openTimeoutMs: number;
    private socket: SocketLike | null = null;
    private opening: Promise<SocketLike> | null = null;
    private readonly live = new Map<string, LiveContext>();
    private readonly waiters: Waiter[] = [];
    private active = 0;
    private counter = 0;
    private closed = false;

    constructor(private readonly options: TtsPlayerOptions) {
        this.modelId = options.modelId ?? SONIC_MODEL;
        this.format = options.format ?? DEFAULT_FORMAT;
        this.factory = options.socket ?? browserSocketFactory;
        this.timers = options.timers ?? realTimers;
        this.now = options.now ?? Date.now;
        this.maxActive = options.maxActive ?? 1;
        this.idleTimeoutMs = options.idleTimeoutMs ?? 10_000;
        this.openTimeoutMs = options.openTimeoutMs ?? 10_000;
        if (this.maxActive !== 1 && this.maxActive !== 2) throw new RangeError('maxActive is 1 or 2.');
    }

    /** Everything besides the utterance that changes the audio, for cache keys. */
    settingsKey(): string {
        return JSON.stringify([this.modelId, this.format.encoding, this.format.sampleRate, this.options.pronunciationDictId ?? null]);
    }

    /** Generates a whole utterance in one request: continue false, no server buffering. */
    speak(u: Utterance, options: { onAudio?: (pcm: Uint8Array) => void } = {}): TtsJob {
        const contextId = uniqueId('tts', ++this.counter);
        const control: JobControl = { cancelled: false, onCancel: null };
        const done = this.run(contextId, u.kind, options.onAudio, control, () => {
            if (!u.transcript.trim()) throw new TtsError('There is nothing to say.', null, 'empty');
            this.send(
                generationRequest(u, contextId, u.transcript, {
                    modelId: this.modelId,
                    format: this.format,
                    pronunciationDictId: this.options.pronunciationDictId,
                    continue: false,
                    maxBufferDelayMs: WHOLE_TEXT_BUFFER_MS,
                }),
            );
        });
        done.catch(() => undefined);
        return { contextId, done, cancel: () => this.cancelJob(control) };
    }

    /** Same as speak, resolving with the clip. */
    synthesize(u: Utterance, options: { onAudio?: (pcm: Uint8Array) => void } = {}): Promise<Clip> {
        return this.speak(u, options).done;
    }

    /**
     * Streams text into one context with continuations. "phrases" sends whole phrases with no server buffering;
     * "tokens" lets Cartesia buffer token-by-token text for up to `bufferMs`. The utterance's own transcript is unused.
     * Contexts expire 1 second after their last audio, so keep the text coming.
     */
    stream(u: Utterance, options: { mode?: 'phrases' | 'tokens'; bufferMs?: number; onAudio?: (pcm: Uint8Array) => void } = {}): TtsStream {
        const bufferMs = options.mode === 'tokens' ? (options.bufferMs ?? TOKEN_STREAM_BUFFER_MS) : WHOLE_TEXT_BUFFER_MS;
        if (!Number.isInteger(bufferMs) || bufferMs < 0 || bufferMs > 5000) throw new RangeError('bufferMs must be 0 to 5000.');
        const contextId = uniqueId('tts', ++this.counter);
        const control: JobControl = { cancelled: false, onCancel: null };
        let markReady: () => void = () => undefined;
        const begun = new Promise<void>((resolve) => {
            markReady = resolve;
        });
        const done = this.run(contextId, u.kind, options.onAudio, control, () => markReady());
        done.catch(() => undefined);
        // If the job fails before it starts, pending pushes resolve instead of waiting forever.
        let chain: Promise<void> = Promise.race([begun, done.then(() => undefined, () => undefined)]);
        let ended = false;
        const sendPart = (transcript: string, more: boolean): Promise<void> => {
            chain = chain.then(() => {
                if (control.cancelled || !this.live.has(contextId)) return;
                this.send(
                    generationRequest(u, contextId, transcript, {
                        modelId: this.modelId,
                        format: this.format,
                        pronunciationDictId: this.options.pronunciationDictId,
                        continue: more,
                        maxBufferDelayMs: bufferMs,
                    }),
                );
                const context = this.live.get(contextId);
                if (context) this.armIdle(context);
            });
            return chain;
        };
        return {
            contextId,
            done,
            cancel: () => this.cancelJob(control),
            push: (text) => {
                if (ended) return Promise.reject(new Error('This stream already ended.'));
                const part = streamText(text);
                return part ? sendPart(part, true) : chain;
            },
            end: () => {
                if (ended) return chain;
                ended = true;
                return sendPart(u.laugh ? ' [laughter]' : '', false);
            },
        };
    }

    /** Cancels whatever is generating or waiting. */
    cancelAll(): void {
        for (const id of [...this.live.keys()]) this.cancelLive(id);
        for (const waiter of this.waiters.splice(0)) waiter.reject(new TtsCancelled());
    }

    close(): void {
        this.closed = true;
        this.cancelAll();
        const socket = this.socket;
        this.socket = null;
        if (socket) {
            try {
                socket.close(1000, 'done');
            } catch {
                // Already closed.
            }
        }
    }

    private run(
        contextId: string,
        kind: UtteranceKind,
        onAudio: ((pcm: Uint8Array) => void) | undefined,
        control: JobControl,
        begin: () => void,
    ): Promise<Clip> {
        return (async () => {
            await this.acquire(control);
            try {
                if (control.cancelled) throw new TtsCancelled();
                await this.ensureSocket();
                if (control.cancelled) throw new TtsCancelled();
                return await new Promise<Clip>((resolve, reject) => {
                    const context: LiveContext = {
                        id: contextId,
                        kind,
                        sentAt: this.now(),
                        firstAudioAt: null,
                        chunks: [],
                        words: [],
                        timer: null,
                        onAudio,
                        resolve,
                        reject,
                    };
                    this.live.set(contextId, context);
                    control.onCancel = () => this.cancelLive(contextId);
                    this.armIdle(context);
                    emit(this.options.onEvent, { stage: 'speak', status: 'started', detail: `generating ${kind}`, ms: 0 });
                    try {
                        begin();
                    } catch (error) {
                        this.settle(contextId, error instanceof Error ? error : new TtsError(String(error), null, null));
                    }
                });
            } finally {
                this.releaseSlot();
            }
        })();
    }

    private cancelJob(control: JobControl): void {
        if (control.cancelled) return;
        control.cancelled = true;
        control.onCancel?.();
    }

    private acquire(control: JobControl): Promise<void> {
        if (this.closed) return Promise.reject(new TtsError('The player is closed.', null, 'closed'));
        if (this.active < this.maxActive) {
            this.active++;
            return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
            const waiter: Waiter = { resolve, reject };
            this.waiters.push(waiter);
            control.onCancel = () => {
                const index = this.waiters.indexOf(waiter);
                if (index >= 0) this.waiters.splice(index, 1);
                reject(new TtsCancelled());
            };
        });
    }

    private releaseSlot(): void {
        const next = this.waiters.shift();
        // Hand the slot straight to the next job, so the active count never goes above the limit.
        if (next) next.resolve();
        else this.active = Math.max(0, this.active - 1);
    }

    private async ensureSocket(): Promise<SocketLike> {
        if (this.socket && this.socket.readyState === SOCKET_OPEN) return this.socket;
        if (!this.opening) {
            this.opening = this.openSocket().finally(() => {
                this.opening = null;
            });
        }
        return this.opening;
    }

    private async openSocket(): Promise<SocketLike> {
        const token = checkAccessToken(await this.options.getToken());
        const socket = this.factory(socketUrl('/tts/websocket', token));
        await waitForOpen(socket, this.openTimeoutMs, this.timers);
        socket.addEventListener('message', (event) => this.onMessage(event.data));
        socket.addEventListener('close', () => this.onClosed(socket));
        this.socket = socket;
        emit(this.options.onEvent, { stage: 'speak', status: 'ok', detail: 'socket open', ms: 0 });
        return socket;
    }

    private onClosed(socket: SocketLike): void {
        if (this.socket !== socket) return;
        this.socket = null;
        for (const id of [...this.live.keys()]) this.settle(id, new TtsError('The voice connection closed.', null, 'closed'));
    }

    private send(message: Record<string, unknown>): void {
        const socket = this.socket;
        if (!socket || socket.readyState !== SOCKET_OPEN) throw new TtsError('The voice connection is closed.', null, 'closed');
        socket.send(JSON.stringify(message));
    }

    private onMessage(data: unknown): void {
        if (typeof data !== 'string') return;
        let parsed: unknown;
        try {
            parsed = JSON.parse(data);
        } catch {
            return;
        }
        if (!parsed || typeof parsed !== 'object') return;
        const message = parsed as Record<string, unknown>;
        const id = typeof message.context_id === 'string' ? message.context_id : null;
        if (message.type === 'error' && id === null) {
            const error = errorFromMessage(message);
            for (const contextId of [...this.live.keys()]) this.settle(contextId, error);
            return;
        }
        const context = id === null ? undefined : this.live.get(id);
        // Unknown ids are contexts we cancelled or finished; a generating request keeps sending after a cancel.
        if (!context) return;
        this.armIdle(context);
        switch (message.type) {
            case 'chunk': {
                if (typeof message.data !== 'string') return;
                const pcm = base64ToBytes(message.data);
                if (context.firstAudioAt === null) context.firstAudioAt = this.now();
                context.chunks.push(pcm);
                try {
                    context.onAudio?.(pcm);
                } catch {
                    // A playback problem must not lose the clip.
                }
                return;
            }
            case 'timestamps':
                addWords(context.words, message.word_timestamps);
                return;
            case 'done':
                this.settle(context.id, null);
                return;
            case 'error':
                this.settle(context.id, errorFromMessage(message));
                return;
            default:
                // flush_done and phoneme_timestamps are not used.
                return;
        }
    }

    private armIdle(context: LiveContext): void {
        this.timers.clear(context.timer);
        context.timer = this.timers.set(() => {
            this.sendCancel(context.id);
            this.settle(context.id, new TtsError('No audio arrived in time.', null, 'timeout'));
        }, this.idleTimeoutMs);
    }

    private sendCancel(id: string): void {
        try {
            if (this.socket && this.socket.readyState === SOCKET_OPEN) this.send({ context_id: id, cancel: true });
        } catch {
            // The socket is closing; nothing left to cancel.
        }
    }

    /** Cancel stops requests that have not started; anything still generating is ignored when it arrives. */
    private cancelLive(id: string): void {
        if (!this.live.has(id)) return;
        this.sendCancel(id);
        this.settle(id, new TtsCancelled());
    }

    private settle(id: string, error: Error | null): void {
        const context = this.live.get(id);
        if (!context) return;
        this.live.delete(id);
        this.timers.clear(context.timer);
        const totalMs = this.now() - context.sentAt;
        if (error) {
            const cancelled = error instanceof TtsCancelled;
            emit(this.options.onEvent, {
                stage: 'speak',
                status: cancelled ? 'ok' : 'error',
                detail: cancelled ? 'cancelled' : 'generation failed',
                ms: totalMs,
            });
            context.reject(error);
            return;
        }
        const pcm = concatBytes(context.chunks);
        const clip: Clip = {
            contextId: id,
            kind: context.kind,
            pcm,
            encoding: this.format.encoding,
            sampleRate: this.format.sampleRate,
            durationMs: pcmDurationMs(pcm.byteLength, this.format.encoding, this.format.sampleRate),
            words: context.words,
            firstAudioMs: context.firstAudioAt === null ? null : context.firstAudioAt - context.sentAt,
            totalMs,
        };
        const counts: Record<string, number> = { clipMs: clip.durationMs, words: clip.words.length };
        if (clip.firstAudioMs !== null) counts.firstAudioMs = clip.firstAudioMs;
        emit(this.options.onEvent, { stage: 'speak', status: 'ok', detail: `clip ready ${context.kind}`, ms: totalMs, counts });
        context.resolve(clip);
    }
}

/**
 * Keeps generated clips for stock phrases, so prompts like "Paused. Nothing will be sent." play without a network
 * round trip and cost no credits after the first time. In-flight requests are shared.
 */
export class PhraseCache {
    private readonly pending = new Map<string, Promise<Clip>>();
    private readonly ready = new Map<string, Clip>();

    constructor(private readonly player: Pick<TtsPlayer, 'synthesize' | 'settingsKey'>) {}

    key(u: Utterance): string {
        return JSON.stringify([
            this.player.settingsKey(),
            u.transcript,
            u.voiceId,
            u.language ?? null,
            u.locale ?? null,
            u.generationConfig.emotion ?? null,
            u.generationConfig.speed ?? null,
            u.generationConfig.volume ?? null,
        ]);
    }

    get(u: Utterance): Promise<Clip> {
        const key = this.key(u);
        const cached = this.ready.get(key);
        if (cached) return Promise.resolve(cached);
        let request = this.pending.get(key);
        if (!request) {
            request = this.player.synthesize(u).then(
                (clip) => {
                    this.ready.set(key, clip);
                    this.pending.delete(key);
                    return clip;
                },
                (error: unknown) => {
                    this.pending.delete(key);
                    throw error;
                },
            );
            this.pending.set(key, request);
        }
        return request;
    }

    peek(u: Utterance): Clip | undefined {
        return this.ready.get(this.key(u));
    }

    /** Generates each phrase in turn (never in parallel, to stay under the plan's TTS concurrency). */
    async warm(list: readonly Utterance[]): Promise<{ ready: number; failed: number }> {
        let ready = 0;
        let failed = 0;
        for (const u of list) {
            try {
                await this.get(u);
                ready++;
            } catch {
                failed++;
            }
        }
        return { ready, failed };
    }

    clear(): void {
        this.pending.clear();
        this.ready.clear();
    }
}

/** The parts of Web Audio that AudioOut uses, so tests can pass a fake. */
export interface AudioBufferLike {
    copyToChannel(source: Float32Array, channel: number): void;
}

export interface AudioSourceNodeLike {
    buffer: AudioBufferLike | null;
    onended: (() => void) | null;
    connect(destination: unknown): unknown;
    start(when?: number): void;
    stop(when?: number): void;
}

export interface AudioContextLike {
    readonly currentTime: number;
    readonly destination: unknown;
    createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
    createBufferSource(): AudioSourceNodeLike;
}

/** Plays clips, or streamed chunks back to back for faster first audio, and reports the playback position. */
export class AudioOut {
    private readonly sources = new Set<AudioSourceNodeLike>();
    private nextAt = 0;
    private startedAt = 0;
    private carry = new Uint8Array(0);
    private generation = 0;

    constructor(
        private readonly context: AudioContextLike,
        private readonly format: OutputFormat = DEFAULT_FORMAT,
        private readonly leadSeconds = 0.05,
    ) {}

    /** Plays a whole clip and resolves when it ends, or with "stopped" if stop() interrupts it. */
    play(clip: Clip): Promise<'ended' | 'stopped'> {
        this.stop();
        const generation = this.generation;
        const samples = pcmToFloat32(clip.pcm, clip.encoding);
        if (samples.length === 0) return Promise.resolve('ended');
        const at = this.context.currentTime + this.leadSeconds;
        this.startedAt = at;
        return new Promise((resolve) => {
            const source = this.schedule(samples, clip.sampleRate, at);
            source.onended = () => {
                this.sources.delete(source);
                resolve(generation === this.generation ? 'ended' : 'stopped');
            };
        });
    }

    /** Schedules a streamed chunk right after the previous one. */
    enqueue(pcm: Uint8Array): void {
        const size = bytesPerSample(this.format.encoding);
        const bytes = concatBytes([this.carry, pcm]);
        const usable = bytes.byteLength - (bytes.byteLength % size);
        this.carry = bytes.slice(usable);
        if (usable === 0) return;
        const samples = pcmToFloat32(bytes.subarray(0, usable), this.format.encoding);
        const earliest = this.context.currentTime + this.leadSeconds;
        if (this.nextAt < earliest) {
            if (this.sources.size === 0) this.startedAt = earliest;
            this.nextAt = earliest;
        }
        const source = this.schedule(samples, this.format.sampleRate, this.nextAt);
        source.onended = () => {
            this.sources.delete(source);
        };
        this.nextAt += samples.length / this.format.sampleRate;
    }

    stop(): void {
        this.generation++;
        for (const source of [...this.sources]) {
            try {
                source.stop();
            } catch {
                // Not started yet or already stopped.
            }
        }
        this.nextAt = 0;
        this.carry = new Uint8Array(0);
    }

    get playing(): boolean {
        return this.sources.size > 0;
    }

    /** Milliseconds into the current playback, for wordAt(). */
    positionMs(): number {
        return Math.max(0, (this.context.currentTime - this.startedAt) * 1000);
    }

    private schedule(samples: Float32Array, sampleRate: number, at: number): AudioSourceNodeLike {
        const buffer = this.context.createBuffer(1, samples.length, sampleRate);
        buffer.copyToChannel(samples, 0);
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.context.destination);
        source.start(at);
        this.sources.add(source);
        return source;
    }
}
