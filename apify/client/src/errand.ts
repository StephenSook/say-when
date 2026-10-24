import { ConfigError, checkToken, parseBaseUrl, type ApifyConfig } from './config.js';
import type { ErrandResult, ErrandStatus, FieldInput, RefusalCode } from './errand-types.js';
import { elapsedMs, emit, type EventSink } from './events.js';
import { ApifyHttpError, endpointOf, requestJson, type FetchLike } from './http.js';

export type ErrandRoute = 'inspect' | 'preview' | 'submit';

/** Options the Actor accepts on preview and submit. Meanings follow apify/form-errand/README.md. */
export interface ErrandOptions {
    /** Visible name of the send button. The Actor's default is "Submit". */
    submitButtonText?: string;
    /** Plain phrases that show the form was received, matched without regard to case. Never a regular expression. */
    confirmationPhrases?: string[];
    /** Note added to one paragraph answer so the recipient knows how it was sent. An empty string turns it off. */
    disclosureText?: string;
    /** Which paragraph question gets the note. */
    disclosureField?: string;
    /** Return the screenshot inline as base64. The Actor's default is true. */
    includeScreenshot?: boolean;
}

export interface InspectRequest {
    /** HTTPS form address, or "demo" for the Actor's built-in demo form. */
    formUrl: string;
}

export interface PreviewRequest extends ErrandOptions {
    /** HTTPS form address, or "demo" for the Actor's built-in demo form. */
    formUrl: string;
    fields: FieldInput[];
}

export interface SubmitRequest extends PreviewRequest {
    /** Must be the literal true, set only after the person confirmed the spoken read-back. */
    confirm: true;
    /** The previewDigest the person heard: 16 hex characters. */
    confirmDigest: string;
}

export interface FormErrandClientOptions {
    /** Standby base URL of the Actor, the FORM_ERRAND_URL value. */
    url: string;
    token: string;
    fetch?: FetchLike;
    onEvent?: EventSink;
    /** Per-route limits in ms. Defaults: inspect 60 s, preview 60 s, submit 120 s. */
    timeoutsMs?: Partial<Record<ErrandRoute, number>>;
    /** Extra attempts for inspect and preview after a 429, a 5xx or a network error. Default 2. Submit never retries. */
    retries?: number;
    /** Wait before the first retry; doubles each time, capped at 4 s. Default 500. */
    retryBaseMs?: number;
}

export interface ErrandCallOptions {
    signal?: AbortSignal;
}

export type UnknownOutcomeReason = 'timeout' | 'network' | 'aborted' | 'server_error' | 'bad_response';

/**
 * The submit may or may not have gone through: it timed out, the connection dropped, the caller cancelled it
 * after it left, or the server answered in a way that proves neither. Do not resend. Check the errand row or
 * the form's responses first. The Actor also refuses the same digest for ten minutes, so a resend inside that
 * window comes back as "duplicate" rather than a second submission.
 */
export class UnknownOutcomeError extends Error {
    readonly reason: UnknownOutcomeReason;
    readonly status: number | null;
    readonly code?: string;

    constructor(reason: UnknownOutcomeReason, status: number | null, code?: string) {
        const detail = status === null ? reason : `${reason}, HTTP ${status}`;
        super(
            `The form submit may or may not have gone through (${detail}). ` +
                "Check the errand row or the form's responses before trying again.",
        );
        this.name = 'UnknownOutcomeError';
        this.reason = reason;
        this.status = status;
        if (code) this.code = code;
    }
}

const DEFAULT_TIMEOUTS_MS: Record<ErrandRoute, number> = { inspect: 60_000, preview: 60_000, submit: 120_000 };

const RESULT_STATUSES = new Set<ErrandStatus>(['inspected', 'previewed', 'submitted', 'duplicate', 'refused', 'failed']);

// Event details use only codes from this list, so an odd reply can never put free text on the dashboard.
// A Record makes the compiler insist every RefusalCode is listed.
const KNOWN_REFUSALS: Record<RefusalCode, true> = {
    bad_input: true,
    bad_url: true,
    load_failed: true,
    captcha: true,
    login: true,
    payment: true,
    upload: true,
    no_form: true,
    not_allowed: true,
    unmatched_fields: true,
    missing_required: true,
    not_confirmed: true,
    digest_mismatch: true,
    no_submit_button: true,
    no_confirmation: true,
};
const REFUSAL_CODES = new Set<string>(Object.keys(KNOWN_REFUSALS));

