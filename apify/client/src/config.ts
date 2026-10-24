/** Standby base URL of the public RAG Web Browser Actor. Requests go to `<base>/search`. */
export const DEFAULT_RAG_WEB_BROWSER_URL = 'https://rag-web-browser.apify.actor';

/** The Apify REST API, used for the Google Maps Scraper run. */
export const APIFY_API_BASE = 'https://api.apify.com';

export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConfigError';
    }
}

export interface ApifyConfig {
    /** Apify API token. Server side only: never log it, never send it to a browser. */
    token: string;
    /** Standby base URL of our form-errand Actor, or undefined when FORM_ERRAND_URL is not set. */
    formErrandUrl?: string;
    /** Standby base URL of RAG Web Browser, without the /search path. */
    ragWebBrowserUrl: string;
}

// Visible ASCII only. A space or line break in a header value makes fetch throw an error that quotes the value,
// which would put the token in a log, so a bad token is refused here instead.
const TOKEN_SHAPE = /^[\x21-\x7e]+$/;

/** Throws when the token is empty or would corrupt the Authorization header. Never echoes the token. */
export function checkToken(token: unknown, name = 'APIFY_TOKEN'): string {
    if (typeof token !== 'string' || token.length === 0) throw new ConfigError(`${name} is not set.`);
    if (!TOKEN_SHAPE.test(token)) throw new ConfigError(`${name} contains spaces, line breaks or other characters a token cannot have.`);
    return token;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Checks a Standby base URL and returns it without a trailing slash. The value itself is never echoed in an
 * error, in case someone pasted a URL with `?token=` in it.
 */
export function parseBaseUrl(raw: string, name: string): string {
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        throw new ConfigError(`${name} is not a valid URL.`);
    }
    if (url.username || url.password) throw new ConfigError(`${name} must not contain a user name or password.`);
    if (url.search || url.hash) {
        throw new ConfigError(`${name} must not have a query string or fragment. The token goes in APIFY_TOKEN.`);
    }
    // The token travels in a header, so it must never go over plain http to anything but this machine.
    const local = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
    if (url.protocol !== 'https:' && !local) throw new ConfigError(`${name} must use https (http only for localhost).`);
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

function optional(value: string | undefined): string | undefined {
    const trimmed = (value ?? '').trim();
    return trimmed === '' ? undefined : trimmed;
}

/** Checks a RAG Web Browser base URL. Accepts the base or the full /search endpoint. */
export function parseRagBaseUrl(raw: string): string {
    return parseBaseUrl(raw, 'RAG_WEB_BROWSER_URL').replace(/\/search$/, '');
}

/**
 * Reads APIFY_TOKEN (required), FORM_ERRAND_URL (optional) and RAG_WEB_BROWSER_URL (optional) from the
 * environment. An empty value counts as unset. Errors name the variable and never its value.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): ApifyConfig {
    const rawToken = optional(env.APIFY_TOKEN);
    if (!rawToken) throw new ConfigError('APIFY_TOKEN is not set. Copy .env.example to .env.local and fill it in.');
    const token = checkToken(rawToken);

    const formErrand = optional(env.FORM_ERRAND_URL);
    const rag = optional(env.RAG_WEB_BROWSER_URL);
    const ragWebBrowserUrl = rag ? parseRagBaseUrl(rag) : DEFAULT_RAG_WEB_BROWSER_URL;

    return {
        token,
        ragWebBrowserUrl,
        ...(formErrand ? { formErrandUrl: parseBaseUrl(formErrand, 'FORM_ERRAND_URL') } : {}),
    };
}
