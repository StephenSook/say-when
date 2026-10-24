// The work behind each agent job kind (docs/spacetime.md 4.5, 7.4 steps 3 to 5):
// - Options: memory first, the D8 search decision, search and retrieve, Claude's plan, then the options.
// - ErrandPreview: the form-errand Actor's preview, attached to the errand with its read-back and digest.
// - Remember: the reply that was said aloud goes into Moss, so the next question already knows it.
// Every write is fenced by (job_id, attempt). StaleAttemptError and JobAbortedError mean the job is someone
// else's now; the orchestrator drops the work. Any other error is reported with agent_fail.

import { ApifyHttpError, type FieldInput, type RefusalCode } from '@say-when/apify-client';
import type { CallRequest } from '@say-when/cartesia/server';

import { LIMITS } from './contract.js';
import type { AgentDb } from './db/db.js';
import { callReducer } from './db/retry.js';
import { classifyYesNo, stockYesNo } from './fastpath.js';
import type { Logger } from './log.js';
import { applyOrder, buildOptions, looksYesNo, memoryFirstOptions } from './options.js';
import { JobEvents, label, StaleAttemptError } from './pipeline.js';
import { PlannerError, type ConversationTurn, type MemoryContext, type PlanInput, type PlannerPort, type PlanResult, type WebContext } from './planner/types.js';
import type { DialerPort, ErrandPort, MemoryPort } from './ports.js';
import { withDeadline } from './deadline.js';
import { JobAbortedError, memoryContext, mossDeadline, recallMemory, retrieveStep, searchStep, type RetrievalDeps } from './retrieval.js';
import type { AgentQueueRow, AllowedForm, CallContact, OptionInput } from './types.js';

/**
 * The last few turns of the conversation with each partner, in this process only. Private text, never written
 * anywhere; it goes into the planner prompt for the same partner and nowhere else.
 */
export class ConversationLog {
    private readonly turns: (ConversationTurn & { partnerId: string })[] = [];

    constructor(private readonly max = 24) {}

    /** Forgets every turn: memory consent is off, so nothing the person said is kept or sent. */
    clear(): void {
        this.turns.length = 0;
    }

    add(partnerId: string, turn: ConversationTurn): void {
        const text = turn.text.replace(/\s+/g, ' ').trim();
        if (!text) return;
        this.turns.push({ partnerId, speaker: turn.speaker, text: text.slice(0, 300) });
        while (this.turns.length > this.max) this.turns.shift();
    }

    /** The newest turns with this partner, oldest first. */
    recent(partnerId: string, count = 8): ConversationTurn[] {
        return this.turns
            .filter((turn) => turn.partnerId === partnerId)
            .slice(-count)
            .map(({ speaker, text }) => ({ speaker, text }));
    }
}

export interface PreviewRecord {
    digest: string;
    formUrl: string;
    fieldsJson: string;
    /** False when the attach's reply was lost, so it is not known whether this preview is the one on the errand. */
    certain: boolean;
}

/** The previews this sidecar attached, by errand id. The submit gate (src/errands.ts) reads it. */
export class PreviewBook {
    private readonly entries = new Map<string, PreviewRecord>();

    constructor(private readonly max = 200) {}

    record(errandId: bigint, entry: PreviewRecord): void {
        const key = errandId.toString();
        this.entries.delete(key);
        this.entries.set(key, entry);
        while (this.entries.size > this.max) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
    }

    get(errandId: bigint): PreviewRecord | undefined {
        return this.entries.get(errandId.toString());
    }
}

export interface JobDeps {
    db: AgentDb;
    planner: PlannerPort;
    retrieval: RetrievalDeps;
    errands: ErrandPort | null;
    dialer: DialerPort | null;
    forms: readonly AllowedForm[];
    contacts: readonly CallContact[];
    previews: PreviewBook;
    conversation: ConversationLog;
    log: Logger;
    timeZone: string;
    maxOptions: number;
    /** Mark written-back replies shareable (AGENT_MEMORY_SHAREABLE): only if the person agreed. */
    memoryShareable: boolean;
    /** Wall clock, epoch ms. */
    now: () => number;
    /** Monotonic clock for durations. */
    clock: () => number;
    /** A fresh Dialer request id: `^[A-Za-z0-9_-]{1,64}$`. */
    requestId: () => string;
    /** How often an open step renews the job lease (src/pipeline.ts). Default LEASE_HEARTBEAT_MS. */
    leaseHeartbeatMs?: number;
    /**
     * The yes or no fast path (AGENT_YES_NO_FAST, on by default in the config): a clear yes or no question gets the
     * stock Yes and No at once instead of a plan (src/fastpath.ts). Off when unset.
     */
    yesNoFast?: boolean;
    /**
     * Draft first (AGENT_DRAFT_FIRST, off by default in the config): when a question will be searched, Claude's options
     * from memory alone are published while the search runs, and the options with web results follow. Off when unset.
     */
    draftFirst?: boolean;
}

