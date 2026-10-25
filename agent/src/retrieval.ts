// Retrieval for one Options job (PLAN D8, docs/spacetime.md 7.4 step 3):
// 1. Memory first: the person's own memory from Moss, locally, in milliseconds.
// 2. A local check (classifyQuestion) decides whether the question needs outside facts. Small talk and personal
//    questions never wait on a search.
// 3. Only then a web or place search (Apify), under its own deadline so it stays inside the job lease.
// 4. The rows are chunked into the Moss web index for this question, and the passages that match the question
//    come back for the planner.
// Every step writes a pipeline event with its time and counts; failures degrade (no memory, no web) instead of
// failing the job, because the person still needs options.

import { ApifyHttpError, type QuestionClass, type SearchResult, type SearchRow } from '@say-when/apify-client';
import { MossCallError, MossRunError, type MemoryHit, type Recall, type WebHit } from '@say-when/moss';

import { DeadlineError, JobAbortedError, withDeadline } from './deadline.js';
import type { Logger } from './log.js';
import { label, StaleAttemptError, wholeMs, type Counts, type JobEvents, type Step } from './pipeline.js';
import type { MemoryContext, WebContext } from './planner/types.js';
import type { Classifier, MemoryPort, SearchPort, WebIndexPort } from './ports.js';
import { excerpt, memoryHitPayload, searchRowPayload, sourceRefOf, webHitPayload, type PayloadHit } from './privacy.js';
import { isPastRequest, pastRequestQuery, type FormRef } from './requests.js';
import type { AgentQueueRow } from './types.js';

export { JobAbortedError };

/**
 * How long a job waits on each Moss call. Moss runs on this laptop and answers in milliseconds, but its README says
 * a call can hang until the run is restarted, so every wait is bounded and a stuck call degrades instead of
 * holding the job.
 */
export const MOSS_DEADLINES = { recall: 3_000, index: 10_000, search: 3_000, rank: 3_000, writeBack: 5_000, forget: 5_000 } as const;
export type MossDeadlines = { [K in keyof typeof MOSS_DEADLINES]: number };

export interface RetrievalDeps {
    classify: Classifier;
    search: SearchPort | null;
    memory: MemoryPort | null;
    web: WebIndexPort | null;
    /** Where place searches look (AGENT_PLACES_NEAR). Without it, place questions use the web search. */
    placesNear: { lat: number; lng: number } | null;
    /**
     * The search's own deadline, kept well inside the 45 s job lease. It bounds the whole wait for outside facts for one
     * question: one search attempt per pick (PLAN D26, 11 s by default).
     */
    searchTimeoutMs: number;
    /**
     * Preloaded search results (src/preload.ts, PLAN D26): real results fetched earlier, used when the live search has
     * not answered within `cacheGraceMs`, or failed. Unset or null: no cache.
     */
    cache?: SearchCacheLookup | null;
    /** How long a search with a matching preloaded result waits for its live answer. Default CACHE_GRACE_MS. */
    cacheGraceMs?: number;
    /** Defaults to MOSS_DEADLINES. */
    mossDeadlines?: Partial<MossDeadlines>;
    log: Logger;
}

/** How long a search with a matching preloaded result waits for the live one before it takes the preloaded one. */
export const CACHE_GRACE_MS = 1_500;

/** Preloaded rows for one search, with how long ago they were fetched. The rows keep their own fetchedAt. */
export interface CachedSearch {
    rows: SearchRow[];
    ageMs: number;
}

/** The preloaded cache as searchStep sees it (src/preload.ts SearchCache). Null when nothing matches or consent is off. */
export interface SearchCacheLookup {
    find(planned: PlannedSearch): CachedSearch | null;
    /** A preloaded maps row whose title names this place (AGENT_PINNED_PLACE), or null. */
    findPlace?(name: string): SearchRow | null;
}

export function mossDeadline(deps: RetrievalDeps, step: keyof MossDeadlines): number {
    return deps.mossDeadlines?.[step] ?? MOSS_DEADLINES[step];
}

