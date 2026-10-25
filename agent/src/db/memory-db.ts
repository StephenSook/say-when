// An in-memory stand-in for the SpacetimeDB module, for tests and offline runs. It applies the rules
// docs/spacetime.md gives for the agent-facing reducers (3.6, 3.7, 4.3 to 4.5): the job fence, the claim and
// digest checks, the vocabulary checks on pipeline events, and the option limits. It also lets a test play the
// module's other side (a station CONFIRM, a STOP during a call) and inject network failures.

import {
    CALL_CLAIM_MS,
    DETAIL_PATTERN,
    DIGEST_PATTERN,
    EVENT_KEY_PATTERN,
    ID_PATTERN,
    LIMITS,
    LINE_KEY_PATTERN,
    MODULE_EVENT_KEY,
    STAGES,
    STATUSES,
} from '../contract.js';
import {
    TONES,
    type AgentConsent,
    type AgentQueueRow,
    type AnswerMode,
    type CallQueueRow,
    type CallStatus,
    type ErrandQueueRow,
    type ErrandStatus,
    type JobKind,
    type JobStatus,
    type MenuItem,
    type OptionInput,
    type Origin,
    type ReducerArgs,
    type ReducerName,
} from '../types.js';
import { DbCallError, type AgentDb, type DbErrorKind } from './db.js';

const ME = 'a'.repeat(64);

interface JobRecord {
    id: bigint;
    kind: JobKind;
    status: JobStatus;
    attempt: number;
    claimedBy: string | null;
    questionId: bigint;
    questionText: string;
    origin: Origin;
    menuItem: MenuItem;
    askedBy: string;
    webSearchAllowed: boolean;
    memoryAllowed: boolean;
    errandId: bigint;
    replyText: string;
    recentErrandTitle: string;
    recentErrandSentAtMs: number | null;
    /** Direct select: the original question of a categories or search turn (0n otherwise), and its words. */
    parentQuestionId: bigint;
    parentQuestionText: string;
    /** Direct select: the Category option picked, for a `category_search` job. */
    category: string;
    createdAtMs: number;
    /** False once the question was picked, cancelled or superseded: publishes then write nothing. */
    questionOpen: boolean;
    /** When the lease of a Claimed job runs out (with the `leaseMs` option only), by `now`. */
    leaseEndsAt?: number;
}

export interface ErrandRecord {
    id: bigint;
    status: ErrandStatus;
    formKey: string;
    formUrl: string;
    formTitle: string;
    fieldsJson: string;
    previewDigest: string;
    readBackText: string;
    readBackJson: string;
    screenshotUrl: string;
    confirmedDigest: string;
    claimAttempt: number;
    claimedBy: string | null;
    confirmationText: string;
    reasonCode: string;
    reason: string;
    submitMs: number;
    confirmedAtMs: number | null;
}

export interface CallRecord {
    id: bigint;
    status: CallStatus;
    requestId: string;
    contactId: string;
    scriptDigest: string;
    claimAttempt: number;
    claimedBy: string | null;
    cancelRequested: boolean;
    cancelReason: string;
    result: string;
    endReason: string;
    reasonCode: string;
    reason: string;
    /** When the person confirmed it, by the module's clock, or null. */
    confirmedAtMs: number | null;
    /** False to play bindings older than module v2, whose `call_queue` rows carry no CONFIRM time. */
    viewShowsConfirmedAt: boolean;
}

export interface PipelineRecord {
    id: bigint;
    eventKey: string;
    jobId: bigint;
    questionId: bigint;
    stage: string;
    status: string;
    detail: string;
    ms: number | null;
    countsJson: string;
    /** The private payload, or '' when none was sent. */
    payloadJson: string;
}

export interface PublishRecord {
    jobId: bigint;
    attempt: number;
    questionId: bigint;
    version: number;
    answerMode: AnswerMode;
    options: OptionInput[];
    final: boolean;
}

export interface CallLineRecord {
    callId: bigint;
    lineKey: string;
    role: string;
    text: string;
}

interface InjectedFailure {
    kind: DbErrorKind;
    /** For `unknown_result`: whether the call ran before its reply was lost. */
    applied: boolean;
    /** For `refused`: the module's message, such as `line busy`. */
    message?: string;
}

export interface NewOptionsJob {
    questionText: string;
    askedBy?: string;
    origin?: Origin;
    menuItem?: MenuItem;
    webSearchAllowed?: boolean;
    memoryAllowed?: boolean;
    recentErrandTitle?: string;
    recentErrandSentAtMs?: number | null;
}

export interface NewErrandPreview {
    formKey: string;
    formUrl: string;
    formTitle: string;
    fieldsJson: string;
}

const refuse = (reducer: string, message: string) => new DbCallError('refused', reducer, message);

/**
 * The option kinds each job may publish, as the module allows them (spacetime/src/agent.ts KINDS_FOR_JOB): a Category
 * option, whose pick starts a search at once, comes only from a categories job, which only a confirmed Search makes.
 */
export const KINDS_FOR_JOB: Partial<Record<JobKind, readonly OptionInput['kind'][]>> = {
    options: ['reply', 'errand', 'call', 'search'],
    categories: ['category', 'reply'],
    category_search: ['reply'],
};

