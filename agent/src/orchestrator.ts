// The sidecar's loop (docs/spacetime.md 7.4). It reacts to the three agent views:
// - `agent_queue`: claims Pending jobs (`agent_claim`; the attempt is the Pending row's attempt + 1) and runs them.
//   A job that leaves the view while it runs (cancelled, superseded, or requeued after a lapsed lease) is
//   aborted, and anything it still tries to write is refused as a stale attempt.
// - `errand_queue`: hands Confirmed errands to the ErrandRunner.
// - `call_queue`: hands Confirmed calls and cancel requests to the CallRunner.
// - `agent_consent` (module v2): whenever it shows memory consent off, the kept conversation is forgotten, with or
//   without a job running, and also when a revocation is followed at once by a new grant (onMemoryOff). A lost
//   connection or a fresh load of the views forgets it too, since a revocation during the gap may leave no trace.
// Failures are reported with `agent_fail` and a sentence for the person; the job never hangs.

import { CallRunner } from './calls.js';
import type { AgentDb } from './db/db.js';
import { callReducer, type Verified } from './db/retry.js';
import { ErrandRunner } from './errands.js';
import { JobInputError, PublishRefusedError, runOptionsJob, runPreviewJob, runRememberJob, type JobDeps } from './jobs.js';
import type { Logger } from './log.js';
import { StaleAttemptError } from './pipeline.js';
import { PlannerError } from './planner/types.js';
import { JobAbortedError } from './retrieval.js';
import type { Admission } from './sandbox.js';
import type { AgentQueueRow, JobKind } from './types.js';

export interface OrchestratorOptions {
    /** Jobs run at once. Default 3. */
    maxJobs?: number;
    /** How long an aborted job may take to stop before its slot is released. Default 5 s. */
    abortGraceMs?: number;
    /**
     * The judge try sandbox's caps (src/sandbox.ts): asked once per claimed job, before it runs. A refused job is
     * failed with the code and sentence it gives, and nothing is spent on it. Absent: every job runs.
     */
    admit?: (row: AgentQueueRow) => Admission;
}

interface Running {
    jobId: bigint;
    kind: JobKind;
    /** The attempt this sidecar holds (or is claiming). */
    attempt: number;
    abort: AbortController;
    /** Set once the view showed the job Claimed by this sidecar at `attempt`. */
    seenClaimed: boolean;
    claiming: boolean;
    /** The job's promise, so a job that will not stop can be let go of. */
    work: Promise<void> | null;
}

const FAIL_SAY = {
    planner: 'I could not write options. Please ask again.',
    agent: 'Something went wrong on my side. Please ask again.',
} as const;

/** The reason code and sentence for agent_fail. Codes are at most 40 characters. */
export function failureOf(error: unknown): { reasonCode: string; reason: string } {
    if (error instanceof PlannerError) return { reasonCode: `planner_${error.code}`.slice(0, 40), reason: FAIL_SAY.planner };
    if (error instanceof PublishRefusedError) return { reasonCode: `publish_${error.why}`.slice(0, 40), reason: FAIL_SAY.agent };
    if (error instanceof JobInputError) return { reasonCode: error.code.slice(0, 40), reason: FAIL_SAY.agent };
    return { reasonCode: 'agent_error', reason: FAIL_SAY.agent };
}

/** Which Pending job to claim first: previews (a person is waiting on a read-back), then the newest questions. */
function priority(a: AgentQueueRow, b: AgentQueueRow): number {
    const rank = (row: AgentQueueRow) => (row.kind === 'errand_preview' ? 0 : row.kind === 'options' ? 1 : 2);
    return rank(a) - rank(b) || (a.kind === 'options' ? b.createdAtMs - a.createdAtMs : a.createdAtMs - b.createdAtMs);
}

export class Orchestrator {
    readonly errands: ErrandRunner;
    readonly calls: CallRunner;
    private readonly running = new Map<string, Running>();
    private readonly work = new Set<Promise<void>>();
    private readonly maxJobs: number;
    private readonly abortGraceMs: number;
    private readonly admit: ((row: AgentQueueRow) => Admission) | null;
    private stopping = false;
    private ticking = false;
    private again = false;
    private unsubscribe: (() => void) | null = null;
    private watchingConsent = false;
    /** The view load (`syncCount`) the last look saw, or null before the first look. */
    private sync: number | null = null;

