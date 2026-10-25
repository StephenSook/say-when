// What the option planner takes and returns (PLAN row 3.4). The planner writes up to four short options in the
// person's own voice; the sidecar turns them into `answer_option` rows (src/options.ts).

import type { FieldInput } from '@say-when/apify-client';

import type { AllowedForm, AnswerMode, CallContact, MenuItem, OptionKind, Origin, SourceRef, Tone } from '../types.js';

/** One turn of the recent conversation, kept in this process only. */
export interface ConversationTurn {
    speaker: 'partner' | 'person';
    text: string;
}

/** A memory the planner may use. `text` is private: it goes into the prompt and nowhere else. */
export interface MemoryContext {
    /** Short id the planner cites, for example `m1`. */
    ref: string;
    /** The Moss memory id, stored on the option as a memory ref. */
    id: string;
    type: 'reply' | 'pref';
    text: string;
    savedAtMs: number | null;
}

/** A web passage or a place the planner may use. Public page text, cut short. */
export interface WebContext {
    /** Short id the planner cites, for example `w2`. */
    ref: string;
    kind: 'web' | 'maps';
    title: string;
    text: string;
    score: number;
    source: SourceRef;
}

export interface PlanInput {
    /** The partner's words, or the menu item the person picked. Private. */
    question: string;
    origin: Origin;
    menuItem: MenuItem;
    history: readonly ConversationTurn[];
    memory: readonly MemoryContext[];
    web: readonly WebContext[];
    /** Forms an errand option may use. Empty means no errand options. */
    forms: readonly AllowedForm[];
    /** Contacts a call option may name. Empty unless a call is possible right now. */
    contacts: readonly CallContact[];
    /** The newest errand sent in the last 10 minutes, which is all a call may report. */
    recentErrand: { title: string; sentAtMs: number } | null;
    /**
     * What the search step did, so the planner knows whether outside facts are in the context. `pending`: a draft
     * written while the search still runs (AGENT_DRAFT_FIRST), so there are no outside facts yet.
     */
    search: 'not_needed' | 'not_allowed' | 'done' | 'failed' | 'none' | 'pending' | 'offered';
    /**
     * Direct select (docs/direct-select.md section 3). `options` (the default): answer the question. `categories`:
     * after a confirmed Search pick, up to four categories to search, with no web call. `category_search`: after a
     * Category pick, replies from the search results.
     */
    task?: PlanTask;
    /**
     * `options` task: a Search option may be offered, third (direct select: every partner question answered in pick
     * mode while web search is allowed and set up, PLAN D24).
     */
    searchOffer?: boolean;
    /**
     * `options` task: the partner asked "do you know", so the web search already ran in this job and its results are in
     * `web` (PLAN D24). The replies come from them; the Search option stays third for a new, narrower search.
     */
    searchedNow?: boolean;
    /** `category_search` task: the category the person picked. */
    category?: string;
    /**
     * `categories` task: a place question whose search is the maps search centred on the venue (AGENT_PLACES_NEAR), so
     * each category's search words name only what to find, never a city.
     */
    placesNear?: boolean;
    maxOptions: number;
    nowMs: number;
    timeZone: string;
    /**
     * Memory and web consent as the module shows them now. Read right before each planner attempt (a retry
     * included): memory (with the conversation) and web passages go to the API only while still allowed.
     */
    consent?: () => { memory: boolean; web: boolean };
}

/** The input as consent allows at this moment. Without `consent`, the input as given. */
export function allowedInput(input: PlanInput): PlanInput {
    const now = input.consent?.();
    if (!now) return input;
    let out = input;
    if (!now.memory && (out.memory.length > 0 || out.history.length > 0)) out = { ...out, memory: [], history: [] };
    if (!now.web && out.web.length > 0) out = { ...out, web: [], search: 'not_allowed' };
    return out;
}

export type PlanTask = 'options' | 'categories' | 'category_search';

export interface PlannedOption {
    kind: OptionKind;
    /** The short words the earpiece reads (direct select): 1 to 3 words, a place name up to 5. */
    label: string;
    text: string;
    /** Category options only: the search words the category stands for. Empty otherwise. */
    query: string;
    tone: Tone;
    laugh: boolean;
    /** The context refs this option relies on (`m1`, `w2`), checked to exist. */
    refs: string[];
    /** Set for errand options: the allowed form and every field value, fixed values included. */
    errand: { form: AllowedForm; fields: FieldInput[] } | null;
    /** Set for call options: a contact from the input list. */
    call: { contact: CallContact } | null;
}

export interface Plan {
    answerMode: AnswerMode;
    options: PlannedOption[];
}

export interface PlanResult extends Plan {
    /** The model that served the reply (a server-side fallback can change it). */
    model: string;
    /** Wall time of the planner call, retries included. */
    ms: number;
    attempts: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    fallbackUsed: boolean;
    /** What the successful attempt sent: memory or the conversation, and web passages. */
    sentMemory: boolean;
    sentWeb: boolean;
}

export interface PlannerPort {
    plan(input: PlanInput, signal: AbortSignal): Promise<PlanResult>;
}

/**
 * Why the planner gave up. The message is a fixed sentence; `problems` lists which validation rules failed by
 * name, never with the reply's text.
 */
export type PlannerErrorCode =
    | 'timeout'
    | 'network'
    | 'rate_limited'
    | 'overloaded'
    | 'unavailable'
    | 'refused'
    | 'truncated'
    | 'invalid_reply'
    | 'auth'
    | 'bad_request'
    | 'not_found'
    | 'aborted'
    | 'error';

export class PlannerError extends Error {
    constructor(
        readonly code: PlannerErrorCode,
        readonly problems: readonly string[] = [],
    ) {
        super(`The option planner failed: ${code}${problems.length > 0 ? ` (${problems.join(', ')})` : ''}.`);
        this.name = 'PlannerError';
    }
}

/** Errors worth one more try: the request may succeed if sent again now. */
export const TRANSIENT_CODES: ReadonlySet<PlannerErrorCode> = new Set(['timeout', 'network', 'rate_limited', 'overloaded', 'unavailable']);