/** The module's stand-in. `me` is the sidecar's identity; rows claimed by anyone else are someone else's. */
export class MemoryDb implements AgentDb {
    readonly me: string;
    readonly jobs = new Map<bigint, JobRecord>();
    readonly errands = new Map<bigint, ErrandRecord>();
    readonly calls = new Map<bigint, CallRecord>();
    readonly events: PipelineRecord[] = [];
    readonly publishes: PublishRecord[] = [];
    readonly callLines: CallLineRecord[] = [];
    /** Every reducer call that took effect, in order. */
    readonly applied: { name: ReducerName; args: unknown }[] = [];
    /** Every reducer call made, including refused and failed ones. */
    readonly attempted: { name: ReducerName; args: unknown }[] = [];
    readonly errandConsent = new Set<string>();
    readonly callConsent = new Set<string>();
    /** Memory and web search consent for every subject: what `agent_consent` shows and what new jobs start with. */
    readonly consent = { memory: true, webSearch: true };
    /** False to play a module whose `agent_consent` shows no row for this sidecar (or bindings without the view). */
    consentRowShown = true;
    /** The active session `agent_consent` shows, or 0n between sessions. Tests set it to start a new session. */
    sessionId = 1n;
    maxOptions = LIMITS.maxOptions;
    connected = true;

    private nextId = 1n;
    private syncs = 1;
    private readonly versions = new Map<bigint, number>();
    private readonly listeners = new Set<() => void>();
    private readonly memoryOffListeners = new Set<() => void>();
    private readonly failures = new Map<ReducerName, InjectedFailure[]>();
    private readonly waiters = new Set<() => void>();
    private readonly now: () => number;
    /** The agent views as listeners last heard them, so a write that changes none of them tells nobody. */
    private told = '';
    /** The module's `job_lease_ms`, or 0 for leases that never run out. */
    private readonly leaseMs: number;

    /**
     * `leaseMs` turns on the job lease: a claim or an `agent_progress` (also a repeated one) or a non-final publish
     * renews it, and a Claimed job whose lease ran out goes back to Pending at the next fenced write, as the
     * module's `lease_expired` would have done.
     */
    constructor(options: { me?: string; now?: () => number; leaseMs?: number } = {}) {
        this.me = options.me ?? ME;
        this.now = options.now ?? Date.now;
        this.leaseMs = options.leaseMs ?? 0;
    }

    // ---------- AgentDb ----------

    agentQueue(): readonly AgentQueueRow[] {
        const rows: AgentQueueRow[] = [];
        for (const job of this.jobs.values()) {
            const mine = job.status === 'claimed' && job.claimedBy === this.me;
            if (job.status !== 'pending' && !mine) continue;
            const errand = job.errandId !== 0n ? this.errands.get(job.errandId) : undefined;
            rows.push({
                jobId: job.id,
                kind: job.kind,
                status: job.status,
                attempt: job.attempt,
                claimedByMe: mine,
                questionId: job.questionId,
                questionText: job.questionText,
                origin: job.origin,
                menuItem: job.menuItem,
                askedBy: job.askedBy,
                webSearchAllowed: job.webSearchAllowed,
                memoryAllowed: job.memoryAllowed,
                errandId: job.errandId,
                formKey: errand?.formKey ?? '',
                formUrl: errand?.formUrl ?? '',
                formTitle: errand?.formTitle ?? '',
                fieldsJson: errand?.fieldsJson ?? '',
                replyText: job.replyText,
                recentErrandTitle: job.recentErrandTitle,
                recentErrandSentAtMs: job.recentErrandSentAtMs,
                parentQuestionId: job.parentQuestionId,
                parentQuestionText: job.parentQuestionText,
                category: job.category,
                createdAtMs: job.createdAtMs,
            });
        }
        return rows;
    }

    errandQueue(): readonly ErrandQueueRow[] {
        const rows: ErrandQueueRow[] = [];
        for (const e of this.errands.values()) {
            const mine = e.status === 'submitting' && e.claimedBy === this.me;
            if (e.status !== 'confirmed' && !mine) continue;
            rows.push({
                errandId: e.id,
                status: e.status,
                claimAttempt: e.claimAttempt,
                claimedByMe: mine,
                formKey: e.formKey,
                formUrl: e.formUrl,
                fieldsJson: e.fieldsJson,
                confirmedDigest: e.confirmedDigest,
                confirmedAtMs: e.confirmedAtMs,
            });
        }
        return rows;
    }

    callQueue(): readonly CallQueueRow[] {
        const rows: CallQueueRow[] = [];
        for (const c of this.calls.values()) {
            const live = c.status === 'dialing' || c.status === 'ringing' || c.status === 'connected';
            // A call whose dial lease lapsed stays in view with cancel_requested, so the sidecar still hangs up.
            const lapsed = c.status === 'failed' && c.reasonCode === 'lease_lapsed' && c.cancelRequested;
            const mine = (live || lapsed) && c.claimedBy === this.me;
            if (c.status !== 'confirmed' && !mine) continue;
            rows.push({
                callId: c.id,
                status: c.status,
                claimAttempt: c.claimAttempt,
                claimedByMe: mine,
                requestId: c.requestId,
                contactId: c.contactId,
                scriptDigest: c.scriptDigest,
                cancelRequested: c.cancelRequested,
                cancelReason: c.cancelReason,
                confirmedAtMs: c.viewShowsConfirmedAt ? c.confirmedAtMs : null,
            });
        }
        return rows;
    }

    agentConsent(): AgentConsent | null {
        if (!this.consentRowShown) return null;
        return { sessionId: this.sessionId, memoryAllowed: this.consent.memory, webSearchAllowed: this.consent.webSearch };
    }

