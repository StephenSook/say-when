// `ensure_timers` (docs/spacetime.md 3.2): after a republish, re-arm any schedule row that should exist and does
// not. Idempotent: it only inserts where a row is missing. Overdue deadlines are armed for now, so a lapsed lease
// still lapses (fail closed) instead of getting a fresh lease.
import type { Timestamp } from 'spacetimedb';
import { activeSession } from './auth';
import { getConfig } from './config';
import type { Ctx } from './ctx';
import { armCallTimer, armErrandTimer, CALL_CLAIM_MS } from './consent';
import { isAfter, onceAt, plusMs } from './util';

function notBefore(ctx: Ctx, ts: Timestamp): Timestamp {
  return isAfter(ts, ctx.timestamp) ? ts : ctx.timestamp;
}

export function ensureTimers(ctx: Ctx): string[] {
  const cfg = getConfig(ctx.db);
  const repaired: string[] = [];
  const session = activeSession(ctx.db);
  if (session) {
    const s = ctx.db.scanState.sessionId.find(session.id);
    const timers = [...ctx.db.scanTimer.sessionId.filter(session.id)];
    if (s && !timers.some((r) => r.stepSeq === s.stepSeq)) {
      const kind = s.phase.tag === 'Reading' || s.phase.tag === 'Window' ? 'StepEnd' : s.phase.tag === 'Veto' ? 'VetoEnd' : s.phase.tag === 'Preparing' ? 'ClipDeadline' : undefined;
      if (kind) {
        ctx.db.scanTimer.insert({ scheduledId: 0n, scheduledAt: onceAt(notBefore(ctx, s.stepEndsAt)), sessionId: session.id, stepSeq: s.stepSeq, kind: { tag: kind } });
        repaired.push('scan_timer');
      }
    }
    if ([...ctx.db.livenessLease.sessionId.filter(session.id)].length === 0) {
      ctx.db.livenessLease.insert({
        scheduledId: 0n,
        scheduledAt: onceAt(plusMs(ctx.timestamp, cfg.livenessLeaseMs)),
        sessionId: session.id,
        beatSeq: 0n,
        lastBeatAt: ctx.timestamp,
        decoderHealthy: false,
        healthySince: undefined,
      });
      repaired.push('liveness_lease');
    }
    if (s && s.phase.tag !== 'Paused' && ![...ctx.db.idleTimer.sessionId.filter(session.id)].some((r) => r.idleSeq === session.idleSeq)) {
      ctx.db.idleTimer.insert({
        scheduledId: 0n,
        scheduledAt: onceAt(notBefore(ctx, plusMs(session.lastCommandAt, cfg.idlePauseMs))),
        sessionId: session.id,
        idleSeq: session.idleSeq,
      });
      repaired.push('idle_timer');
    }
  }
  for (const job of [...ctx.db.agentJob.jobByStatus.filter({ tag: 'Claimed' })]) {
    if ([...ctx.db.jobLease.jobId.filter(job.id)].some((r) => r.attempt === job.attempt)) continue;
    ctx.db.jobLease.insert({ scheduledId: 0n, scheduledAt: onceAt(notBefore(ctx, job.leaseExpiresAt ?? ctx.timestamp)), jobId: job.id, attempt: job.attempt });
    repaired.push(`job_lease:${job.id}`);
  }
  const errandKinds = {
    Drafted: 'Preview',
    Previewed: 'Readback',
    AwaitingConfirm: 'ConfirmWindow',
    Submitting: 'Submit',
  } as const;
  for (const [status, kind] of Object.entries(errandKinds) as [keyof typeof errandKinds, (typeof errandKinds)[keyof typeof errandKinds]][]) {
    for (const e of [...ctx.db.errand.errandByStatus.filter({ tag: status })]) {
      if ([...ctx.db.errandLease.errandId.filter(e.id)].some((r) => r.kind.tag === kind)) continue;
      const when =
        kind === 'Preview'
          ? plusMs(e.createdAt, cfg.previewTimeoutMs)
          : kind === 'Readback'
            ? plusMs(e.previewedAt ?? e.updatedAt, cfg.readbackDeadlineMs)
            : kind === 'ConfirmWindow'
              ? (e.confirmClosesAt ?? ctx.timestamp)
              : plusMs(e.claimedAt ?? e.updatedAt, cfg.submitLeaseMs);
      const seq = kind === 'Preview' ? 0 : kind === 'Submit' ? e.claimAttempt : e.windowSeq;
      armErrandTimer(ctx, e.id, kind, seq, notBefore(ctx, when));
      repaired.push(`errand_lease:${e.id}`);
    }
  }
  // A Confirmed call's ConfirmWindow row guards its claim (module v2): CALL_CLAIM_MS after the CONFIRM.
  const callKinds = {
    Prepared: 'Readback',
    AwaitingConfirm: 'ConfirmWindow',
    Confirmed: 'ConfirmWindow',
    Dialing: 'Lease',
    Ringing: 'Lease',
    Connected: 'Lease',
  } as const;
  for (const [status, kind] of Object.entries(callKinds) as [keyof typeof callKinds, (typeof callKinds)[keyof typeof callKinds]][]) {
    for (const c of [...ctx.db.callRequest.callByStatus.filter({ tag: status })]) {
      if ([...ctx.db.callTimer.callId.filter(c.id)].some((r) => r.kind.tag === kind)) continue;
      const when =
        kind === 'Readback'
          ? plusMs(c.createdAt, cfg.readbackDeadlineMs)
          : status === 'Confirmed'
            ? plusMs(c.confirmedAt ?? c.updatedAt, CALL_CLAIM_MS)
            : kind === 'ConfirmWindow'
              ? (c.confirmClosesAt ?? ctx.timestamp)
              : plusMs(c.dialedAt ?? c.updatedAt, cfg.callLeaseMs);
      const seq = kind === 'Lease' ? c.claimAttempt : c.windowSeq;
      armCallTimer(ctx, c.id, kind, seq, notBefore(ctx, when));
      repaired.push(`call_timer:${c.id}`);
    }
  }
  const armedCodes = new Set([...ctx.db.pairingTimer.iter()].map((p) => p.code));
  for (const r of [...ctx.db.pairingRequest.iter()]) {
    if (armedCodes.has(r.code)) continue;
    ctx.db.pairingTimer.insert({ scheduledId: 0n, scheduledAt: onceAt(notBefore(ctx, r.expiresAt)), code: r.code });
    repaired.push(`pairing_timer:${r.code}`);
  }
  return repaired;
}