/**
 * The Dialer only reports an errand sent in the last ten minutes, and checks again right before it dials; the view
 * has no clock, so the sidecar checks too. Call options are offered only while two minutes are left, the time a
 * prepared call stays valid, so the pick, the read-back and the CONFIRM still fit inside the Dialer's window.
 */
const RECENT_ERRAND_MS = 10 * 60_000;
const CALL_TIME_NEEDED_MS = 2 * 60_000;

function recentErrand(row: AgentQueueRow, nowMs: number): { title: string; sentAtMs: number } | null {
    if (!row.recentErrandTitle || row.recentErrandSentAtMs === null) return null;
    const age = nowMs - row.recentErrandSentAtMs;
    return age >= 0 && age < RECENT_ERRAND_MS - CALL_TIME_NEEDED_MS ? { title: row.recentErrandTitle, sentAtMs: row.recentErrandSentAtMs } : null;
}

/** A job the module handed over without what it needs. Reported with agent_fail and its code. */
export class JobInputError extends Error {
    constructor(readonly code: string) {
        super(`job input: ${code}`);
        this.name = 'JobInputError';
    }
}

/** The plan step's failure label, in the plan stage vocabulary. */
function plannerLabel(error: unknown): string {
    if (error instanceof PlannerError) return label('claude', error.code.replace(/_/g, ' '));
    return label('claude error');
}

/**
 * Publishes options, final or not. Throws StaleAttemptError when another attempt owns the job (the work is dropped),
 * PublishRefusedError when the module refuses the options, and ConsentWithdrawnError when `allowed` (read before
 * every try) says the consent the options rely on is gone.
 */
async function publish(
    db: AgentDb,
    job: { jobId: bigint; attempt: number },
    answerMode: 'pick' | 'yes_no',
    options: OptionInput[],
    final: boolean,
    allowed: () => boolean = () => true,
): Promise<void> {
    const outcome = await callReducer(
        db,
        'agentPublishOptions',
        { jobId: job.jobId, attempt: job.attempt, answerMode, options, final },
        // A lost reply on a final publish is sent again; if the first one ran, the job is Done and the second
        // comes back stale, which is the same result. A non-final publish is not sent twice (it would add a version).
        { onUnknown: final ? 'repeat' : 'verify', verify: () => 'unclear', beforeTry: allowed },
    );
    if (outcome.ok) return;
    if (outcome.kind === 'withdrawn') throw new ConsentWithdrawnError();
    if (outcome.kind === 'stale') {
        if (outcome.uncertain && final) return;
        throw new StaleAttemptError('agent_publish_options');
    }
    if (!final && outcome.kind === 'unknown_result') return;
    throw new PublishRefusedError(outcome.kind);
}

export class PublishRefusedError extends Error {
    constructor(readonly why: string) {
        super(`the module refused the options (${why})`);
        this.name = 'PublishRefusedError';
    }
}

/** The options were not published: a consent they rely on was withdrawn before they could be sent. */
export class ConsentWithdrawnError extends Error {
    constructor() {
        super('a consent the options rely on was withdrawn');
        this.name = 'ConsentWithdrawnError';
    }
}

interface ConsentNow {
    webSearchAllowed: boolean;
    memoryAllowed: boolean;
    /** The module shows this attempt's job without memory consent: what the conversation kept must go. */
    memoryRevoked: boolean;
}

/**
 * The consent this attempt works under, as the module shows it now: the job's own flags AND the module's current
 * consent (`agent_consent`, module v2). Revoking web search or memory consent clears the flags on jobs already
 * running (spacetime/src/consent.ts, stopUncovered) and shows in `agent_consent`, so both are read again right
 * before each use. It fails closed: while the views are not current (disconnected, or the subscription not applied
 * again yet) a revocation could be missing from them, a job no longer claimed by this attempt is about to be aborted,
 * and an `agent_consent` the sidecar cannot read is not consent, so none of them gets anything.
 */