    onMemoryOff(listener: () => void): () => void {
        this.memoryOffListeners.add(listener);
        return () => this.memoryOffListeners.delete(listener);
    }

    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    syncCount(): number {
        return this.syncs;
    }

    isCurrent(): boolean {
        return this.connected;
    }

    async ready(timeoutMs: number): Promise<boolean> {
        if (this.connected) return true;
        return new Promise<boolean>((resolve) => {
            const done = (value: boolean) => {
                clearTimeout(timer);
                this.waiters.delete(wake);
                resolve(value);
            };
            const wake = () => done(true);
            const timer = setTimeout(() => done(false), timeoutMs);
            this.waiters.add(wake);
        });
    }

    async call<K extends ReducerName>(name: K, args: ReducerArgs[K]): Promise<void> {
        this.attempted.push({ name, args: structuredClone(args) });
        if (!this.connected) throw new DbCallError('disconnected', name, 'not connected');
        const injected = this.failures.get(name)?.shift();
        if (injected && !(injected.kind === 'unknown_result' && injected.applied)) {
            throw new DbCallError(injected.kind, name, injected.message ?? (injected.kind === 'stale' ? 'stale attempt' : `injected ${injected.kind}`));
        }
        this.apply(name, args);
        this.applied.push({ name, args: structuredClone(args) });
        this.changed();
        if (injected) throw new DbCallError('unknown_result', name, 'connection dropped before the reply');
    }

    // ---------- What the test or the operator does on the module's side ----------

    /** A partner question: the module's `ask_question` made an Options job. */
    addOptionsJob(job: NewOptionsJob): bigint {
        const id = this.id();
        this.jobs.set(id, {
            id,
            kind: 'options',
            status: 'pending',
            attempt: 0,
            claimedBy: null,
            questionId: this.id(),
            questionText: job.questionText,
            origin: job.origin ?? 'partner',
            menuItem: job.menuItem ?? 'none',
            askedBy: job.askedBy ?? 'b'.repeat(64),
            // Like the module: a new job carries the consent that holds when it is made.
            webSearchAllowed: job.webSearchAllowed ?? this.consent.webSearch,
            memoryAllowed: job.memoryAllowed ?? this.consent.memory,
            errandId: 0n,
            replyText: '',
            recentErrandTitle: job.recentErrandTitle ?? '',
            recentErrandSentAtMs: job.recentErrandSentAtMs ?? null,
            parentQuestionId: 0n,
            parentQuestionText: '',
            category: '',
            createdAtMs: this.now(),
            questionOpen: true,
        });
        this.changed();
        return id;
    }

    /** The question a job answers, so a test can open the direct select follow-ups on it. */
    questionOf(jobId: bigint): bigint {
        const job = this.jobs.get(jobId);
        if (!job) throw new Error('questionOf: no such job');
        return job.questionId;
    }

    /**
     * Direct select, like the module's createFollowUp (spacetime/src/clock.ts): a confirmed Search opens a categories
     * turn and a Category pick a search turn, each a new question row on the person's original question
     * (`parentQuestionId`, its words copied), with one job. A categories job carries no web search consent (it makes
     * no web call); a search job carries the WebSearch consent. Without `parentQuestionId` a new original is made up.
     */
    addFollowUpJob(job: { kind: 'categories' | 'category_search'; questionText: string; parentQuestionId?: bigint; category?: string; webSearchAllowed?: boolean; memoryAllowed?: boolean }): bigint {
        const id = this.id();
        this.jobs.set(id, {
            id,
            kind: job.kind,
            status: 'pending',
            attempt: 0,
            claimedBy: null,
            questionId: this.id(),
            questionText: job.questionText,
            origin: 'partner',
            menuItem: 'none',
            askedBy: 'b'.repeat(64),
            webSearchAllowed: job.webSearchAllowed ?? (job.kind === 'category_search' && this.consent.webSearch),
            memoryAllowed: job.memoryAllowed ?? this.consent.memory,
            errandId: 0n,
            replyText: '',
            recentErrandTitle: '',
            recentErrandSentAtMs: null,
            parentQuestionId: job.parentQuestionId ?? this.id(),
            parentQuestionText: job.questionText,
            category: job.kind === 'category_search' ? (job.category ?? '') : '',
            createdAtMs: this.now(),
            questionOpen: true,
        });
        this.changed();
        return id;
    }

    /** YES on an errand option: the module made a Drafted errand and an ErrandPreview job. */
    addPreviewJob(errand: NewErrandPreview): { jobId: bigint; errandId: bigint } {
        const errandId = this.id();
        this.errands.set(errandId, {
            id: errandId,
            status: 'drafted',
            formKey: errand.formKey,
            formUrl: errand.formUrl,
            formTitle: errand.formTitle,
            fieldsJson: errand.fieldsJson,
            previewDigest: '',
            readBackText: '',
            readBackJson: '',
            screenshotUrl: '',
            confirmedDigest: '',
            claimAttempt: 0,
            claimedBy: null,
            confirmationText: '',
            reasonCode: '',
            reason: '',
            submitMs: 0,
            confirmedAtMs: null,
        });
        this.errandConsent.add(errand.formKey);
        const jobId = this.id();
        this.jobs.set(jobId, {
            id: jobId,
            kind: 'errand_preview',
            status: 'pending',
            attempt: 0,
            claimedBy: null,
            questionId: this.id(),
            questionText: '',
            origin: 'partner',
            menuItem: 'none',
            askedBy: 'b'.repeat(64),
            webSearchAllowed: false,
            memoryAllowed: false,
            errandId,
            replyText: '',
            recentErrandTitle: '',
            recentErrandSentAtMs: null,
            parentQuestionId: 0n,
            parentQuestionText: '',
            category: '',
            createdAtMs: this.now(),
            questionOpen: true,
        });
        this.changed();
        return { jobId, errandId };
    }

