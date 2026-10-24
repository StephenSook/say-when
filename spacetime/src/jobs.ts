// The agent sidecar's work queue (docs/spacetime.md 2.9, 3.6, 4.5): jobs, leases and the attempt fence.
// Option jobs and previews are read-only and safe to rerun; a form submit is never a job (see consent.ts).
import { Identity } from 'spacetimedb';
import { SenderError } from 'spacetimedb/server';
import { getConfig } from './config';
import { requireRole } from './auth';
import type { Ctx } from './ctx';
import type { AgentJob, JobKind } from './schema';
import { appendLedger, isAfter, onceAt, plusMs } from './util';

export interface NewJob {
  sessionId: bigint;
  questionId: bigint;
  errandId?: bigint;
  webSearchAllowed?: boolean;
  memoryAllowed?: boolean;
}

export function createJob(ctx: Ctx, kind: JobKind['tag'], job: NewJob): AgentJob {
  const row = ctx.db.agentJob.insert({
    id: 0n,
    kind: { tag: kind },
    status: { tag: 'Pending' },
    questionId: job.questionId,
    errandId: job.errandId ?? 0n,
    attempt: 0,
    claimedBy: Identity.zero(),
    leaseExpiresAt: undefined,
    webSearchAllowed: job.webSearchAllowed ?? false,
    memoryAllowed: job.memoryAllowed ?? false,
    reason: '',
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  });
  return row;
}

function deleteLeases(ctx: Ctx, jobId: bigint): void {
  for (const lease of [...ctx.db.jobLease.jobId.filter(jobId)]) {
    ctx.db.jobLease.scheduledId.delete(lease.scheduledId);
  }
}

/** Ends a job (Done, Failed or Cancelled) and drops its lease rows. */
export function endJob(ctx: Ctx, job: AgentJob, status: 'Done' | 'Failed' | 'Cancelled', reason = ''): AgentJob {
  deleteLeases(ctx, job.id);
  const next: AgentJob = {
    ...job,
    status: { tag: status },
    leaseExpiresAt: undefined,
    reason,
    updatedAt: ctx.timestamp,
  };
  ctx.db.agentJob.id.update(next);
  return next;
}

/** Cancels every Pending or Claimed job for a question, optionally only one errand's or one kind's. */
export function cancelJobs(
  ctx: Ctx,
  questionId: bigint,
  reason: string,
  only: { errandId?: bigint; kind?: JobKind['tag'] } = {},
): void {
  for (const job of [...ctx.db.agentJob.jobByQuestion.filter(questionId)]) {
    if (only.errandId !== undefined && job.errandId !== only.errandId) continue;
    if (only.kind !== undefined && job.kind.tag !== only.kind) continue;
    if (job.status.tag === 'Pending' || job.status.tag === 'Claimed') endJob(ctx, job, 'Cancelled', reason);
  }
}

/** Claims a Pending job: attempt + 1, a lease, a `job_lease` row. Anything but Pending is someone else's. */
export function claimJob(ctx: Ctx, jobId: bigint, sessionId: bigint): AgentJob {
  const job = ctx.db.agentJob.id.find(jobId);
  if (!job || job.status.tag !== 'Pending') throw new SenderError('not pending');
  const cfg = getConfig(ctx.db);
  const attempt = job.attempt + 1;
  const ends = plusMs(ctx.timestamp, cfg.jobLeaseMs);
  const next: AgentJob = {
    ...job,
    status: { tag: 'Claimed' },
    attempt,
    claimedBy: ctx.sender,
    leaseExpiresAt: ends,
    updatedAt: ctx.timestamp,
  };
  ctx.db.agentJob.id.update(next);
  ctx.db.jobLease.insert({ scheduledId: 0n, scheduledAt: onceAt(ends), jobId, attempt });
  appendLedger(ctx, sessionId, 'job_claimed', 'Agent', { jobId, questionId: job.questionId, errandId: job.errandId, outcome: `attempt:${attempt}` });
  return next;
}

/**
 * Every `(job_id, attempt)` write is fenced: the caller is an Agent, the job is Claimed, the attempt matches, the
 * caller holds it, and the lease has not run out. A lapsed lease counts as lost even before `lease_expired` runs,
 * so a late write can neither land nor renew the lease; the sidecar drops its work and the job is requeued.
 */
export function requireFencedJob(ctx: Ctx, jobId: bigint, attempt: number): AgentJob {
  requireRole(ctx, 'Agent');
  const job = ctx.db.agentJob.id.find(jobId);
  if (!job || job.status.tag !== 'Claimed' || job.attempt !== attempt || !job.claimedBy.isEqual(ctx.sender)) {
    throw new SenderError('stale attempt');
  }
  if (!job.leaseExpiresAt || !isAfter(job.leaseExpiresAt, ctx.timestamp)) throw new SenderError('stale attempt');
  return job;
}

/** Pushes a Claimed job's lease forward: delete and insert the `job_lease` row (never update in place). */
export function extendLease(ctx: Ctx, job: AgentJob): AgentJob {
  const cfg = getConfig(ctx.db);
  deleteLeases(ctx, job.id);
  const ends = plusMs(ctx.timestamp, cfg.jobLeaseMs);
  const next: AgentJob = { ...job, leaseExpiresAt: ends, updatedAt: ctx.timestamp };
  ctx.db.agentJob.id.update(next);
  ctx.db.jobLease.insert({ scheduledId: 0n, scheduledAt: onceAt(ends), jobId: job.id, attempt: job.attempt });
  return next;
}

/** Back to Pending after a lapsed lease; the next claim gets attempt + 1. */
export function requeueJob(ctx: Ctx, job: AgentJob): AgentJob {
  deleteLeases(ctx, job.id);
  const next: AgentJob = {
    ...job,
    status: { tag: 'Pending' },
    claimedBy: Identity.zero(),
    leaseExpiresAt: undefined,
    updatedAt: ctx.timestamp,
  };
  ctx.db.agentJob.id.update(next);
  return next;
}