function consentNow(deps: JobDeps, row: AgentQueueRow, attempt: number): ConsentNow {
    const none = { webSearchAllowed: false, memoryAllowed: false, memoryRevoked: false };
    if (!deps.db.isCurrent()) return none;
    const now = deps.db.agentQueue().find((r) => r.jobId === row.jobId && r.status === 'claimed' && r.claimedByMe && r.attempt === attempt);
    if (!now) return none;
    const module = deps.db.agentConsent();
    if (!module) return { ...none, memoryRevoked: !now.memoryAllowed };
    return {
        webSearchAllowed: row.webSearchAllowed && now.webSearchAllowed && module.webSearchAllowed,
        memoryAllowed: row.memoryAllowed && now.memoryAllowed && module.memoryAllowed,
        memoryRevoked: !now.memoryAllowed || !module.memoryAllowed,
    };
}

/** Memory consent for this attempt, forgetting the kept conversation whenever the module shows it withdrawn. */
function memoryConsent(deps: JobDeps, row: AgentQueueRow, attempt: number): boolean {
    const now = consentNow(deps, row, attempt);
    if (now.memoryRevoked) deps.conversation.clear();
    return now.memoryAllowed;
}

/** Options job: everything from the question to `agent_publish_options(final = true)`. */
export async function runOptionsJob(row: AgentQueueRow, attempt: number, deps: JobDeps, signal: AbortSignal): Promise<void> {
    const job = { jobId: row.jobId, attempt };
    const events = new JobEvents(deps.db, job, deps.log, deps.clock, { heartbeatMs: deps.leaseHeartbeatMs, signal });
    const questionKey = `q${row.questionId}`;
    const isMenu = row.origin === 'menu' && row.menuItem !== 'none';
    if (!isMenu && row.questionText.trim() === '') throw new JobInputError('empty_question');
    // Consent as the module shows it at each use: revoking it clears the job's flags while the job runs.
    const allowMemory = () => memoryConsent(deps, row, attempt);
    const allowWeb = () => consentNow(deps, row, attempt).webSearchAllowed;
    // A call option about the recent errand is possible: only the normal plan sees the contacts and that errand, so
    // neither stock options nor a final draft may answer the question.
    const callPossible = () => !!deps.dialer && deps.contacts.length > 0 && recentErrand(row, deps.now()) !== null;
    // The turns with this partner before this question (the question itself goes to the planner on its own). The
    // conversation is kept, and sent, only under memory consent; once the module shows it withdrawn, what was kept is
    // forgotten (memoryConsent), at whichever check sees it first.
    const history = allowMemory() ? deps.conversation.recent(row.askedBy) : [];
    if (!isMenu && allowMemory()) deps.conversation.add(row.askedBy, { speaker: 'partner', text: row.questionText });
    // Set once the question's rows may be in the Moss web index, so they are forgotten whatever happens next.
    let mayBeIndexed = false;
    try {
        // 0. The yes or no fast path (src/fastpath.ts): a clear yes or no question gets the stock Yes and No at once,
        // final, with no memory, search or Claude. The person hears "Yes or no?" and the picked word is said aloud.
        if (!isMenu && deps.yesNoFast) {
            const verdict = classifyYesNo(row.questionText);
            const fast = verdict.yesNo && !callPossible();
            const why = verdict.yesNo && !fast ? 'call_possible' : verdict.reason;
            deps.log.info(fast ? 'yes or no fast path: stock options' : 'yes or no fast path not taken', { job: row.jobId, why });
            if (fast) {
                const options = stockYesNo();
                // Written before the publish: a final publish ends the job, and the module refuses events after it.
                await events.instant('plan', 'ok', 'yes no stock', 0, { counts: { optionCount: options.length, yesNo: true, final: true } });
                await publish(deps.db, job, 'yes_no', options, true);
                deps.log.info('options published', { job: row.jobId, options: options.length, mode: 'yes_no', ms: 0 });
                return;
            }
        }

        // 1. Memory first.
        // With the newest past request of each allowed form (src/requests.ts), so the same form can be filled again.
        const recall = await recallMemory(
            deps.retrieval,
            events,
            row,
            signal,
            allowMemory,
            deps.forms.map((form) => form.formTitle),
        );
        if (signal.aborted) throw new JobAbortedError();

        // 2 and 3. Decide (D8), then search while the memory-first options (or the draft) are read. Menu turns never
        // search. `stopSearch` ends a search whose result can no longer be used (a yes or no draft went final).
        const check = isMenu ? null : deps.retrieval.classify(row.questionText);
        const stopSearch = new AbortController();
        const searching = check
            ? searchStep(deps.retrieval, events, row, check, signal, allowWeb, stopSearch.signal)
            : Promise.resolve({ status: 'none' as const, rows: [], kind: null });
        // Settle the search promise's rejection now, so it cannot go unhandled while the early publish runs.
        searching.catch(() => undefined);
        const willSearch = !!check && check.needsWeb && row.webSearchAllowed && allowWeb() && deps.retrieval.search !== null;
        let earlyPublished = false;
        if (willSearch && recall && allowMemory() && !looksYesNo(row.questionText)) {
            const early = memoryFirstOptions(recall, deps.maxOptions);
            if (early) {
                const step = await events.begin('plan', 'memory first');
                try {
                    // Checked again after the step started, and before every try: options drawn from memory need
                    // memory consent.
                    await publish(deps.db, job, 'pick', early, false, allowMemory);
                    earlyPublished = true;
                    await step.ok('memory first', { counts: { optionCount: early.length, final: false } });
                } catch (error) {
                    if (!(error instanceof PublishRefusedError) && !(error instanceof ConsentWithdrawnError)) throw error;
                    // The early options are a head start; the final options still come.
                    await step.error('memory first refused');
                }
            }
        }

        const plans: PlanContext = { deps, row, events, signal, allowMemory, allowWeb };
        const planInput = (memory: MemoryContext[], web: WebContext[], search: PlanInput['search'], recent: RecentErrand | null, nowMs: number): PlanInput => {
            const consent = consentNow(deps, row, attempt);
            return {
                question: row.questionText,
                origin: row.origin,
                menuItem: row.menuItem,
                history: consent.memoryAllowed ? history : [],
                memory,
                web,
                forms: deps.forms,
                contacts: recent && deps.dialer ? deps.contacts : [],
                recentErrand: recent,
                search,
                maxOptions: deps.maxOptions,
                nowMs,
                timeZone: deps.timeZone,
                consent: () => ({ memory: allowMemory(), web: allowWeb() }),
            };
        };

        // Draft first (AGENT_DRAFT_FIRST): while the search runs, Claude writes options from memory and the
        // conversation only, and they are published as a first version (final = false). The module scans the newest
        // version: a version published while the person hears options waits for the end of that pass (pending_version)
        // and is switched in with the `more_options` chime, so options never change during a read, and a pick names an
        // option of the version being read. Only when nothing was published yet (memory-first options are a head
        // start of their own). No calls in a draft: a call option makes the Dialer prepare a request.
        let draft: Planned | null = null;
        if (deps.draftFirst && willSearch && !earlyPublished) {
            try {
                const consent = consentNow(deps, row, attempt);
                const memory = consent.memoryAllowed ? memoryContext(recall) : [];
                const drafted = await planOptions(plans, planInput(memory, [], 'pending', null, deps.now()), memory, [], null, 'claude draft');
                if (!drafted.stillAllowed()) throw new ConsentWithdrawnError();
                if (drafted.plan.answerMode === 'yes_no' && callPossible()) {
                    // A final yes or no draft would end the job before the normal plan could offer the call, and an
                    // open one would start the prompt over when the final version comes, so it is not published.
                    deps.log.info('yes or no draft not used: a call about the recent errand is possible', { job: row.jobId });
                } else if (drafted.plan.answerMode === 'yes_no') {
                    // In yes_no mode the person hears only "Yes or no?", so a later version would change nothing they
                    // hear and would only start the prompt over. The draft is final and the search is stopped.
                    stopSearch.abort();
                    await searching.catch(() => undefined);
                    await publish(deps.db, job, 'yes_no', drafted.options, true, drafted.stillAllowed);
                    deps.log.info('options published', { job: row.jobId, options: drafted.options.length, mode: 'yes_no', ms: drafted.plan.ms, draft: true });
                    return;
                } else {
                    await publish(deps.db, job, 'pick', drafted.options, false, drafted.stillAllowed);
                    draft = drafted;
                    deps.log.info('draft options published; the search goes on', { job: row.jobId, options: drafted.options.length, ms: drafted.plan.ms });
                }
            } catch (error) {
                if (signal.aborted || error instanceof JobAbortedError) throw new JobAbortedError();
                if (!(error instanceof PlannerError) && !(error instanceof PublishRefusedError) && !(error instanceof ConsentWithdrawnError)) throw error;
                // The draft is a head start; the final options still come.
                deps.log.warn('no draft options; the options come after the search', { job: row.jobId, why: error.name });
            }
        }

        const search = await searching;
        if (signal.aborted) throw new JobAbortedError();

        // 4. Index the rows and retrieve passages.
        mayBeIndexed = search.rows.length > 0;
        const retrieved = await retrieveStep(deps.retrieval, events, row, questionKey, search.rows, recall, signal, allowMemory);
        if (signal.aborted) throw new JobAbortedError();

        // 5. Claude's plan. Memory, the conversation and web passages go into the prompt only while their consent
        // holds; the planner reads it again right before each attempt (PlanInput.consent).
        const consent = consentNow(deps, row, attempt);
        const nowMs = deps.now();
        const recent = recentErrand(row, nowMs);
        const memory = consent.memoryAllowed ? memoryContext(recall) : [];
        const web = consent.webSearchAllowed ? retrieved.web : [];
        const searchStatus = consent.webSearchAllowed || search.status === 'not_needed' || search.status === 'none' ? search.status : 'not_allowed';

        // A draft is being read and the search brought nothing to add: the draft's options become the final
        // version as they are, instead of a second plan that could only reword them. Not when a recent errand is on
        // the row: the draft never saw it or the contacts, so only the normal plan can offer a call about it.
        if (draft && web.length === 0 && !recent && draft.stillAllowed()) {
            try {
                await events.instant('plan', 'ok', 'draft kept', 0, { counts: { optionCount: draft.options.length, final: true } });
                await publish(deps.db, job, draft.plan.answerMode, draft.options, true, draft.stillAllowed);
                deps.log.info('options published', { job: row.jobId, options: draft.options.length, mode: draft.plan.answerMode, ms: 0, draft: true });
                return;
            } catch (error) {
                if (!(error instanceof ConsentWithdrawnError)) throw error;
                deps.log.info('a consent was withdrawn while the options were made; writing them again without it', { job: row.jobId });
            }
        }

        const input = planInput(memory, web, searchStatus, recent, nowMs);
        // 5 to 7. Plan, options, publish. The consent a plan relied on (memory, the conversation, web passages) is
        // read again after every wait and before every publish try. When it was withdrawn on the way, the plan is
        // written again without it (the planner drops it from the new request). Consent is never given back to a
        // running job and there are two kinds, so three rounds are the most this takes.
        for (let round = 1; ; round++) {
            const planned = await planOptions(plans, input, memory, web, recent, 'claude');

            // 7. Publish, unless a consent the options rely on went away during the waits above (or during a retry).
            try {
                if (!planned.stillAllowed()) throw new ConsentWithdrawnError();
                await publish(deps.db, job, planned.plan.answerMode, planned.options, true, planned.stillAllowed);
                deps.log.info('options published', { job: row.jobId, options: planned.options.length, mode: planned.plan.answerMode, ms: planned.plan.ms });
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
            // Bounded and without the job's signal: cleanup runs even for a cancelled job, but never holds it.
            const forgetting = deps.retrieval.web.forget(questionKey);
            await withDeadline(forgetting, mossDeadline(deps.retrieval, 'forget'), 'web forget').catch(() =>
                deps.log.warn('could not forget the web passages in time; Moss drops them when the run closes', { job: row.jobId }),
            );
        }
    }
}

interface PlanContext {
    deps: JobDeps;
    row: AgentQueueRow;
    events: JobEvents;
    signal: AbortSignal;
    allowMemory: () => boolean;
    allowWeb: () => boolean;
}

type RecentErrand = { title: string; sentAtMs: number };

/** A plan turned into options, ready to publish. */
interface Planned {
    plan: PlanResult;
    options: OptionInput[];
    /** False once a consent the options rely on (memory, the conversation, web passages, the ranking) is withdrawn. */
    stillAllowed: () => boolean;
}

/**
 * Steps 5 and 6: one plan step (`claude`, or `claude draft` for a draft): the planner call with its own retry, the
 * options built from the plan, and their order by memory affinity while memory consent holds.
 */
async function planOptions(
    ctx: PlanContext,
    input: PlanInput,
    memory: readonly MemoryContext[],
    web: readonly WebContext[],
    recent: RecentErrand | null,
    detail: 'claude' | 'claude draft',
): Promise<Planned> {
    const { deps, row, events, signal, allowMemory, allowWeb } = ctx;
    const step = await events.begin('plan', detail);
    let plan: PlanResult;
    try {
        plan = await deps.planner.plan(input, signal);
    } catch (error) {
        if (signal.aborted) throw new JobAbortedError();
        await step.error(plannerLabel(error), { counts: error instanceof PlannerError ? { problems: error.problems.length } : undefined });
        throw error;
    }
    let rankedByMemory = false;
    const stillAllowed = () => !((plan.sentMemory || rankedByMemory) && !allowMemory()) && !(plan.sentWeb && !allowWeb());

    // 6. Options: call options are prepared by the Dialer now, so the read-back and digest exist at the pick.
    const built = buildOptions(plan, plan.sentMemory ? memory : [], plan.sentWeb ? web : [], (contact) => prepareCall(deps, contact, recent));
    let options = built.options;
    if (stillAllowed() && plan.answerMode === 'pick' && allowMemory() && deps.retrieval.memory?.isOpen()) {
        try {
            const ranking = deps.retrieval.memory.rank(row.askedBy, built.candidates);
            const ordering = await withDeadline(ranking, mossDeadline(deps.retrieval, 'rank'), 'memory rank', signal);
            // Memory decides the order only if its consent still holds now that the ranking is back.
            if (allowMemory()) {
                options = applyOrder(options, ordering.withMemory.map((option) => option.id));
                rankedByMemory = true;
            }
        } catch (error) {
            if (signal.aborted || error instanceof JobAbortedError) throw new JobAbortedError();
            deps.log.warn('memory ranking failed; keeping the planner order', { job: row.jobId });
        }
    }
    await step.ok(detail, {
        counts: {
            optionCount: options.length,
            yesNo: plan.answerMode === 'yes_no',
            attempts: plan.attempts,
            claudeMs: plan.ms,
            inputTokens: plan.inputTokens,
            outputTokens: plan.outputTokens,
            cacheReadTokens: plan.cacheReadTokens,
            fallbackUsed: plan.fallbackUsed,
            droppedCalls: built.droppedCalls,
            ...(detail === 'claude draft' ? { draft: true } : {}),
        },
    });
    return { plan, options, stillAllowed };
}

function prepareCall(deps: JobDeps, contact: CallContact, recent: RecentErrand | null) {
    if (!deps.dialer || !recent) return null;
    const request: CallRequest = { requestId: deps.requestId(), contactId: contact.contactId, errand: { title: recent.title, sentAt: recent.sentAtMs } };
    const prepared = deps.dialer.prepare(request);
    if (prepared.ok) return prepared.call;
    deps.log.info('the Dialer refused a call option', { code: prepared.refusal.code });
    return null;
}

/** Parses the errand's `fields_json` into the Actor's FieldInput[]. Null when it is not a list of fields. */
export function parseFields(json: string): FieldInput[] | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > LIMITS.actionFields) return null;
    const out: FieldInput[] = [];
    for (const item of parsed) {
        if (!item || typeof item !== 'object') return null;
        const f = item as Record<string, unknown>;
        if (typeof f.label !== 'string' || f.label.trim() === '') return null;
        const value = f.value;
        const okValue = typeof value === 'string' || typeof value === 'boolean' || (Array.isArray(value) && value.every((v) => typeof v === 'string'));
        if (!okValue) return null;
        out.push({ label: f.label, value: value as FieldInput['value'], ...(typeof f.source === 'string' ? { source: f.source } : {}) });
    }
    return out;
}

