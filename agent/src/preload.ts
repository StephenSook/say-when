// Preloaded search results (PLAN D26, Stephen Oct 25 2:15 AM: "Apify errored a couple times ... Preload some data for
// Google Maps and any other sites, and max 11 seconds for it"). A Google Maps run takes 11 to 16 s and a web search can
// time out, so the sidecar keeps a warm cache of REAL Apify results for a short fixed list of searches (the venue's
// usual place categories near AGENT_PLACES_NEAR, and a few demo questions), fetched at start and again every
// AGENT_PRELOAD_REFRESH_MS. searchStep (src/retrieval.ts) uses a matching entry when the live search has not answered
// within CACHE_GRACE_MS, or fails. Rows keep their original fetchedAt, and the search event says `cached` with the
// rows' age, so nothing fetched earlier is ever shown as live.
// - Consent: a preload goes out only while the module's web search consent holds (`agent_consent`, views current, a
//   session open); without it the round waits and runs once consent shows. A revocation the views show empties the
//   cache and stops the round's runs. A cached row is used only while that consent holds now.
// - Public words only: the list is fixed config, never the person's question or memory. Only counts are logged.
// - At most `concurrency` searches at once, each with its own deadline; nothing ever blocks the sidecar's start.

import { existsSync, readFileSync } from 'node:fs';

import type { SearchResult, SearchRow } from '@say-when/apify-client';

import type { AgentDb } from './db/db.js';
import type { Logger } from './log.js';
import { wholeMs } from './pipeline.js';
import { placeQuery, type CachedSearch, type PlannedSearch, type SearchCacheLookup } from './retrieval.js';

/** One search in the preload list (agent/preload.example.json). */
export interface PreloadSearch {
    kind: 'web' | 'maps';
    query: string;
}

export const PRELOAD_DEFAULTS = {
    /** AGENT_PRELOAD_REFRESH_MS: 20 minutes. */
    refreshMs: 20 * 60_000,
    /**
     * AGENT_PRELOAD_TIMEOUT_MS. Nobody waits on a preload, so it gets longer than the 11 s search deadline: a Maps run
     * takes 11 to 16 s (Oct 24), and with 11 s most of them would time out and leave the cache empty.
     */
    timeoutMs: 25_000,
    /** Searches running at once. */
    concurrency: 2,
    /** A cached entry older than this is not used (its place facts, such as open now, grow stale). */
    maxAgeMs: 2 * 60 * 60_000,
} as const;

const MAX_SEARCHES = 20;
const MAX_QUERY_CHARS = 200;

export class PreloadFileError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PreloadFileError';
    }
}

/** The preload list from its JSON: `{ "searches": [{ "kind": "maps" | "web", "query": "..." }] }`. */
export function parsePreload(json: string): PreloadSearch[] {
    let data: unknown;
    try {
        data = JSON.parse(json);
    } catch {
        throw new PreloadFileError('The preload file is not JSON.');
    }
    const list = (data as { searches?: unknown } | null)?.searches;
    if (!Array.isArray(list)) throw new PreloadFileError('The preload file needs a "searches" list.');
    if (list.length > MAX_SEARCHES) throw new PreloadFileError(`The preload file has more than ${MAX_SEARCHES} searches.`);
    return list.map((item: unknown, i) => {
        const { kind, query } = (item ?? {}) as { kind?: unknown; query?: unknown };
        if (kind !== 'web' && kind !== 'maps') throw new PreloadFileError(`Preload search ${i + 1}: kind must be web or maps.`);
        if (typeof query !== 'string' || query.trim() === '' || query.length > MAX_QUERY_CHARS) {
            throw new PreloadFileError(`Preload search ${i + 1}: query must be 1 to ${MAX_QUERY_CHARS} characters.`);
        }
        return { kind, query: query.replace(/\s+/g, ' ').trim() };
    });
}

/** Reads and checks the preload file. */
export function loadPreload(path: string): PreloadSearch[] {
    if (!existsSync(path)) throw new PreloadFileError('The preload file does not exist.');
    let json: string;
    try {
        json = readFileSync(path, 'utf8');
    } catch {
        throw new PreloadFileError('The preload file could not be read.');
    }
    return parsePreload(json);
}

// Place words that mean the same search near the venue.
const SAME_PLACE: Readonly<Record<string, string>> = {
    coffee: 'cafe',
    'coffee shop': 'cafe',
    cafe: 'cafe',
    breakfast: 'restaurant',
    brunch: 'restaurant',
    lunch: 'restaurant',
    dinner: 'restaurant',
    restaurant: 'restaurant',
    drugstore: 'pharmacy',
    pharmacy: 'pharmacy',
};

