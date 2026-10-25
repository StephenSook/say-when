// Direct select (docs/direct-select.md, PLAN D18, D23): three gestures pick three options, so the person hears the
// whole list once, numbered, and picks any of them. A web search runs when they ask for it, or at once when the partner
// asks "do you know" (D24). Three jobs:
// - Options: memory first, then Claude's options, each with a short earpiece label. Every partner question answered in
//   pick mode gets a Search option third while web search is allowed and set up (D24): reply, reply (or the errand or
//   the call), Search the web. Nothing is searched here, except for "do you know": that question is searched at once
//   (maps or web, as the scan path does) and the replies come from the results, with their sources.
// - Categories (after a Search pick and its confirm): up to four categories tailored to the question, planned with no
//   web call, and the search words each one stands for (kept in CategoryBook). With AGENT_SEARCH_PREFETCH the search
//   for each of the first three starts as the categories are published (src/prefetch.ts), since the person already
//   confirmed it.
// - Category search (after a Category pick): the Google Maps search near AGENT_PLACES_NEAR for a place question, the
//   RAG web search otherwise (the prefetched run for that category when there is one), indexed the usual way
//   (pipeline rows, the question's Moss web index), then up to four places or facts as replies with their sources.
// The person always picks; a reply is said aloud at once, and an errand, a call or a search start waits for a read-back
// and a fresh confirm in the module.

import type { QuestionClass } from '@say-when/apify-client';

import { LIMITS } from './contract.js';
import { withDeadline } from './deadline.js';
import { classifyYesNo, stockYesNo } from './fastpath.js';
import {
    ConsentWithdrawnError,
    consentNow,
    JobInputError,
    memoryConsent,
    planOptions,
    publish,
    recentErrand,
    type JobDeps,
    type PlanContext,
} from './jobs.js';
import { acceptedSource, PAD_REPLIES } from './options.js';
import { JobEvents } from './pipeline.js';
import { PlannerError, type PlanInput, type WebContext } from './planner/types.js';
import { SearchPrefetch } from './prefetch.js';
import {
    categorySearch,
    JobAbortedError,
    memoryContext,
    mossDeadline,
    prefetchedSearchStep,
    recallMemory,
    retrieveStep,
    searchStep,
    sendSearch,
    type SearchOutcome,
} from './retrieval.js';
import type { AgentQueueRow, AnswerMode, OptionInput, Tone } from './types.js';

const clean = (text: string): string => text.replace(/\s+/g, ' ').trim();
const norm = (text: string): string => clean(text).toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, '').trim();

/**
 * A job the person cannot be helped with right now, with the sentence they hear (agent_fail). For example a category
 * search after web search consent was withdrawn.
 */
export class DirectRefusal extends Error {
    constructor(
        readonly code: string,
        readonly sentence: string,
    ) {
        super(`direct select: ${code}`);
        this.name = 'DirectRefusal';
    }
}

export const WEB_OFF = 'Web search is turned off, so I did not search.';
export const SEARCH_OFF = 'Web search is not set up, so I did not search.';

/** The Search option the sidecar adds when the planner left it out (its words are fixed, never a fact). */
export const STOCK_SEARCH: Readonly<OptionInput> = {
    kind: 'search',
    label: 'Search the web',
    text: 'Search the web for ideas.',
    tone: '',
    laugh: false,
    provenance: 'stock',
    sources: [],
    memoryRefs: [],
    actionJson: '',
};

/** Fills a list up to `count` options with stock replies, each in a tone and with words the list does not use yet. */
function padWithReplies(options: OptionInput[], count: number): OptionInput[] {
    const out = [...options];
    for (const pad of PAD_REPLIES) {
        if (out.length >= count) break;
        if (out.some((o) => o.tone === pad.tone || norm(o.text) === norm(pad.text) || norm(o.label) === norm(pad.label))) continue;
        out.push({ kind: 'reply', label: pad.label, text: pad.text, tone: pad.tone, laugh: false, provenance: 'stock', sources: [], memoryRefs: [], actionJson: '' });
    }
    return out;
}