    /** A reply was said aloud and Memory consent is on: the module made a Remember job. */
    addRememberJob(job: { questionText: string; replyText: string; askedBy?: string; memoryAllowed?: boolean }): bigint {
        const id = this.id();
        this.jobs.set(id, {
            id,
            kind: 'remember',
            status: 'pending',
            attempt: 0,
            claimedBy: null,
            questionId: this.id(),
            questionText: job.questionText,
            origin: 'partner',
            menuItem: 'none',
            askedBy: job.askedBy ?? 'b'.repeat(64),
            webSearchAllowed: false,
            memoryAllowed: job.memoryAllowed ?? this.consent.memory,
            errandId: 0n,
            replyText: job.replyText,
            recentErrandTitle: '',
            recentErrandSentAtMs: null,
            parentQuestionId: 0n,
            parentQuestionText: '',
            category: '',
            createdAtMs: this.now(),
            questionOpen: true,
        });
        this.changed();
        return id;
    }

    /**
     * The station read the read-back and the person gave a valid CONFIRM: Previewed to Confirmed. `digest` lets a
     * test confirm a different digest than the one previewed (which the real module would never do).
     */
    confirmErrand(errandId: bigint, digest?: string): void {
        const e = this.errands.get(errandId);
        if (!e || e.status !== 'previewed') throw new Error('confirmErrand: the errand is not previewed');
        e.status = 'confirmed';
        e.confirmedDigest = digest ?? e.previewDigest;
        if (digest !== undefined) e.previewDigest = digest;
        e.confirmedAtMs = this.now();
        this.changed();
    }

    /** A Confirmed errand straight away, for tests of the submit path alone. */
    addConfirmedErrand(errand: NewErrandPreview & { digest: string }): bigint {
        const id = this.id();
        this.errands.set(id, {
            id,
            status: 'confirmed',
            formKey: errand.formKey,
            formUrl: errand.formUrl,
            formTitle: errand.formTitle,
            fieldsJson: errand.fieldsJson,
            previewDigest: errand.digest,
            readBackText: 'read back',
            readBackJson: '[]',
            screenshotUrl: '',
            confirmedDigest: errand.digest,
            claimAttempt: 0,
            claimedBy: null,
            confirmationText: '',
            reasonCode: '',
            reason: '',
            submitMs: 0,
            confirmedAtMs: this.now(),
        });
        this.errandConsent.add(errand.formKey);
        this.changed();
        return id;
    }

    /**
     * A call option was picked, read back and confirmed. `confirmedAtMs` (default now) is the CONFIRM's time on the
     * module's clock; a test sets it in the past for an update that reached the sidecar late. `viewShowsConfirmedAt`
     * false plays bindings older than module v2: the module knows the time, the sidecar's view does not.
     */
    addConfirmedCall(call: { requestId: string; contactId: string; digest: string; confirmedAtMs?: number | null; viewShowsConfirmedAt?: boolean }): bigint {
        const id = this.id();
        this.calls.set(id, {
            id,
            status: 'confirmed',
            requestId: call.requestId,
            contactId: call.contactId,
            scriptDigest: call.digest,
            claimAttempt: 0,
            claimedBy: null,
            cancelRequested: false,
            cancelReason: '',
            result: '',
            endReason: '',
            reasonCode: '',
            reason: '',
            confirmedAtMs: call.confirmedAtMs === undefined ? this.now() : call.confirmedAtMs,
            viewShowsConfirmedAt: call.viewShowsConfirmedAt ?? true,
        });
        this.callConsent.add(call.contactId);
        this.changed();
        return id;
    }

    /** The call's ConfirmWindow timer after the CONFIRM: a call nobody claimed in time is Stopped (`confirm_expired`). */
    expireConfirmedCall(callId: bigint): void {
        const c = this.calls.get(callId);
        if (!c || c.status !== 'confirmed') throw new Error('expireConfirmedCall: the call is not confirmed');
        c.status = 'stopped';
        c.reasonCode = 'confirm_expired';
        this.changed();
    }

    /** STOP, HEADSET_OFF, the idle pause or an operator during a live call. A Confirmed call is stopped instead. */
    requestCallCancel(callId: bigint, reason: 'stop' | 'headset_off' | 'auto_pause' | 'operator'): void {
        const c = this.calls.get(callId);
        if (!c) throw new Error('requestCallCancel: no such call');
        if (c.status === 'confirmed') c.status = 'stopped';
        else {
            c.cancelRequested = true;
            c.cancelReason = reason;
        }
        this.changed();
    }

    /** The call's dial lease ran out (`call_timeout`): Failed, result unknown, and the sidecar is asked to hang up. */
    lapseCallLease(callId: bigint): void {
        const c = this.calls.get(callId);
        if (!c) throw new Error('lapseCallLease: no such call');
        c.status = 'failed';
        c.result = 'unknown';
        c.reasonCode = 'lease_lapsed';
        if (!c.cancelRequested) c.cancelReason = 'operator';
        c.cancelRequested = true;
        this.changed();
    }