const PREVIEW_FAILED = 'The form could not be prepared, so nothing was sent.';

/** The form-errand Actor's refusal codes (apify/client RefusalCode). A Record, so a new code fails the typecheck. */
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

/** ErrandPreview job: the Actor's preview (never a submit), attached to the Drafted errand. */
export async function runPreviewJob(row: AgentQueueRow, attempt: number, deps: JobDeps, signal: AbortSignal): Promise<void> {
    const events = new JobEvents(deps.db, { jobId: row.jobId, attempt }, deps.log, deps.clock, { heartbeatMs: deps.leaseHeartbeatMs, signal });
    try {
        await previewJob(row, attempt, deps, signal, events);
    } finally {
        events.close();
    }
}

async function previewJob(row: AgentQueueRow, attempt: number, deps: JobDeps, signal: AbortSignal, events: JobEvents): Promise<void> {
    const job = { jobId: row.jobId, attempt };
    const attach = async (args: {
        status: 'previewed' | 'refused' | 'failed';
        formTitle?: string;
        readBackText?: string;
        readBackJson?: string;
        previewDigest?: string;
        screenshotUrl?: string;
        reasonCode?: string;
        reason?: string;
        previewMs?: number;
    }) => {
        const outcome = await callReducer(
            deps.db,
            'agentAttachPreview',
            {
                jobId: job.jobId,
                attempt,
                status: args.status,
                formTitle: (args.formTitle ?? '').slice(0, LIMITS.formTitle),
                readBackText: args.readBackText ?? '',
                readBackJson: args.readBackJson ?? '',
                previewDigest: args.previewDigest ?? '',
                screenshotUrl: args.screenshotUrl ?? '',
                reasonCode: (args.reasonCode ?? '').slice(0, LIMITS.reasonCode),
                reason: (args.reason ?? '').slice(0, LIMITS.reason),
                previewMs: Math.max(0, Math.round(args.previewMs ?? 0)),
            },
            { onUnknown: 'repeat' },
        );
        if (outcome.ok) return { attached: true, certain: !outcome.uncertain };
        if (outcome.kind === 'stale') {
            if (outcome.uncertain) return { attached: true, certain: false };
            throw new StaleAttemptError('agent_attach_preview');
        }
        throw new PublishRefusedError(outcome.kind);
    };

    if (!deps.errands) {
        await attach({ status: 'failed', reasonCode: 'errands_not_configured', reason: 'The form helper is not set up, so nothing was sent.' });
        return;
    }
    const fields = parseFields(row.fieldsJson);
    if (!fields || !row.formUrl) {
        await attach({ status: 'failed', reasonCode: 'bad_fields', reason: PREVIEW_FAILED });
        return;
    }

    const step = await events.begin('errand', 'preview');
    let result;
    try {
        result = await deps.errands.preview({ formUrl: row.formUrl, fields }, { signal });
    } catch (error) {
        if (signal.aborted) throw new JobAbortedError();
        const code = error instanceof ApifyHttpError ? (error.kind === 'http' ? `http_${error.status ?? 0}` : error.kind) : 'error';
        await step.error(label('preview', code.replace(/_/g, ' ')));
        await attach({ status: 'failed', reasonCode: `preview_${code}`, reason: PREVIEW_FAILED });
        return;
    }

    const previewMs = result.timings.totalMs;
    if (result.status === 'previewed' && result.previewDigest && result.readBackText) {
        if (result.readBackText.length > LIMITS.readBackText) {
            await step.error('preview read-back too long');
            await attach({ status: 'failed', reasonCode: 'read_back_too_long', reason: 'The read-back is too long to say, so nothing was sent.', previewMs });
            return;
        }
        const readBackJson = JSON.stringify(result.readBack);
        await step.ok('preview previewed', {
            counts: { readBack: result.readBack.length, unmatched: result.unmatched.length, missingRequired: result.missingRequired.length, previewMs },
        });
        const attached = await attach({
            status: 'previewed',
            formTitle: result.formTitle ?? row.formTitle,
            readBackText: result.readBackText,
            readBackJson: readBackJson.length <= LIMITS.readBackJsonChars ? readBackJson : '[]',
            previewDigest: result.previewDigest,
            screenshotUrl: result.screenshotUrl && result.screenshotUrl.length <= LIMITS.screenshotUrl ? result.screenshotUrl : '',
            previewMs,
        });
        if (attached.attached) {
            // The submit gate checks the module's confirmed digest against this one.
            deps.previews.record(row.errandId, { digest: result.previewDigest, formUrl: row.formUrl, fieldsJson: row.fieldsJson, certain: attached.certain });
        }
        return;
    }
    if (result.status === 'refused' && result.refusal) {
        // Only the Actor's own refusal codes reach a public label; anything else reads "unknown".
        const code = KNOWN_REFUSALS[result.refusal.code] ? result.refusal.code : 'unknown';
        await step.error(label('preview refused:', code));
        await attach({ status: 'refused', reasonCode: code, reason: result.refusal.reason, previewMs });
        return;
    }
    await step.error('preview bad response');
    await attach({ status: 'failed', reasonCode: 'bad_preview', reason: PREVIEW_FAILED, previewMs });
}

