// Fakes for every outside service the sidecar uses. No test reaches the network, needs a key, or opens Moss.

import Anthropic from '@anthropic-ai/sdk';
import { classifyQuestion, type ErrandResult, type PreviewRequest, type SearchResult, type SearchRow, type SubmitRequest } from '@say-when/apify-client';
import type { CallOutcome, CallRequest, CallSnapshot, CancelReason, PreparedCall } from '@say-when/cartesia/server';
import type { CandidateOption, IndexResult, MemoryHit, Ordering, Recall, WebSearch } from '@say-when/moss';

import { CallRunner } from '../src/calls.js';
import { MemoryDb } from '../src/db/memory-db.js';
import type { ErrandEmailDeps } from '../src/email.js';
import { ErrandRunner } from '../src/errands.js';
import { ConversationLog, PreviewBook, SentBook, type JobDeps } from '../src/jobs.js';
import { MemoryWatch } from '../src/requests.js';
import { recordingLogger, type RecordingLogger } from '../src/log.js';
import { Orchestrator, type OrchestratorOptions } from '../src/orchestrator.js';
import { ClaudePlanner, type MessagesApi } from '../src/planner/claude.js';
import type { PlanReply } from '../src/planner/schema.js';
import type { CallHandleLike, DialerPort, ErrandPort, MemoryPort, SearchPort, WebIndexPort } from '../src/ports.js';
import type { AllowedForm, CallContact } from '../src/types.js';

type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

/** Content that must never reach a public event, a log line or a payload (where the comment says so). */
export const SECRET = {
    question: 'Is the pharmacy on Zorbleton Street still open',
    privateMemory: 'PRIVMEM I take my coffee black with oat milk',
    sharedMemory: 'SHAREDMEM Sure, somewhere quiet',
    contactName: 'Leonora',
    formValue: 'FORMVALUE lunch at the cafe at noon',
    readBack: 'READBACK To Care team request. Details: FORMVALUE',
    option: 'OPTIONTEXT',
    phone: '+1 415 555 0199',
} as const;

/** Records the order the fakes were called in, across all of them. */
export class Trace {
    readonly steps: string[] = [];
    add(step: string): void {
        this.steps.push(step);
    }
    indexOf(step: string): number {
        return this.steps.indexOf(step);
    }
}

// ---------- Claude ----------

export function message(text: string, overrides: Record<string, unknown> = {}): Anthropic.Beta.BetaMessage {
    return {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-5-5',
        content: [{ type: 'text', text, citations: null }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        stop_details: null,
        usage: { input_tokens: 900, output_tokens: 210, cache_read_input_tokens: 640, cache_creation_input_tokens: 0, iterations: null },
        ...overrides,
    } as unknown as Anthropic.Beta.BetaMessage;
}

type Queued = Anthropic.Beta.BetaMessage | Error | ((params: CreateParams) => Anthropic.Beta.BetaMessage);

export class FakeApi implements MessagesApi {
    readonly calls: { params: CreateParams; options: { timeout?: number; maxRetries?: number; signal?: AbortSignal } | undefined }[] = [];
    private readonly queue: Queued[] = [];
    /** Hold every call until the signal aborts (for cancellation tests). */
    hang = false;
    /** Wait this long before answering each call (a slow planner). */
    delayMs = 0;

    constructor(private readonly trace?: Trace) {}

    reply(json: PlanReply | Record<string, unknown>, overrides: Record<string, unknown> = {}): this {
        this.queue.push(message(JSON.stringify(withLabels(json)), overrides));
        return this;
    }

    replyWith(fn: (params: CreateParams) => PlanReply | Record<string, unknown>): this {
        this.queue.push((params) => message(JSON.stringify(withLabels(fn(params)))));
        return this;
    }

    raw(msg: Anthropic.Beta.BetaMessage): this {
        this.queue.push(msg);
        return this;
    }

    fail(error: Error): this {
        this.queue.push(error);
        return this;
    }

    async create(params: CreateParams, options?: { timeout?: number; maxRetries?: number; signal?: AbortSignal }): Promise<Anthropic.Beta.BetaMessage> {
        this.calls.push({ params, options });
        this.trace?.add('claude.create');
        if (this.hang) {
            await new Promise<void>((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()), { once: true });
            });
        }
        if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        const next = this.queue.shift();
        if (!next) throw new Error('FakeApi: no reply queued');
        if (next instanceof Error) throw next;
        return typeof next === 'function' ? next(params) : next;
    }

    /** The user message of call `n`. */
    userMessage(n = 0): string {
        const content = this.calls[n]?.params.messages[0]?.content;
        return typeof content === 'string' ? content : '';
    }
}

