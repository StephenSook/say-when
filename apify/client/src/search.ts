import { createHash } from 'node:crypto';

import { APIFY_API_BASE, ConfigError, loadConfig, parseRagBaseUrl, type ApifyConfig } from './config.js';
import { elapsedMs, emit, type EventSink } from './events.js';
import {
    ApifyHttpError,
    endpointOf,
    requestJson,
    type FetchLike,
    type HttpErrorInit,
    type HttpErrorKind,
    type HttpResult,
    type Verdict,
} from './http.js';

export type SearchSource = 'web' | 'maps';

/** Place facts copied from Google Maps Scraper fields. Each one is set only when its source field was present. */
export interface PlaceFacts {
    /** Star rating (totalScore). Left out when it is missing or 0, since Google has no 0-star rating. */
    rating?: number;
    /** Number of reviews (reviewsCount). */
    reviews?: number;
    /** Open when the place was fetched (wasOpenAtScrapeTime). It says nothing about later; see fetchedAt. */
    openNow?: boolean;
    /** Only ever true. Set only when additionalInfo.Accessibility lists "Wheelchair accessible entrance": true. */
    wheelchairEntrance?: true;
    address?: string;
    phone?: string;
    /** Google category (categoryName), for example "Coffee shop". */
    category?: string;
}

/** One search result, shaped for Moss and for the sources on an option row. */
export interface SearchRow {
    /** Stable id: "web:" plus 16 hex characters of the page URL's sha256, or "maps:" plus the Google placeId. */
    id: string;
    source: SearchSource;
    title: string;
    /** Web: the page as markdown, cut near 20,000 characters. Maps: a short plain summary of the fields present. */
    text: string;
    /** Web: the page that was loaded. Maps: the Google Maps link. */
    url?: string;
    /** Maps only. */
    placeId?: string;
    /** Maps only. */
    location?: { lat: number; lng: number };
    /** ISO 8601 time the page was loaded or the place was scraped. */
    fetchedAt: string;
    /** Web: Google result rank. Maps: 1-based position in the scraper's output. */
    rank?: number;
    /** Maps only. */
    facts?: PlaceFacts;
}

export interface SearchResult {
    rows: SearchRow[];
    /** Wall time of the whole call, retries included. */
    ms: number;
    /** The query as sent. */
    query: string;
    /** True when some results were dropped or may have been cut short. See README "Partial results". */
    partial: boolean;
}

export interface CallOptions {
    /** Defaults to loadConfig(), which reads process.env. */
    config?: ApifyConfig;
    fetch?: FetchLike;
    onEvent?: EventSink;
    /** Cancels the call. A cancelled call rejects with ApifyHttpError kind "aborted". */
    signal?: AbortSignal;
}

export interface WebSearchOptions extends CallOptions {
    /** Extra attempts after a 429, a 5xx or a network error. Default 2. Place search never retries. */
    retries?: number;
    /** Wait before the first retry; doubles each time, capped at 4 s. Default 500. */
    retryBaseMs?: number;
    /** Pages to fetch, 1 to 10. Default 3. Each one adds time and cost. */
    maxResults?: number;
    /** Our limit for one attempt. Default 45,000. Without requestTimeoutSecs, the server gets this minus 5 s. */
    timeoutMs?: number;
    /** The Actor's own limit, 1 to 300. When it runs out it returns the pages that loaded. Default 40. */
    requestTimeoutSecs?: number;
    /** "raw-http" (the Actor's default, faster) or "browser-playwright" (for pages that need JavaScript). */
    scrapingTool?: 'raw-http' | 'browser-playwright';
    /** Wait for dynamic content, browser-playwright only. */
    dynamicContentWaitSecs?: number;
    /** Remove cookie banners, browser-playwright only. The Actor's default is true. */
    removeCookieWarnings?: boolean;
    /** Cap on each page's text. Default 20,000. */
    maxTextChars?: number;
}

