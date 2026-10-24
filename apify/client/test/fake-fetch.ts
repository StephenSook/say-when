import type { FetchLike } from '../src/http.js';

export interface SeenCall {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
    redirect: RequestInit['redirect'];
    signal: AbortSignal | undefined;
}

export type Reply = (call: SeenCall) => Response | Promise<Response>;

/** A fetch stand-in that records every call and answers with the next reply; the last reply repeats. */
export function fakeFetch(...replies: Reply[]): { fetch: FetchLike; calls: SeenCall[] } {
    const calls: SeenCall[] = [];
    const fetch: FetchLike = async (input, init = {}) => {
        const call: SeenCall = {
            url: input,
            method: init.method ?? 'GET',
            headers: Object.fromEntries(new Headers(init.headers).entries()),
            body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
            redirect: init.redirect,
            signal: init.signal ?? undefined,
        };
        calls.push(call);
        const reply = replies[Math.min(calls.length, replies.length) - 1];
        if (!reply) throw new Error('fakeFetch was given no replies');
        return reply(call);
    };
    return { fetch, calls };
}

export const json =
    (body: unknown, status = 200, headers: Record<string, string> = {}): Reply =>
    () =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const text =
    (body: string, status: number): Reply =>
    () =>
        new Response(body, { status });

/** Never answers; rejects only when the request is aborted, the way real fetch does. */
export const hang: Reply = (call) =>
    new Promise((_, reject) => {
        call.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')), {
            once: true,
        });
    });

/** Never answers and ignores the abort signal, to prove the client still gives up on time. */
export const deaf: Reply = () => new Promise<Response>(() => undefined);

/** Fails the way undici does: a TypeError("fetch failed") whose cause carries a code. */
export const networkError =
    (code = 'ECONNRESET'): Reply =>
    () =>
        Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`read ${code}`), { code }) }));

/** Records each backoff wait instead of sleeping. */
export function recordSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
    const waits: number[] = [];
    return {
        waits,
        sleep: async (ms: number) => {
            waits.push(ms);
        },
    };
}

export const TOKEN = 'apify_api_TESTtoken0000000000000000000000';