export type SearchStatus = 'not_needed' | 'not_allowed' | 'done' | 'failed' | 'none';

export interface SearchOutcome {
    status: SearchStatus;
    rows: SearchRow[];
    kind: 'web' | 'maps' | null;
}

/** The label for a failed Moss step, from fixed parts only. */
export function mossErrorLabel(step: string, error: unknown): string {
    if (error instanceof DeadlineError) return label(step, 'failed: timeout');
    if (error instanceof MossRunError) return label(step, 'failed:', error.code === 'not_open' ? 'moss closed' : error.code);
    if (error instanceof MossCallError) return error.usageLimit ? label('moss paused: usage limit reached') : label(step, 'failed:', error.code);
    return label(step, 'failed');
}

/** The label for a failed search, in the apify/client event vocabulary (`web timeout`, `maps http 402`). */
export function searchErrorLabel(kind: 'web' | 'maps', error: unknown, deadline: boolean): string {
    if (deadline) return label(kind, 'timeout');
    if (error instanceof ApifyHttpError) return label(kind, error.kind === 'http' ? `http ${error.status ?? ''}` : error.kind.replace('_', ' '));
    return label(kind, 'error');
}

/** At most this many allowed forms get a past-request query per question. */
const MAX_PAST_REQUEST_FORMS = 4;

/** The newer of two hits; the first when their times tie or are unknown. */
function newer(a: MemoryHit | null, b: MemoryHit): MemoryHit {
    if (!a) return b;
    return (b.at ?? -Infinity) > (a.at ?? -Infinity) ? b : a;
}

/**
 * A form's past-request query, bounded on its own: a query that fails or never answers only leaves its form out, and
 * never costs the question's own recall.
 */
async function findPastRequests(memory: MemoryPort, row: AgentQueueRow, form: FormRef, deadlineMs: number): Promise<MemoryHit[]> {
    try {
        const result = await withDeadline(memory.recall(pastRequestQuery(form), row.askedBy), deadlineMs, 'past request recall');
        return result.hits;
    } catch {
        return [];
    }
}

/**
 * The question's recall, plus the newest past request (src/requests.ts) of each allowed form, first, so the planner
 * can offer to send the same form again. One local query per form by its title and key, run beside the question's
 * own query. The two rank by similarity and can find different notes, so the newest note of each form is taken from
 * both; every other past request is left out, since only the newest one is "last time".
 */
async function recallWithPastRequests(
    memory: MemoryPort,
    row: AgentQueueRow,
    forms: readonly FormRef[],
    deadlineMs: number,
    signal: AbortSignal,
): Promise<{ recall: Recall; pastRequests: number }> {
    const unique = forms.filter((form, i) => forms.findIndex((f) => f.formKey === form.formKey) === i);
    // The query budget limits the extra queries only; a note the question's own recall found counts for every form.
    const finding = Promise.all(unique.slice(0, MAX_PAST_REQUEST_FORMS).map((form) => findPastRequests(memory, row, form, deadlineMs)));
    const recall = await withDeadline(memory.recall(row.questionText, row.askedBy), deadlineMs, 'memory recall', signal);
    // Each past-request query has its own deadline, started with the question's, so this wait is bounded too.
    const found = await finding;
    const past: MemoryHit[] = [];
    unique.forEach((form, i) => {
        let best: MemoryHit | null = null;
        for (const hit of [...(found[i] ?? []), ...recall.hits]) {
            if (hit.type === 'pref' && isPastRequest(hit.text, form)) best = newer(best, hit);
        }
        if (best && !past.some((hit) => hit.id === best?.id)) past.push(best);
    });
    const rest = recall.hits.filter((hit) => !isPastRequest(hit.text));
    return { recall: { ...recall, hits: [...past, ...rest] }, pastRequests: past.length };
}

/**
 * Step 1: the person's memory for this question and this partner, with the newest past request of each allowed form
 * (`forms`). Null when memory is off, closed or failed. `allowed` reads the job's memory consent as the module shows
 * it now: it is checked again after every wait, since consent can be revoked while a job runs.
 */