export interface PlaceSearchOptions extends CallOptions {
    /** Search around this point. Without it, put the area in the query ("lunch near Berkeley"). */
    near?: { lat: number; lng: number };
    /** Circle radius around `near`. Default 1. */
    radiusKm?: number;
    /** Places to return, 1 to 50. Default 8. Always sent: the scraper reads an empty value as "all places". */
    maxPlaces?: number;
    /** Result language. Default "en". */
    language?: string;
    /**
     * The run's time limit in seconds, 10 to 290. Default 120. A run that reaches it keeps the places it found
     * (`partial: true`). The whole call, start to places, may take up to 30 s longer.
     */
    timeoutSecs?: number;
    /** Run memory in MB, a power of 2 of at least 128. Default 4096. */
    memoryMbytes?: number;
    /** Hard cap on what one run can charge, 0.50 (Apify's minimum) to 5. Default 0.50. */
    maxChargeUsd?: number;
}

const RAG_SERVER_MARGIN_MS = 5_000;
const MAX_QUERY_CHARS = 1_000;
const MAPS_ACTOR = 'compass~crawler-google-places';
/**
 * The lowest charge cap Apify accepts on a Maps run, and our default. A lower one is refused before the run starts:
 * HTTP 400 `max-total-charge-usd-below-minimum`, "Maximum cost per run is less than the allowed minimum of $0.50"
 * (live test, Oct 24; with 0.25 every place search failed). It is a ceiling, not a price: a run is billed per place.
 */
const MAPS_MIN_CHARGE_USD = 0.5;
const MAPS_FIELDS = [
    'title',
    'address',
    'location',
    'totalScore',
    'reviewsCount',
    'wasOpenAtScrapeTime',
    'permanentlyClosed',
    'temporarilyClosed',
    'categoryName',
    'phone',
    'url',
    'placeId',
    'scrapedAt',
    'additionalInfo',
];
const WHEELCHAIR_ENTRANCE = 'Wheelchair accessible entrance';

// Bounds on what one reply may hold: bytes are counted while it streams in, before parsing, and every
// string we keep is capped after. Identifiers that run long are dropped rather than cut.
const RAG_MAX_BYTES = 16 * 1024 * 1024;
const MAPS_MAX_BYTES = 4 * 1024 * 1024;
const MAX_TITLE_CHARS = 300;
const MAX_URL_CHARS = 2_048;
const MAX_ADDRESS_CHARS = 300;
const MAX_CATEGORY_CHARS = 100;
const MAX_PHONE_CHARS = 40;
const MAX_PLACE_ID_CHARS = 200;
const MAX_ACCESSIBILITY_ENTRIES = 100;

// Small readers for untyped JSON.
const record = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
/** An identifier or link kept whole, or dropped when it is too long to be real. */
const ident = (value: unknown, max: number): string => {
    const s = str(value);
    return s.length <= max ? s : '';
};
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const shortHash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

function isoTime(value: unknown): string | null {
    if (typeof value !== 'string' || value === '') return null;
    const at = Date.parse(value);
    return Number.isNaN(at) ? null : new Date(at).toISOString();
}

function cleanQuery(query: unknown, name: string): string {
    if (typeof query !== 'string') throw new TypeError(`${name} must be a string.`);
    const q = query.replace(/\s+/g, ' ').trim();
    if (q === '') throw new RangeError(`${name} is empty.`);
    if (q.length > MAX_QUERY_CHARS) throw new RangeError(`${name} is longer than ${MAX_QUERY_CHARS} characters.`);
    return q;
}

