// Pipeline events for one job, written through `agent_progress` (docs/spacetime.md 3.6). The public
// `pipeline_event` row gets only a short label from a fixed vocabulary, a duration and numbers; the content goes
// to the private `pipeline_payload` (shown on the board only while the room shares text). Every write is fenced
// by (job_id, attempt), so a `stale attempt` refusal means another attempt owns the job: StaleAttemptError stops
// the work. Any other failed event write is logged and skipped, because telemetry must never stop a reply.
//
// Each `agent_progress` also renews the job lease (spacetime/src/agent.ts: the lease is extended even when the
// event key already exists). A step that waits on something slow (a planner retry, a search, a form preview)
// therefore re-sends its own `started` event every LEASE_HEARTBEAT_MS while it is open: no new public row, and the
// lease cannot lapse under work that is still going.

import { DETAIL_PATTERN, LIMITS } from './contract.js';
import type { AgentDb } from './db/db.js';
import { callReducer } from './db/retry.js';
import type { Logger } from './log.js';
import type { Stage } from './types.js';

/**
 * The stages the sidecar reports. Listen, speak and select belong to the module and the station: the module writes
 * one speak step per read under its own keys (`s<session>:read:<step>`, module v2), so the sidecar writes no speak
 * event at all. Its keys start with the job id, never with a prefix the module writes under (MODULE_EVENT_KEY).
 */
export type SidecarStage = Extract<Stage, 'search' | 'retrieve' | 'plan' | 'errand'>;

export interface JobRef {
    jobId: bigint;
    attempt: number;
}

/** The module refused a write because another attempt owns the job now. Drop the work. */
export class StaleAttemptError extends Error {
    constructor(readonly reducer: string) {
        super('stale attempt');
        this.name = 'StaleAttemptError';
    }
}

export type Counts = Record<string, number | boolean | undefined>;

/** How often an open step renews the job lease. Well under the module's default 45 s `job_lease_ms`. */
export const LEASE_HEARTBEAT_MS = 10_000;