// Statuses the platform or the server send before any errand runs, so a submit that got one was not sent.
const REFUSED_BEFORE_RUN = new Set([400, 401, 402, 403, 404, 405, 413, 429]);

const OPTION_KEYS = ['submitButtonText', 'confirmationPhrases', 'disclosureText', 'disclosureField', 'includeScreenshot'] as const;

const DIGEST_SHAPE = /^[0-9a-f]{16}$/;

/** Loose shape check: enough to trust the fields we read, without rejecting fields the Actor adds later. */
function isErrandResult(value: unknown): value is ErrandResult {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const v = value as Record<string, unknown>;
    const refusalOk =
        v.refusal === null || (typeof v.refusal === 'object' && typeof (v.refusal as Record<string, unknown>).code === 'string');
    return (
        typeof v.status === 'string' &&
        RESULT_STATUSES.has(v.status as ErrandStatus) &&
        Array.isArray(v.questions) &&
        Array.isArray(v.readBack) &&
        Array.isArray(v.unmatched) &&
        Array.isArray(v.missingRequired) &&
        refusalOk
    );
}

function checkFormUrl(formUrl: unknown): string {
    if (typeof formUrl !== 'string' || formUrl.trim() === '') throw new TypeError('formUrl must be a non-empty string.');
    return formUrl;
}

function checkFields(fields: unknown): FieldInput[] {
    if (!Array.isArray(fields) || fields.length === 0) throw new TypeError('fields must list at least one answer.');
    return fields as FieldInput[];
}

function optionsOf(req: ErrandOptions): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of OPTION_KEYS) if (req[key] !== undefined) out[key] = req[key];
    return out;
}

function checkedTimeouts(timeouts: Partial<Record<ErrandRoute, number>> | undefined): Record<ErrandRoute, number> {
    const out = { ...DEFAULT_TIMEOUTS_MS };
    for (const route of Object.keys(out) as ErrandRoute[]) {
        const value = timeouts?.[route];
        if (value === undefined) continue;
        if (!Number.isFinite(value) || value <= 0) throw new TypeError(`timeoutsMs.${route} must be a positive number of ms.`);
        out[route] = value;
    }
    return out;
}

/** Turns a failed submit into UnknownOutcomeError unless the error proves nothing was sent. */
function asSubmitError(error: unknown): unknown {
    if (!(error instanceof ApifyHttpError)) return error;
    // Cancelled before the request left: nothing was sent.
    if (error.attempts === 0) return error;
    // Refused by the platform or the server before any errand ran.
    if (error.kind === 'http' && error.status !== null && REFUSED_BEFORE_RUN.has(error.status)) return error;
    switch (error.kind) {
        case 'timeout':
            return new UnknownOutcomeError('timeout', error.status);
        case 'network':
            return new UnknownOutcomeError('network', null, error.code);
        case 'aborted':
            return new UnknownOutcomeError('aborted', null);
        case 'bad_response':
            return new UnknownOutcomeError('bad_response', error.status);
        case 'http':
            return new UnknownOutcomeError('server_error', error.status);
    }
}

function errorLabel(error: unknown): string {
    if (error instanceof UnknownOutcomeError) return `unknown outcome (${error.reason})`;
    if (error instanceof ApifyHttpError) return error.kind === 'http' ? `http ${error.status}` : error.kind.replace('_', ' ');
    if (error instanceof ConfigError) return 'config';
    return 'error';
}

/**
 * Client for our form-errand Actor in Standby. Inspect and preview are reads and retry on transient errors.
 * Submit is an outward action: it is sent once, never retried, and any doubt about whether it arrived
 * becomes UnknownOutcomeError.
 */
export class FormErrandClient {
    readonly url: string;
    // Private so the token never shows up in JSON.stringify or a logged client object.
    readonly #token: string;
    readonly #fetch: FetchLike | undefined;
    readonly #onEvent: EventSink | undefined;
    readonly #timeouts: Record<ErrandRoute, number>;
    readonly #retries: number | undefined;
    readonly #retryBaseMs: number | undefined;

    constructor(opts: FormErrandClientOptions) {
        this.url = parseBaseUrl(opts.url, 'FORM_ERRAND_URL');
        this.#token = checkToken(opts.token);
        this.#fetch = opts.fetch;
        this.#onEvent = opts.onEvent;
        this.#timeouts = checkedTimeouts(opts.timeoutsMs);
        this.#retries = opts.retries;
        this.#retryBaseMs = opts.retryBaseMs;
    }

