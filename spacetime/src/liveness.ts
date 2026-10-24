// Reading the dead-man lease (docs/spacetime.md 2.9 `liveness_lease`, 3.4 `heartbeat`). The newest row is both
// the deadline and the last heartbeat. Contact counts only while that deadline has not passed, and "healthy for
// N ms" counts only continuous healthy beats, never time from before a pause.
import type { Timestamp } from 'spacetimedb';
import type { ReadDb } from './ctx';
import type { LivenessLease, Session } from './schema';
import { msBetween } from './util';

export function latestLease(db: ReadDb, sessionId: bigint): LivenessLease | undefined {
  let latest: LivenessLease | undefined;
  for (const l of db.livenessLease.sessionId.filter(sessionId)) {
    if (!latest || l.beatSeq >= latest.beatSeq) latest = l;
  }
  return latest;
}

/** The lease's deadline has passed (the scheduler may not have fired yet). */
export function leaseLapsed(row: LivenessLease, now: Timestamp): boolean {
  if (row.scheduledAt.tag !== 'Time') return false;
  return row.scheduledAt.value.microsSinceUnixEpoch <= now.microsSinceUnixEpoch;
}

/** For CONFIRM: the newest beat says the decoder is healthy and its lease has not lapsed. */
export function contactIsGood(db: ReadDb, sessionId: bigint, now: Timestamp): boolean {
  const l = latestLease(db, sessionId);
  return !!l && l.decoderHealthy && !leaseLapsed(l, now);
}

/** The `healthy_since` a new beat carries: kept only across continuous healthy beats with no lapse between. */
export function nextHealthySince(previous: LivenessLease | undefined, healthy: boolean, now: Timestamp): Timestamp | undefined {
  if (!healthy) return undefined;
  if (previous && previous.decoderHealthy && previous.healthySince && !leaseLapsed(previous, now)) return previous.healthySince;
  return now;
}

/**
 * The session's current idle deadline (the `idle_timer` row with the session's `idleSeq`) has passed. The timer may
 * not have run yet, so anything that must not cross the deadline checks it here.
 */
export function idleLapsed(db: ReadDb, session: Session, now: Timestamp): boolean {
  for (const r of db.idleTimer.sessionId.filter(session.id)) {
    if (r.idleSeq === session.idleSeq && r.scheduledAt.tag === 'Time' && r.scheduledAt.value.microsSinceUnixEpoch <= now.microsSinceUnixEpoch) {
      return true;
    }
  }
  return false;
}

/** A call of the session is Connected (the idle timer re-arms instead of pausing, so it never hangs one up). */
export function hasConnectedCall(db: ReadDb, sessionId: bigint): boolean {
  for (const c of db.callRequest.callBySession.filter(sessionId)) {
    if (c.status.tag === 'Connected') return true;
  }
  return false;
}

/**
 * The idle pause is due: the deadline passed and its timer would pause (no call is Connected), whether or not the
 * timer has run yet. What `idle_pause` voids must not be confirmed or claimed after this point.
 */
export function idleDue(db: ReadDb, session: Session, now: Timestamp): boolean {
  return idleLapsed(db, session, now) && !hasConnectedCall(db, session.id);
}

/**
 * For a resume after a signal pause: healthy, not lapsed, and healthy for at least `ms`, counted from whichever
 * is later, the start of the healthy run or the pause itself.
 */
export function contactGoodFor(db: ReadDb, sessionId: bigint, now: Timestamp, ms: number, pausedAt: Timestamp | undefined): boolean {
  const l = latestLease(db, sessionId);
  if (!l || !l.decoderHealthy || !l.healthySince || leaseLapsed(l, now)) return false;
  const from = pausedAt && pausedAt.microsSinceUnixEpoch > l.healthySince.microsSinceUnixEpoch ? pausedAt : l.healthySince;
  return msBetween(now, from) >= ms;
}