    /**
     * The owner revoked web search or memory consent: the flag is cleared on every job not done yet, a Remember job is
     * cancelled when memory goes (spacetime/src/consent.ts, stopUncovered), and `agent_consent` shows it. While
     * connected, the onMemoryOff listeners hear a memory revocation at once, as the adapter's row callbacks do.
     */
    revokeConsent(scope: 'web_search' | 'memory'): void {
        for (const job of this.jobs.values()) {
            if (job.status !== 'pending' && job.status !== 'claimed') continue;
            if (scope === 'memory' && job.kind === 'remember') job.status = 'cancelled';
            else if (scope === 'web_search') job.webSearchAllowed = false;
            else job.memoryAllowed = false;
        }
        if (scope === 'memory') this.consent.memory = false;
        else this.consent.webSearch = false;
        if (scope === 'memory' && this.connected && this.consentRowShown) for (const listener of [...this.memoryOffListeners]) listener();
        this.changed();
    }

    /** The owner gave web search or memory consent again. Jobs already made keep their flags (never given back). */
    grantConsent(scope: 'web_search' | 'memory'): void {
        if (scope === 'memory') this.consent.memory = true;
        else this.consent.webSearch = true;
        this.changed();
    }

    /** A newer question superseded this one, or the partner cancelled it: the job is Cancelled. */
    cancelJob(jobId: bigint): void {
        const job = this.jobs.get(jobId);
        if (!job) throw new Error('cancelJob: no such job');
        job.status = 'cancelled';
        job.questionOpen = false;
        this.changed();
    }

    /** The lease lapsed (lease_expired): back to Pending, so a new attempt can claim it. */
    expireLease(jobId: bigint): void {
        const job = this.jobs.get(jobId);
        if (!job || job.status !== 'claimed') throw new Error('expireLease: the job is not claimed');
        job.status = 'pending';
        job.claimedBy = null;
        this.changed();
    }

    /** The next call to `name` fails with `kind`. With `applied`, an unknown result ran before its reply was lost. */
    failNext(name: ReducerName, kind: DbErrorKind, options: { applied?: boolean; times?: number; message?: string } = {}): void {
        const list = this.failures.get(name) ?? [];
        for (let i = 0; i < (options.times ?? 1); i++) {
            list.push({ kind, applied: options.applied ?? false, ...(options.message !== undefined ? { message: options.message } : {}) });
        }
        this.failures.set(name, list);
    }

    /** Drops or restores the connection. A reconnect re-syncs: the views arrive again as a fresh snapshot. */
    setConnected(connected: boolean): void {
        const reconnect = connected && !this.connected;
        const lost = !connected && this.connected;
        this.connected = connected;
        // Like the adapter: a lost connection counts as memory off, since a revocation during the gap may never show.
        if (lost) for (const listener of [...this.memoryOffListeners]) listener();
        if (!reconnect) return;
        this.syncs += 1;
        for (const wake of [...this.waiters]) wake();
        this.changed(true);
    }

    job(jobId: bigint): JobRecord | undefined {
        return this.jobs.get(jobId);
    }

    // ---------- The rules ----------

    private apply<K extends ReducerName>(name: K, raw: ReducerArgs[K]): void {
        switch (name) {
            case 'agentClaim': {
                const a = raw as ReducerArgs['agentClaim'];
                const job = this.jobs.get(a.jobId);
                this.lapse(job);
                if (!job || job.status !== 'pending') throw refuse(name, 'not pending');
                job.status = 'claimed';
                job.attempt += 1;
                job.claimedBy = this.me;
                this.renewLease(job);
                return;
            }
            case 'agentProgress':
                return this.progress(raw as ReducerArgs['agentProgress']);
            case 'agentPublishOptions':
                return this.publish(raw as ReducerArgs['agentPublishOptions']);
            case 'agentAttachPreview':
                return this.attach(raw as ReducerArgs['agentAttachPreview']);
            case 'agentFail': {
                const a = raw as ReducerArgs['agentFail'];
                const job = this.fenced(name, a.jobId, a.attempt);
                checkText(name, a.reasonCode, 'reason_code', LIMITS.reasonCode);
                checkText(name, a.reason, 'reason', LIMITS.reason);
                job.status = 'failed';
                if (job.kind === 'errand_preview') {
                    const e = this.errands.get(job.errandId);
                    if (e && e.status === 'drafted') e.status = 'failed';
                }
                return;
            }
            case 'agentDone': {
                const a = raw as ReducerArgs['agentDone'];
                const job = this.fenced(name, a.jobId, a.attempt);
                if (job.kind !== 'remember') throw refuse(name, 'agent_done is for remember jobs');
                checkCounts(name, a.countsJson);
                job.status = 'done';
                return;
            }
            case 'claimErrand': {
                const a = raw as ReducerArgs['claimErrand'];
                const e = this.errands.get(a.errandId);
                if (!e) throw refuse(name, 'no such errand');
                if (e.status !== 'confirmed') throw refuse(name, 'errand is not confirmed');
                if (a.digest !== e.confirmedDigest || a.digest !== e.previewDigest) throw refuse(name, 'digest mismatch');
                if (!this.errandConsent.has(e.formKey)) throw refuse(name, 'no errand consent');
                e.status = 'submitting';
                e.claimAttempt += 1;
                e.claimedBy = this.me;
                return;
            }
            case 'completeErrand':
                return this.complete(raw as ReducerArgs['completeErrand']);
            case 'claimCall': {
                const a = raw as ReducerArgs['claimCall'];
                const c = this.calls.get(a.callId);
                if (!c) throw refuse(name, 'no such call');
                if (c.status !== 'confirmed') throw refuse(name, 'call is not confirmed');
                if (a.digest !== c.scriptDigest) throw refuse(name, 'digest mismatch');
                if (!this.callConsent.has(c.contactId)) throw refuse(name, 'no call consent');
                // Module v2: a CONFIRM CALL_CLAIM_MS old or older (or of no known time) cannot dial. Final for the sidecar.
                if (c.confirmedAtMs === null || this.now() - c.confirmedAtMs >= CALL_CLAIM_MS) throw refuse(name, 'confirm expired');
                c.status = 'dialing';
                c.claimAttempt += 1;
                c.claimedBy = this.me;
                return;
            }
            case 'reportCallStatus':
                return this.callStatus(raw as ReducerArgs['reportCallStatus']);
            case 'addCallLine': {
                const a = raw as ReducerArgs['addCallLine'];
                if (!LINE_KEY_PATTERN.test(a.lineKey)) throw refuse(name, 'bad line_key');
                if (a.role !== 'assistant' && a.role !== 'recipient') throw refuse(name, 'role must be assistant or recipient');
                checkText(name, a.text, 'text', LIMITS.callLineText, 1);
                const call = this.fencedCall(name, a.callId, a.attempt);
                // Lines belong to a live call; one that ended, failed or lapsed takes none (ignored quietly).
                if (call.status !== 'dialing' && call.status !== 'ringing' && call.status !== 'connected') return;
                if (this.callLines.some((line) => line.lineKey === a.lineKey)) return;
                this.callLines.push({ callId: a.callId, lineKey: a.lineKey, role: a.role, text: a.text });
                return;
            }
            case 'requestPairing':
                return;
        }
    }