/** Remember job: the spoken reply into Moss for this partner, then `agent_done`. */
export async function runRememberJob(row: AgentQueueRow, attempt: number, deps: JobDeps, signal?: AbortSignal): Promise<void> {
    const events = new JobEvents(deps.db, { jobId: row.jobId, attempt }, deps.log, deps.clock, { heartbeatMs: deps.leaseHeartbeatMs, signal });
    try {
        await rememberJob(row, attempt, deps, events, signal);
    } catch (error) {
        // Taken away part way (aborted, cancelled or replaced, for example by a memory revocation during the write):
        // the kept conversation is forgotten on this path too.
        deps.conversation.clear();
        throw error;
    } finally {
        events.close();
    }
}

async function rememberJob(row: AgentQueueRow, attempt: number, deps: JobDeps, events: JobEvents, signal?: AbortSignal): Promise<void> {
    const job = { jobId: row.jobId, attempt };
    // Memory consent for this very attempt: an attempt that was aborted or replaced writes nothing. A Remember job
    // that was taken away (aborted, cancelled, gone from the view) also forgets the kept conversation, since a
    // memory revocation cancels Remember jobs and the module shows nothing else for it.
    const allowed = () => {
        const ok = !signal?.aborted && memoryConsent(deps, row, attempt);
        if (!ok && (signal?.aborted || deps.db.isCurrent())) deps.conversation.clear();
        return ok;
    };
    // The spoken reply joins the conversation only under memory consent; without it, what was kept is forgotten.
    if (allowed() && row.replyText) deps.conversation.add(row.askedBy, { speaker: 'person', text: row.replyText });
    const memory = deps.retrieval.memory;
    let counts: Record<string, number | boolean> = { written: 0 };
    if (!allowed()) {
        counts = { written: 0, memoryAllowed: false };
    } else if (!memory || !memory.isOpen()) {
        counts = { written: 0, mossOpen: false };
    } else if (!row.replyText || !row.questionText) {
        counts = { written: 0, empty: true };
    } else {
        const step = await events.begin('retrieve', 'memory write back');
        if (!allowed()) {
            // Revoked while the step was starting: nothing is written.
            counts = { written: 0, memoryAllowed: false };
            await step.ok('memory write back', { counts });
        } else {
            try {
                const writing = memory.writeBack({ question: row.questionText, reply: row.replyText, partnerId: row.askedBy, shareable: deps.memoryShareable });
                const result = await withDeadline(writing, mossDeadline(deps.retrieval, 'writeBack'), 'memory write back');
                counts = { written: 1, added: result.added, updated: result.updated };
                await step.ok('memory write back', { counts });
            } catch (error) {
                if (error instanceof StaleAttemptError) throw error;
                counts = { written: 0 };
                const name = error instanceof Error ? error.name : 'error';
                deps.log.warn('memory write back failed', { job: row.jobId, why: name });
                await step.error(label('memory write back failed'));
            }
        }
    }
    // An aborted attempt does not mark the job done: the lease hands it to the next attempt, which still writes.
    if (signal?.aborted) throw new JobAbortedError();
    const outcome = await callReducer(deps.db, 'agentDone', { jobId: job.jobId, attempt, countsJson: JSON.stringify(counts) }, { onUnknown: 'repeat' });
    if (!outcome.ok && outcome.kind === 'stale' && !outcome.uncertain) throw new StaleAttemptError('agent_done');
    if (!outcome.ok && outcome.kind !== 'stale') deps.log.warn('agent_done was not recorded', { job: row.jobId, why: outcome.kind });
}