type ReplyOption = PlanReply['options'][number];

/** A test option's earpiece label when it names none: its first three words, without punctuation. */
export function labelOf(text: string): string {
    return text.replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 3).join(' ');
}

export function reply(option: Partial<ReplyOption> & { text: string }): ReplyOption {
    return { kind: 'reply', label: labelOf(option.text), query: '', tone: 'neutral', laugh: false, sources: [], errand: null, call: null, ...option };
}

/** Gives every option of a reply written before direct select its label and query, as the planner now always sends them. */
function withLabels(json: PlanReply | Record<string, unknown>): PlanReply | Record<string, unknown> {
    const options = (json as { options?: unknown }).options;
    if (!Array.isArray(options)) return json;
    return {
        ...json,
        options: options.map((o: unknown) => {
            if (!o || typeof o !== 'object') return o;
            const option = o as Record<string, unknown>;
            return { label: labelOf(typeof option.text === 'string' ? option.text : ''), query: '', ...option };
        }),
    };
}

/** A valid four-option pick reply. */
export function fourOptions(sources: string[][] = [[], [], [], []]): PlanReply {
    return {
        answer_mode: 'pick',
        options: [
            reply({ text: 'Yes, let us get lunch.', tone: 'warm', sources: sources[0] ?? [] }),
            reply({ text: 'Maybe later today.', tone: 'calm', sources: sources[1] ?? [] }),
            reply({ text: 'Not today, thanks.', tone: 'neutral', sources: sources[2] ?? [] }),
            reply({ text: 'Only somewhere quiet.', tone: 'firm', sources: sources[3] ?? [] }),
        ],
    };
}

export function yesNo(): PlanReply {
    return {
        answer_mode: 'yes_no',
        options: [reply({ text: 'Yes, a little tired.', tone: 'calm' }), reply({ text: 'No, I am fine.', tone: 'warm' })],
    };
}

// ---------- Apify search ----------

export function webRow(n: number, overrides: Partial<SearchRow> = {}): SearchRow {
    return {
        id: `web:${String(n).padStart(16, '0')}`,
        source: 'web',
        title: `Page ${n}`,
        text: `Page ${n} says the pharmacy opens at 9 and closes at 9. Call ${SECRET.phone} for hours.`,
        url: `https://example.com/page-${n}`,
        fetchedAt: '2026-10-24T19:00:00.000Z',
        rank: n,
        ...overrides,
    };
}

export function placeRow(n: number): SearchRow {
    return {
        id: `maps:place${n}`,
        source: 'maps',
        title: `Pharmacy ${n}`,
        text: `Pharmacy ${n}. Drugstore. 12 Main St. Open when checked. Phone ${SECRET.phone}.`,
        url: `https://maps.example.com/?cid=${n}`,
        placeId: `place${n}`,
        location: { lat: 37.87, lng: -122.27 },
        fetchedAt: '2026-10-24T19:00:00.000Z',
        rank: n,
        facts: { rating: 4.5, reviews: 120, openNow: true, address: '12 Main St', phone: SECRET.phone, category: 'Drugstore' },
    };
}

export class FakeSearch implements SearchPort {
    readonly calls: { kind: 'web' | 'maps'; query: string; near?: { lat: number; lng: number } }[] = [];
    rows: SearchRow[] = [webRow(1), webRow(2)];
    error: Error | null = null;
    hang = false;
    partial = false;
    /** While set, each search waits for it (a slow search the test releases), or fails at once if aborted. */
    gate: Promise<void> | null = null;

    constructor(private readonly trace?: Trace) {}

    /** Holds every search until the returned function is called. */
    hold(): () => void {
        let release = () => undefined as void;
        this.gate = new Promise<void>((resolve) => (release = resolve));
        return () => {
            this.gate = null;
            release();
        };
    }

    web(question: string, options: { signal: AbortSignal }): Promise<SearchResult> {
        this.calls.push({ kind: 'web', query: question });
        this.trace?.add('search.web');
        return this.result(question, options.signal);
    }