    private progress(a: ReducerArgs['agentProgress']): void {
        const name = 'agentProgress';
        const job = this.fenced(name, a.jobId, a.attempt);
        if (!EVENT_KEY_PATTERN.test(a.eventKey)) throw refuse(name, 'bad event_key');
        // Module v2: keys under the module's own prefixes are the module's (its speak, select and call steps).
        if (MODULE_EVENT_KEY.test(a.eventKey)) throw refuse(name, 'event_key uses a prefix the module writes');
        this.renewLease(job);
        if (this.events.some((event) => event.eventKey === a.eventKey)) return; // a retry, or a lease renewal
        if (!(STAGES as readonly string[]).includes(a.stage)) throw refuse(name, 'bad stage');
        if (!(STATUSES as readonly string[]).includes(a.status)) throw refuse(name, 'bad status');
        if (!DETAIL_PATTERN.test(a.detail)) throw refuse(name, 'bad detail');
        checkCounts(name, a.countsJson);
        if (Buffer.byteLength(a.payloadJson, 'utf8') > 16_384) throw refuse(name, 'payload_json is too long');
        if (a.payloadJson !== '') parseObject(name, a.payloadJson, 'payload_json');
        if (a.stage === 'search' && !job.webSearchAllowed) throw refuse(name, 'no web search consent');
        if (!Number.isInteger(a.ms) || a.ms < 0) throw refuse(name, 'bad ms');
        this.events.push({
            id: this.id(),
            eventKey: a.eventKey,
            jobId: a.jobId,
            questionId: job.questionId,
            stage: a.stage,
            status: a.status,
            detail: a.detail,
            ms: a.status === 'started' ? null : a.ms,
            countsJson: a.countsJson === '' ? '{}' : a.countsJson,
            payloadJson: a.payloadJson,
        });
    }

    private publish(a: ReducerArgs['agentPublishOptions']): void {
        const name = 'agentPublishOptions';
        const job = this.fenced(name, a.jobId, a.attempt);
        // Direct select: the categories and category search jobs publish options for their question too, each only
        // the kinds it may (spacetime/src/agent.ts KINDS_FOR_JOB).
        const kinds = KINDS_FOR_JOB[job.kind];
        if (!kinds) throw refuse(name, 'not an options job');
        if (a.options.some((o) => !kinds.includes(o.kind))) throw refuse(name, `a ${job.kind} job cannot publish that option kind`);
        if (!job.questionOpen) {
            if (a.final) job.status = 'done';
            else this.renewLease(job);
            return;
        }
        const count = a.options.length;
        if (a.answerMode === 'pick') {
            if (count < 1 || count > this.maxOptions) throw refuse(name, 'pick needs 1 to max_options options');
        } else if (a.answerMode === 'yes_no') {
            if (count !== 2) throw refuse(name, 'yes_no needs exactly 2 options');
        } else {
            throw refuse(name, 'answer_mode must be pick or yes_no');
        }
        for (const option of a.options) checkOption(name, option);
        if (a.answerMode === 'yes_no' && a.options.some((o) => o.kind !== 'reply')) throw refuse(name, 'yes_no options must be replies');
        const version = Math.max(this.versions.get(job.questionId) ?? 0, 0) + 1;
        this.versions.set(job.questionId, version);
        this.publishes.push({
            jobId: a.jobId,
            attempt: a.attempt,
            questionId: job.questionId,
            version,
            answerMode: a.answerMode,
            options: structuredClone(a.options),
            final: a.final,
        });
        if (a.final) job.status = 'done';
        else this.renewLease(job);
    }

