import type { FetchLike } from '../src/http.js';
import type { AudioSource } from '../src/stt.js';
import type { AudioBufferLike, AudioContextLike, AudioSourceNodeLike, Clip } from '../src/tts.js';
import type { SocketEvent, SocketLike, Timers } from '../src/ws.js';

/** A WebSocket stand-in. Tests open it, push server messages into it and read what the code sent. */
export class FakeSocket implements SocketLike {
    static created: FakeSocket[] = [];
    readyState = 0;
    binaryType = 'blob';
    readonly sent: (string | Uint8Array)[] = [];
    closedWith: { code?: number; reason?: string } | null = null;
    private readonly listeners = new Map<string, Set<(event: SocketEvent) => void>>();

    constructor(readonly url: string) {
        FakeSocket.created.push(this);
    }

    static reset(): void {
        FakeSocket.created = [];
    }

    static last(): FakeSocket {
        const socket = FakeSocket.created.at(-1);
        if (!socket) throw new Error('No socket was opened.');
        return socket;
    }

    send(data: string | Uint8Array): void {
        if (this.readyState !== 1) throw new Error('FakeSocket is not open.');
        this.sent.push(data);
    }

    close(code?: number, reason?: string): void {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.closedWith = { code, reason };
        this.emit('close', { code: code ?? 1000, reason: reason ?? '' });
    }

    addEventListener(type: string, listener: (event: SocketEvent) => void): void {
        const set = this.listeners.get(type) ?? new Set();
        set.add(listener);
        this.listeners.set(type, set);
    }

    removeEventListener(type: string, listener: (event: SocketEvent) => void): void {
        this.listeners.get(type)?.delete(listener);
    }

    open(): void {
        this.readyState = 1;
        this.emit('open', {});
    }

    receive(message: unknown): void {
        this.emit('message', { data: JSON.stringify(message) });
    }

    serverClose(code = 1000): void {
        this.readyState = 3;
        this.emit('close', { code, reason: '' });
    }

    texts(): Record<string, unknown>[] {
        return this.sent.filter((item): item is string => typeof item === 'string').map((item) => JSON.parse(item) as Record<string, unknown>);
    }

    binaries(): Uint8Array[] {
        return this.sent.filter((item): item is Uint8Array => item instanceof Uint8Array);
    }

    private emit(type: string, event: SocketEvent): void {
        for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    }
}

export interface FetchCall {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | undefined;
}

export interface FakeAnswer {
    status: number;
    body?: unknown;
}

/** A fetch stand-in that records every request. Throwing from the handler simulates a network failure. */
export function fakeFetch(handler: (call: FetchCall) => FakeAnswer | Promise<FakeAnswer>): FetchLike & { calls: FetchCall[] } {
    const calls: FetchCall[] = [];
    const fn: FetchLike = async (url, init) => {
        const call: FetchCall = { url, method: init.method, headers: { ...init.headers }, body: init.body };
        calls.push(call);
        const answer = await handler(call);
        const text = typeof answer.body === 'string' ? answer.body : answer.body === undefined ? '' : JSON.stringify(answer.body);
        return { status: answer.status, text: async () => text };
    };
    return Object.assign(fn, { calls });
}

/** Timers that only fire when the test moves time forward. */
export class ManualTimers implements Timers {
    now = 0;
    private nextId = 1;
    private readonly tasks = new Map<number, { at: number; fn: () => void }>();

    set(fn: () => void, ms: number): unknown {
        const id = this.nextId++;
        this.tasks.set(id, { at: this.now + ms, fn });
        return id;
    }

    clear(handle: unknown): void {
        if (typeof handle === 'number') this.tasks.delete(handle);
    }

    tick(ms: number): void {
        const target = this.now + ms;
        for (;;) {
            let dueId = -1;
            let due: { at: number; fn: () => void } | undefined;
            for (const [id, task] of this.tasks) {
                if (task.at <= target && (!due || task.at < due.at)) {
                    due = task;
                    dueId = id;
                }
            }
            if (!due) break;
            this.tasks.delete(dueId);
            this.now = due.at;
            due.fn();
        }
        this.now = target;
    }

    get pending(): number {
        return this.tasks.size;
    }
}

/** Lets pending promise chains run. */
export async function flush(rounds = 5): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Microphone stand-in. stop() hands over a 2-byte tail, the way MicCapture flushes its last partial chunk. */
export class FakeAudio implements AudioSource {
    started = false;
    stopped = false;
    private onChunk: ((pcm: Uint8Array) => void) | null = null;

    async start(onChunk: (pcm: Uint8Array) => void): Promise<void> {
        this.onChunk = onChunk;
        this.started = true;
    }

    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        this.onChunk?.(new Uint8Array([7, 7]));
    }

    feed(bytes = 3200): void {
        this.onChunk?.(new Uint8Array(bytes));
    }
}

export class FakeSourceNode implements AudioSourceNodeLike {
    buffer: AudioBufferLike | null = null;
    onended: (() => void) | null = null;
    startedAt: number | null = null;
    stopped = false;

    constructor(private readonly context: FakeAudioContext) {}

    connect(): unknown {
        return undefined;
    }

    start(when = 0): void {
        this.startedAt = when;
        this.context.started.push({ at: when, length: (this.buffer as { length?: number } | null)?.length ?? 0 });
    }

    stop(): void {
        this.stopped = true;
        this.onended?.();
    }

    end(): void {
        this.onended?.();
    }
}

export class FakeAudioContext implements AudioContextLike {
    currentTime = 0;
    readonly destination = {};
    readonly started: { at: number; length: number }[] = [];
    readonly sources: FakeSourceNode[] = [];

    createBuffer(_channels: number, length: number, _sampleRate: number): AudioBufferLike & { length: number } {
        return { length, copyToChannel: () => undefined };
    }

    createBufferSource(): FakeSourceNode {
        const node = new FakeSourceNode(this);
        this.sources.push(node);
        return node;
    }
}

/** How a promise settled within `ms` of real time, or 'pending', so a broken test fails instead of hanging. */
export async function settled<T>(promise: Promise<T>, ms = 200): Promise<{ value: T } | { error: unknown } | 'pending'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Promise<'pending'>((resolve) => {
        timer = setTimeout(() => resolve('pending'), ms);
    });
    try {
        return await Promise.race([promise.then((value) => ({ value }), (error: unknown) => ({ error })), pending]);
    } finally {
        clearTimeout(timer);
    }
}

/** A promise the test resolves by hand, for a token that arrives late or never. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

export function fakeClip(samples: number): Clip {
    return {
        contextId: 'clip',
        kind: 'prompt',
        pcm: new Uint8Array(samples * 2),
        encoding: 'pcm_s16le',
        sampleRate: 24000,
        durationMs: Math.round((samples * 1000) / 24000),
        words: [],
        firstAudioMs: 0,
        totalMs: 0,
    };
}