    constructor(
        private readonly deps: JobDeps,
        runners: { errands: ErrandRunner; calls: CallRunner },
        options: OrchestratorOptions = {},
    ) {
        this.errands = runners.errands;
        this.calls = runners.calls;
        this.maxJobs = Math.max(1, options.maxJobs ?? 3);
        this.abortGraceMs = Math.max(0, options.abortGraceMs ?? 5_000);
        this.admit = options.admit ?? null;
        // A runner whose claim never reached the module asks for another look at the views.
        this.errands.setWake(() => this.tick());
        this.calls.setWake(() => this.tick());
    }

    start(): void {
        // A memory revocation forgets the kept conversation at once, even one followed by a new grant before the
        // next look at the views. Never removed (stop() included): forgetting is always safe.
        if (!this.watchingConsent) {
            this.watchingConsent = true;
            this.deps.db.onMemoryOff(() => this.deps.conversation.clear());
        }
        this.unsubscribe = this.deps.db.onChange(() => this.tick());
        this.tick();
    }

    /** Jobs being worked on now. */
    get busy(): number {
        return this.running.size;
    }

    /** Resolves when no job is running. For tests and shutdown. */
    async idle(timeoutMs = 10_000): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (this.work.size > 0) {
            if (Date.now() > deadline) return false;
            await Promise.race([Promise.allSettled([...this.work]), new Promise((resolve) => setTimeout(resolve, 50))]);
        }
        return true;
    }

    /**
     * Stops claiming, aborts option and remember jobs (safe to rerun; their lease requeues them), lets previews,
     * submits and calls finish within the time given, and hangs up a live call if it is still going.
     */
    async stop(timeoutMs = 20_000): Promise<void> {
        this.stopping = true;
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.errands.stop();
        this.calls.stop();
        for (const job of this.running.values()) if (job.kind !== 'errand_preview') job.abort.abort();
        await this.idle(timeoutMs / 2);
        await this.errands.drain(timeoutMs / 2);
        this.calls.hangUpAll('operator');
        await this.calls.drain(5_000);
    }

    private tick(): void {
        if (this.stopping) return;
        if (this.ticking) {
            this.again = true;
            return;
        }
        this.ticking = true;
        try {
            do {
                this.again = false;
                this.step();
            } while (this.again && !this.stopping);
        } finally {
            this.ticking = false;
        }
    }

    private step(): void {
        const { db, log } = this.deps;
        let jobs: readonly AgentQueueRow[] = [];
        try {
            // The module's consent, read on every look: memory off, or no readable consent while the views are
            // current, means nothing the person said is kept. So does a fresh load of the views (a reconnect): a
            // revocation during the gap may have been given again before it, leaving nothing in agent_consent.
            const sync = db.syncCount();
            const reloaded = this.sync !== null && sync !== this.sync;
            this.sync = sync;
            if (reloaded || (db.isCurrent() && db.agentConsent()?.memoryAllowed !== true)) this.deps.conversation.clear();
            jobs = db.agentQueue();
            this.errands.reconcile(db.errandQueue());
            this.calls.reconcile(db.callQueue());
        } catch (error) {
            log.error('could not read the agent views', { why: error instanceof Error ? error.name : 'error' });
            return;
        }

        // Jobs that are no longer this sidecar's: abort them.
        for (const job of this.running.values()) {
            if (job.claiming) continue;
            const row = jobs.find((r) => r.jobId === job.jobId);
            const mine = !!row && row.status === 'claimed' && row.claimedByMe && row.attempt === job.attempt;
            if (mine) job.seenClaimed = true;
            else if (job.seenClaimed && !job.abort.signal.aborted) {
                log.info('a job left this sidecar; stopping its work', { job: job.jobId });
                job.abort.abort();
                this.releaseLater(job);
            }
        }

        // Claim Pending jobs while there is room.
        const pending = jobs.filter((r) => r.status === 'pending' && !this.running.has(r.jobId.toString())).sort(priority);
        for (const row of pending) {
            if (this.running.size >= this.maxJobs) break;
            this.launch(row);
        }
    }

    private launch(row: AgentQueueRow): void {
        const key = row.jobId.toString();
        const job: Running = { jobId: row.jobId, kind: row.kind, attempt: row.attempt + 1, abort: new AbortController(), seenClaimed: false, claiming: true, work: null };
        this.running.set(key, job);
        const work = this.claimAndRun(row, job).finally(() => {
            // A job released after it would not stop may have been claimed again since: leave the new entry alone.
            if (this.running.get(key) === job) this.running.delete(key);
            this.work.delete(work);
            this.tick();
        });
        job.work = work;
        this.work.add(work);
    }

    /**
     * An aborted job normally stops at its next await. One stuck in a call that ignores the signal would hold its
     * slot and keep this sidecar from claiming the job again, so after a grace period its slot is released; anything
     * it still writes is refused as a stale attempt.
     */
    private releaseLater(job: Running): void {
        const key = job.jobId.toString();
        const timer = setTimeout(() => {
            if (this.running.get(key) !== job) return;
            this.deps.log.warn('a job did not stop after it was aborted; releasing its slot', { job: job.jobId });
            this.running.delete(key);
            if (job.work) this.work.delete(job.work);
            this.tick();
        }, this.abortGraceMs);
        timer.unref?.();
    }

    private async claimAndRun(row: AgentQueueRow, job: Running): Promise<void> {
        const { db, log } = this.deps;
        const verify = (): Verified => {
            const now = db.agentQueue().find((r) => r.jobId === row.jobId);
            // Claimed by this sidecar at any attempt past the Pending row's: this claim landed, perhaps at a later
            // attempt than computed (see below). One sidecar runs per identity, and this job was not running here.
            if (now && now.status === 'claimed' && now.claimedByMe && now.attempt > row.attempt) return 'applied';
            if (now && now.status === 'pending' && now.attempt === row.attempt) return 'not_applied';
            return 'unclear';
        };
        const claim = await callReducer(db, 'agentClaim', { jobId: row.jobId }, { onUnknown: 'verify', verify });
        if (claim.ok) {
            // The attempt is the Pending row's attempt + 1, unless another claim and a lapsed lease happened between
            // reading that row and this claim arriving. When the view already shows the claim, its attempt wins.
            const owned = db.agentQueue().find((r) => r.jobId === row.jobId && r.status === 'claimed' && r.claimedByMe);
            if (owned && owned.attempt > job.attempt) {
                log.info('the claim landed at a later attempt than expected', { job: row.jobId, expected: job.attempt, attempt: owned.attempt });
                job.attempt = owned.attempt;
            }
            // The claim itself shows the job was this sidecar's (its reply comes with the view update), so a job
            // cancelled before any later look is still aborted, instead of running on with every write refused.
            job.seenClaimed = true;
        }
        job.claiming = false;
        if (!claim.ok) {
            if (claim.kind === 'refused') log.info('a job was taken by another agent', { job: row.jobId });
            else log.warn('a job could not be claimed', { job: row.jobId, why: claim.kind });
            return;
        }
        if (this.stopping && row.kind !== 'errand_preview') job.abort.abort();
        log.info('job claimed', { job: row.jobId, kind: row.kind, attempt: job.attempt });
        const admission = this.admit?.(row);
        if (admission && !admission.ok) {
            // Past a sandbox cap: nothing is spent, and the module shows the code on the board.
            log.info('job refused by the try caps', { job: row.jobId, why: admission.why });
            const outcome = await callReducer(
                db,
                'agentFail',
                { jobId: row.jobId, attempt: job.attempt, reasonCode: admission.reasonCode, reason: admission.reason },
                { onUnknown: 'repeat' },
            );
            if (!outcome.ok && outcome.kind !== 'stale') log.error('agent_fail was not recorded; the lease will requeue the job', { job: row.jobId, why: outcome.kind });
            return;
        }
        try {
            switch (row.kind) {
                case 'options':
                    await runOptionsJob(row, job.attempt, this.deps, job.abort.signal);
                    break;
                case 'errand_preview':
                    await runPreviewJob(row, job.attempt, this.deps, job.abort.signal);
                    break;
                case 'remember':
                    await runRememberJob(row, job.attempt, this.deps, job.abort.signal);
                    break;
            }
        } catch (error) {
            if (error instanceof StaleAttemptError || error instanceof JobAbortedError || job.abort.signal.aborted) {
                log.info('job dropped: it belongs to another attempt now', { job: row.jobId });
                return;
            }
            const failure = failureOf(error);
            log.warn('job failed', { job: row.jobId, kind: row.kind, code: failure.reasonCode });
            const outcome = await callReducer(db, 'agentFail', { jobId: row.jobId, attempt: job.attempt, ...failure }, { onUnknown: 'repeat' });
            if (!outcome.ok && outcome.kind !== 'stale') log.error('agent_fail was not recorded; the lease will requeue the job', { job: row.jobId, why: outcome.kind });
        }
    }
}