function intInRange(value: number, min: number, max: number, name: string): number {
    if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} must be a whole number from ${min} to ${max}.`);
    return value;
}

function numberInRange(value: number, min: number, max: number, name: string): number {
    if (!Number.isFinite(value) || value < min || value > max) throw new RangeError(`${name} must be from ${min} to ${max}.`);
    return value;
}

/** Cuts long page text, preferring a word boundary within the last 200 characters. */
function capText(value: string, max: number): string {
    if (value.length <= max) return value;
    let cut = value.slice(0, max);
    const space = cut.search(/\s\S*$/);
    if (space > max - 200) cut = cut.slice(0, space);
    // Never end on half of a surrogate pair.
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    return cut.trimEnd();
}

function errorLabel(error: unknown): string {
    if (error instanceof ApifyHttpError) return error.kind === 'http' ? `http ${error.status}` : error.kind.replace('_', ' ');
    if (error instanceof ConfigError) return 'config';
    return 'error';
}

function badShape(service: string, method: string, url: string, status: number, attempts: number, what: string): ApifyHttpError {
    return new ApifyHttpError({ service, endpoint: endpointOf(method, url), kind: 'bad_response', status, bodySnippet: what, attempts });
}

// ---------- Web search: RAG Web Browser in Standby ----------

/** RAG Web Browser answers a timeout with no loaded page as HTTP 500 { errorMessage: "Timed out." }. */
function ragClassify(status: number, text: string): Verdict {
    if (status === 500) {
        try {
            if (record(JSON.parse(text))?.errorMessage === 'Timed out.') return 'timeout';
        } catch {
            // Not JSON: treat like any other 500.
        }
    }
    return status === 429 || status >= 500 ? 'retry' : 'fail';
}

function webTimeouts(opts: WebSearchOptions): { requestTimeoutSecs: number; timeoutMs: number } {
    if (opts.timeoutMs !== undefined) numberInRange(opts.timeoutMs, 1, 600_000, 'timeoutMs');
    if (opts.requestTimeoutSecs !== undefined) {
        const secs = intInRange(opts.requestTimeoutSecs, 1, 300, 'requestTimeoutSecs');
        return { requestTimeoutSecs: secs, timeoutMs: opts.timeoutMs ?? secs * 1000 + RAG_SERVER_MARGIN_MS };
    }
    const timeoutMs = opts.timeoutMs ?? 45_000;
    // Let the server stop first, so it sends back the pages that loaded instead of us dropping everything.
    const secs = Math.min(300, Math.max(1, Math.floor((timeoutMs - RAG_SERVER_MARGIN_MS) / 1000)));
    return { requestTimeoutSecs: secs, timeoutMs };
}

function webRow(raw: unknown, maxTextChars: number): SearchRow | null {
    const item = record(raw);
    const crawl = record(item?.crawl);
    if (!item || !crawl) return null;
    // Only pages that loaded. "pending" and "failed" items, including ones cut off by the timeout, are dropped.
    if (crawl.requestStatus !== 'handled') return null;
    if (finite(crawl.httpStatusCode) && crawl.httpStatusCode >= 400) return null;
    const markdown = str(item.markdown);
    if (!markdown) return null;
    const metadata = record(item.metadata);
    const result = record(item.searchResult);
    const url = ident(metadata?.url, MAX_URL_CHARS) || ident(result?.url, MAX_URL_CHARS);
    if (!url) return null;
    const rankValue = result?.rank;
    const rank = finite(rankValue) ? rankValue : undefined;
    return {
        id: `web:${shortHash(url)}`,
        source: 'web',
        title: capText(str(metadata?.title) || str(result?.title) || url, MAX_TITLE_CHARS),
        text: capText(markdown, maxTextChars),
        url,
        fetchedAt: isoTime(crawl.loadedAt) ?? new Date().toISOString(),
        ...(rank !== undefined ? { rank } : {}),
    };
}

/**
 * Searches Google and scrapes the top pages with RAG Web Browser in Standby. Resolves with the pages that
 * loaded (`partial` is true when any were dropped); rejects with ApifyHttpError when nothing usable came back.
 */
export async function searchWeb(question: string, opts: WebSearchOptions = {}): Promise<SearchResult> {
    const query = cleanQuery(question, 'question');
    const maxResults = intInRange(opts.maxResults ?? 3, 1, 10, 'maxResults');
    const maxTextChars = intInRange(opts.maxTextChars ?? 20_000, 500, 100_000, 'maxTextChars');
    const { requestTimeoutSecs, timeoutMs } = webTimeouts(opts);
    if (opts.scrapingTool !== undefined && opts.scrapingTool !== 'raw-http' && opts.scrapingTool !== 'browser-playwright') {
        throw new RangeError('scrapingTool must be "raw-http" or "browser-playwright".');
    }
    const params = new URLSearchParams({ query, maxResults: String(maxResults), requestTimeoutSecs: String(requestTimeoutSecs) });
    if (opts.scrapingTool) params.set('scrapingTool', opts.scrapingTool);
    if (opts.dynamicContentWaitSecs !== undefined) {
        params.set('dynamicContentWaitSecs', String(intInRange(opts.dynamicContentWaitSecs, 0, 300, 'dynamicContentWaitSecs')));
    }
    if (opts.removeCookieWarnings !== undefined) {
        // Standby passes query values through as strings, so "false" would read as true; an empty value is
        // the only falsy one (actor-rag-web-browser src/utils.ts parseParameters, read Oct 24; not tested live).
        params.set('removeCookieWarnings', opts.removeCookieWarnings ? 'true' : '');
    }
    const config = opts.config ?? loadConfig();
    // Checked again here too, so a hand-built config cannot put a ?token= into the request URL.
    const url = `${parseRagBaseUrl(config.ragWebBrowserUrl)}/search?${params}`;

    const started = performance.now();
    emit(opts.onEvent, { stage: 'search', status: 'started', detail: 'web', ms: 0 });
    try {
        const res = await requestJson({
            service: 'rag-web-browser',
            method: 'GET',
            url,
            token: config.token,
            timeoutMs,
            maxBytes: RAG_MAX_BYTES,
            idempotent: true,
            retries: opts.retries ?? 2,
            retryBaseMs: opts.retryBaseMs,
            classify: ragClassify,
            signal: opts.signal,
            fetch: opts.fetch,
        });
        if (!Array.isArray(res.body)) {
            throw badShape('rag-web-browser', 'GET', url, res.status, res.attempts, 'Expected a JSON array of results.');
        }
        const rows: SearchRow[] = [];
        const seen = new Set<string>();
        let skipped = 0;
        // Never more than we asked for, however many items the reply holds.
        for (const raw of res.body.slice(0, maxResults)) {
            const row = webRow(raw, maxTextChars);
            if (!row) {
                skipped += 1;
            } else if (!seen.has(row.id)) {
                seen.add(row.id);
                rows.push(row);
            }
        }
        const ms = elapsedMs(started);
        const partial = skipped > 0;
        emit(opts.onEvent, { stage: 'search', status: 'ok', detail: partial ? 'web partial' : 'web', ms, counts: { rows: rows.length, skipped } });
        return { rows, ms, query, partial };
    } catch (error) {
        emit(opts.onEvent, { stage: 'search', status: 'error', detail: `web ${errorLabel(error)}`, ms: elapsedMs(started) });
        throw error;
    }
}

// ---------- Place search: Google Maps Scraper, started as a run whose dataset is then read ----------

// 408: the API gave up on the request; not worth repeating, the caller's time is spent. Starting a run (and
// aborting one) is never retried, since each POST can start or change a paid run (see searchPlaces).
const mapsClassify = (status: number): Verdict => (status === 408 ? 'timeout' : 'fail');
// Reading a run's status or its dataset changes nothing, so a 429 or a 5xx is tried again, inside the deadline.
const mapsReadClassify = (status: number): Verdict => (status === 408 ? 'timeout' : status === 429 || status >= 500 ? 'retry' : 'fail');

/** Apify's longest server-side wait for a run to finish, on the start call and on the status call. */
const MAPS_WAIT_MAX_SECS = 60;
/** The first wait asks for the run's limit plus this, so a run that starts a little late can still end inside it. */
const MAPS_WAIT_EXTRA_SECS = 5;
/** Kept back from every later wait, for its reply and for reading the dataset after the run ends. */
const MAPS_REPLY_MARGIN_MS = 5_000;
/** The whole call may take the run's limit plus this: starting the run, waiting for it and reading its places. */
const MAPS_CLIENT_MARGIN_SECS = 30;
/** Status calls after the start, at most. Waits of up to 60 s cover the longest run limit (290 s) in six. */
const MAPS_MAX_POLLS = 8;
/** A run object is a few KB; a far bigger one is refused while it streams in. */
const MAPS_RUN_MAX_BYTES = 1024 * 1024;
/** The best-effort abort of a run we stopped waiting for gets this long, on its own. */
const MAPS_ABORT_TIMEOUT_MS = 5_000;
/** Apify run and dataset ids are short and alphanumeric. They go into URL paths, so nothing else is accepted. */
const APIFY_ID = /^[A-Za-z0-9]{1,64}$/;
const RUN_STATUSES = new Set(['READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMING-OUT', 'TIMED-OUT', 'ABORTING', 'ABORTED']);
const RUN_FINISHED = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);
// Endpoints as errors name them. A run id or dataset id is a capability (the run object and its storages can be
// read with the id alone), so errors name the route, never the ids.
const MAPS_START_ENDPOINT = endpointOf('POST', `${APIFY_API_BASE}/v2/actors/${MAPS_ACTOR}/runs`);
const MAPS_RUN_ENDPOINT = endpointOf('GET', `${APIFY_API_BASE}/v2/actor-runs/:runId`);
const MAPS_ITEMS_ENDPOINT = endpointOf('GET', `${APIFY_API_BASE}/v2/datasets/:datasetId/items`);

interface MapsRun {
    id: string;
    status: string;
    datasetId: string;
}

/** The fields of an Apify run object we use, or null when any of them is missing or malformed. */
function mapsRun(body: unknown): MapsRun | null {
    const data = record(record(body)?.data);
    if (!data) return null;
    const { id, status, defaultDatasetId } = data;
    if (typeof id !== 'string' || !APIFY_ID.test(id)) return null;
    if (typeof status !== 'string' || !RUN_STATUSES.has(status)) return null;
    if (typeof defaultDatasetId !== 'string' || !APIFY_ID.test(defaultDatasetId)) return null;
    return { id, status, datasetId: defaultDatasetId };
}

/** Asks Apify to stop a run we no longer wait for, so it stops charging. Never awaited; a failure is ignored. */
function abortRunQuietly(runId: string, token: string, fetchFn: FetchLike | undefined): void {
    requestJson({
        service: 'google-maps',
        method: 'POST',
        url: `${APIFY_API_BASE}/v2/actor-runs/${runId}/abort`,
        token,
        timeoutMs: MAPS_ABORT_TIMEOUT_MS,
        maxBytes: MAPS_RUN_MAX_BYTES,
        idempotent: false,
        classify: mapsClassify,
        fetch: fetchFn,
    }).catch(() => undefined);
}

function hasWheelchairEntrance(additionalInfo: unknown): boolean {
    const list = record(additionalInfo)?.Accessibility;
    return (
        Array.isArray(list) &&
        list.slice(0, MAX_ACCESSIBILITY_ENTRIES).some((entry) => record(entry)?.[WHEELCHAIR_ENTRANCE] === true)
    );
}

const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

function placeSummary(title: string, facts: PlaceFacts, temporarilyClosed: boolean): string {
    const parts = [sentence(title)];
    if (facts.category) parts.push(sentence(facts.category));
    if (facts.address) parts.push(sentence(facts.address));
    if (facts.rating !== undefined) {
        const reviews = facts.reviews;
        parts.push(
            reviews === undefined
                ? `Rated ${facts.rating}.`
                : `Rated ${facts.rating} from ${reviews.toLocaleString('en-US')} ${reviews === 1 ? 'review' : 'reviews'}.`,
        );
    }
    if (temporarilyClosed) parts.push('Temporarily closed.');
    else if (facts.openNow !== undefined) parts.push(facts.openNow ? 'Open when checked.' : 'Closed when checked.');
    if (facts.wheelchairEntrance) parts.push('Wheelchair accessible entrance.');
    if (facts.phone) parts.push(`Phone ${facts.phone}.`);
    return parts.join(' ');
}

function placeRow(raw: unknown, position: number): SearchRow | 'closed' | null {
    const item = record(raw);
    if (!item) return null;
    // Never offer a place Google lists as permanently closed.
    if (item.permanentlyClosed === true) return 'closed';
    const title = capText(str(item.title), MAX_TITLE_CHARS);
    if (!title) return null;

    const facts: PlaceFacts = {};
    if (finite(item.totalScore) && item.totalScore > 0) facts.rating = item.totalScore;
    if (finite(item.reviewsCount) && item.reviewsCount >= 0) facts.reviews = item.reviewsCount;
    if (typeof item.wasOpenAtScrapeTime === 'boolean') facts.openNow = item.wasOpenAtScrapeTime;
    // Never inferred: only an explicit true on this exact entry counts.
    if (hasWheelchairEntrance(item.additionalInfo)) facts.wheelchairEntrance = true;
    const address = capText(str(item.address), MAX_ADDRESS_CHARS);
    if (address) facts.address = address;
    // A phone number cut short would be a wrong number, so a long one is dropped.
    const phone = ident(item.phone, MAX_PHONE_CHARS);
    if (phone) facts.phone = phone;
    const category = capText(str(item.categoryName), MAX_CATEGORY_CHARS);
    if (category) facts.category = category;

    const placeId = ident(item.placeId, MAX_PLACE_ID_CHARS);
    const url = ident(item.url, MAX_URL_CHARS);
    const loc = record(item.location);
    const location = loc && finite(loc.lat) && finite(loc.lng) ? { lat: loc.lat, lng: loc.lng } : undefined;
    return {
        id: placeId ? `maps:${placeId}` : `maps:${shortHash(`${title}|${address}`)}`,
        source: 'maps',
        title,
        text: placeSummary(title, facts, item.temporarilyClosed === true),
        ...(url ? { url } : {}),
        ...(placeId ? { placeId } : {}),
        ...(location ? { location } : {}),
        fetchedAt: isoTime(item.scrapedAt) ?? new Date().toISOString(),
        rank: position,
        ...(Object.keys(facts).length > 0 ? { facts } : {}),
    };
}

/**
 * Finds places with the Google Maps Scraper. Starts a run with a memory setting, a time limit and a charge cap,
 * waits for it to end (Apify holds each reply up to 60 s), then reads the places from the run's dataset. A run
 * that reaches its own time limit keeps the places it found, with `partial: true`; one that found none, failed
 * or was aborted rejects. Places Google lists as permanently closed are dropped.
 */
export async function searchPlaces(query: string, opts: PlaceSearchOptions = {}): Promise<SearchResult> {
    const q = cleanQuery(query, 'query');
    const maxPlaces = intInRange(opts.maxPlaces ?? 8, 1, 50, 'maxPlaces');
    const timeoutSecs = intInRange(opts.timeoutSecs ?? 120, 10, 290, 'timeoutSecs');
    const memory = opts.memoryMbytes ?? 4096;
    if (!Number.isInteger(memory) || memory < 128 || (memory & (memory - 1)) !== 0) {
        throw new RangeError('memoryMbytes must be a power of 2 of at least 128.');
    }
    const maxCharge = opts.maxChargeUsd ?? MAPS_MIN_CHARGE_USD;
    if (!Number.isFinite(maxCharge) || maxCharge < MAPS_MIN_CHARGE_USD || maxCharge > 5) {
        // Refused here rather than by Apify, which answers a cap under $0.50 with HTTP 400.
        throw new RangeError('maxChargeUsd must be at least 0.50 (Apify refuses a lower cap) and at most 5.');
    }
    const language = opts.language ?? 'en';
    if (typeof language !== 'string' || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(language)) {
        throw new RangeError('language must be a language code such as "en".');
    }
    let geolocation: Record<string, unknown> | undefined;
    if (opts.near) {
        const lat = numberInRange(opts.near.lat, -90, 90, 'near.lat');
        const lng = numberInRange(opts.near.lng, -180, 180, 'near.lng');
        const radiusKm = numberInRange(opts.radiusKm ?? 1, 0.05, 100, 'radiusKm');
        // GeoJSON order: longitude first.
        geolocation = { type: 'Point', coordinates: [lng, lat], radiusKm };
    }
    const config = opts.config ?? loadConfig();

    const input = {
        searchStringsArray: [q],
        maxCrawledPlacesPerSearch: maxPlaces,
        language,
        scrapePlaceDetailPage: false,
        maxReviews: 0,
        maxImages: 0,
        scrapeReviewsPersonalData: false,
        ...(geolocation ? { customGeolocation: geolocation } : {}),
    };
    const params = new URLSearchParams({
        timeout: String(timeoutSecs),
        memory: String(memory),
        maxTotalChargeUsd: String(maxCharge),
        // Apify holds the reply until the run ends or this many seconds pass, whichever comes first.
        waitForFinish: String(Math.min(MAPS_WAIT_MAX_SECS, timeoutSecs + MAPS_WAIT_EXTRA_SECS)),
    });
    const startUrl = `${APIFY_API_BASE}/v2/actors/${MAPS_ACTOR}/runs?${params}`;
    const itemParams = new URLSearchParams({ format: 'json', clean: 'true', fields: MAPS_FIELDS.join(','), limit: String(maxPlaces) });

    const started = performance.now();
    emit(opts.onEvent, { stage: 'search', status: 'started', detail: 'maps', ms: 0 });

    // One deadline for the whole call (the start, every status wait and the dataset read), beside the caller's signal.
    const budgetMs = (timeoutSecs + MAPS_CLIENT_MARGIN_SECS) * 1000;
    const caller = opts.signal;
    const stop = new AbortController();
    const onCallerAbort = () => stop.abort();
    if (caller?.aborted) stop.abort();
    else caller?.addEventListener('abort', onCallerAbort, { once: true });
    const timer = setTimeout(() => stop.abort(), budgetMs);
    const leftMs = () => budgetMs - (performance.now() - started);
    // Requests sent so far, for `attempts` on an error.
    let sent = 0;
    const fail = (kind: HttpErrorKind, endpoint: string, status: number | null, extra: Partial<HttpErrorInit> = {}) =>
        new ApifyHttpError({ service: 'google-maps', endpoint, kind, status, attempts: sent, ...extra });

    /** One request inside the deadline. Its errors name the route rather than the ids, and count every request. */
    const send = async (endpoint: string, method: 'GET' | 'POST', url: string, read: boolean, maxBytes: number, body?: unknown): Promise<HttpResult> => {
        try {
            const res = await requestJson({
                service: 'google-maps',
                method,
                url,
                token: config.token,
                ...(body !== undefined ? { body } : {}),
                timeoutMs: Math.max(1, Math.ceil(leftMs())),
                maxBytes,
                // Starting a run is never retried: each POST can start a new paid run, and after a dropped connection
                // the first run may still be going, with its own charge cap. Reads change nothing and get one retry.
                idempotent: read,
                retries: read ? 1 : 0,
                classify: read ? mapsReadClassify : mapsClassify,
                signal: stop.signal,
                fetch: opts.fetch,
            });
            sent += res.attempts;
            return res;
        } catch (error) {
            if (!(error instanceof ApifyHttpError)) throw error;
            sent += error.attempts;
            // Our deadline stops a request the way the caller's signal does; only the caller's is a cancellation.
            const kind: HttpErrorKind = error.kind === 'aborted' && !caller?.aborted ? 'timeout' : error.kind;
            throw fail(kind, endpoint, error.status, {
                bodySnippet: error.bodySnippet,
                ...(error.code ? { code: error.code } : {}),
                ...(kind === 'timeout' && error.status === null ? { timeoutMs: budgetMs } : {}),
            });
        }
    };
    const runOf = (res: HttpResult, endpoint: string, expectId?: string): MapsRun => {
        const next = mapsRun(res.body);
        if (!next || (expectId !== undefined && next.id !== expectId)) {
            throw fail('bad_response', endpoint, res.status, { bodySnippet: 'Expected the Apify run with its id, status and dataset id.' });
        }
        return next;
    };

    let run: MapsRun | null = null;
    try {
        let res = await send(MAPS_START_ENDPOINT, 'POST', startUrl, false, MAPS_RUN_MAX_BYTES, input);
        let runEndpoint = MAPS_START_ENDPOINT;
        run = runOf(res, runEndpoint);
        for (let polls = 0; !RUN_FINISHED.has(run.status); polls += 1) {
            const waitSecs = Math.min(MAPS_WAIT_MAX_SECS, Math.floor((leftMs() - MAPS_REPLY_MARGIN_MS) / 1000));
            if (waitSecs < 1 || polls >= MAPS_MAX_POLLS) throw fail('timeout', MAPS_RUN_ENDPOINT, null, { timeoutMs: budgetMs });
            runEndpoint = MAPS_RUN_ENDPOINT;
            res = await send(runEndpoint, 'GET', `${APIFY_API_BASE}/v2/actor-runs/${run.id}?waitForFinish=${waitSecs}`, true, MAPS_RUN_MAX_BYTES);
            run = runOf(res, runEndpoint, run.id);
        }
        if (run.status === 'FAILED' || run.status === 'ABORTED') {
            throw fail('bad_response', runEndpoint, res.status, { bodySnippet: `The run ended ${run.status}.` });
        }
        const itemsRes = await send(MAPS_ITEMS_ENDPOINT, 'GET', `${APIFY_API_BASE}/v2/datasets/${run.datasetId}/items?${itemParams}`, true, MAPS_MAX_BYTES);
        if (!Array.isArray(itemsRes.body)) {
            throw fail('bad_response', MAPS_ITEMS_ENDPOINT, itemsRes.status, { bodySnippet: 'Expected a JSON array of places.' });
        }
        const timedOut = run.status === 'TIMED-OUT';
        // A run that reached its own limit keeps the places it found. With none, it is a timeout like any other.
        if (timedOut && itemsRes.body.length === 0) throw fail('timeout', MAPS_START_ENDPOINT, null, { timeoutMs: timeoutSecs * 1000 });
        // Never more than we asked for, however many items the reply holds.
        const items = itemsRes.body.slice(0, maxPlaces);
        const rows: SearchRow[] = [];
        const seen = new Set<string>();
        let closed = 0;
        let skipped = 0;
        items.forEach((raw, i) => {
            const row = placeRow(raw, i + 1);
            if (row === 'closed') closed += 1;
            else if (row === null) skipped += 1;
            else if (!seen.has(row.id)) {
                seen.add(row.id);
                rows.push(row);
            }
        });
        const ms = elapsedMs(started);
        // A run cut off by its time limit may have had more places to find.
        const partial = timedOut || skipped > 0;
        emit(opts.onEvent, {
            stage: 'search',
            status: 'ok',
            detail: partial ? 'maps partial' : 'maps',
            ms,
            counts: { rows: rows.length, closed, skipped },
        });
        return { rows, ms, query: q, partial };
    } catch (error) {
        // A run we stop waiting for would go on to its own limit and charge for it, so ask Apify to stop it.
        if (run && !RUN_FINISHED.has(run.status)) abortRunQuietly(run.id, config.token, opts.fetch);
        emit(opts.onEvent, { stage: 'search', status: 'error', detail: `maps ${errorLabel(error)}`, ms: elapsedMs(started) });
        throw error;
    } finally {
        clearTimeout(timer);
        caller?.removeEventListener('abort', onCallerAbort);
    }
}