export async function recallMemory(
    deps: RetrievalDeps,
    events: JobEvents,
    row: AgentQueueRow,
    signal: AbortSignal,
    allowed: () => boolean = () => true,
    forms: readonly FormRef[] = [],
): Promise<Recall | null> {
    if (!row.memoryAllowed || !allowed()) {
        await events.instant('retrieve', 'ok', 'memory off', 0, { counts: { hitCount: 0, memoryAllowed: false } });
        return null;
    }
    if (!deps.memory || !deps.memory.isOpen()) {
        await events.instant('retrieve', 'error', 'moss closed', 0, { counts: { hitCount: 0, mossOpen: false } });
        return null;
    }
    const step = await events.begin('retrieve', 'memory recall');
    try {
        const recalled = allowed() ? await recallWithPastRequests(deps.memory, row, forms, mossDeadline(deps, 'recall'), signal) : null;
        const recall = recalled?.recall ?? null;
        if (!recall || !allowed()) {
            // Revoked while the step started or while Moss answered: nothing from memory is used or shown.
            await step.ok('memory recall', { counts: { hitCount: 0, memoryAllowed: false } });
            return null;
        }
        await step.ok('memory recall', {
            counts: { hitCount: recall.hits.length, instant: recall.instant.length, pastRequests: recalled?.pastRequests ?? 0, mossMs: recall.mossMs ?? undefined },
            payload: { hits: recall.hits.map(memoryHitPayload) },
            listKey: 'hits',
        });
        return recall;
    } catch (error) {
        if (error instanceof StaleAttemptError) throw error;
        if (signal.aborted || error instanceof JobAbortedError) throw new JobAbortedError();
        deps.log.warn('memory recall failed; continuing without memory', { job: row.jobId, why: error instanceof Error ? error.name : 'error' });
        await step.error(mossErrorLabel('memory recall', error));
        return null;
    }
}

const PLACE_WORDS = [
    'urgent care', 'ice cream', 'coffee shop', 'gas station', 'bus stop', 'train station', 'post office', 'grocery store',
    'breakfast', 'brunch', 'lunch', 'dinner', 'coffee', 'cafe', 'restaurant', 'pizza', 'tacos', 'sushi', 'burgers',
    'ramen', 'pho', 'boba', 'dessert', 'bakery', 'pharmacy', 'drugstore', 'hospital', 'clinic', 'grocery',
    'supermarket', 'restroom', 'bathroom', 'toilet', 'park', 'museum', 'library', 'gym', 'atm', 'bank', 'hotel',
    'parking', 'beach', 'theater', 'cinema',
];

/** Words of interest that name a kind of place, for questions with no place word ("like nature or something"). */
const INTEREST_WORDS: readonly [RegExp, string][] = [
    [/\b(nature|outdoors?|outside|hikes?|hiking|trails?|walks?|gardens?|green)\b/, 'park'],
    [/\b(views?|scenic|sunsets?|sunrises?)\b/, 'scenic viewpoint'],
    [/\b(arts?|gallery|galleries|exhibits?)\b/, 'museum'],
    [/\b(eat|food|hungry|meal|snacks?)\b/, 'restaurant'],
    [/\b(drinks?|tea)\b/, 'cafe'],
    [/\b(shop|shopping|stores?|mall)\b/, 'shopping'],
];

/** What Maps is asked when the question names no place and no interest. */
export const DEFAULT_PLACE_QUERY = 'tourist attraction';

/**
 * Spoken words for a place that classifyQuestion misses: "Do you know any good spots?" read as personal and went to the
 * web search (Oct 25, PLAN D26). With AGENT_PLACES_NEAR set they go to the maps search near the venue; placeQuery
 * turns "outdoor spots" into a park and "good spots" or "somewhere fun" into DEFAULT_PLACE_QUERY.
 */
const SPOT_WORDS = /\b(?:spots?|places?|somewhere|things to do|hang(?:ing)? out)\b/i;