    /** Builds a client from loadConfig() output. Throws ConfigError when FORM_ERRAND_URL is not set. */
    static fromConfig(config: ApifyConfig, opts: Omit<FormErrandClientOptions, 'url' | 'token'> = {}): FormErrandClient {
        if (!config.formErrandUrl) {
            throw new ConfigError("FORM_ERRAND_URL is not set. Copy the Standby URL from the Actor's Endpoints tab into .env.local.");
        }
        return new FormErrandClient({ ...opts, url: config.formErrandUrl, token: config.token });
    }

    /** Lists the form's questions. Read-only. */
    async inspect(req: InspectRequest, call: ErrandCallOptions = {}): Promise<ErrandResult> {
        return this.#call('inspect', { formUrl: checkFormUrl(req.formUrl) }, call);
    }

    /** Fills the form, reads every value back off the page and returns the digest. Never sends. */
    async preview(req: PreviewRequest, call: ErrandCallOptions = {}): Promise<ErrandResult> {
        const body = { formUrl: checkFormUrl(req.formUrl), fields: checkFields(req.fields), ...optionsOf(req) };
        return this.#call('preview', body, call);
    }

    /**
     * Sends the form, once. Checks confirm and the digest before anything leaves this process. Read the result:
     * "submitted" and "duplicate" mean it went through once; "refused" means nothing was sent; "failed" with
     * refusal code "no_confirmation" means send was pressed but no confirmation appeared, so treat it like
     * UnknownOutcomeError and do not resend.
     */
    async submit(req: SubmitRequest, call: ErrandCallOptions = {}): Promise<ErrandResult> {
        if (req.confirm !== true) {
            throw new TypeError('submit needs confirm: true, set only after the person confirmed the read-back.');
        }
        if (typeof req.confirmDigest !== 'string' || !DIGEST_SHAPE.test(req.confirmDigest)) {
            throw new TypeError('confirmDigest must be the 16 hex characters from the preview.');
        }
        const body = {
            formUrl: checkFormUrl(req.formUrl),
            fields: checkFields(req.fields),
            confirm: true,
            confirmDigest: req.confirmDigest,
            ...optionsOf(req),
        };
        return this.#call('submit', body, call);
    }

    async #call(route: ErrandRoute, body: Record<string, unknown>, call: ErrandCallOptions): Promise<ErrandResult> {
        const started = performance.now();
        emit(this.#onEvent, { stage: 'errand', status: 'started', detail: route, ms: 0 });
        let result: ErrandResult;
        try {
            result = await this.#send(route, body, call.signal);
        } catch (error) {
            const thrown = route === 'submit' ? asSubmitError(error) : error;
            emit(this.#onEvent, { stage: 'errand', status: 'error', detail: `${route} ${errorLabel(thrown)}`, ms: elapsedMs(started) });
            throw thrown;
        }
        const bad = result.status === 'refused' || result.status === 'failed';
        const code = result.refusal ? (REFUSAL_CODES.has(result.refusal.code) ? result.refusal.code : 'unknown') : null;
        emit(this.#onEvent, {
            stage: 'errand',
            status: bad ? 'error' : 'ok',
            detail: `${route} ${result.status}${code ? `: ${code}` : ''}`,
            ms: elapsedMs(started),
            counts: {
                questions: result.questions.length,
                readBack: result.readBack.length,
                unmatched: result.unmatched.length,
                missingRequired: result.missingRequired.length,
            },
        });
        return result;
    }

    async #send(route: ErrandRoute, body: Record<string, unknown>, signal: AbortSignal | undefined): Promise<ErrandResult> {
        const url = `${this.url}/${route}`;
        const res = await requestJson({
            service: 'form-errand',
            method: 'POST',
            url,
            token: this.#token,
            body,
            timeoutMs: this.#timeouts[route],
            idempotent: route !== 'submit',
            retries: this.#retries,
            retryBaseMs: this.#retryBaseMs,
            // The Actor answers invalid input with HTTP 400 and a normal refused ErrandResult.
            passStatuses: [400],
            signal,
            fetch: this.#fetch,
        });
        if (isErrandResult(res.body)) return res.body;
        throw new ApifyHttpError({
            service: 'form-errand',
            endpoint: endpointOf('POST', url),
            kind: res.status === 400 ? 'http' : 'bad_response',
            status: res.status,
            bodySnippet: res.snippet ?? 'The body was not an errand result.',
            attempts: res.attempts,
        });
    }
}
