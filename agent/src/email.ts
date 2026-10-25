// PLAN D25 (Stephen, Oct 25): after a form errand is sent, Eleven emails the care team, for real, through Apify's
// public Send Email Actor (`apify/send-mail`, input `{ to, subject, text }`), with the APIFY_TOKEN the sidecar already
// has. The recipient comes only from ERRAND_EMAIL_TO; unset, the feature is off.
//
// - The email is drafted when the errand's read-back is prepared (src/jobs.ts previewJob), and the read-back then says
//   "and email the care team", so the person's one confirm covers the form and the email. The draft is kept here, in
//   this process only, under the errand id and the preview digest the read-back carried.
// - It is sent only after the module took the errand's Submitted result (src/errands.ts), once, never retried. A form
//   that was not sent, was stopped, refused, failed, or ended with an unknown outcome never sends its email, and a
//   duplicate (the form already had this request) sends none either: the first send's email covers it.
// - Its steps reach the screens as `errand` pipeline steps: "email drafted" from the preview job (`agent_progress`),
//   then "email sending", "email sent" or "email failed: <code>" (`agent_errand_email`, module change for D25). The
//   public rows carry a fixed label and numbers only; the subject, the body and the masked address ride in the private
//   payload, which the board shows only while the room shares text. The full address is never logged or shown.

import type { ReadBackItem } from '@say-when/apify-client';

import { LIMITS } from './contract.js';
import type { AllowedForm } from './types.js';

/** The Apify Store's public Send Email Actor, in the API's `username~name` form. */
export const SEND_MAIL_ACTOR = 'apify~send-mail';
export const APIFY_API = 'https://api.apify.com';

/** What the read-back adds when the email is on. */
export const EMAIL_PHRASE = 'and email the care team';

/** One email address, the shape only: no spaces, no commas, one @, a dotted domain. */
const ADDRESS = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$/;

export function isEmailAddress(value: string): boolean {
    return value.length <= 254 && ADDRESS.test(value);
}

/** "s***@gmail.com": the first character of the name and the domain. The only form of the address any screen sees. */
export function maskEmail(address: string): string {
    const at = address.lastIndexOf('@');
    if (at < 1) return '***';
    return `${address.slice(0, 1)}***@${address.slice(at + 1)}`;
}

/**
 * The read-back with the email in it. The Actor's text ends "Confirm to send." (apify/form-errand buildReadBackText),
 * which becomes "Confirm to send it and email the care team."; any other text gets a sentence on the end.
 */
