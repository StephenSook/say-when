import { checkToken } from './config.js';

/** The slice of fetch this package uses, so tests can pass a fake. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type HttpErrorKind = 'http' | 'timeout' | 'network' | 'aborted' | 'bad_response';

export interface HttpErrorInit {
    service: string;
    endpoint: string;
    kind: HttpErrorKind;
    status: number | null;
    bodySnippet?: string;
    attempts: number;
    code?: string;
    timeoutMs?: number;
}

/**
 * A failed call to an Apify endpoint. The message names the service, method, host and path, never the query
 * string (it can hold the partner's question) and never the token, which is also scrubbed from the snippet.
 */
export class ApifyHttpError extends Error {
    readonly service: string;
    /** Method, host and path, for example "GET rag-web-browser.apify.actor/search". */
    readonly endpoint: string;
    readonly kind: HttpErrorKind;
    /** HTTP status, or null when no response arrived. */
    readonly status: number | null;
    /** Up to 300 characters from the response body (the Apify error message when there is one), token removed. */
    readonly bodySnippet: string;
    /** Requests actually started, retries included. 0 means nothing was sent. */
    readonly attempts: number;
    /** Low-level network code such as ECONNREFUSED, when the runtime gave one. */
    readonly code?: string;

    constructor(init: HttpErrorInit) {
        super(describe(init));
        this.name = 'ApifyHttpError';
        this.service = init.service;
        this.endpoint = init.endpoint;
        this.kind = init.kind;
        this.status = init.status;
        this.bodySnippet = init.bodySnippet ?? '';
        this.attempts = init.attempts;
        if (init.code) this.code = init.code;
    }
}

function describe(init: HttpErrorInit): string {
    const where = `${init.service} ${init.endpoint}`;
    const snippet = init.bodySnippet ? `: ${init.bodySnippet}` : '';
    switch (init.kind) {
        case 'http':
            return `${where} answered ${init.status}${snippet}`;
        case 'timeout':
            return init.status === null
                ? `${where} timed out${init.timeoutMs ? ` after ${init.timeoutMs} ms` : ''}`
                : `${where} timed out on the server (${init.status})${snippet}`;
        case 'network':
            return `${where} failed with a network error${init.code ? ` (${init.code})` : ''}`;
        case 'aborted':
            return `${where} was cancelled by the caller`;
        case 'bad_response':
            return `${where} sent a response that could not be used${snippet}`;
    }
}

/** What a non-2xx status means: try again, a timeout that is not worth repeating, or a plain failure. */
export type Verdict = 'retry' | 'timeout' | 'fail';

export interface RequestOptions {
    /** Short service name for messages, for example "rag-web-browser". */
    service: string;
    method: 'GET' | 'POST';
    url: string;
    token: string;
    /** Sent as JSON when present. */
    body?: unknown;
    /** Limit for one attempt, covering the response headers and the whole body. */
    timeoutMs: number;
    /** True only for calls that change nothing outside, so repeating them is harmless. Retries need it. */
    idempotent: boolean;
    /** Extra attempts for idempotent calls after a 429, a 5xx or a network error. Default 2, at most 5. */
    retries?: number;
    /** Wait before the first retry; doubles each time, capped at 4 s. Default 500, as Apify's API docs suggest. */
    retryBaseMs?: number;
    /** Non-2xx statuses whose JSON body is returned instead of thrown, for endpoints that answer refusals with a body. */
    passStatuses?: number[];
    /** Decides what a non-2xx status means. Default: 429 and 5xx retry, everything else fails. */
    classify?: (status: number, text: string) => Verdict;
    signal?: AbortSignal;
    fetch?: FetchLike;
    /** Injected in tests. Must resolve early when the signal aborts. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface HttpResult {
    status: number;
    /** Parsed JSON, or null for an empty body. */
    body: unknown;
    attempts: number;
    /** Scrubbed snippet of the body, set only for a passed-through non-2xx status. */
    snippet?: string;
}

const DEFAULT_RETRIES = 2;
const MAX_RETRIES = 5;
const DEFAULT_RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 4_000;
const SNIPPET_CHARS = 300;

const defaultClassify = (status: number): Verdict => (status === 429 || status >= 500 ? 'retry' : 'fail');

/** Removes the token, and anything shaped like an Apify token, from text that may end up in a log. */
export function scrub(text: string, token: string): string {
    let out = text;
    if (token.length >= 8) out = out.split(token).join('[token]');
    return out
        .replace(/apify_api_[A-Za-z0-9]+/g, '[token]')
        .replace(/([?&]token=)[^&\s"']+/gi, '$1[token]')
        .replace(/(bearer\s+)[^\s"',]+/gi, '$1[token]');
}

/** A short, scrubbed snippet: the Apify error message when the body has one, else the raw text. */
export function snippetOf(text: string, token: string): string {
    let message = text;
    try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const body = parsed as Record<string, unknown>;
            const error = body.error;
            if (error && typeof error === 'object') {
                // Apify API: { error: { type, message } }
                const e = error as Record<string, unknown>;
                const parts = [e.type, e.message].filter((p): p is string => typeof p === 'string' && p !== '');
                if (parts.length > 0) message = parts.join(': ');
            } else if (typeof error === 'string') {
                // Our form-errand server: { error }
                message = error;
            } else if (typeof body.errorMessage === 'string') {
                // RAG Web Browser: { errorMessage }
                message = body.errorMessage;
            }
        }
    } catch {
        // Not JSON; keep the raw text.
    }
    // Scrub before cutting, so a token can never survive half cut off.
    return scrub(message.replace(/\s+/g, ' ').trim(), token).slice(0, SNIPPET_CHARS);
}

/** Method, host and path of a URL, without the query string. */
export function endpointOf(method: string, url: string): string {
    try {
        const u = new URL(url);
        return `${method} ${u.host}${u.pathname}`;
    } catch {
        return method;
    }
}

function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }
        const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal?.addEventListener('abort', done, { once: true });
    });
}

