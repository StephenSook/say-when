import type { Page } from 'playwright';

import type { Refusal, RefusalCode } from './types.js';

/** Sentences written to be spoken aloud through the earpiece. */
export const REASONS: Record<RefusalCode, string> = {
    bad_input: 'The errand request was not valid, so nothing was done.',
    bad_url: 'That form address is not a secure web address, so I did not open it.',
    load_failed: 'The form did not load, so nothing was sent.',
    captcha: 'This form has a CAPTCHA. I never get past those, so it needs a person.',
    login: 'This form needs a sign-in. I do not handle passwords.',
    payment: 'This form asks for payment. I never pay for anything.',
    upload: 'This form wants a file upload. I do not upload files.',
    no_form: 'I could not find a form on that page.',
    not_allowed:
        'This form has not opted in to assisted filling and is not on the allowed list, so I only listed its questions.',
    unmatched_fields: 'Some answers did not match a question on the form, so nothing was sent.',
    missing_required: 'Some required questions are still empty, so nothing was sent.',
    not_confirmed: 'There was no confirm, so nothing was sent.',
    digest_mismatch: 'The form changed since it was read back, so nothing was sent.',
    no_submit_button: 'I could not find the send button, so nothing was sent.',
    no_confirmation: 'I pressed send but did not see a confirmation. Check before trying again.',
    click_uncertain: 'I may have sent it. Check before trying again.',
};

export const refusal = (code: RefusalCode, detail?: string): Refusal => ({
    code,
    reason: detail ? `${REASONS[code]} ${detail}` : REASONS[code],
});

/** Text a form owner puts in the form's description (or a meta tag) to allow assisted filling. */
export const OPT_IN_MARKER = 'form-errand:allow';

const SIGN_IN_HOSTS = [
    'accounts.google.com',
    'login.microsoftonline.com',
    'login.live.com',
    'appleid.apple.com',
    'auth0.com',
    'okta.com',
];

/** Checks the address before any browser opens it. */
export function checkUrl(formUrl: string, opts: { allowLocal: boolean }): Refusal | null {
    if (formUrl.length > 2048) return refusal('bad_url');
    let url: URL;
    try {
        url = new URL(formUrl);
    } catch {
        return refusal('bad_url');
    }
    if (url.username || url.password) return refusal('bad_url');
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.protocol === 'https:' && !local) return null;
    if (opts.allowLocal && local && (url.protocol === 'http:' || url.protocol === 'https:')) return null;
    return refusal('bad_url');
}

/**
 * True when `formUrl` is on one of the allowed prefixes. Both sides are parsed first, so case, default ports,
 * "..", and percent-encoding cannot slip past. The origin must match exactly and the path must equal the
 * prefix path or continue below it: "https://forms.example.com/a" allows "/a/viewform" but not "/ab".
 */
export function matchesAllowedPrefix(formUrl: string, prefixes: string[]): boolean {
    let url: URL;
    try {
        url = new URL(formUrl);
    } catch {
        return false;
    }
    return prefixes.some((raw) => {
        let prefix: URL;
        try {
            prefix = new URL(raw.trim());
        } catch {
            return false;
        }
        if (prefix.protocol !== 'https:' && prefix.protocol !== 'http:') return false;
        if (url.origin !== prefix.origin) return false;
        const base = prefix.pathname.replace(/\/+$/, '');
        return base === '' || url.pathname === base || url.pathname.startsWith(`${base}/`);
    });
}

export function parsePrefixes(value: string | undefined): string[] {
    return (value ?? '')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
}

export function isSignInUrl(rawUrl: string): boolean {
    try {
        const url = new URL(rawUrl);
        const host = url.hostname.toLowerCase();
        if (SIGN_IN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
        return /\/(login|signin|sign-in|sign_in|servicelogin)(\/|$)/i.test(url.pathname);
    } catch {
        return false;
    }
}

/**
 * Looks at the loaded page and returns why we must not touch it, if anything.
 * Order matters: a CAPTCHA or sign-in wall is reported before anything else on the page.
 */
export async function checkPage(page: Page): Promise<Refusal | null> {
    if (isSignInUrl(page.url())) return refusal('login');
    const code = await page.evaluate(() => {
        const q = (selector: string) => document.querySelector(selector);
        const frames = Array.from(document.querySelectorAll('iframe')).map((f) => f.getAttribute('src') ?? '');
        if (
            frames.some((src) => /recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha/i.test(src)) ||
            q('.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]')
        ) {
            return 'captcha';
        }
        if (q('input[type=password]')) return 'login';
        if (
            q('[autocomplete^="cc-"]') ||
            frames.some((src) => /js\.stripe\.com|paypal\.com|braintreegateway|adyen|checkout\.com/i.test(src))
        ) {
            return 'payment';
        }
        if (q('input[type=file]')) return 'upload';
        const fillable = document.querySelectorAll(
            'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]), textarea, select, [role=radio], [role=checkbox], [role=textbox]',
        );
        if (fillable.length === 0) return 'no_form';
        return null;
    });
    return code ? refusal(code as RefusalCode) : null;
}

/** The owner's opt-in: the marker text anywhere on the page, or <meta name="form-errand" content="allow">. */
export async function hasOptInMarker(page: Page): Promise<boolean> {
    return page.evaluate((marker) => {
        const meta = document.querySelector('meta[name="form-errand"]');
        if (meta && (meta.getAttribute('content') ?? '').trim().toLowerCase() === 'allow') return true;
        return (document.body?.innerText ?? '').toLowerCase().includes(marker);
    }, OPT_IN_MARKER);
}
