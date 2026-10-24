import { CARTESIA_API_BASE, CARTESIA_VERSION } from './constants.js';
import { redact } from './events.js';

/** The slice of WHATWG fetch this package uses, so tests and other runtimes can pass their own. */
export type FetchLike = (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface HttpRequest {
    url: string;
    method: HttpMethod;
    headers: Record<string, string>;
    body?: string;
}

export interface HttpResponse {
    status: number;
    text: string;
}

export class CartesiaConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CartesiaConfigError';
    }
}

const ERROR_CODE = /^[a-z]+(?:_[a-z]+){0,7}$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Cartesia's error codes are short snake_case words (quota_exceeded, voice_not_found). Anything else, including
 * anything with digits or shaped like a key, is dropped, so an echoed secret cannot ride along on the error.
 */
export function safeErrorCode(value: unknown): string | null {
    return typeof value === 'string' && value.length <= 64 && ERROR_CODE.test(value) && redact(value) === value ? value : null;
}

/** Keeps only a UUID from a request id (WebSocket ids may add context after it); anything else is dropped. */
export function safeRequestId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const match = UUID.exec(value);
    return match ? match[0].toLowerCase() : null;
}

/**
 * A non-2xx answer. Every string on it is redacted or checked, and request headers are never copied, so neither the
 * key nor a phone number the server echoed can leak through the message or a property.
 */
export class CartesiaHttpError extends Error {
    readonly status: number;
    readonly errorCode: string | null;
    readonly title: string;
    readonly requestId: string | null;

    constructor(status: number, errorCode: unknown, title: string, detail: string, requestId: unknown) {
        super(redact(detail ? `${title}: ${detail}` : title).slice(0, 300));
        this.name = 'CartesiaHttpError';
        this.status = Number.isInteger(status) ? status : 0;
        this.errorCode = safeErrorCode(errorCode);
        this.title = redact(title).slice(0, 120);
        this.requestId = safeRequestId(requestId);
    }
}

/** No answer arrived: a network failure or our timeout. The request may still have reached Cartesia. */
export class CartesiaNetworkError extends Error {
    constructor(cause: unknown) {
        super(redact(cause instanceof Error ? cause.message : String(cause)).slice(0, 200));
        this.name = 'CartesiaNetworkError';
    }
}

/** Query string with %20 for spaces, which is what the keyterm docs ask for (URLSearchParams would send "+"). */
export function encodeQuery(pairs: ReadonlyArray<readonly [string, string]>): string {
    return pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
}

/** A REST request with the API key and the version header. Pure, so it runs in any runtime. Server side only. */
export function buildRequest(
    apiKey: string,
    method: HttpMethod,
    path: string,
    options: { body?: unknown; query?: ReadonlyArray<readonly [string, string]> } = {},
): HttpRequest {
    if (typeof apiKey !== 'string' || apiKey.trim() === '') throw new CartesiaConfigError('CARTESIA_API_KEY is not set.');
    const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey.trim()}`,
        'Cartesia-Version': CARTESIA_VERSION,
    };
    const query = options.query && options.query.length > 0 ? `?${encodeQuery(options.query)}` : '';
    const request: HttpRequest = { url: `${CARTESIA_API_BASE}${path}${query}`, method, headers };
    if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        request.body = JSON.stringify(options.body);
    }
    return request;
}

/** Reads Cartesia's structured error body (error_code, title, message, request_id) without trusting its shape. */
export function httpError(status: number, bodyText: string): CartesiaHttpError {
    let errorCode: string | null = null;
    let title = `HTTP ${status}`;
    let detail = '';
    let requestId: string | null = null;
    try {
        const data: unknown = JSON.parse(bodyText);
        if (data && typeof data === 'object') {
            const record = data as Record<string, unknown>;
            if (typeof record.error_code === 'string') errorCode = record.error_code;
            if (typeof record.title === 'string') title = record.title;
            if (typeof record.message === 'string') detail = record.message;
            if (typeof record.request_id === 'string') requestId = record.request_id;
        }
    } catch {
        detail = bodyText.slice(0, 200);
    }
    return new CartesiaHttpError(status, errorCode, title, detail, requestId);
}

/** Calls the runtime's fetch at call time, so a test that replaces it is always respected. */
export const defaultFetch: FetchLike = (url, init) => {
    const fetchFn = (globalThis as { fetch?: unknown }).fetch;
    if (typeof fetchFn !== 'function') throw new CartesiaConfigError('This runtime has no fetch. Pass one in.');
    return (fetchFn as FetchLike)(url, init);
};

/** Sends once and never retries. Callers decide, because a request that timed out may still have landed. */
export async function send(request: HttpRequest, fetchFn: FetchLike = defaultFetch, timeoutMs = 15_000): Promise<HttpResponse> {
    const init: Parameters<FetchLike>[1] = { method: request.method, headers: request.headers };
    if (request.body !== undefined) init.body = request.body;
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') init.signal = AbortSignal.timeout(timeoutMs);
    let response: Awaited<ReturnType<FetchLike>>;
    try {
        response = await fetchFn(request.url, init);
    } catch (error) {
        throw new CartesiaNetworkError(error);
    }
    let text = '';
    try {
        text = await response.text();
    } catch {
        text = '';
    }
    return { status: response.status, text };
}

/** The parsed JSON body of a 2xx answer, or a CartesiaHttpError. */
export function okJson<T>(response: HttpResponse): T {
    if (response.status < 200 || response.status >= 300) throw httpError(response.status, response.text);
    try {
        return JSON.parse(response.text) as T;
    } catch {
        throw new CartesiaHttpError(response.status, null, 'Unreadable response', 'the body was not JSON', null);
    }
}