/** A maps query's category key: placeQuery's place word ("quiet cafe" is cafe, "parks and gardens" park), folded. */
export function placeKey(query: string): string {
    const found = placeQuery(query).toLowerCase();
    return SAME_PLACE[found] ?? found;
}

const STOP_WORDS: ReadonlySet<string> = new Set(
    (
        'a an the of to do does did is are was were be in on at for and or near nearby by around you your know what when where how who ' +
        'which this that it its i we me my us can could would should will any some there with from about today now tell have has get go ' +
        'something anything please there'
    ).split(' '),
);

/** A web query's content words: lowercase, no stop words, at least two characters. */
export function contentWords(text: string): Set<string> {
    const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    return new Set(words.filter((w) => w.length > 1 && !STOP_WORDS.has(w)));
}

/** At least this many content words in common, and at least this share of the longer query's words. */
const WEB_MIN_SHARED = 2;
const WEB_MIN_SHARE = 0.5;

/** How well a web query matches a preloaded one: shared words over the longer query's words, or 0 when too few. */
export function webMatchScore(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
    let shared = 0;
    for (const word of a) if (b.has(word)) shared += 1;
    if (shared < WEB_MIN_SHARED) return 0;
    const score = shared / Math.max(a.size, b.size);
    return score >= WEB_MIN_SHARE ? score : 0;
}