function parseRetryAfter(value: string | null): number | null {
    if (!value) return null;
    const v = value.trim();
    if (/^\d+$/.test(v)) return Number(v) * 1000;
    const at = Date.parse(v);
    return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/** The wait before the next attempt, or null when the server asked for longer than we are willing to wait. */
function backoff(attempt: number, baseMs: number, retryAfterMs: number | null): number | null {
    if (retryAfterMs !== null) return retryAfterMs > RETRY_CAP_MS ? null : retryAfterMs;
    return Math.min(RETRY_CAP_MS, baseMs * 2 ** (attempt - 1));
}

/** A short code like ECONNREFUSED from a fetch failure. Only the code: messages can quote header values. */
function networkCode(error: unknown): string | undefined {
    const candidates = [(error as { cause?: { code?: unknown } })?.cause?.code, (error as { code?: unknown })?.code];
    const code = candidates.find((c): c is string => typeof c === 'string');
    return code && /^[A-Z0-9_]{2,40}$/.test(code) ? code : undefined;
}

type Outcome =
    | { type: 'response'; status: number; text: string; retryAfterMs: number | null }
    | { type: 'timeout' }
    | { type: 'aborted' }
    | { type: 'network'; code?: string };

async function attemptOnce(doFetch: FetchLike, url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Outcome> {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    // Settles when this attempt is stopped, so a fetch that ignores its signal still cannot hang us.
    const stopped = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
    });
    stopped.catch(() => undefined);
    try {
        const pending = doFetch(url, { ...init, signal: controller.signal });
        pending.catch(() => undefined);
        const res = await Promise.race([pending, stopped]);
        const reading = res.text();
        reading.catch(() => undefined);
        const text = await Promise.race([reading, stopped]);
        return { type: 'response', status: res.status, text, retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) };
    } catch (error) {
        if (timedOut) return { type: 'timeout' };
        if (signal?.aborted) return { type: 'aborted' };
        return { type: 'network', code: networkCode(error) };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}

/**
 * One JSON call with a timeout per attempt. Retries happen only when `idempotent` is true, and only after a
 * 429, a 5xx or a network error, never after a timeout: by then the caller's time is already spent.
 * The token goes in the Authorization header only, and redirects are refused so it never follows one.
 */
export async function requestJson(opts: RequestOptions): Promise<HttpResult> {
    const token = checkToken(opts.token, 'The Apify token');
    const doFetch = opts.fetch ?? fetch;
    const sleep = opts.sleep ?? sleepFor;
    const classify = opts.classify ?? defaultClassify;
    const retries = Math.min(MAX_RETRIES, Math.max(0, Math.floor(opts.retries ?? DEFAULT_RETRIES)));
    const maxAttempts = opts.idempotent ? 1 + retries : 1;
    const baseMs = Math.max(0, opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS);
    const endpoint = endpointOf(opts.method, opts.url);
    const fail = (kind: HttpErrorKind, status: number | null, attempts: number, extra: Partial<HttpErrorInit> = {}) =>
        new ApifyHttpError({ service: opts.service, endpoint, kind, status, attempts, ...extra });

    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    let payload: string | undefined;
    if (opts.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(opts.body);
    }
    const init: RequestInit = { method: opts.method, headers, redirect: 'error', ...(payload !== undefined ? { body: payload } : {}) };

    let attempts = 0;
    for (;;) {
        if (opts.signal?.aborted) throw fail('aborted', null, attempts);
        attempts += 1;
        const outcome = await attemptOnce(doFetch, opts.url, init, opts.timeoutMs, opts.signal);

        if (outcome.type === 'timeout') throw fail('timeout', null, attempts, { timeoutMs: opts.timeoutMs });
        if (outcome.type === 'aborted') throw fail('aborted', null, attempts);
        if (outcome.type === 'network') {
            if (attempts < maxAttempts) {
                await sleep(backoff(attempts, baseMs, null) ?? RETRY_CAP_MS, opts.signal);
                continue;
            }
            throw fail('network', null, attempts, outcome.code ? { code: outcome.code } : {});
        }

        const { status, text } = outcome;
        const ok = status >= 200 && status < 300;
        if (ok || opts.passStatuses?.includes(status)) {
            let body: unknown = null;
            if (text.trim() !== '') {
                try {
                    body = JSON.parse(text);
                } catch {
                    throw fail('bad_response', status, attempts, { bodySnippet: snippetOf(text, token) });
                }
            }
            return { status, body, attempts, ...(ok ? {} : { snippet: snippetOf(text, token) }) };
        }

        const verdict = classify(status, text);
        const bodySnippet = snippetOf(text, token);
        if (verdict === 'timeout') throw fail('timeout', status, attempts, { bodySnippet });
        if (verdict === 'retry' && attempts < maxAttempts) {
            const wait = backoff(attempts, baseMs, outcome.retryAfterMs);
            if (wait !== null) {
                await sleep(wait, opts.signal);
                continue;
            }
        }
        throw fail('http', status, attempts, { bodySnippet });
    }
}