    private attach(a: ReducerArgs['agentAttachPreview']): void {
        const name = 'agentAttachPreview';
        const job = this.fenced(name, a.jobId, a.attempt);
        if (job.kind !== 'errand_preview') throw refuse(name, 'not a preview job');
        if (a.status !== 'previewed' && a.status !== 'refused' && a.status !== 'failed') throw refuse(name, 'bad status');
        checkText(name, a.formTitle, 'form_title', LIMITS.formTitle);
        checkText(name, a.screenshotUrl, 'screenshot_url', LIMITS.screenshotUrl);
        checkText(name, a.reasonCode, 'reason_code', LIMITS.reasonCode);
        checkText(name, a.reason, 'reason', LIMITS.reason);
        if (a.readBackJson.length > LIMITS.readBackJsonChars) throw refuse(name, 'read_back_json is too long');
        if (a.status === 'previewed') {
            if (!DIGEST_PATTERN.test(a.previewDigest)) throw refuse(name, 'bad preview_digest');
            checkText(name, a.readBackText, 'read_back_text', LIMITS.readBackText, 1);
        }
        const e = this.errands.get(job.errandId);
        job.status = 'done';
        if (!e || e.status !== 'drafted') return; // STOP was quicker: the errand is unchanged
        if (a.status === 'previewed' && !this.errandConsent.has(e.formKey)) {
            e.status = 'refused';
            e.reasonCode = 'no_consent';
            return;
        }
        e.formTitle = a.formTitle || e.formTitle;
        e.screenshotUrl = a.screenshotUrl;
        if (a.status === 'previewed') {
            e.status = 'previewed';
            e.previewDigest = a.previewDigest;
            e.readBackText = a.readBackText;
            e.readBackJson = a.readBackJson;
        } else {
            e.status = a.status;
            e.reasonCode = a.reasonCode || a.status;
            e.reason = a.reason;
        }
    }

    private complete(a: ReducerArgs['completeErrand']): void {
        const name = 'completeErrand';
        const target: Record<string, ErrandStatus> = {
            submitted: 'submitted',
            duplicate: 'submitted',
            refused: 'refused',
            failed: 'failed',
            unknown: 'unknown_outcome',
        };
        const to = target[a.status];
        if (!to) throw refuse(name, 'status must be submitted, duplicate, refused, failed or unknown');
        checkText(name, a.confirmationText, 'confirmation_text', LIMITS.confirmationText);
        checkText(name, a.screenshotUrl, 'screenshot_url', LIMITS.screenshotUrl);
        checkText(name, a.reasonCode, 'reason_code', LIMITS.reasonCode);
        checkText(name, a.reason, 'reason', LIMITS.reason);
        const e = this.errands.get(a.errandId);
        if (!e || e.claimAttempt !== a.attempt || e.claimedBy !== this.me) throw new DbCallError('stale', name, 'stale attempt');
        if (e.status === to) return; // a retry of a call that already committed
        if (e.status !== 'submitting' && e.status !== 'unknown_outcome') throw refuse(name, 'errand is not submitting');
        if (e.status === 'unknown_outcome' && to === 'unknown_outcome') return;
        e.status = to;
        e.confirmationText = a.confirmationText;
        e.reasonCode = to === 'submitted' ? '' : a.reasonCode || a.status;
        e.reason = to === 'submitted' ? '' : a.reason;
        e.submitMs = a.submitMs;
    }

    private callStatus(a: ReducerArgs['reportCallStatus']): void {
        const name = 'reportCallStatus';
        const results = ['', 'answered', 'no_answer', 'busy', 'voicemail', 'cancelled', 'failed', 'refused', 'unknown'];
        if (!results.includes(a.result)) throw refuse(name, 'unknown call result');
        checkText(name, a.endReason, 'end_reason', LIMITS.endReason);
        checkText(name, a.reasonCode, 'reason_code', LIMITS.reasonCode);
        checkText(name, a.reason, 'reason', LIMITS.reason);
        const c = this.fencedCall(name, a.callId, a.attempt);
        const allowed: Record<string, CallStatus[]> = {
            ringing: ['dialing'],
            connected: ['dialing', 'ringing'],
            ended: ['dialing', 'ringing', 'connected'],
            failed: ['dialing', 'ringing', 'connected'],
            refused: ['dialing', 'ringing'],
        };
        const from = allowed[a.status];
        if (!from) throw refuse(name, 'status must be ringing, connected, ended, failed or refused');
        if (!from.includes(c.status)) return; // out of order or repeated: ignored quietly
        c.status = a.status === 'ended' ? 'ended' : a.status;
        if (a.status === 'ended' || a.status === 'failed' || a.status === 'refused') {
            c.result = a.status === 'refused' ? 'refused' : a.result || (a.status === 'ended' ? 'answered' : 'failed');
            c.endReason = a.endReason;
            // Like the module since v2 (spacetime/src/consent.ts reportCallStatus): an ended call keeps its reason too.
            c.reasonCode = a.reasonCode;
            c.reason = a.reason;
        }
    }

    /**
     * What `board_calls.held` would show for this call (spacetime/src/consent.ts isHeld): a hold code, or the Dialer's
     * hold sentence in the stored reason.
     */
    held(callId: bigint): boolean {
        const c = this.calls.get(callId);
        if (!c) return false;
        return c.reasonCode === 'opt_out_hold' || c.reasonCode === 'hold_file_error' || /are on hold until someone checks/.test(c.reason);
    }