/** The classifier, with a question SPOT_WORDS finds marked as a place question. Whether it needs the web is kept. */
export function withPlaceWords(classify: Classifier): Classifier {
    return (question) => {
        const check = classify(question);
        if (check.kind === 'places' || check.kind === 'smalltalk' || !SPOT_WORDS.test(question)) return check;
        return { ...check, kind: 'places' };
    };
}

// Capitalized words that are not names, also when they start a sentence.
const NOT_NAMES: ReadonlySet<string> = new Set([
    'I', "I'm", "I'd", "I'll", "I've", 'Is', 'Are', 'Was', 'Do', 'Does', 'Did', 'Can', 'Could', 'Would', 'Will', 'Should',
    'What', 'Where', 'When', 'How', 'Why', 'Who', 'Which', 'So', 'Oh', 'All', 'Hey', 'Hi', 'Hello', 'Okay', 'OK', 'Yes', 'No',
    'Let', "Let's", 'Want', 'You', 'We', 'Maybe', 'Like', 'And', 'But', 'Then', 'Right', 'Um', 'Uh', 'Well', 'Sure', 'Any',
    'Anything', 'Something', 'Somewhere', 'There', 'The', 'A', 'An', 'It', 'That', 'This',
]);
// A run of capitalized words, with "of", "the" or "and" inside ("Palace of Fine Arts", "Golden Gate Park").
const NAME_RUN = /[A-Z][\w'&.-]*(?:\s+(?:(?:of|the|and|at|on)\s+)?[A-Z][\w'&.-]*)*/g;
const NEAR_NAME = new RegExp(String.raw`\b(?:near|around|by|close to|next to)\s+(?:the\s+)?` + NAME_RUN.source, 'g');

/** A named place in the question ("Palace of Fine Arts", "Is Target still open?"), or null. */
function namedPlace(question: string): string | null {
    for (const match of question.matchAll(NAME_RUN)) {
        const words = match[0].split(/\s+/).filter((word) => !NOT_NAMES.has(word.replace(/[.,!?]+$/, '')));
        if (words.length === 0) continue;
        const name = words.join(' ').replace(/[.,!?]+$/, '');
        // One capitalized word at the start of a sentence is usually just the first word, not a name.
        const before = question.slice(0, match.index ?? 0);
        if (words.length === 1 && match[0] === words[0] && (before.trim() === '' || /[.?!]\s*$/.test(before))) continue;
        if (name.length > 0) return name.slice(0, 60);
    }
    return null;
}

/**
 * A short place query ("lunch", "pharmacy", "park"), never the person's memory and never the whole spoken sentence:
 * Maps finds nothing for a long sentence and the run times out (Oct 24, 15 s). In order: a place word, a named place,
 * an interest word, then DEFAULT_PLACE_QUERY.
 */
export function placeQuery(question: string): string {
    const text = question.toLowerCase();
    for (const word of PLACE_WORDS) if (new RegExp(`\\b${word}s?\\b`).test(text)) return word;
    // "near the Palace of Fine Arts" says where to look, not what to find: Maps already searches around that point.
    const rest = question.replace(NEAR_NAME, ' ');
    const name = namedPlace(rest);
    if (name) return name;
    const restText = rest.toLowerCase();
    for (const [pattern, query] of INTEREST_WORDS) if (pattern.test(restText)) return query;
    return DEFAULT_PLACE_QUERY;
}