/** A label for the public row: lowercase letters, digits, spaces, colons, underscores and dashes, 1 to 120 characters. */
export function label(...parts: (string | number)[]): string {
    const text = parts
        .map(String)
        .join(' ')
        .toLowerCase()
        .replace(/[^a-z0-9 :_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120)
        .trim();
    return DETAIL_PATTERN.test(text) ? text : 'step';
}

const COUNT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** `counts_json`: numbers and booleans only. Anything else is dropped here rather than refused by the module. */
export function countsJson(counts: Counts | undefined): string {
    const clean: Record<string, number | boolean> = {};
    for (const [key, value] of Object.entries(counts ?? {})) {
        if (!COUNT_KEY.test(key)) continue;
        if (typeof value === 'boolean') clean[key] = value;
        else if (typeof value === 'number' && Number.isFinite(value)) clean[key] = Math.round(value * 1000) / 1000;
    }
    const json = JSON.stringify(clean);
    return json.length <= LIMITS.countsJsonChars ? json : '{}';
}

/**
 * `payload_json` under the module's 16 KB limit. `listKey` names the array to shorten from the end when the payload
 * is too big (search rows, Moss hits). Returns '' when nothing fits.
 */
export function payloadJson(payload: Record<string, unknown> | undefined, listKey?: string): { json: string; dropped: number } {
    if (!payload) return { json: '', dropped: 0 };
    const copy: Record<string, unknown> = { ...payload };
    let dropped = 0;
    const list = listKey && Array.isArray(copy[listKey]) ? [...(copy[listKey] as unknown[])] : null;
    if (list && listKey) copy[listKey] = list;
    for (;;) {
        const json = JSON.stringify(copy);
        if (Buffer.byteLength(json, 'utf8') <= LIMITS.payloadBytes) return { json, dropped };
        if (!list || list.length === 0) return { json: '', dropped };
        list.pop();
        dropped += 1;
    }
}

/** Whole, non-negative milliseconds for a u32 column. */
export function wholeMs(ms: number): number {
    if (!Number.isFinite(ms) || ms <= 0) return 0;
    return Math.min(4_294_967_295, Math.round(ms));
}

export interface StepEnd {
    counts?: Counts;
    payload?: Record<string, unknown>;
    /** The array in `payload` that may be shortened to fit. */
    listKey?: string;
}

/** One timed step: `started` when it begins, then `ok` or `error` once, with the time it took. */
export class Step {
    private finished = false;
    private heartbeat: ReturnType<typeof setInterval> | null = null;

    constructor(
        private readonly events: JobEvents,
        readonly stage: SidecarStage,
        readonly seq: number,
        readonly startedAt: number,
        private readonly startLabel: string,
    ) {}

    elapsedMs(): number {
        return wholeMs(this.events.now() - this.startedAt);
    }

    ok(detail?: string, end: StepEnd = {}): Promise<void> {
        return this.finish('ok', detail ?? this.startLabel, end);
    }

    error(detail: string, end: StepEnd = {}): Promise<void> {
        return this.finish('error', detail, end);
    }

    /** @internal Renews the job lease every `intervalMs` until the step ends or `renew` says the job is gone. */
    keepLease(intervalMs: number, renew: () => Promise<boolean>): void {
        let busy = false;
        this.heartbeat = setInterval(() => {
            if (busy || this.finished) return;
            busy = true;
            void renew().then((keep) => {
                busy = false;
                if (!keep) this.stopLease();
            });
        }, intervalMs);
        this.heartbeat.unref?.();
    }

    /** @internal */
    stopLease(): void {
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = null;
    }

    private finish(status: 'ok' | 'error', detail: string, end: StepEnd): Promise<void> {
        if (this.finished) return Promise.resolve();
        this.finished = true;
        this.stopLease();
        return this.events.write(this.stage, status, this.seq, detail, this.elapsedMs(), end);
    }
}

export interface JobEventsOptions {
    /** Lease renewal for open steps; 0 turns it off. Default LEASE_HEARTBEAT_MS. */
    heartbeatMs?: number;
    /** The job's signal: once it fires the job is over, and no step renews the lease again. */
    signal?: AbortSignal;
}

export class JobEvents {
    private seq = 0;
    private closed = false;
    private readonly open = new Set<Step>();
    private readonly heartbeatMs: number;

    constructor(
        private readonly db: AgentDb,
        readonly job: JobRef,
        private readonly log: Logger,
        readonly now: () => number = () => performance.now(),
        options: JobEventsOptions = {},
    ) {
        this.heartbeatMs = options.heartbeatMs ?? LEASE_HEARTBEAT_MS;
        options.signal?.addEventListener('abort', () => this.close(), { once: true });
    }

    /** Writes `started` and returns the step to finish. While it is open, the step keeps the job lease. */
    async begin(stage: SidecarStage, detail: string): Promise<Step> {
        const seq = ++this.seq;
        const step = new Step(this, stage, seq, this.now(), label(detail));
        await this.write(stage, 'started', seq, detail, 0, {});
        if (this.heartbeatMs > 0 && !this.closed) {
            this.open.add(step);
            step.keepLease(this.heartbeatMs, () => this.renew(stage, seq, detail));
        }
        return step;
    }

    /** Stops every lease renewal. Called when the job ends, whatever ended it. */
    close(): void {
        this.closed = true;
        for (const step of this.open) step.stopLease();
        this.open.clear();
    }

    /**
     * Sends a step's `started` event again. The module keeps the event it has and renews the lease. False once the
     * job is no longer this attempt's, so the renewals stop.
     */
    private async renew(stage: SidecarStage, seq: number, detail: string): Promise<boolean> {
        if (this.closed) return false;
        const outcome = await callReducer(this.db, 'agentProgress', this.progressArgs(stage, 'started', seq, detail, 0, '{}', ''), {
            onUnknown: 'repeat',
            attempts: 1,
            readyTimeoutMs: 1_000,
        });
        if (outcome.ok) return true;
        return outcome.kind !== 'stale' && outcome.kind !== 'refused';
    }

    private progressArgs(stage: SidecarStage, status: 'started' | 'ok' | 'error', seq: number, detail: string, ms: number, counts: string, payload: string) {
        return {
            jobId: this.job.jobId,
            attempt: this.job.attempt,
            eventKey: `${this.job.jobId}:${this.job.attempt}:${seq}:${stage}:${status}`,
            stage,
            status,
            detail: label(detail),
            ms: status === 'started' ? 0 : wholeMs(ms),
            countsJson: counts,
            payloadJson: payload,
        };
    }

    /** A step with no running phase, for example a search that was skipped. */
    async instant(stage: SidecarStage, status: 'ok' | 'error', detail: string, ms: number, end: StepEnd = {}): Promise<void> {
        const seq = ++this.seq;
        await this.write(stage, status, seq, detail, wholeMs(ms), end);
    }

    /** @internal Used by Step. */
    async write(stage: SidecarStage, status: 'started' | 'ok' | 'error', seq: number, detail: string, ms: number, end: StepEnd): Promise<void> {
        const { json, dropped } = payloadJson(end.payload, end.listKey);
        const counts = dropped > 0 ? { ...end.counts, payloadTrimmed: true } : end.counts;
        const outcome = await callReducer(
            this.db,
            'agentProgress',
            this.progressArgs(stage, status, seq, detail, ms, countsJson(counts), json),
            // Idempotent on event_key: a lost reply is answered by sending the same event again.
            { onUnknown: 'repeat' },
        );
        if (outcome.ok) return;
        if (outcome.kind === 'stale') throw new StaleAttemptError('agent_progress');
        this.log.warn('a pipeline event was not written', { job: this.job.jobId, stage, status, why: outcome.kind });
    }
}