/** A place name for matching: lowercase letters and digits, single spaces. */
function nameKey(text: string): string {
    return text.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

export type PreloadSend = (planned: PlannedSearch, signal: AbortSignal) => Promise<SearchResult>;

export interface PreloadOptions {
    searches: readonly PreloadSearch[];
    /** Each preload search's deadline. */
    timeoutMs: number;
    /** How often the list is searched again; 0 for never. */
    refreshMs: number;
    send: PreloadSend;
    concurrency?: number;
    maxAgeMs?: number;
}

interface Entry {
    search: PreloadSearch;
    rows: SearchRow[];
    /** Monotonic clock when the rows came back. */
    at: number;
    key: string;
    words: Set<string>;
}

export class SearchCache implements SearchCacheLookup {
    private readonly entries = new Map<string, Entry>();
    private readonly searches: readonly PreloadSearch[];
    private unsubscribe: (() => void) | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private running: Promise<void> | null = null;
    private round: AbortController | null = null;
    /** Goes up on every drop, so a run that comes back after a revocation is not kept. */
    private generation = 0;
    /** A round was skipped (no consent yet) or the cache was dropped: run one once consent shows. */
    private waiting = false;
    private closed = false;

    constructor(
        private readonly db: AgentDb,
        private readonly log: Logger,
        /** Monotonic clock, ms. */
        private readonly clock: () => number,
        private readonly options: PreloadOptions,
    ) {
        this.searches = options.searches;
    }

    /** Listens for consent, starts the first round in the background and the refresh timer. Never waits. */
    start(): void {
        if (this.closed || this.unsubscribe) return;
        this.unsubscribe = this.db.onChange(() => this.onViews());
        void this.refresh();
        if (this.options.refreshMs > 0) {
            this.timer = setInterval(() => void this.refresh(), this.options.refreshMs);
            this.timer.unref?.();
        }
    }

    /** Runs one round now, unless one is running, consent is off (then it waits for consent) or the cache is closed. */
    refresh(): Promise<void> {
        if (this.closed) return Promise.resolve();
        if (this.running) return this.running;
        if (!this.consentOn()) {
            if (!this.waiting) this.log.info('search preload waits for web search consent');
            this.waiting = true;
            return Promise.resolve();
        }
        this.waiting = false;
        const running = this.runRound(this.generation).catch(() => undefined);
        this.running = running;
        void running.finally(() => {
            if (this.running === running) this.running = null;
        });
        return running;
    }

    /** The preloaded rows for this search, or null: nothing matches, they are too old, or web search consent is off. */
    find(planned: PlannedSearch): CachedSearch | null {
        if (this.closed || !this.consentOn()) return null;
        const now = this.clock();
        const maxAge = this.options.maxAgeMs ?? PRELOAD_DEFAULTS.maxAgeMs;
        let best: Entry | null = null;
        let bestScore = 0;
        if (planned.kind === 'maps') {
            const key = placeKey(planned.query);
            for (const entry of this.entries.values()) {
                if (entry.search.kind === 'maps' && entry.key === key && now - entry.at <= maxAge) {
                    best = entry;
                    break;
                }
            }
        } else {
            const words = contentWords(planned.query);
            for (const entry of this.entries.values()) {
                if (entry.search.kind !== 'web' || now - entry.at > maxAge) continue;
                const score = webMatchScore(words, entry.words);
                if (score > bestScore) {
                    best = entry;
                    bestScore = score;
                }
            }
        }
        if (!best) return null;
        return { rows: best.rows.map((row) => structuredClone(row)), ageMs: Math.max(0, now - best.at) };
    }

    /**
     * A preloaded maps row whose title names this place, or null (PLAN D26: AGENT_PINNED_PLACE is cited from a real
     * row when one was fetched). Same rules as find: consent on now, not too old. The row keeps its own fetchedAt.
     */
    findPlace(name: string): SearchRow | null {
        if (this.closed || !this.consentOn()) return null;
        const want = nameKey(name);
        if (want === '') return null;
        const now = this.clock();
        const maxAge = this.options.maxAgeMs ?? PRELOAD_DEFAULTS.maxAgeMs;
        for (const entry of this.entries.values()) {
            if (entry.search.kind !== 'maps' || now - entry.at > maxAge) continue;
            const row = entry.rows.find((r) => r.source === 'maps' && nameKey(r.title).includes(want));
            if (row) return structuredClone(row);
        }
        return null;
    }

    /** How many searches have rows now. */
    get size(): number {
        return this.entries.size;
    }

    /** Stops the timer and the running round, stops listening and drops every entry. */
    close(): void {
        if (this.closed) return;
        this.closed = true;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.round?.abort();
        this.entries.clear();
        this.generation += 1;
    }

    private onViews(): void {
        if (this.closed) return;
        if (this.revoked()) {
            if (this.entries.size > 0 || this.running) {
                this.log.info('search preload dropped', { why: 'consent', entries: this.entries.size });
                this.entries.clear();
                this.generation += 1;
                this.round?.abort();
            }
            this.waiting = true;
            return;
        }
        if (this.waiting && !this.running && this.consentOn()) void this.refresh();
    }

    private async runRound(generation: number): Promise<void> {
        const started = this.clock();
        const controller = new AbortController();
        this.round = controller;
        const queue = [...this.searches];
        let ok = 0;
        let failed = 0;
        let skipped = 0;
        const worker = async (): Promise<void> => {
            for (let next = queue.shift(); next; next = queue.shift()) {
                // Read again right before each search goes out.
                if (this.closed || controller.signal.aborted || generation !== this.generation || !this.consentOn()) {
                    skipped += 1;
                    continue;
                }
                const search = next;
                try {
                    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.options.timeoutMs)]);
                    const result = await Promise.resolve().then(() => this.options.send(search, signal));
                    if (this.closed || generation !== this.generation || !this.consentOn()) {
                        skipped += 1;
                        continue;
                    }
                    // No rows keeps the older entry, which is still real.
                    if (result.rows.length === 0) {
                        failed += 1;
                        continue;
                    }
                    this.entries.set(`${search.kind}|${search.query.toLowerCase()}`, {
                        search,
                        rows: result.rows,
                        at: this.clock(),
                        key: search.kind === 'maps' ? placeKey(search.query) : '',
                        words: search.kind === 'web' ? contentWords(search.query) : new Set(),
                    });
                    ok += 1;
                } catch {
                    failed += 1;
                }
            }
        };
        const workers = Math.max(1, Math.min(this.options.concurrency ?? PRELOAD_DEFAULTS.concurrency, queue.length));
        await Promise.all(Array.from({ length: workers }, () => worker()));
        if (this.round === controller) this.round = null;
        this.log.info('search preload done', { ok, failed, skipped, entries: this.entries.size, ms: wholeMs(this.clock() - started) });
    }

    /** Web search consent as the module shows it now: views current, a session open, web search allowed. */
    private consentOn(): boolean {
        if (!this.db.isCurrent()) return false;
        const consent = this.db.agentConsent();
        return !!consent && consent.webSearchAllowed && consent.sessionId !== 0n;
    }

    /** A revocation the views show: current views with no consent row or with web search off. */
    private revoked(): boolean {
        if (!this.db.isCurrent()) return false;
        const consent = this.db.agentConsent();
        return !consent || !consent.webSearchAllowed;
    }
}
