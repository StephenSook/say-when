import { CARTESIA_VERSION, CARTESIA_WS_BASE } from './constants.js';
import { encodeQuery } from './http.js';

export const SOCKET_OPEN = 1;

export interface SocketEvent {
    data?: unknown;
    code?: number;
    reason?: string;
}

/** What both the browser WebSocket and the test fakes provide. */
export interface SocketLike {
    readonly readyState: number;
    binaryType?: string;
    send(data: string | Uint8Array): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: string, listener: (event: SocketEvent) => void): void;
    removeEventListener(type: string, listener: (event: SocketEvent) => void): void;
}

export type SocketFactory = (url: string) => SocketLike;

/** Timer functions, injectable so tests control time. */
export interface Timers {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
}

export const realTimers: Timers = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => {
        if (handle !== null && handle !== undefined) clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
};

/** Opens sockets with the runtime's WebSocket (the browser's, in our pages). */
export const browserSocketFactory: SocketFactory = (url) => {
    const Ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
    if (typeof Ctor !== 'function') throw new Error('This runtime has no WebSocket. Pass a socket factory.');
    return new (Ctor as new (url: string) => unknown)(url) as SocketLike;
};

/** Refuses anything shaped like an API key: browsers only ever hold short-lived access tokens minted on a server. */
export function checkAccessToken(token: unknown): string {
    if (typeof token !== 'string' || token.trim() === '') throw new Error('No access token. Mint one on the server first.');
    if (token.startsWith('sk_car_')) throw new Error('That is an API key, not an access token. API keys stay on the server.');
    return token;
}

/** wss URL with the version and the token as query parameters, since browsers cannot set WebSocket headers. */
export function socketUrl(path: string, token: string, params: ReadonlyArray<readonly [string, string]> = []): string {
    const all: (readonly [string, string])[] = [...params, ['cartesia_version', CARTESIA_VERSION], ['access_token', token]];
    return `${CARTESIA_WS_BASE}${path}?${encodeQuery(all)}`;
}

/** Resolves when the socket opens; rejects if it closes or errors first, or takes longer than `timeoutMs`. */
export function waitForOpen(socket: SocketLike, timeoutMs: number, timers: Timers): Promise<void> {
    if (socket.readyState === SOCKET_OPEN) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            timers.clear(timer);
            socket.removeEventListener('open', onOpen);
            socket.removeEventListener('close', onFail);
            socket.removeEventListener('error', onFail);
        };
        const onOpen = () => {
            cleanup();
            resolve();
        };
        const onFail = () => {
            cleanup();
            reject(new Error('The voice connection did not open.'));
        };
        const timer = timers.set(() => {
            cleanup();
            try {
                socket.close(1000, 'open timeout');
            } catch {
                // Already closing.
            }
            reject(new Error('The voice connection took too long to open.'));
        }, timeoutMs);
        socket.addEventListener('open', onOpen);
        socket.addEventListener('close', onFail);
        socket.addEventListener('error', onFail);
    });
}

/** A unique context or request id. Cartesia does not allow reusing a context id after it expires. */
export function uniqueId(prefix: string, counter: number): string {
    const random = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
    return `${prefix}-${counter}-${random.slice(0, 8)}`;
}