export function readBackWithEmail(text: string): string {
    const trimmed = text.trimEnd();
    if (trimmed.endsWith('Confirm to send.')) return `${trimmed.slice(0, -'Confirm to send.'.length)}Confirm to send it ${EMAIL_PHRASE}.`;
    return `${trimmed} Sending it also emails the care team.`;
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const fieldKey = (label: string): string => oneLine(label).toLowerCase();

/** The time a request was made, in the person's zone: "Sat, Oct 25, 1:41 AM PDT". */
export function requestTime(nowMs: number, timeZone: string): string {
    return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(nowMs);
}

/** "What do you need? Ride", "Details: lunch at noon": a question label keeps its question mark and takes no colon. */
export function valueLine(label: string, value: string): string {
    const name = oneLine(label).replace(/[\s:]+$/, '');
    const shown = oneLine(value) || '(blank)';
    return name.endsWith('?') ? `${name} ${shown}` : `${name}: ${shown}`;
}

export interface EmailText {
    subject: string;
    text: string;
}

/**
 * The email for one errand, from the values read back off the page (what the person heard and confirmed):
 * - subject "Care team request: Ride": the form's title, then the value of its first field with choices;
 * - the body lists every value read back, the time of the request, and that Eleven sent it on the person's behalf
 *   after they heard it read back and confirmed it.
 */
export function draftEmail(input: { formTitle: string; readBack: readonly ReadBackItem[]; form?: AllowedForm; nowMs: number; timeZone: string }): EmailText {
    const title = oneLine(input.formTitle) || 'Care team request';
    const values = new Map(input.readBack.map((item) => [fieldKey(item.label), oneLine(item.value)] as const));
    const topicField = input.form?.fields.find((field) => Array.isArray(field.choices) && field.choices.length > 0);
    const topic = topicField ? (values.get(fieldKey(topicField.label)) ?? '') : '';
    const subject = (topic ? `${title}: ${topic}` : title).slice(0, 120);
    const lines = input.readBack.filter((item) => oneLine(item.label) !== '').map((item) => valueLine(item.label, item.value));
    const text = [
        `${title}, sent with the Eleven app.`,
        '',
        ...lines,
        '',
        `Requested: ${requestTime(input.nowMs, input.timeZone)}.`,
        'The person heard these values read back and confirmed them before the form and this email were sent. The Eleven app sent both on their behalf.',
    ].join('\n');
    return { subject, text };
}

/** One drafted email. Private: `to` and `text` never reach a log; screens get `toMasked` and the payload only. */
export interface EmailDraft {
    errandId: bigint;
    /** The preview digest of the read-back that said "and email the care team". Only a CONFIRM of it sends this. */
    digest: string;
    to: string;
    toMasked: string;
    subject: string;
    text: string;
    draftedAtMs: number;
}

/** The private payload of an email step, sized for `payload_json`. */
export function emailPayload(draft: EmailDraft, extra: Record<string, string> = {}): Record<string, unknown> {
    return { email: { to: draft.toMasked, subject: draft.subject, text: draft.text.slice(0, 4_000), draftedAt: new Date(draft.draftedAtMs).toISOString(), ...extra } };
}

/** The drafts waiting for their errand, by errand id. Taken once: a draft can never be sent twice. */
export class EmailBook {
    private readonly entries = new Map<string, EmailDraft>();

    constructor(private readonly max = 50) {}

    record(draft: EmailDraft): void {
        const key = draft.errandId.toString();
        this.entries.delete(key);
        this.entries.set(key, draft);
        while (this.entries.size > this.max) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
    }

    has(errandId: bigint): boolean {
        return this.entries.has(errandId.toString());
    }

    /** The draft, removed from the book. */
    take(errandId: bigint): EmailDraft | undefined {
        const key = errandId.toString();
        const draft = this.entries.get(key);
        this.entries.delete(key);
        return draft;
    }
}

export interface MailMessage {
    to: string;
    subject: string;
    text: string;
}

/**
 * - `sent`: the Actor's run SUCCEEDED, so Apify handed the email to its mail service.
 * - `failed`: provably not sent (the run was refused before it started, or the run itself failed).
 * - `unknown`: it may have gone out (the run did not finish in time, or the reply was lost). Never sent again.
 * `code` is a fixed word, never content.
 */
export type MailOutcome = { status: 'sent'; ms: number } | { status: 'failed' | 'unknown'; code: string; ms: number };

/** The mail sender. Never throws. */
export interface MailPort {
    send(message: MailMessage): Promise<MailOutcome>;
}

/** What the sidecar needs for D25. Unset in JobDeps and ErrandRunnerDeps: the feature is off. */
export interface ErrandEmailDeps {
    /** ERRAND_EMAIL_TO. Private. */
    to: string;
    mail: MailPort;
    book: EmailBook;
    forms: readonly AllowedForm[];
    timeZone: string;
    /** Wall clock, epoch ms. */
    now: () => number;
    /** Monotonic clock for durations. */
    clock: () => number;
}

/** The draft and the read-back text that announces it, or null when the read-back with the email is too long to say. */
export function prepareEmail(
    deps: ErrandEmailDeps,
    errand: { errandId: bigint; formKey: string; formTitle: string },
    preview: { readBackText: string; readBack: readonly ReadBackItem[]; previewDigest: string },
): { draft: EmailDraft; readBackText: string } | null {
    const readBackText = readBackWithEmail(preview.readBackText);
    if (readBackText.length > LIMITS.readBackText) return null;
    const nowMs = deps.now();
    const form = deps.forms.find((f) => f.formKey === errand.formKey);
    const { subject, text } = draftEmail({ formTitle: errand.formTitle, readBack: preview.readBack, ...(form ? { form } : {}), nowMs, timeZone: deps.timeZone });
    return {
        readBackText,
        draft: { errandId: errand.errandId, digest: preview.previewDigest, to: deps.to, toMasked: maskEmail(deps.to), subject, text, draftedAtMs: nowMs },
    };
}

/** The slice of fetch the mail sender uses, so tests pass a fake and nothing ever reaches Apify. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApifyMailOptions {
    token: string;
    fetch?: FetchLike;
    /** Default https://api.apify.com. */
    baseUrl?: string;
    /** How long Apify holds the request open for the run to finish (`waitForFinish`, at most 60). Default 30. */
    waitSecs?: number;
    /** The whole request's limit. Default waitSecs + 10 s. */
    timeoutMs?: number;
    clock?: () => number;
}