    /** The module's `lease_expired`, run when the job is next touched: a Claimed job past its lease is Pending again. */
    private lapse(job: JobRecord | undefined): void {
        if (!job || !this.leaseMs || job.status !== 'claimed' || job.leaseEndsAt === undefined) return;
        if (this.now() <= job.leaseEndsAt) return;
        job.status = 'pending';
        job.claimedBy = null;
        this.changed();
    }

    private renewLease(job: JobRecord): void {
        if (this.leaseMs) job.leaseEndsAt = this.now() + this.leaseMs;
    }

    private fenced(reducer: string, jobId: bigint, attempt: number): JobRecord {
        this.lapse(this.jobs.get(jobId));
        const job = this.jobs.get(jobId);
        if (!job || job.status !== 'claimed' || job.attempt !== attempt || job.claimedBy !== this.me) {
            throw new DbCallError('stale', reducer, 'stale attempt');
        }
        return job;
    }

    private fencedCall(reducer: string, callId: bigint, attempt: number): CallRecord {
        const c = this.calls.get(callId);
        if (!c || c.claimAttempt !== attempt || c.claimedBy !== this.me) throw new DbCallError('stale', reducer, 'stale attempt');
        return c;
    }

    private id(): bigint {
        const id = this.nextId;
        this.nextId += 1n;
        return id;
    }

    private changed(force = false): void {
        // Like the SDK: listeners hear about changes to the agent views only (a pipeline event alone changes none),
        // in a microtask queued before the reducer call returns, and not while disconnected. A reconnect always
        // tells them, as the SDK's onApplied does.
        queueMicrotask(() => {
            if (!this.connected) return;
            const views = this.viewSignature();
            if (!force && views === this.told) return;
            this.told = views;
            for (const listener of [...this.listeners]) listener();
        });
    }

    private viewSignature(): string {
        return JSON.stringify([this.agentQueue(), this.errandQueue(), this.callQueue(), this.agentConsent()], (_key, value: unknown) =>
            typeof value === 'bigint' ? value.toString() : value,
        );
    }
}

function checkText(reducer: string, value: string, field: string, max: number, min = 0): void {
    if (typeof value !== 'string') throw refuse(reducer, `${field} must be text`);
    if (value.trim().length < min) throw refuse(reducer, `${field} is empty`);
    if (value.length > max) throw refuse(reducer, `${field} is longer than ${max} characters`);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw refuse(reducer, `${field} has control characters`);
}

function parseObject(reducer: string, json: string, field: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        throw refuse(reducer, `${field} is not JSON`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw refuse(reducer, `${field} must be a JSON object`);
    return parsed as Record<string, unknown>;
}

function checkCounts(reducer: string, json: string): void {
    if (json === '') return;
    if (json.length > LIMITS.countsJsonChars) throw refuse(reducer, 'counts_json is too long');
    for (const [key, value] of Object.entries(parseObject(reducer, json, 'counts_json'))) {
        if (key.length > LIMITS.countsKeyChars) throw refuse(reducer, 'counts_json key is too long');
        const ok = typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
        if (!ok) throw refuse(reducer, 'counts_json values must be numbers or booleans');
    }
}

function checkOption(reducer: string, option: OptionInput): void {
    checkText(reducer, option.text, 'text', LIMITS.optionText, 1);
    // Direct select: the earpiece label, empty for "read the text" (docs/direct-select.md section 4).
    checkText(reducer, option.label, 'label', LIMITS.optionLabel);
    if (option.tone !== '' && !(TONES as readonly string[]).includes(option.tone)) throw refuse(reducer, 'tone is not in the allowlist');
    if (option.kind === 'errand') {
        const a = parseObject(reducer, option.actionJson, 'action_json');
        if (typeof a.formKey !== 'string' || !ID_PATTERN.test(a.formKey)) throw refuse(reducer, 'bad formKey');
        if (typeof a.formUrl !== 'string' || !(a.formUrl === 'demo' || a.formUrl.startsWith('https://')) || a.formUrl.length > LIMITS.formUrl) {
            throw refuse(reducer, 'formUrl must be https or demo');
        }
        if (typeof a.formTitle !== 'string' || a.formTitle.length > LIMITS.formTitle) throw refuse(reducer, 'bad formTitle');
        if (!Array.isArray(a.fields) || a.fields.length > LIMITS.actionFields) throw refuse(reducer, 'fields must be a list');
    } else if (option.kind === 'call') {
        const a = parseObject(reducer, option.actionJson, 'action_json');
        if (typeof a.requestId !== 'string' || !ID_PATTERN.test(a.requestId)) throw refuse(reducer, 'bad requestId');
        if (typeof a.contactId !== 'string' || !ID_PATTERN.test(a.contactId)) throw refuse(reducer, 'bad contactId');
        if (typeof a.digest !== 'string' || !DIGEST_PATTERN.test(a.digest)) throw refuse(reducer, 'bad digest');
        if (typeof a.recipientName !== 'string' || a.recipientName.trim() === '' || a.recipientName.length > 80) throw refuse(reducer, 'bad recipientName');
        if (typeof a.readBack !== 'string' || a.readBack.trim() === '' || a.readBack.length > 500) throw refuse(reducer, 'bad readBack');
        if (typeof a.expiresAt !== 'number' || !Number.isFinite(a.expiresAt)) throw refuse(reducer, 'bad expiresAt');
    } else if (option.kind === 'reply' || option.kind === 'search' || option.kind === 'category') {
        if (option.actionJson !== '') throw refuse(reducer, 'a reply carries no action');
    } else {
        throw refuse(reducer, 'kind must be reply, errand, call, search or category');
    }
}
