// Retrieval for one Options job (PLAN D8, docs/spacetime.md 7.4 step 3):
// 1. Memory first: the person's own memory from Moss, locally, in milliseconds.
// 2. A local check (classifyQuestion) decides whether the question needs outside facts. Small talk and personal
//    questions never wait on a search.
// 3. Only then a web or place search (Apify), under its own deadline so it stays inside the job lease.
// 4. The rows are chunked into the Moss web index for this question, and the passages that match the question
//    come back for the planner.
// Every step writes a pipeline event with its time and counts; failures degrade (no memory, no web) instead of
// failing the job, because the person still needs options.

import { ApifyHttpError, type QuestionClass, type SearchRow } from '@say-when/apify-client';
import { MossCallError, MossRunError, type Recall, type WebHit } from '@say-when/moss';

import { DeadlineError, JobAbortedError, withDeadline } from './deadline.js';
import type { Logger } from './log.js';
import { label, StaleAttemptError, type JobEvents } from './pipeline.js';
import type { MemoryContext, WebContext } from './planner/types.js';
import type { Classifier, MemoryPort, SearchPort, WebIndexPort } from './ports.js';
import { excerpt, memoryHitPayload, searchRowPayload, sourceRefOf, webHitPayload, type PayloadHit } from './privacy.js';
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
    /** The search's own deadline, kept well inside the 45 s job lease. */
    searchTimeoutMs: number;
    /** Defaults to MOSS_DEADLINES. */
    mossDeadlines?: Partial<MossDeadlines>;
    log: Logger;
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

/**
 * Step 1: the person's memory for this question and this partner. Null when memory is off, closed or failed.
 * `allowed` reads the job's memory consent as the module shows it now: it is checked again after every wait, since
 * consent can be revoked while a job runs.
 */
export async function recallMemory(
    deps: RetrievalDeps,
    events: JobEvents,
    row: AgentQueueRow,
    signal: AbortSignal,
    allowed: () => boolean = () => true,
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
        const recall = allowed() ? await withDeadline(deps.memory.recall(row.questionText, row.askedBy), mossDeadline(deps, 'recall'), 'memory recall', signal) : null;
        if (!recall || !allowed()) {
            // Revoked while the step started or while Moss answered: nothing from memory is used or shown.
            await step.ok('memory recall', { counts: { hitCount: 0, memoryAllowed: false } });
            return null;
        }
        await step.ok('memory recall', {
            counts: { hitCount: recall.hits.length, instant: recall.instant.length, mossMs: recall.mossMs ?? undefined },
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

/** A short place query ("lunch", "pharmacy"), never the person's memory. Falls back to the question's own words. */
export function placeQuery(question: string): string {
    const text = question.toLowerCase();
    for (const word of PLACE_WORDS) if (new RegExp(`\\b${word}s?\\b`).test(text)) return word;
    return question.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * Steps 2 and 3. A question that needs no outside facts writes one `search ok skipped` event (when web search is
 * allowed at all) and returns at once. Without consent for web search there is no search and no search event:
 * the module refuses search events for such a job. `allowed` reads that consent as the module shows it now, and is
 * checked again right before the question goes out.
 */
export async function searchStep(
    deps: RetrievalDeps,
    events: JobEvents,
    row: AgentQueueRow,
    check: QuestionClass,
    signal: AbortSignal,
    allowed: () => boolean = () => true,
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
    const kind: 'web' | 'maps' = check.kind === 'places' && deps.placesNear ? 'maps' : 'web';
    const step = await events.begin('search', kind);
    if (!allowed()) {
        // Revoked while the step was starting: the question never goes out.
        await step.error('search off');
        return { status: 'not_allowed', rows: [], kind: null };
    }
    const deadline = AbortSignal.timeout(deps.searchTimeoutMs);
    const combined = AbortSignal.any([signal, deadline]);
    try {
        const result =
            kind === 'maps'
                ? await deps.search.places(placeQuery(row.questionText), { signal: combined, near: deps.placesNear ?? undefined })
                : await deps.search.web(row.questionText, { signal: combined });
        await step.ok(result.partial ? `${kind} partial` : kind, {
            counts: { needsWeb: true, searches: 1, rowCount: result.rows.length, partial: result.partial },
            payload: { reason: check.reason, rows: result.rows.map(searchRowPayload) },
            listKey: 'rows',
        });
        return { status: 'done', rows: result.rows, kind };
    } catch (error) {
        if (signal.aborted) throw new JobAbortedError();
        await step.error(searchErrorLabel(kind, error, deadline.aborted), { counts: { needsWeb: true, searches: 1, rowCount: 0 } });
        deps.log.warn('search failed; planning without outside facts', { job: row.jobId, search: kind, deadline: deadline.aborted });
        return { status: 'failed', rows: [], kind };
    }
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
        const found = await withDeadline(deps.web.search(questionKey, row.questionText), mossDeadline(deps, 'search'), 'web search', signal);
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