    places(query: string, options: { signal: AbortSignal; near?: { lat: number; lng: number } }): Promise<SearchResult> {
        this.calls.push({ kind: 'maps', query, ...(options.near ? { near: options.near } : {}) });
        this.trace?.add('search.maps');
        return this.result(query, options.signal);
    }

    private async result(query: string, signal: AbortSignal): Promise<SearchResult> {
        if (this.hang) {
            await new Promise<void>((_resolve, reject) => {
                const fail = () => reject(Object.assign(new Error('aborted'), { name: 'ApifyHttpError', kind: 'aborted' }));
                if (signal.aborted) fail();
                signal.addEventListener('abort', fail, { once: true });
            });
        }
        if (this.gate) {
            const gate = this.gate;
            await new Promise<void>((resolve, reject) => {
                const fail = () => reject(Object.assign(new Error('aborted'), { name: 'ApifyHttpError', kind: 'aborted' }));
                if (signal.aborted) return fail();
                signal.addEventListener('abort', fail, { once: true });
                void gate.then(() => {
                    signal.removeEventListener('abort', fail);
                    resolve();
                });
            });
        }
        if (this.error) throw this.error;
        return { rows: this.rows.map((row) => structuredClone(row)), ms: 1200, query, partial: this.partial };
    }
}

// ---------- Moss ----------

export function memoryHit(n: number, overrides: Partial<MemoryHit> = {}): MemoryHit {
    return {
        id: `mem:reply:${String(n).padStart(16, 'a')}`,
        type: 'reply',
        partnerId: 'b'.repeat(64),
        at: Date.parse('2026-10-12T18:00:00Z'),
        score: 0.8 - n * 0.05,
        text: `Q: Want lunch?\nA: ${SECRET.privateMemory} ${n}`,
        reply: `${SECRET.privateMemory} ${n}`,
        shareable: false,
        sharedText: null,
        ...overrides,
    };
}

export class FakeMemory implements MemoryPort {
    open = true;
    recallResult: Recall = { hits: [memoryHit(1)], instant: [`${SECRET.privateMemory} 1`], mossMs: 3, wallMs: 4 };
    recallError: Error | null = null;
    readonly recalls: { question: string; partnerId: string }[] = [];
    readonly written: { question: string; reply: string; partnerId: string; shareable?: boolean }[] = [];
    readonly ranked: { partnerId: string; options: CandidateOption[] }[] = [];
    /** Optional reordering for rank(): the candidate ids in the order to return. */
    order: string[] | null = null;
    /** A Moss call that never answers and ignores every signal (the README's "can hang until restarted"). */
    recallHang = false;
    /** Wait this long before answering a recall (or failing it with `recallError`). */
    recallDelayMs = 0;
    /** Wait this long before a write into memory lands. */
    writeBackDelayMs = 0;
    /** What a past-request query (src/requests.ts) finds. None by default. */
    pastRequestHits: MemoryHit[] = [];
    /** A past-request query that never answers (the question's own recall still does). */
    pastRequestHang = false;
    /** Notes added with addNote: the past requests kept after a send. */
    readonly notes: { text: string; shareable: false }[] = [];
    noteError: Error | null = null;

    constructor(private readonly trace?: Trace) {}

    isOpen(): boolean {
        return this.open;
    }

    async recall(question: string, partnerId: string): Promise<Recall> {
        this.recalls.push({ question, partnerId });
        this.trace?.add('memory.recall');
        if (this.pastRequestHang && question.startsWith('Past request (')) await new Promise<never>(() => undefined);
        if (this.recallHang) await new Promise<never>(() => undefined);
        if (this.recallDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.recallDelayMs));
        if (this.recallError) throw this.recallError;
        if (question.startsWith('Past request (')) return { hits: structuredClone(this.pastRequestHits), instant: [], mossMs: 1, wallMs: 1 };
        return structuredClone(this.recallResult);
    }

    async addNote(note: { text: string; shareable: false }) {
        if (this.noteError) throw this.noteError;
        this.notes.push({ ...note });
        return { id: `mem:pref:note${this.notes.length}`, added: 1, updated: 0 };
    }

    async writeBack(confirmed: { question: string; reply: string; partnerId: string; shareable?: boolean }) {
        if (this.writeBackDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.writeBackDelayMs));
        this.written.push(confirmed);
        return { id: 'mem:reply:written', added: 1, updated: 0 };
    }

    async rank(partnerId: string, options: readonly CandidateOption[]): Promise<Ordering> {
        this.ranked.push({ partnerId, options: [...options] });
        const ids = this.order ?? options.map((o) => o.id);
        const ranked = ids
            .map((id) => options.find((o) => o.id === id))
            .filter((o): o is CandidateOption => !!o)
            .map((o) => ({ id: o.id, text: o.text, support: o.support ?? 0, affinity: 0, evidence: [], score: 0, last: false }));
        return { withMemory: ranked, withoutMemory: ranked };
    }
}