/**
 * The options with exactly one Search option, always third (PLAN D24; at most three options since D23): reply, reply
 * (or the errand or the call), Search the web. An errand or a call comes right after the first reply, so a three-option
 * list keeps it; a list with fewer than two other options is filled up with stock replies (as D22 does), so Search is
 * still third. A yes or no plan becomes a pick, since the module takes only replies in yes_no mode. With a bigger
 * `maxOptions` (four), the rest follow the Search option.
 */
export function withSearch(options: readonly OptionInput[], maxOptions: number): { answerMode: AnswerMode; options: OptionInput[]; added: boolean } {
    const found = options.find((o) => o.kind === 'search');
    const search = found ?? { ...STOCK_SEARCH };
    const room = Math.max(1, Math.min(maxOptions, LIMITS.maxOptions) - 1);
    const others = options.filter((o) => o.kind !== 'search');
    const [first, ...moreReplies] = others.filter((o) => o.kind === 'reply');
    const actions = others.filter((o) => o.kind !== 'reply');
    const ordered = first && actions.length > 0 ? [first, ...actions, ...moreReplies] : others;
    const rest = padWithReplies(ordered.slice(0, room), Math.min(2, room));
    const at = Math.min(2, rest.length);
    return { answerMode: 'pick', options: [...rest.slice(0, at), search, ...rest.slice(at)], added: !found };
}

/**
 * The Search option is offered for every partner question the planner answers (PLAN D24, Stephen Oct 25), while web
 * search is allowed and set up: also small talk, and also in the ten minutes after a request was sent (the call option
 * keeps its own rule, recentErrand). Never on the person's own menu, and never with the stock yes or no (fast path).
 */
function searchOffered(deps: JobDeps, row: AgentQueueRow, isMenu: boolean, allowWeb: () => boolean): boolean {
    return !isMenu && row.webSearchAllowed && allowWeb() && deps.retrieval.search !== null;
}

/**
 * "Do you know ..." (PLAN D24, Stephen Oct 25): the partner asks whether the person knows something, so the options job
 * searches at once, with no Search pick, no confirm and no categories. Any case, whole words; "d'you know" too.
 */
