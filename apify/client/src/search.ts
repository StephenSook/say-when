import { createHash } from 'node:crypto';

import { APIFY_API_BASE, ConfigError, loadConfig, parseRagBaseUrl, type ApifyConfig } from './config.js';
import { elapsedMs, emit, type EventSink } from './events.js';
import { ApifyHttpError, endpointOf, requestJson, type FetchLike, type Verdict } from './http.js';

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
    /** Extra attempts after a 429, a 5xx or a network error. Default 2 for web search, 1 for places. */
    retries?: number;
    /** Wait before the first retry; doubles each time, capped at 4 s. Default 500. */
    retryBaseMs?: number;
}

export interface WebSearchOptions extends CallOptions {
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
    /** The run's time limit in seconds, 10 to 290 (the sync API gives up at 300). Default 120. */
    timeoutSecs?: number;
    /** Run memory in MB, a power of 2 of at least 128. Default 4096. */
    memoryMbytes?: number;
    /** Hard cap on what one run can charge, above 0 and at most 5. Default 0.25. */
    maxChargeUsd?: number;
}

const RAG_SERVER_MARGIN_MS = 5_000;
const MAX_QUERY_CHARS = 1_000;
const MAPS_ACTOR = 'compass~crawler-google-places';
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

// Small readers for untyped JSON.
const record = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
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
    const url = str(metadata?.url) || str(result?.url);
    if (!url) return null;
    const rankValue = result?.rank;
    const rank = finite(rankValue) ? rankValue : undefined;
    return {
        id: `web:${shortHash(url)}`,
        source: 'web',
        title: str(metadata?.title) || str(result?.title) || url,
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
        for (const raw of res.body) {
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

// ---------- Place search: Google Maps Scraper, run synchronously ----------

function mapsClassify(status: number): Verdict {
    // 408: the run passed the sync API's 300 s limit. Repeating it would take as long again.
    if (status === 408) return 'timeout';
    return status === 429 || status >= 500 ? 'retry' : 'fail';
}

function hasWheelchairEntrance(additionalInfo: unknown): boolean {
    const list = record(additionalInfo)?.Accessibility;
    return Array.isArray(list) && list.some((entry) => record(entry)?.[WHEELCHAIR_ENTRANCE] === true);
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
    const title = str(item.title);
    if (!title) return null;

    const facts: PlaceFacts = {};
    if (finite(item.totalScore) && item.totalScore > 0) facts.rating = item.totalScore;
    if (finite(item.reviewsCount) && item.reviewsCount >= 0) facts.reviews = item.reviewsCount;
    if (typeof item.wasOpenAtScrapeTime === 'boolean') facts.openNow = item.wasOpenAtScrapeTime;
    // Never inferred: only an explicit true on this exact entry counts.
    if (hasWheelchairEntrance(item.additionalInfo)) facts.wheelchairEntrance = true;
    const address = str(item.address);
    if (address) facts.address = address;
    const phone = str(item.phone);
    if (phone) facts.phone = phone;
    const category = str(item.categoryName);
    if (category) facts.category = category;

    const placeId = str(item.placeId);
    const url = str(item.url);
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
 * Finds places with the Google Maps Scraper, run synchronously with a memory setting, a time limit and a
 * charge cap on every call. Places Google lists as permanently closed are dropped.
 */
export async function searchPlaces(query: string, opts: PlaceSearchOptions = {}): Promise<SearchResult> {
    const q = cleanQuery(query, 'query');
    const maxPlaces = intInRange(opts.maxPlaces ?? 8, 1, 50, 'maxPlaces');
    const timeoutSecs = intInRange(opts.timeoutSecs ?? 120, 10, 290, 'timeoutSecs');
    const memory = opts.memoryMbytes ?? 4096;
    if (!Number.isInteger(memory) || memory < 128 || (memory & (memory - 1)) !== 0) {
        throw new RangeError('memoryMbytes must be a power of 2 of at least 128.');
    }
    const maxCharge = opts.maxChargeUsd ?? 0.25;
    if (!Number.isFinite(maxCharge) || maxCharge <= 0 || maxCharge > 5) throw new RangeError('maxChargeUsd must be above 0 and at most 5.');
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
        fields: MAPS_FIELDS.join(','),
    });
    const url = `${APIFY_API_BASE}/v2/actors/${MAPS_ACTOR}/run-sync-get-dataset-items?${params}`;

    const started = performance.now();
    emit(opts.onEvent, { stage: 'search', status: 'started', detail: 'maps', ms: 0 });
    try {
        const res = await requestJson({
            service: 'google-maps',
            method: 'POST',
            url,
            token: config.token,
            body: input,
            // The run's limit plus time to start it and return the items, never past the sync API's 300 s.
            timeoutMs: Math.min(timeoutSecs + 30, 310) * 1000,
            // A read with no outward effect, so it may repeat; each repeat is a new run under the same charge cap.
            idempotent: true,
            retries: opts.retries ?? 1,
            retryBaseMs: opts.retryBaseMs,
            classify: mapsClassify,
            signal: opts.signal,
            fetch: opts.fetch,
        });
        if (!Array.isArray(res.body)) {
            throw badShape('google-maps', 'POST', url, res.status, res.attempts, 'Expected a JSON array of places.');
        }
        const rows: SearchRow[] = [];
        const seen = new Set<string>();
        let closed = 0;
        let skipped = 0;
        res.body.forEach((raw, i) => {
            const row = placeRow(raw, i + 1);
            if (row === 'closed') closed += 1;
            else if (row === null) skipped += 1;
            else if (!seen.has(row.id)) {
                seen.add(row.id);
                rows.push(row);
            }
        });
        const ms = elapsedMs(started);
        // The API docs do not say what a run that hits its own time limit returns. If it returns the places
        // found so far, the run took the whole limit and came back short, so flag that as a hint.
        const partial = skipped > 0 || (res.body.length < maxPlaces && ms >= timeoutSecs * 1000);
        emit(opts.onEvent, {
            stage: 'search',
            status: 'ok',
            detail: partial ? 'maps partial' : 'maps',
            ms,
            counts: { rows: rows.length, closed, skipped },
        });
        return { rows, ms, query: q, partial };
    } catch (error) {
        emit(opts.onEvent, { stage: 'search', status: 'error', detail: `maps ${errorLabel(error)}`, ms: elapsedMs(started) });
        throw error;
    }
}