export class FakeWebIndex implements WebIndexPort {
    readonly indexed = new Map<string, SearchRow[]>();
    readonly forgotten: string[] = [];
    indexError: Error | null = null;
    /** How many of the next forget() calls never answer, ignoring every signal. */
    hangForgets = 0;

    constructor(private readonly trace?: Trace) {}

    async index(questionKey: string, rows: readonly SearchRow[]): Promise<IndexResult> {
        this.trace?.add('web.index');
        if (this.indexError) throw this.indexError;
        this.indexed.set(questionKey, rows.map((row) => structuredClone(row)));
        return { rows: rows.length, chunks: rows.length * 2, added: rows.length * 2, updated: 0, removed: 0, skipped: 0, truncated: 0, indexMs: 12 };
    }

    async search(questionKey: string): Promise<WebSearch> {
        this.trace?.add('web.search');
        const rows = this.indexed.get(questionKey) ?? [];
        return {
            hits: rows.map((row, i) => ({ id: `web:hit${i}#0`, questionId: questionKey, score: 0.9 - i * 0.1, text: `${row.title}\n\n${row.text}`, row })),
            mossMs: 2,
            wallMs: 3,
        };
    }

    async forget(questionKey: string): Promise<number> {
        this.trace?.add('web.forget');
        this.forgotten.push(questionKey);
        if (this.hangForgets > 0) {
            this.hangForgets -= 1;
            await new Promise<never>(() => undefined);
        }
        return (this.indexed.get(questionKey) ?? []).length;
    }
}

// ---------- The form-errand Actor ----------

export function errandResult(overrides: Partial<ErrandResult> = {}): ErrandResult {
    return {
        status: 'previewed',
        mode: 'preview',
        formUrl: 'demo',
        finalUrl: null,
        formTitle: 'Care team request',
        fillAllowed: true,
        questions: [],
        readBack: [{ label: 'Details', value: SECRET.formValue, matchedBy: 'label' }],
        readBackText: SECRET.readBack,
        previewDigest: '0123456789abcdef',
        unmatched: [],
        missingRequired: [],
        refusal: null,
        confirmationText: null,
        screenshotKey: null,
        screenshotUrl: 'https://api.apify.com/v2/key-value-stores/x/records/shot',
        timings: { loadMs: 800, fillMs: 300, submitMs: null, totalMs: 1400 },
        submittedAt: null,
        ...overrides,
    };
}

export class FakeErrands implements ErrandPort {
    readonly previews: PreviewRequest[] = [];
    readonly submits: SubmitRequest[] = [];
    /** Runs inside submit, before it answers (for example to revoke a consent while the form is sent). */
    onSubmit: (() => void) | null = null;
    previewResult: ErrandResult | Error = errandResult();
    submitResult: ErrandResult | Error = errandResult({ status: 'submitted', mode: 'submit', confirmationText: 'Request received.', submittedAt: '2026-10-24T19:00:05Z' });

    async preview(request: PreviewRequest): Promise<ErrandResult> {
        this.previews.push(structuredClone(request));
        if (this.previewResult instanceof Error) throw this.previewResult;
        return structuredClone(this.previewResult);
    }

    async submit(request: SubmitRequest): Promise<ErrandResult> {
        this.submits.push(structuredClone(request));
        this.onSubmit?.();
        if (this.submitResult instanceof Error) throw this.submitResult;
        return structuredClone(this.submitResult);
    }
}

// ---------- The Dialer ----------

export class FakeHandle implements CallHandleLike {
    readonly done: Promise<CallOutcome>;
    private resolveDone: (outcome: CallOutcome) => void = () => undefined;

    constructor(readonly requestId: string) {
        this.done = new Promise((resolve) => (this.resolveDone = resolve));
    }