const DO_YOU_KNOW = /\b(?:do\s+|d['’]\s?)you\s+know\b/i;

export function asksDoYouKnow(question: string): boolean {
    return DO_YOU_KNOW.test(question);
}

/** The reason in the payload of a "do you know" search event: fixed words, never the question. */
export const DO_YOU_KNOW_REASON = 'Asked "do you know", so the web search ran at once.';

/**
 * Options job in direct select: everything from the question to `agent_publish_options(final = true)`. No search,
 * except for "do you know" (D24), which is searched at once.
 */
export async function runDirectOptionsJob(row: AgentQueueRow, attempt: number, deps: JobDeps, signal: AbortSignal): Promise<void> {
    const job = { jobId: row.jobId, attempt };
    const events = new JobEvents(deps.db, job, deps.log, deps.clock, { heartbeatMs: deps.leaseHeartbeatMs, signal });
    const questionKey = `q${row.questionId}`;
    const isMenu = row.origin === 'menu' && row.menuItem !== 'none';
    if (!isMenu && row.questionText.trim() === '') throw new JobInputError('empty_question');
    const allowMemory = () => memoryConsent(deps, row, attempt);
    const allowWeb = () => consentNow(deps, row, attempt).webSearchAllowed;
    const callPossible = () => !!deps.dialer && deps.contacts.length > 0 && recentErrand(row, deps.now()) !== null;
    // The conversation is kept, and sent, only under memory consent (as in the scan path, src/jobs.ts).
    const history = allowMemory() ? deps.conversation.recent(row.askedBy) : [];
    if (!isMenu && allowMemory()) deps.conversation.add(row.askedBy, { speaker: 'partner', text: row.questionText });
    // Set once the question's rows may be in the Moss web index ("do you know"), so they are forgotten whatever happens.
    let mayBeIndexed = false;
    try {
        const check = isMenu ? null : deps.retrieval.classify(row.questionText);
        const offer = searchOffered(deps, row, isMenu, allowWeb);
        // "Do you know ..." is searched now (D24); any other question waits for the person to pick Search.
        const searchNow = offer && asksDoYouKnow(row.questionText);
        // A question that could use outside facts (D8) is not answered with the stock Yes and No: Search fits better.
        const searchFits = offer && !!check?.needsWeb;

        // 0. The yes or no fast path: "One: yes. Two: no." at once. Not when a search or a call fits better.
        if (!isMenu && deps.yesNoFast) {
            const verdict = classifyYesNo(row.questionText);
            const fast = verdict.yesNo && !callPossible() && !searchFits && !searchNow;
            const why = verdict.yesNo && !fast ? (searchNow ? 'do_you_know' : searchFits ? 'search_possible' : 'call_possible') : verdict.reason;
            deps.log.info(fast ? 'yes or no fast path: stock options' : 'yes or no fast path not taken', { job: row.jobId, why });
            if (fast) {
                const options = stockYesNo();
                await events.instant('plan', 'ok', 'yes no stock', 0, { counts: { optionCount: options.length, yesNo: true, final: true } });
                await publish(deps.db, job, 'yes_no', options, true);
                deps.log.info('options published', { job: row.jobId, options: options.length, mode: 'yes_no', ms: 0 });
                return;
            }
        }

        // 1. Memory first.
        const recall = await recallMemory(deps.retrieval, events, row, signal, allowMemory, deps.forms);
        if (signal.aborted) throw new JobAbortedError();

        // 2. The search. "Do you know ..." (D24): the search the scan path runs (Google Maps near AGENT_PLACES_NEAR for a
        // place question, the RAG web search otherwise), with its pipeline events, then the question's Moss web index.
        // Any other question: nothing is searched until the person picks Search and confirms.
        let searched: SearchOutcome | null = null;
        let found: WebContext[] = [];
        if (searchNow && check) {
            searched = await searchStep(deps.retrieval, events, row, { ...check, needsWeb: true, reason: DO_YOU_KNOW_REASON }, signal, allowWeb);
            if (signal.aborted) throw new JobAbortedError();
            mayBeIndexed = searched.rows.length > 0;
            found = (await retrieveStep(deps.retrieval, events, row, questionKey, searched.rows, recall, signal, allowMemory)).web;
            if (signal.aborted) throw new JobAbortedError();
            deps.log.info('do you know: searched at once', { job: row.jobId, search: searched.kind, status: searched.status, rows: searched.rows.length });
        } else if (check && offer) {
            await events.instant('search', 'ok', 'offered', 0, {
                counts: { needsWeb: check.needsWeb, searches: 0, rowCount: 0, offered: true },
                payload: { reason: check.reason, rows: [] },
            });
        } else if (check && !check.needsWeb) await searchStep(deps.retrieval, events, row, check, signal, allowWeb);
        const ctx: PlanContext = { deps, row, events, signal, allowMemory, allowWeb };

        // 3. Claude's options, and the publish. As in the scan path, a plan that relied on a consent withdrawn on the
        // way is written again without it, three rounds at most; a Search option and the results need web search consent.
        for (let round = 1; ; round++) {
            const consent = consentNow(deps, row, attempt);
            const offering = offer && consent.webSearchAllowed;
            const nowMs = deps.now();
            const recent = recentErrand(row, nowMs);
            const memory = consent.memoryAllowed ? memoryContext(recall) : [];
            const web = consent.webSearchAllowed ? found : [];
            const searchStatus: PlanInput['search'] = searched
                ? web.length > 0
                    ? 'done'
                    : consent.webSearchAllowed || searched.status === 'not_needed' || searched.status === 'none'
                      ? searched.status
                      : 'not_allowed'
                : offering
                  ? 'offered'
                  : check?.needsWeb
                    ? 'not_allowed'
                    : check
                      ? 'not_needed'
                      : 'none';
            const input: PlanInput = {
                question: row.questionText,
                origin: row.origin,
                menuItem: row.menuItem,
                history: consent.memoryAllowed ? history : [],
                memory,
                web,
                forms: deps.forms,
                contacts: recent && deps.dialer ? deps.contacts : [],
                recentErrand: recent,
                search: searchStatus,
                task: 'options',
                searchOffer: offering,
                ...(searched ? { searchedNow: true } : {}),
                maxOptions: deps.maxOptions,
                nowMs,
                timeZone: deps.timeZone,
                consent: () => ({ memory: allowMemory(), web: allowWeb() }),
            };
            // With a Search option the order means something (reply, reply or action, search), so memory does not reorder it.
            const planned = await planOptions(ctx, input, memory, web, recent, 'claude', !offering);
            const shaped = offering ? withSearch(planned.options, deps.maxOptions) : { answerMode: planned.plan.answerMode, options: planned.options, added: false };
            const allowed = () => planned.stillAllowed() && (!offering || allowWeb());
            try {
                if (!allowed()) throw new ConsentWithdrawnError();
                await publish(deps.db, job, shaped.answerMode, shaped.options, true, allowed);
                deps.log.info('options published', {
                    job: row.jobId,
                    options: shaped.options.length,
                    mode: shaped.answerMode,
                    ms: planned.plan.ms,
                    search: offering,
                    searchAdded: shaped.added,
                });
                break;
            } catch (error) {
                if (!(error instanceof ConsentWithdrawnError)) throw error;
                if (round >= 3) throw new PlannerError('aborted');
                deps.log.info('a consent was withdrawn while the options were made; writing them again without it', { job: row.jobId });
            }
        }
    } finally {
        events.close();
        if (mayBeIndexed && deps.retrieval.web) {
            // Bounded and without the job's signal, as in the scan path's options job.
            const forgetting = deps.retrieval.web.forget(questionKey);
            await withDeadline(forgetting, mossDeadline(deps.retrieval, 'forget'), 'web forget').catch(() =>
                deps.log.warn('could not forget the web passages in time; Moss drops them when the run closes', { job: row.jobId }),
            );
        }
    }
}

// ---------- Categories ----------

export interface CategoryEntry {
    label: string;
    text: string;
    /** The search words the category stands for. Public words only: from the question and the category, never memory. */
    query: string;
}

/**
 * The categories this sidecar offered, by question, so a Category pick runs the search words the planner wrote for
 * it. In this process only (a restart falls back to defaultCategoryQuery). Content-light: category words and search
 * words, never memory.
 */
export class CategoryBook {
    private readonly entries = new Map<string, CategoryEntry[]>();

    constructor(private readonly max = 50) {}

    record(questionId: bigint, categories: readonly CategoryEntry[]): void {
        const key = questionId.toString();
        this.entries.delete(key);
        this.entries.set(key, categories.map((c) => ({ ...c })));
        while (this.entries.size > this.max) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
    }

    /** The search words for the picked category (matched by its label or its text), or null. */
    find(questionId: bigint, category: string): string | null {
        const wanted = norm(category);
        if (wanted === '') return null;
        const found = (this.entries.get(questionId.toString()) ?? []).find((c) => norm(c.label) === wanted || norm(c.text) === wanted);
        return found?.query ?? null;
    }
}

function categoryBook(deps: JobDeps): CategoryBook {
    deps.categoryBook ??= new CategoryBook();
    return deps.categoryBook;
}

function prefetchBook(deps: JobDeps): SearchPrefetch {
    deps.prefetches ??= new SearchPrefetch(deps.db, deps.log, deps.clock);
    return deps.prefetches;
}

/**
 * Starts the search for each offered category (src/prefetch.ts), right before the categories are published: the
 * person confirmed the search, and the categories job is still this attempt's (a pause or a new question cancels it),
 * which `live` checks again before each search goes out, together with the module's web search consent. Returns how
 * many searches went out.
 */
function startPrefetch(deps: JobDeps, row: AgentQueueRow, attempt: number, original: { id: bigint; text: string }, entries: readonly CategoryEntry[], signal: AbortSignal): number {
    const search = deps.retrieval.search;
    if (!deps.prefetch || !search || entries.length === 0) return 0;
    const places = deps.retrieval.classify(original.text).kind === 'places';
    const live = () =>
        !signal.aborted && deps.db.agentQueue().some((r) => r.jobId === row.jobId && r.status === 'claimed' && r.claimedByMe && r.attempt === attempt);
    return prefetchBook(deps).start(
        original.id,
        entries.map((entry) => categorySearch(deps.retrieval, entry.query, places)),
        deps.retrieval.searchTimeoutMs,
        live,
        (planned, runSignal) => sendSearch(deps.retrieval, search, planned, runSignal),
    );
}

/**
 * A categories or search turn is a new question row on the person's original question (spacetime/src/clock.ts
 * createFollowUp), so both share the original's id: the categories are kept under it, and found again under it.
 */
function originalOf(row: AgentQueueRow): { id: bigint; text: string } {
    return {
        id: row.parentQuestionId !== 0n ? row.parentQuestionId : row.questionId,
        text: row.parentQuestionText.trim() !== '' ? row.parentQuestionText : row.questionText,
    };
}

/** The place a question names after in, near, around or at ("... today in San Francisco?"), or null. */
export function placeHint(question: string): string | null {
    const match = /\b(?:in|near|around|at)\s+((?:[A-Z][\p{L}'.-]*)(?:\s+[A-Z][\p{L}'.-]*){0,3})/u.exec(question);
    return match?.[1] ?? null;
}

/** The question as search words: one line, no closing punctuation, short. */
function topicOf(question: string): string {
    return clean(question).replace(/[?.!]+$/, '').slice(0, 100);
}

const PLACE_CATEGORIES: readonly { label: string; text: string; words: string }[] = [
    { label: 'Nature', text: 'Something outdoors, like a park.', words: 'parks and gardens' },
    { label: 'Fun', text: 'Something fun to do.', words: 'fun things to do' },
    { label: 'Food', text: 'Somewhere to eat.', words: 'restaurants' },
];
const FACT_CATEGORIES: readonly { label: string; text: string; suffix: string }[] = [
    { label: 'Quick facts', text: 'The short answer.', suffix: '' },
    { label: 'Latest news', text: 'What is new about it.', suffix: ' news' },
];
const SOMETHING_ELSE = { label: 'Something else', text: 'Something else.' } as const;

/** The categories when the planner cannot write them: fixed words for a place question, or for facts. */
export function stockCategories(question: string, check: QuestionClass, max: number): CategoryEntry[] {
    const topic = topicOf(question);
    const place = placeHint(question);
    const list: CategoryEntry[] =
        check.kind === 'places'
            ? PLACE_CATEGORIES.map((c) => ({ label: c.label, text: c.text, query: place ? `${c.words} in ${place}` : c.words }))
            : FACT_CATEGORIES.map((c) => ({ label: c.label, text: c.text, query: `${topic}${c.suffix}` }));
    const room = Math.max(1, Math.min(max, LIMITS.maxOptions) - 1);
    return [...list.slice(0, room), { ...SOMETHING_ELSE, query: topic }];
}

/** Search words for a category this sidecar did not offer (or no longer remembers). */
export function defaultCategoryQuery(question: string, category: string): string {
    const topic = topicOf(question);
    const wanted = norm(category);
    if (wanted === '' || wanted === norm(SOMETHING_ELSE.label)) return topic;
    const stock = PLACE_CATEGORIES.find((c) => norm(c.label) === wanted);
    const place = placeHint(question);
    if (stock) return place ? `${stock.words} in ${place}` : stock.words;
    return `${clean(category).slice(0, 40)} ${place ? `in ${place}` : topic}`.trim();
}

function categoryOption(entry: CategoryEntry, provenance: 'model' | 'stock'): OptionInput {
    return { kind: 'category', label: entry.label, text: entry.text, tone: '', laugh: false, provenance, sources: [], memoryRefs: [], actionJson: '' };
}

/** Categories job: after a confirmed Search, up to four categories for the question, with no web call. */
export async function runCategoriesJob(row: AgentQueueRow, attempt: number, deps: JobDeps, signal: AbortSignal): Promise<void> {
    const job = { jobId: row.jobId, attempt };
    const events = new JobEvents(deps.db, job, deps.log, deps.clock, { heartbeatMs: deps.leaseHeartbeatMs, signal });
    try {
        const original = originalOf(row);
        if (original.text.trim() === '') throw new JobInputError('empty_question');
        // No web call here, so the job carries no web search consent (the module checks it again at the Category pick).
        const ctx: PlanContext = { deps, row, events, signal, allowMemory: () => memoryConsent(deps, row, attempt), allowWeb: () => false };
        // Only the question: no memory and no conversation, so the search words can carry nothing private. A place
        // question searched on the maps is already centred on the venue, so its search words name no city.
        const placesNear = deps.retrieval.placesNear !== null && deps.retrieval.classify(original.text).kind === 'places';
        const input: PlanInput = {
            question: original.text,
            origin: row.origin,
            menuItem: row.menuItem,
            history: [],
            memory: [],
            web: [],
            forms: [],
            contacts: [],
            recentErrand: null,
            search: 'none',
            task: 'categories',
            ...(placesNear ? { placesNear: true } : {}),
            maxOptions: deps.maxOptions,
            nowMs: deps.now(),
            timeZone: deps.timeZone,
        };
        let entries: CategoryEntry[];
        let options: OptionInput[];
        try {
            const planned = await planOptions(ctx, input, [], [], null, 'claude categories', false);
            entries = planned.plan.options.map((o) => ({ label: o.label, text: o.text, query: o.query }));
            options = planned.options;
        } catch (error) {
            if (signal.aborted || error instanceof JobAbortedError) throw new JobAbortedError();
            if (!(error instanceof PlannerError)) throw error;
            // The person asked to search, so fixed categories beat a failure.
            entries = stockCategories(original.text, deps.retrieval.classify(original.text), deps.maxOptions);
            options = entries.map((entry) => categoryOption(entry, 'stock'));
            deps.log.warn('the planner could not write categories; using the stock ones', { job: row.jobId, code: error.code });
            await events.instant('plan', 'ok', 'categories stock', 0, { counts: { optionCount: options.length, final: true } });
        }
        categoryBook(deps).record(original.id, entries);
        // Before the publish, which ends the job: a search goes out only while the job is still this attempt's. If the
        // publish fails, the runs are dropped unused when their time to live is up.
        const prefetched = startPrefetch(deps, row, attempt, original, entries, signal);
        await publish(deps.db, job, 'pick', options, true);
        deps.log.info('categories published', { job: row.jobId, options: options.length, prefetched });
    } finally {
        events.close();
    }
}

// ---------- Category search ----------

const PLACE_TONES: readonly Tone[] = ['warm', 'calm', 'neutral', 'firm'];

/** At most this many words in a place label (a place name may be longer than a category). */
const PLACE_LABEL_WORDS = 5;

function placeLabel(name: string): string {
    return clean(name).split(' ').slice(0, PLACE_LABEL_WORDS).join(' ');
}

/** Replies naming the places the maps search found, for when the planner cannot write them. Never a web page title. */
export function placeOptions(web: readonly WebContext[], max: number): OptionInput[] {
    const out: OptionInput[] = [];
    const seen = new Set<string>();
    for (const item of web) {
        if (item.kind !== 'maps' || out.length >= Math.min(max, LIMITS.maxOptions)) continue;
        const name = clean(item.title).replace(/[<>[\]{}]/g, '').slice(0, 80);
        if (name === '' || seen.has(norm(name))) continue;
        seen.add(norm(name));
        const source = acceptedSource(item.source);
        out.push({
            kind: 'reply',
            label: placeLabel(name),
            text: `Let's go to ${name}!`,
            tone: PLACE_TONES[out.length] ?? '',
            laugh: false,
            provenance: 'maps',
            sources: source ? [source] : [],
            memoryRefs: [],
            actionJson: '',
        });
    }
    return out;
}

/** Category search job: the search the person asked for, then up to four places or facts as replies. */
export async function runCategorySearchJob(row: AgentQueueRow, attempt: number, deps: JobDeps, signal: AbortSignal): Promise<void> {
    const job = { jobId: row.jobId, attempt };
    const events = new JobEvents(deps.db, job, deps.log, deps.clock, { heartbeatMs: deps.leaseHeartbeatMs, signal });
    const questionKey = `q${row.questionId}`;
    let mayBeIndexed = false;
    try {
        const category = clean(row.category);
        const original = originalOf(row);
        if (original.text.trim() === '') throw new JobInputError('empty_question');
        if (category === '') throw new JobInputError('empty_category');
        const allowWeb = () => consentNow(deps, row, attempt).webSearchAllowed;
        const allowMemory = () => memoryConsent(deps, row, attempt);
        if (!row.webSearchAllowed || !allowWeb()) throw new DirectRefusal('web_search_off', WEB_OFF);
        if (!deps.retrieval.search) throw new DirectRefusal('search_off', SEARCH_OFF);

        // The search words: the planner's for this category, or fixed ones. Never memory.
        const check = deps.retrieval.classify(original.text);
        const known = categoryBook(deps).find(original.id, category);
        const query = known ?? defaultCategoryQuery(original.text, category);
        const places = check.kind === 'places';
        const searchCheck = { ...check, needsWeb: true };
        // The run started when the categories were offered (src/prefetch.ts), under the same search words, if any.
        const prefetched = deps.prefetch ? (deps.prefetches?.take(original.id, categorySearch(deps.retrieval, query, places)) ?? null) : null;
        deps.log.info('category search', { job: row.jobId, known: known !== null, places, prefetched: prefetched !== null });
        const fromPrefetch = prefetched ? await prefetchedSearchStep(deps.retrieval, events, row, searchCheck, signal, allowWeb, prefetched) : null;
        if (signal.aborted) throw new JobAbortedError();
        // No prefetch, or it failed: the search as before.
        const search = fromPrefetch ?? (await searchStep(deps.retrieval, events, row, searchCheck, signal, allowWeb, undefined, { query, places }));
        if (signal.aborted) throw new JobAbortedError();

        // Indexed the usual way: the question's Moss web index, forgotten at the end.
        mayBeIndexed = search.rows.length > 0;
        const retrieved = await retrieveStep(deps.retrieval, events, row, questionKey, search.rows, null, signal, allowMemory, query);
        if (signal.aborted) throw new JobAbortedError();
        const ctx: PlanContext = { deps, row, events, signal, allowMemory, allowWeb };

        for (let round = 1; ; round++) {
            const web = allowWeb() ? retrieved.web : [];
            const input: PlanInput = {
                question: original.text,
                origin: row.origin,
                menuItem: row.menuItem,
                history: [],
                memory: [],
                web,
                forms: [],
                contacts: [],
                recentErrand: null,
                search: web.length > 0 ? 'done' : search.status === 'done' ? 'none' : search.status === 'not_allowed' || !allowWeb() ? 'not_allowed' : 'failed',
                task: 'category_search',
                category,
                maxOptions: deps.maxOptions,
                nowMs: deps.now(),
                timeZone: deps.timeZone,
                consent: () => ({ memory: false, web: allowWeb() }),
            };
            let options: OptionInput[];
            let allowed: () => boolean;
            try {
                const planned = await planOptions(ctx, input, [], web, null, 'claude results', false);
                options = planned.options;
                allowed = planned.stillAllowed;
            } catch (error) {
                if (signal.aborted || error instanceof JobAbortedError) throw new JobAbortedError();
                if (!(error instanceof PlannerError)) throw error;
                // Places the maps search found can still be offered by name; anything else fails as usual.
                const fallback = placeOptions(web, deps.maxOptions);
                if (fallback.length === 0) throw error;
                deps.log.warn('the planner could not write the results; offering the places by name', { job: row.jobId, code: error.code });
                await events.instant('plan', 'ok', 'places stock', 0, { counts: { optionCount: fallback.length, final: true } });
                options = fallback;
                allowed = allowWeb;
            }
            try {
                if (!allowed()) throw new ConsentWithdrawnError();
                await publish(deps.db, job, 'pick', options, true, allowed);
                deps.log.info('search results published', { job: row.jobId, options: options.length });
                break;
            } catch (error) {
                if (!(error instanceof ConsentWithdrawnError)) throw error;
                if (round >= 3) throw new PlannerError('aborted');
                deps.log.info('a consent was withdrawn while the options were made; writing them again without it', { job: row.jobId });
            }
        }
    } finally {
        events.close();
        if (mayBeIndexed && deps.retrieval.web) {
            // Bounded and without the job's signal, as in the options job.
            const forgetting = deps.retrieval.web.forget(questionKey);
            await withDeadline(forgetting, mossDeadline(deps.retrieval, 'forget'), 'web forget').catch(() =>
                deps.log.warn('could not forget the web passages in time; Moss drops them when the run closes', { job: row.jobId }),
            );
        }
    }
}