/** Network codes that mean the request never left this machine or never found the host. */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_INVALID_URL']);

function networkCode(error: unknown): string {
    const candidates = [(error as { cause?: { code?: unknown } })?.cause?.code, (error as { code?: unknown })?.code];
    const code = candidates.find((c): c is string => typeof c === 'string');
    return code && /^[A-Z0-9_]{2,40}$/.test(code) ? code : '';
}

/**
 * Starts one run of `apify/send-mail` and waits for it (POST /v2/acts/apify~send-mail/runs?waitForFinish=N). The token
 * goes in the Authorization header only, redirects are refused, and nothing is retried: a second try could send a
 * second email.
 */
export function apifyMail(options: ApifyMailOptions): MailPort {
    const doFetch = options.fetch ?? fetch;
    const base = (options.baseUrl ?? APIFY_API).replace(/\/+$/, '');
    const waitSecs = Math.min(60, Math.max(1, Math.round(options.waitSecs ?? 30)));
    const timeoutMs = options.timeoutMs ?? waitSecs * 1000 + 10_000;
    const clock = options.clock ?? (() => performance.now());
    const url = `${base}/v2/acts/${SEND_MAIL_ACTOR}/runs?waitForFinish=${waitSecs}`;
    return {
        async send(message: MailMessage): Promise<MailOutcome> {
            const started = clock();
            const ms = () => Math.max(0, Math.round(clock() - started));
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            let res: Response;
            try {
                res = await doFetch(url, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
                    body: JSON.stringify({ to: message.to, subject: message.subject, text: message.text }),
                    redirect: 'error',
                    signal: controller.signal,
                });
            } catch (error) {
                clearTimeout(timer);
                if (controller.signal.aborted) return { status: 'unknown', code: 'timeout', ms: ms() };
                const code = networkCode(error);
                return NOT_SENT_CODES.has(code) ? { status: 'failed', code: 'network', ms: ms() } : { status: 'unknown', code: 'network', ms: ms() };
            }
            let body: unknown = null;
            try {
                const text = await res.text();
                body = text.trim() === '' ? null : JSON.parse(text);
            } catch {
                body = null;
            } finally {
                clearTimeout(timer);
            }
            if (!res.ok) {
                // A refused start (bad token, no credit, bad input, too many requests) ran nothing. A server error may
                // have started the run.
                return res.status >= 500 ? { status: 'unknown', code: `http_${res.status}`, ms: ms() } : { status: 'failed', code: `http_${res.status}`, ms: ms() };
            }
            const run = (body as { data?: { status?: unknown } } | null)?.data;
            const status = typeof run?.status === 'string' ? run.status : '';
            if (status === 'SUCCEEDED') return { status: 'sent', ms: ms() };
            if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') return { status: 'failed', code: 'run_failed', ms: ms() };
            if (status === 'READY' || status === 'RUNNING' || status === 'ABORTING' || status === 'TIMING-OUT') return { status: 'unknown', code: 'still_running', ms: ms() };
            return { status: 'unknown', code: 'bad_response', ms: ms() };
        },
    };
}

/** The sentence a failed or unknown email shows, by its code. */
export function mailSentence(outcome: Exclude<MailOutcome, { status: 'sent' }>): string {
    if (outcome.status === 'unknown') return 'The email may or may not have gone out. It was not sent again.';
    if (outcome.code === 'http_401' || outcome.code === 'http_403') return 'The email service turned the request away, so no email was sent.';
    if (outcome.code === 'http_402') return 'The email service needs credit, so no email was sent.';
    if (outcome.code === 'run_failed') return 'The email service could not send it.';
    return 'The email could not be sent.';
}
