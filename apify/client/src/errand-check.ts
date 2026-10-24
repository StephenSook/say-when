import type { ErrandStatus, QuestionInfo, RefusalCode } from './errand-types.js';

export type Route = 'inspect' | 'preview' | 'submit';

// What each route can answer. Submit never reports "previewed", preview never "submitted", and so on.
const ROUTE_STATUSES: Record<Route, ReadonlySet<ErrandStatus>> = {
    inspect: new Set<ErrandStatus>(['inspected', 'refused']),
    preview: new Set<ErrandStatus>(['previewed', 'refused']),
    submit: new Set<ErrandStatus>(['submitted', 'duplicate', 'refused', 'failed']),
};

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
    click_uncertain: true,
};
export const REFUSAL_CODES: ReadonlySet<string> = new Set(Object.keys(KNOWN_REFUSALS));

/** Codes that mean the send button may have been pressed: they only come with status "failed". */
export const UNCERTAIN_CODES: ReadonlySet<string> = new Set<RefusalCode>(['no_confirmation', 'click_uncertain']);

const QUESTION_KINDS: ReadonlySet<string> = new Set<QuestionInfo['kind']>(['text', 'paragraph', 'select', 'checkbox', 'choice', 'checkboxes']);

// Bounds on what we hold from one reply. The Actor accepts at most 40 answers.
export const LIMITS = { text: 20_000, answers: 50, items: 500, options: 500, base64: 16_000_000 } as const;

const DIGEST_SHAPE = /^[0-9a-f]{16}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

class Invalid extends Error {}

function str(o: Obj, key: string, where: string, max: number = LIMITS.text): string {
    const v = o[key];
    if (typeof v !== 'string') throw new Invalid(`${where}${key} is not a string`);
    if (v.length > max) throw new Invalid(`${where}${key} is too long`);
    return v;
}

function strOrNull(o: Obj, key: string, where = ''): string | null {
    return o[key] === null ? null : str(o, key, where);
}

function numOrNull(o: Obj, key: string, where: string): void {
    const v = o[key];
    if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) throw new Invalid(`${where}${key} is not a number or null`);
}

function list(o: Obj, key: string, max: number): unknown[] {
    const v = o[key];
    if (!Array.isArray(v)) throw new Invalid(`${key} is not a list`);
    if (v.length > max) throw new Invalid(`${key} has too many entries`);
    return v;
}

function strings(o: Obj, key: string, max: number): void {
    list(o, key, max).forEach((item, i) => {
        if (typeof item !== 'string' || item.length > LIMITS.text) throw new Invalid(`${key}[${i}] is not a short string`);
    });
}

function check(v: unknown, route: Route): void {
    if (!isObj(v)) throw new Invalid('the reply is not an object');
    const status = str(v, 'status', '');
    if (!ROUTE_STATUSES[route].has(status as ErrandStatus)) throw new Invalid(`status is not one ${route} can return`);
    if (v.mode !== route) throw new Invalid('mode does not match the route');
    str(v, 'formUrl', '');
    strOrNull(v, 'finalUrl');
    strOrNull(v, 'formTitle');
    if (typeof v.fillAllowed !== 'boolean') throw new Invalid('fillAllowed is not true or false');

    list(v, 'questions', LIMITS.items).forEach((q, i) => {
        const where = `questions[${i}].`;
        if (!isObj(q)) throw new Invalid(`questions[${i}] is not an object`);
        str(q, 'label', where);
        if (typeof q.kind !== 'string' || !QUESTION_KINDS.has(q.kind)) throw new Invalid(`${where}kind is not a known kind`);
        if (typeof q.required !== 'boolean') throw new Invalid(`${where}required is not true or false`);
        if (q.options !== undefined) strings(q, 'options', LIMITS.options);
    });
    list(v, 'readBack', LIMITS.answers).forEach((item, i) => {
        const where = `readBack[${i}].`;
        if (!isObj(item)) throw new Invalid(`readBack[${i}] is not an object`);
        str(item, 'label', where);
        str(item, 'value', where);
        str(item, 'matchedBy', where);
        if (item.source !== undefined) str(item, 'source', where);
    });
    const readBackText = strOrNull(v, 'readBackText');
    const digest = strOrNull(v, 'previewDigest');
    if (digest !== null && !DIGEST_SHAPE.test(digest)) throw new Invalid('previewDigest is not 16 hex characters');
    strings(v, 'unmatched', LIMITS.answers);
    strings(v, 'missingRequired', LIMITS.items);

    let code: string | null = null;
    if (v.refusal !== null) {
        if (!isObj(v.refusal)) throw new Invalid('refusal is not an object or null');
        code = str(v.refusal, 'code', 'refusal.');
        if (!REFUSAL_CODES.has(code)) throw new Invalid('refusal.code is not a known code');
        str(v.refusal, 'reason', 'refusal.');
    }
    const confirmation = strOrNull(v, 'confirmationText');
    strOrNull(v, 'screenshotKey');
    strOrNull(v, 'screenshotUrl');
    if (v.screenshotBase64 !== undefined) str(v, 'screenshotBase64', '', LIMITS.base64);
    if (!isObj(v.timings)) throw new Invalid('timings is not an object');
    for (const key of ['loadMs', 'fillMs', 'submitMs']) numOrNull(v.timings, key, 'timings.');
    if (typeof v.timings.totalMs !== 'number' || !Number.isFinite(v.timings.totalMs)) throw new Invalid('timings.totalMs is not a number');
    const submittedAt = strOrNull(v, 'submittedAt');

    // What each status promises.
    if ((status === 'refused' || status === 'failed') !== (code !== null)) throw new Invalid('refusal does not match the status');
    if (status === 'failed' && !UNCERTAIN_CODES.has(code ?? '')) throw new Invalid('a failed result has a refusal code that is not an unknown outcome');
    if (status === 'refused' && UNCERTAIN_CODES.has(code ?? '')) throw new Invalid('a refused result has an unknown-outcome code');
    if (status === 'previewed' && (digest === null || readBackText === null)) throw new Invalid('a preview has no digest or read-back');
    if (status === 'submitted' && (digest === null || !confirmation || submittedAt === null)) {
        throw new Invalid('a submitted result has no digest, confirmation or time');
    }
    if (status === 'duplicate' && submittedAt === null) throw new Invalid('a duplicate has no time');
}

/**
 * Checks a reply against every field of ErrandResult and against what the route can return.
 * Returns null when it is valid, otherwise a short description that never quotes the reply's text.
 */
export function checkErrandResult(value: unknown, route: Route): string | null {
    try {
        check(value, route);
        return null;
    } catch (error) {
        if (error instanceof Invalid) return error.message;
        throw error;
    }
}