    finish(outcome: Partial<CallOutcome>): void {
        this.resolveDone({
            requestId: this.requestId,
            result: 'answered',
            dialed: true,
            callId: 'cartesia-call-1',
            endReason: 'agent_hangup',
            cancelReason: null,
            refusal: null,
            optedOut: false,
            held: false,
            spoken: 'They picked up. The call has ended.',
            summary: null,
            ms: 42_000,
            ...outcome,
        });
    }
}

export class FakeDialer implements DialerPort {
    readonly prepared: CallRequest[] = [];
    readonly placed: { requestId: string; digest: string }[] = [];
    /** The CONFIRM time each place() was given, by the module's clock. */
    readonly placedConfirmedAt: number[] = [];
    readonly cancels: CancelReason[] = [];
    refusePrepare = false;
    refusePlace = false;
    handle: FakeHandle | null = null;

    prepare(request: CallRequest): { ok: true; call: PreparedCall } | { ok: false; refusal: { code: 'consent_expired'; reason: string } } {
        this.prepared.push(request);
        if (this.refusePrepare) return { ok: false, refusal: { code: 'consent_expired', reason: 'Their agreement to calls has expired, so I did not call.' } };
        return {
            ok: true,
            call: {
                requestId: request.requestId,
                contactId: request.contactId,
                recipientName: SECRET.contactName,
                readBack: `Call ${SECRET.contactName} to say your Care team request was sent.`,
                digest: 'fedcba9876543210',
                expiresAt: Date.now() + 120_000,
            },
        };
    }

    place(requestId: string, digest: string, confirmedAtMs: number): { ok: true; handle: CallHandleLike } | { ok: false; refusal: { code: 'do_not_call'; reason: string } } {
        this.placed.push({ requestId, digest });
        this.placedConfirmedAt.push(confirmedAtMs);
        if (this.refusePlace) return { ok: false, refusal: { code: 'do_not_call', reason: 'That person asked not to be called, so I did not call.' } };
        this.handle = new FakeHandle(requestId);
        return { ok: true, handle: this.handle };
    }

    cancelActive(reason: CancelReason): void {
        this.cancels.push(reason);
    }
}

export function snapshot(requestId: string, phase: CallSnapshot['phase'], transcript: CallSnapshot['transcript'] = []): CallSnapshot {
    return { requestId, phase, status: null, cancelPending: false, callId: 'cartesia-call-1', transcript };
}

// ---------- Forms and contacts ----------

export const DEMO_FORM: AllowedForm = {
    formKey: 'care_team_request',
    formUrl: 'demo',
    formTitle: 'Care team request',
    fields: [
        { label: 'Who is this from?', fixedValue: 'Alex' },
        { label: 'What do you need?', choices: ['Ride', 'Meal or drink', 'Company', 'Something else'], required: true },
        { label: 'Details' },
        { label: 'When?' },
        { label: 'How urgent?', choices: ['Now', 'Today', 'This week'] },
    ],
};

export const LEON: CallContact = { contactId: 'leon', name: SECRET.contactName };

// ---------- The whole sidecar over MemoryDb ----------

export interface Harness {
    db: MemoryDb;
    api: FakeApi;
    planner: ClaudePlanner;
    search: FakeSearch;
    memory: FakeMemory;
    web: FakeWebIndex;
    errands: FakeErrands;
    dialer: FakeDialer;
    log: RecordingLogger;
    trace: Trace;
    deps: JobDeps;
    orchestrator: Orchestrator;
    errandRunner: ErrandRunner;
    callRunner: CallRunner;
}

export interface HarnessOptions {
    search?: boolean;
    memory?: boolean;
    errands?: boolean;
    dialer?: boolean;
    placesNear?: boolean;
    forms?: AllowedForm[];
    contacts?: CallContact[];
    searchTimeoutMs?: number;
    memoryShareable?: boolean;
    now?: () => number;
    /** Monotonic clock for durations and the call freshness window. Default performance.now. */
    clock?: () => number;
    /** How long an aborted job may take to stop before its slot is released. Default 5 s. */
    abortGraceMs?: number;
    /** The module's job lease (MemoryDb leaseMs); off by default. */
    leaseMs?: number;
    /** How often an open step renews the lease. Default LEASE_HEARTBEAT_MS. */
    leaseHeartbeatMs?: number;
    /** The call dial deadline after the CONFIRM, and the allowed clock difference (CallRunner). */
    confirmToDialMs?: number;
    clockSkewMs?: number;
    /** The yes or no fast path (JobDeps.yesNoFast). Off by default here, so the older tests keep the planner path. */
    yesNoFast?: boolean;
    /** Draft first (JobDeps.draftFirst). Off by default here, like the fast path. */
    draftFirst?: boolean;
    /** The judge try sandbox's admission check (src/sandbox.ts); none by default. */
    admit?: OrchestratorOptions['admit'];
    /** Run as the judge try sandbox (AGENT_TRY): the errand runner keeps no past request. Off by default. */
    sandbox?: boolean;
    /** Direct select (JobDeps.direct). Off by default here, so the older tests keep the scan path. */
    direct?: boolean;
    /** Search prefetch (JobDeps.prefetch). Off by default here, so the older direct select tests count only their own searches. */
    prefetch?: boolean;
    /** PLAN D25, the care team email after a sent form (src/email.ts). Off by default. */
    email?: ErrandEmailDeps;
}