/** At most this many words in a category's maps query ("quiet cafe", "park with a view"). */
const PLACE_QUERY_WORDS = 5;
const PLACE_QUERY_CHARS = 60;
// "... in San Francisco", "near Fort Mason": Maps already searches around AGENT_PLACES_NEAR, so a place only narrows it.
const PLACE_TAIL = /\s+(?:in|near|around|at|by)\s+(?:the\s+)?\p{Lu}.*$/u;
const TIME_TAIL = /\s+(?:today|tonight|now|right now|this (?:morning|afternoon|evening|weekend))$/i;
// A query that reads like the spoken question, which Maps cannot use.
const QUESTION_START = /^(?:anything|something|somewhere|what|where|when|which|who|how|is|are|can|could|do|does|did|should|would|will|want|any|let'?s)\b/i;

/**
 * A category's search words as a maps query: what to find, without the city or the time ("parks and gardens in San
 * Francisco" is "parks and gardens"). Words that are still long, or read like the question, go through placeQuery.
 */
export function shortPlaceQuery(words: string): string {
    const text = words.replace(/\s+/g, ' ').trim();
    const cut = text.replace(PLACE_TAIL, '').replace(TIME_TAIL, '').replace(/[?.!,]+$/, '').trim();
    const count = cut === '' ? 0 : cut.split(' ').length;
    if (count > 0 && count <= PLACE_QUERY_WORDS && cut.length <= PLACE_QUERY_CHARS && !QUESTION_START.test(cut)) return cut;
    return placeQuery(cut === '' ? text : cut);
}

/** One search as it goes out: Google Maps near AGENT_PLACES_NEAR, or the RAG web search. */
export interface PlannedSearch {
    kind: 'web' | 'maps';
    query: string;
}

/**
 * Direct select's category search: Maps with short place words when it is a place question and AGENT_PLACES_NEAR is
 * set, the web search with the words as they are otherwise. The category search job and its prefetch
 * (src/prefetch.ts) both plan with this, so a prefetched run is found again under the same words.
 */
export function categorySearch(deps: Pick<RetrievalDeps, 'placesNear'>, query: string, places: boolean): PlannedSearch {
    const kind = places && deps.placesNear ? 'maps' : 'web';
    return { kind, query: kind === 'maps' ? shortPlaceQuery(query) : query };
}

/** Sends one planned search with the sidecar's settings (src/wiring.ts searchPort sets the Actor limits). */
export function sendSearch(deps: Pick<RetrievalDeps, 'placesNear'>, search: SearchPort, planned: PlannedSearch, signal: AbortSignal): Promise<SearchResult> {
    return planned.kind === 'maps' ? search.places(planned.query, { signal, near: deps.placesNear ?? undefined }) : search.web(planned.query, { signal });
}

/**
 * Steps 2 and 3. A question that needs no outside facts writes one `search ok skipped` event (when web search is
 * allowed at all) and returns at once. Without consent for web search there is no search and no search event:
 * the module refuses search events for such a job. `allowed` reads that consent as the module shows it now, and is
 * checked again right before the question goes out. `stop` ends a search whose result can no longer be used; it
 * closes its step with `search stopped` and returns no rows.
 */
export async function searchStep(
    deps: RetrievalDeps,
    events: JobEvents,
    row: AgentQueueRow,
    check: QuestionClass,
    signal: AbortSignal,
    allowed: () => boolean = () => true,
    stop?: AbortSignal,
    /**
     * Direct select's category search: these search words instead of the question (a place query for maps), and
     * whether to look for places. Never memory: the words come from the question and the category.
     */
    override?: { query: string; places: boolean },
): Promise<SearchOutcome> {
    if (!check.needsWeb) {
        if (row.webSearchAllowed && allowed()) {
            await events.instant('search', 'ok', 'skipped', 0, {
                counts: { needsWeb: false, searches: 0, rowCount: 0 },
                payload: { reason: check.reason, rows: [] },
            });
        }
        return { status: 'not_needed', rows: [], kind: null };
    }
    if (!row.webSearchAllowed || !allowed()) return { status: 'not_allowed', rows: [], kind: null };
    if (!deps.search) {
        await events.instant('search', 'error', 'search off', 0, { counts: { needsWeb: true, searches: 0, rowCount: 0 } });
        return { status: 'failed', rows: [], kind: null };
    }
    const planned: PlannedSearch = override
        ? categorySearch(deps, override.query, override.places)
        : check.kind === 'places' && deps.placesNear
          ? { kind: 'maps', query: placeQuery(row.questionText) }
          : { kind: 'web', query: row.questionText };
    const kind = planned.kind;
    const step = await events.begin('search', kind);
    if (!allowed()) {
        // Revoked while the step was starting: the question never goes out.
        await step.error('search off');
        return { status: 'not_allowed', rows: [], kind: null };
    }
    // PLAN D26: one attempt, bounded by the search deadline. With a matching preloaded result, the live search gets
    // cacheGraceMs; after that, or if it fails, the preloaded rows are used and the live run is stopped.
    const cached = deps.cache?.find(planned) ?? null;
    const deadline = AbortSignal.timeout(deps.searchTimeoutMs);
    const instead = new AbortController();
    const combined = AbortSignal.any(stop ? [signal, deadline, instead.signal, stop] : [signal, deadline, instead.signal]);
    try {
        if (stop?.aborted) throw new DOMException('stopped', 'AbortError');
        const live = sendSearch(deps, deps.search, planned, combined);
        let result: SearchResult;
        if (cached) {
            const early = await within(live, deps.cacheGraceMs ?? CACHE_GRACE_MS);
            if (early === null) {
                instead.abort();
                return await cachedStep(deps, step, row, check, kind, cached, 'slow', allowed);
            }
            result = early;
        } else {
            result = await live;
        }
        await step.ok(result.partial ? `${kind} partial` : kind, {
            counts: { needsWeb: true, searches: 1, rowCount: result.rows.length, partial: result.partial },
            payload: { reason: check.reason, rows: result.rows.map(searchRowPayload) },
            listKey: 'rows',
        });
        return { status: 'done', rows: result.rows, kind };
    } catch (error) {
        if (signal.aborted) throw new JobAbortedError();
        if (stop?.aborted) {
            // Stopped on purpose: its result could no longer be used (a yes or no draft went final).
            await step.ok('search stopped', { counts: { needsWeb: true, searches: 1, rowCount: 0 } });
            return { status: 'none', rows: [], kind };
        }
        if (cached) return await cachedStep(deps, step, row, check, kind, cached, 'failed', allowed);
        await step.error(searchErrorLabel(kind, error, deadline.aborted), { counts: { needsWeb: true, searches: 1, rowCount: 0 } });
        deps.log.warn('search failed; planning without outside facts', { job: row.jobId, search: kind, deadline: deadline.aborted });
        return { status: 'failed', rows: [], kind };
    }
}

/**
 * `work`'s value if it settles within `ms`, or null once `ms` passes. Rejects if `work` rejects first. A later
 * rejection is handled here, so it can never become an unhandled rejection.
 */
function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
    return new Promise<T | null>((resolve, reject) => {
        const timer = setTimeout(() => resolve(null), ms);
        work.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

/**
 * The search step closed with preloaded rows (PLAN D26): real results fetched earlier, never shown as live. The detail
 * says `cached`, the counts carry `cached: true`, the rows' age in seconds (`ageS`) and why the live one was not used
 * (`liveFailed`), and every row keeps its own fetchedAt. Web search consent is read again first.
 */
async function cachedStep(
    deps: RetrievalDeps,
    step: Step,
    row: AgentQueueRow,
    check: QuestionClass,
    kind: 'web' | 'maps',
    cached: CachedSearch,
    why: 'slow' | 'failed',
    allowed: () => boolean,
    extra: Counts = {},
): Promise<SearchOutcome> {
    if (!allowed()) {
        await step.error('search off');
        return { status: 'not_allowed', rows: [], kind: null };
    }
    const ageS = Math.max(0, Math.round(cached.ageMs / 1000));
    await step.ok(label(kind, 'cached'), {
        counts: { needsWeb: true, searches: 1, rowCount: cached.rows.length, cached: true, ageS, liveFailed: why === 'failed', ...extra },
        payload: { reason: check.reason, rows: cached.rows.map(searchRowPayload) },
        listKey: 'rows',
    });
    deps.log.info('search used preloaded results', { job: row.jobId, search: kind, why, ageS, rows: cached.rows.length });
    return { status: 'done', rows: cached.rows, kind };
}

/** How a prefetched search ended (src/prefetch.ts). `ms` is how long its own run took. Never rejects. */
export type PrefetchOutcome = { ok: true; result: SearchResult; ms: number } | { ok: false; error: unknown; ms: number; timedOut: boolean };

/** A prefetched search a category search job takes over: already done, or still on its way. */
export interface PrefetchedRun {
    kind: 'web' | 'maps';
    outcome: Promise<PrefetchOutcome>;
}

/**
 * Steps 2 and 3 for a search that was prefetched when the categories were offered. Its events are this job's, as if
 * it had searched itself: `search started`, then `ok` (or `error`) with the run's own time and `prefetched: true`
 * (`waitMs` is what this job waited for it). Web search consent is read again once the run is back, and a revoked
 * consent means none of its rows are used. PLAN D26: the prefetched run is this pick's one search. When it fails or
 * runs out of time there is no second search: the preloaded rows for `planned` are used if there are any, and
 * otherwise the job plans without outside facts. With preloaded rows, the run gets cacheGraceMs before they are used.
 */
export async function prefetchedSearchStep(
    deps: RetrievalDeps,
    events: JobEvents,
    row: AgentQueueRow,
    check: QuestionClass,
    signal: AbortSignal,
    allowed: () => boolean,
    run: PrefetchedRun,
    planned?: PlannedSearch,
): Promise<SearchOutcome> {
    if (!row.webSearchAllowed || !allowed()) return { status: 'not_allowed', rows: [], kind: null };
    const step = await events.begin('search', run.kind);
    const waitStart = events.now();
    const counts = { needsWeb: true, searches: 1, prefetched: true };
    const cached = planned ? (deps.cache?.find(planned) ?? null) : null;
    let outcome: PrefetchOutcome | null;
    try {
        // The run has its own deadline, started earlier; this one only bounds the wait, and the job's signal ends it.
        const waiting = cached ? within(run.outcome, deps.cacheGraceMs ?? CACHE_GRACE_MS) : run.outcome;
        outcome = await withDeadline(waiting, deps.searchTimeoutMs, 'prefetched search', signal);
    } catch (error) {
        if (signal.aborted || error instanceof JobAbortedError) throw new JobAbortedError();
        if (cached) return await cachedStep(deps, step, row, check, run.kind, cached, 'failed', allowed, { prefetched: true, waitMs: wholeMs(events.now() - waitStart) });
        await step.error(searchErrorLabel(run.kind, error, true), { counts: { ...counts, rowCount: 0, waitMs: wholeMs(events.now() - waitStart) } });
        deps.log.warn('the prefetched search did not come back in time; planning without outside facts', { job: row.jobId, search: run.kind });
        return { status: 'failed', rows: [], kind: run.kind };
    }
    if (signal.aborted) throw new JobAbortedError();
    const waitMs = wholeMs(events.now() - waitStart);
    if (!allowed()) {
        // Revoked while the run was on its way: nothing it found is used or shown.
        await step.error('search off');
        return { status: 'not_allowed', rows: [], kind: null };
    }
    if (outcome === null || !outcome.ok) {
        if (cached) return await cachedStep(deps, step, row, check, run.kind, cached, outcome === null ? 'slow' : 'failed', allowed, { prefetched: true, waitMs });
        if (outcome === null) {
            // Not reached: a wait ends early only when there are preloaded rows.
            await step.error(label(run.kind, 'timeout'), { counts: { ...counts, rowCount: 0, waitMs } });
            return { status: 'failed', rows: [], kind: run.kind };
        }
        await step.error(searchErrorLabel(run.kind, outcome.error, outcome.timedOut), { ms: outcome.ms, counts: { ...counts, rowCount: 0, waitMs } });
        deps.log.info('the prefetched search failed; planning without outside facts (one search per pick)', { job: row.jobId, search: run.kind, deadline: outcome.timedOut });
        return { status: 'failed', rows: [], kind: run.kind };
    }
    const result = outcome.result;
    await step.ok(result.partial ? `${run.kind} partial` : run.kind, {
        ms: outcome.ms,
        counts: { ...counts, rowCount: result.rows.length, partial: result.partial, waitMs },
        payload: { reason: check.reason, rows: result.rows.map(searchRowPayload) },
        listKey: 'rows',
    });
    return { status: 'done', rows: result.rows, kind: run.kind };
}

export interface Retrieved {
    web: WebContext[];
}

const MAX_WEB_CONTEXT = 6;

function contextFromHits(hits: readonly WebHit[]): WebContext[] {
    const out: WebContext[] = [];
    for (const hit of hits) {
        const source = sourceRefOf(hit.row);
        if (!hit.row || !source) continue;
        out.push({ ref: `w${out.length + 1}`, kind: hit.row.source, title: hit.row.title, text: hit.text, score: hit.score, source });
        if (out.length >= MAX_WEB_CONTEXT) break;
    }
    return out;
}

/** Without Moss: the rows themselves, best ranked first, with a score that falls with rank. */
function contextFromRows(rows: readonly SearchRow[]): WebContext[] {
    return rows.slice(0, MAX_WEB_CONTEXT).map((row, i) => ({
        ref: `w${i + 1}`,
        kind: row.source,
        title: row.title,
        text: excerpt(row.text, 600),
        score: Math.max(0.5, 1 - i * 0.1),
        source: sourceRefOf(row) ?? { source: row.source, url: undefined, placeId: undefined, fetchedAt: row.fetchedAt },
    }));
}

/**
 * Step 4: chunk the rows into the Moss web index for this question and retrieve the passages that match it. The
 * caller forgets the question's passages at the end whenever it had rows, because an index call that ran past its
 * deadline can still land later.
 */
export async function retrieveStep(
    deps: RetrievalDeps,
    events: JobEvents,
    row: AgentQueueRow,
    questionKey: string,
    rows: readonly SearchRow[],
    recall: Recall | null,
    signal: AbortSignal,
    memoryAllowed: () => boolean = () => true,
    /** What the passages are matched against: the question by default, the category's search words for a category search. */
    query: string = row.questionText,
): Promise<Retrieved> {
    if (rows.length === 0) return { web: [] };
    if (!deps.web || !deps.memory || !deps.memory.isOpen()) {
        // Moss is off or closed: the planner reads the top rows directly.
        return { web: contextFromRows(rows) };
    }
    const index = await events.begin('retrieve', 'web index');
    try {
        const result = await withDeadline(deps.web.index(questionKey, rows), mossDeadline(deps, 'index'), 'web index', signal);
        await index.ok('web index', { counts: { rows: result.rows, chunks: result.chunks, indexMs: result.indexMs, skippedRows: result.skipped } });
    } catch (error) {
        if (signal.aborted || error instanceof JobAbortedError) throw new JobAbortedError();
        await index.error(mossErrorLabel('web index', error));
        deps.log.warn('web index failed; planning from the rows', { job: row.jobId });
        return { web: contextFromRows(rows) };
    }
    const search = await events.begin('retrieve', 'web search');
    try {
        const found = await withDeadline(deps.web.search(questionKey, query), mossDeadline(deps, 'search'), 'web search', signal);
        const web = contextFromHits(found.hits);
        // The memory hits are shown beside the web hits only while memory consent still holds.
        const memoryPayload: PayloadHit[] = recall && memoryAllowed() ? recall.hits.map(memoryHitPayload) : [];
        await search.ok('web search', {
            counts: {
                hitCount: memoryPayload.length + found.hits.length,
                memoryHits: memoryPayload.length,
                webHits: found.hits.length,
                mossMs: found.mossMs ?? undefined,
            },
            payload: { hits: [...memoryPayload, ...found.hits.map(webHitPayload)] },
            listKey: 'hits',
        });
        return { web: web.length > 0 ? web : contextFromRows(rows) };
    } catch (error) {
        if (signal.aborted || error instanceof JobAbortedError) throw new JobAbortedError();
        await search.error(mossErrorLabel('web search', error));
        return { web: contextFromRows(rows) };
    }
}

/** Memory hits as planner context, `m1`, `m2`, ... Private text: it goes into the prompt only. */
export function memoryContext(recall: Recall | null): MemoryContext[] {
    if (!recall) return [];
    return recall.hits.slice(0, 8).map((hit, i) => ({
        ref: `m${i + 1}`,
        id: hit.id,
        type: hit.type,
        text: hit.text,
        savedAtMs: hit.at,
    }));
}