export function harness(options: HarnessOptions = {}): Harness {
    const trace = new Trace();
    const db = new MemoryDb({ leaseMs: options.leaseMs });
    const api = new FakeApi(trace);
    const log = recordingLogger();
    const planner = new ClaudePlanner({ api, retryDelayMs: 1, sleep: async () => undefined, log });
    const search = new FakeSearch(trace);
    const memory = new FakeMemory(trace);
    const web = new FakeWebIndex(trace);
    const errands = new FakeErrands();
    const dialer = new FakeDialer();
    const previews = new PreviewBook();
    const sent = new SentBook();
    const clock = options.clock ?? (() => performance.now());
    let requests = 0;
    const memoryWatch = new MemoryWatch(db);
    const deps: JobDeps = {
        db,
        planner,
        retrieval: {
            classify: classifyQuestion,
            search: options.search === false ? null : search,
            memory: options.memory === false ? null : memory,
            web: options.memory === false ? null : web,
            placesNear: options.placesNear ? { lat: 37.87, lng: -122.27 } : null,
            searchTimeoutMs: options.searchTimeoutMs ?? 5_000,
            log,
        },
        errands: options.errands === false ? null : errands,
        dialer: options.dialer === false ? null : dialer,
        forms: options.forms ?? [],
        contacts: options.contacts ?? [],
        previews,
        sent,
        conversation: new ConversationLog(),
        log,
        timeZone: 'America/Los_Angeles',
        maxOptions: 4,
        memoryShareable: options.memoryShareable ?? false,
        memoryWatch,
        now: options.now ?? Date.now,
        clock,
        requestId: () => `call-test-${++requests}`,
        leaseHeartbeatMs: options.leaseHeartbeatMs,
        yesNoFast: options.yesNoFast,
        draftFirst: options.draftFirst,
        direct: options.direct,
        prefetch: options.prefetch,
        ...(options.email ? { email: options.email } : {}),
    };
    // Short retry waits so the tests of claims that never reached the module run fast.
    const callRunner = new CallRunner({
        db,
        dialer: deps.dialer,
        log,
        clock,
        now: deps.now,
        retryMs: 5,
        ...(options.confirmToDialMs !== undefined ? { confirmToDialMs: options.confirmToDialMs } : {}),
        ...(options.clockSkewMs !== undefined ? { clockSkewMs: options.clockSkewMs } : {}),
    });
    const errandRunner = new ErrandRunner({
        db,
        errands: deps.errands,
        previews,
        sent,
        now: deps.now,
        log,
        clock,
        retryMs: 5,
        pastRequests: { memory: deps.retrieval.memory, forms: deps.forms, timeZone: deps.timeZone, now: deps.now, sandbox: options.sandbox ?? false, watch: memoryWatch },
        ...(options.email ? { email: options.email } : {}),
    });
    const orchestrator = new Orchestrator(
        deps,
        { errands: errandRunner, calls: callRunner },
        { maxJobs: 3, abortGraceMs: options.abortGraceMs ?? 5_000, ...(options.admit ? { admit: options.admit } : {}) },
    );
    return { db, api, planner, search, memory, web, errands, dialer, log, trace, deps, orchestrator, errandRunner, callRunner };
}

/** Polls until `check` is true. Fails the test after `timeoutMs`. */
export async function waitFor(check: () => boolean, timeoutMs = 3_000, what = 'condition'): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error(`waitFor timed out: ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

/** Lets queued microtasks and short timers run. */
export const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
