// The errand and call gates (docs/spacetime.md 3.4, 3.6, 3.7, 4.3, 4.4): consent rows, read-back, the seven
// CONFIRM checks, the agent's digest-checked claim, leases, and what voids a pending action.
//
// What the database enforces: when an errand or call may go (Confirmed, digest match, one claim, a lease).
// What it trusts: the sidecar has one submit path, after a successful claim. See docs/spacetime.md 10.1 item 14.
import { Identity, Timestamp } from 'spacetimedb';
import { SenderError } from 'spacetimedb/server';
import { getConfig } from './config';
import type { Ctx, ReadDb } from './ctx';
import { cancelJobs, createJob } from './jobs';
import { contactIsGood, idleLapsed } from './liveness';
import type {
  AnswerOption,
  CallRequest,
  CallTimerKind,
  Config,
  ConsentScope,
  Errand,
  ErrandTimerKind,
  Question,
  Session,
} from './schema';
import {
  appendLedger,
  DIGEST_RE,
  emitCue,
  hasKey,
  ID_RE,
  isAfter,
  msBetween,
  normCode,
  onceAt,
  plusMs,
  requireMatch,
  requireOptionalText,
  requireText,
  u32,
  writePipeline,
  type Actor,
} from './util';

// ---------- Consent ----------

/** An active row for the scope whose subject is this subject or empty (every subject). */
export function hasConsent(db: ReadDb, scope: ConsentScope['tag'], subject: string): boolean {
  for (const c of db.consent.consentByScope.filter({ tag: scope })) {
    if (c.revokedAt === undefined && (c.subject === '' || c.subject === subject)) return true;
  }
  return false;
}

// ---------- Status groups ----------

export const ERRAND_PRE_CLAIM = ['Drafted', 'Previewed', 'AwaitingConfirm', 'Confirmed'] as const;
export const CALL_PRE_CLAIM = ['Prepared', 'AwaitingConfirm', 'Confirmed'] as const;
export const CALL_LIVE = ['Dialing', 'Ringing', 'Connected'] as const;

const isIn = <T extends string>(tag: string, group: readonly T[]): tag is T => (group as readonly string[]).includes(tag);

export function isErrandPreClaim(e: Errand): boolean {
  return isIn(e.status.tag, ERRAND_PRE_CLAIM);
}
export function isCallPreClaim(c: CallRequest): boolean {
  return isIn(c.status.tag, CALL_PRE_CLAIM);
}
export function isCallLive(c: CallRequest): boolean {
  return isIn(c.status.tag, CALL_LIVE);
}

/** What is in flight for a session, newest first in each group. */
export interface PendingWork {
  /** An errand nobody has claimed yet (Drafted to Confirmed). */
  errand?: Errand;
  /** A call nobody has claimed yet (Prepared to Confirmed). */
  call?: CallRequest;
  /** A call the agent is dialing or on. */
  liveCall?: CallRequest;
  /** An errand the agent is submitting. */
  submitting?: Errand;
}

export function pendingWork(db: ReadDb, sessionId: bigint): PendingWork {
  const out: PendingWork = {};
  for (const e of db.errand.errandBySession.filter(sessionId)) {
    if (isErrandPreClaim(e) && (!out.errand || e.id > out.errand.id)) out.errand = e;
    if (e.status.tag === 'Submitting' && (!out.submitting || e.id > out.submitting.id)) out.submitting = e;
  }
  for (const c of db.callRequest.callBySession.filter(sessionId)) {
    if (isCallPreClaim(c) && (!out.call || c.id > out.call.id)) out.call = c;
    if (isCallLive(c) && (!out.liveCall || c.id > out.liveCall.id)) out.liveCall = c;
  }
  return out;
}

export function hasAnythingPending(p: PendingWork): boolean {
  return !!(p.errand || p.call || p.liveCall || p.submitting);
}

// ---------- Spoken reasons ----------

/** One plain sentence per module-made reason, for the earpiece and the board. */
const SAY: Record<string, string> = {
  no: 'Stopped. Nothing was sent.',
  stop: 'Stopped. Nothing was sent.',
  headset_lost: 'Paused because the headset signal was lost. Nothing was sent.',
  headset_off: 'Paused because the headset came off. Nothing was sent.',
  idle: 'Paused after a long quiet spell. Nothing was sent.',
  operator: 'Paused by a helper. Nothing was sent.',
  interrupted: 'A new question came in. Nothing was sent.',
  consent_revoked: 'Permission for this was taken back. Nothing was sent.',
  session_ended: 'The session ended. Nothing was sent.',
  readback_not_finished: 'The read-back did not finish. Nothing was sent.',
  window_closed: 'Stopped, nothing sent.',
  preview_timeout: 'The form did not load in time. Nothing was sent.',
  agent_lost: 'The helper program stopped answering. Nothing was sent.',
  no_consent: 'That needs permission first. Nothing was sent.',
  bad_action: 'That request was not set up right. Nothing was sent.',
  lease_lapsed: 'It may or may not have gone through.',
  expired: 'That call is no longer ready. No call was made.',
  duplicate_request: 'That call was already set up once. No call was made.',
};

function sayFor(code: string, isCall: boolean): string {
  const s = hasKey(SAY, code) ? SAY[code]! : 'Stopped. Nothing was sent.';
  return isCall ? s.replace('Nothing was sent.', 'No call was made.') : s;
}

/**
 * The sentence an anonymous board may show for a stored reason while sharing is off: the module's own wording for
 * one of its codes, or nothing. A stored sentence can come from the Actor, the Dialer or the sidecar, so it is
 * shown only while sharing is on.
 */
export function publicReason(code: string, isCall: boolean): string {
  return hasKey(SAY, code) ? sayFor(code, isCall) : '';
}

/** A reason code made safe for a pipeline `detail` label. */
function codeLabel(code: string): string {
  return normCode(code) || 'unknown';
}

// ---------- Errand rows and timers ----------

function saveErrand(ctx: Ctx, e: Errand): Errand {
  const next = { ...e, updatedAt: ctx.timestamp };
  ctx.db.errand.id.update(next);
  return next;
}

export function clearErrandTimers(ctx: Ctx, errandId: bigint, kinds?: ErrandTimerKind['tag'][]): void {
  for (const r of [...ctx.db.errandLease.errandId.filter(errandId)]) {
    if (!kinds || kinds.includes(r.kind.tag)) ctx.db.errandLease.scheduledId.delete(r.scheduledId);
  }
}

export function armErrandTimer(ctx: Ctx, errandId: bigint, kind: ErrandTimerKind['tag'], seq: number, when: Timestamp): void {
  clearErrandTimers(ctx, errandId, [kind]);
  ctx.db.errandLease.insert({ scheduledId: 0n, scheduledAt: onceAt(when), errandId, kind: { tag: kind }, seq });
}

function errandEvent(ctx: Ctx, e: Errand, key: string, status: 'started' | 'ok' | 'error', detail: string, ms?: number, actor: Actor = 'Module'): void {
  writePipeline(ctx, {
    eventKey: `e${e.id}:${key}`,
    sessionId: e.sessionId,
    questionId: e.questionId,
    stage: 'errand',
    status,
    detail,
    ms,
    actor,
  });
}

export interface StopOpts {
  actor: Actor;
  gestureId?: string;
  cue?: boolean;
}

/** Stops an errand nobody has claimed yet. Never touches a Submitting errand (too late to recall). */
export function stopErrand(ctx: Ctx, e: Errand, code: string, opts: StopOpts): Errand {
  if (!isErrandPreClaim(e)) return e;
  clearErrandTimers(ctx, e.id);
  cancelJobs(ctx, e.questionId, 'errand_stopped', { errandId: e.id });
  const next = saveErrand(ctx, {
    ...e,
    status: { tag: 'Stopped' },
    reasonCode: code,
    reason: sayFor(code, false),
    stopGestureId: opts.gestureId ?? '',
    endedAt: ctx.timestamp,
  });
  if (opts.cue !== false) emitCue(ctx, e.sessionId, 'not_sent', { reason: code, errandId: e.id, questionId: e.questionId });
  appendLedger(ctx, e.sessionId, 'errand', opts.actor, {
    errandId: e.id,
    questionId: e.questionId,
    gestureId: opts.gestureId,
    digest: e.previewDigest,
    outcome: 'stopped',
    reason: code,
  });
  errandEvent(ctx, next, 'stopped', 'error', `stopped: ${codeLabel(code)}`);
  return next;
}

// ---------- Call rows and timers ----------

function saveCall(ctx: Ctx, c: CallRequest): CallRequest {
  const next = { ...c, updatedAt: ctx.timestamp };
  ctx.db.callRequest.id.update(next);
  return next;
}

export function clearCallTimers(ctx: Ctx, callId: bigint, kinds?: CallTimerKind['tag'][]): void {
  for (const r of [...ctx.db.callTimer.callId.filter(callId)]) {
    if (!kinds || kinds.includes(r.kind.tag)) ctx.db.callTimer.scheduledId.delete(r.scheduledId);
  }
}

export function armCallTimer(ctx: Ctx, callId: bigint, kind: CallTimerKind['tag'], seq: number, when: Timestamp): void {
  clearCallTimers(ctx, callId, [kind]);
  ctx.db.callTimer.insert({ scheduledId: 0n, scheduledAt: onceAt(when), callId, kind: { tag: kind }, seq });
}

function callEvent(ctx: Ctx, c: CallRequest, key: string, status: 'started' | 'ok' | 'error', detail: string, actor: Actor = 'Module'): void {
  writePipeline(ctx, {
    eventKey: `c${c.id}:${key}`,
    sessionId: c.sessionId,
    questionId: c.questionId,
    stage: 'call',
    status,
    detail,
    actor,
  });
}

/** Stops a call nobody has claimed yet. */
export function stopCall(ctx: Ctx, c: CallRequest, code: string, opts: StopOpts): CallRequest {
  if (!isCallPreClaim(c)) return c;
  clearCallTimers(ctx, c.id);
  const next = saveCall(ctx, {
    ...c,
    status: { tag: 'Stopped' },
    reasonCode: code,
    reason: sayFor(code, true),
    stopGestureId: opts.gestureId ?? '',
    endedAt: ctx.timestamp,
  });
  if (opts.cue !== false) emitCue(ctx, c.sessionId, 'not_sent', { reason: code, callId: c.id, questionId: c.questionId });
  appendLedger(ctx, c.sessionId, 'call', opts.actor, {
    callId: c.id,
    questionId: c.questionId,
    gestureId: opts.gestureId,
    digest: c.scriptDigest,
    outcome: 'stopped',
    reason: code,
  });
  callEvent(ctx, next, 'stopped', 'error', `stopped: ${codeLabel(code)}`);
  return next;
}

/** Asks the sidecar to hang up a live call. Its Dialer calls `cancelActive(reason)` and reports Ended. */
export function requestCallCancel(ctx: Ctx, c: CallRequest, cancelReason: string, opts: StopOpts): CallRequest {
  if (!isCallLive(c)) return c;
  const next = c.cancelRequested ? c : saveCall(ctx, { ...c, cancelRequested: true, cancelReason, stopGestureId: opts.gestureId ?? c.stopGestureId });
  if (opts.cue !== false) emitCue(ctx, c.sessionId, 'call_cancelling', { reason: cancelReason, callId: c.id, questionId: c.questionId });
  appendLedger(ctx, c.sessionId, 'call', opts.actor, {
    callId: c.id,
    questionId: c.questionId,
    gestureId: opts.gestureId,
    outcome: 'cancel_requested',
    reason: cancelReason,
  });
  callEvent(ctx, next, 'cancel', 'started', 'hanging up');
  return next;
}

/** The Dialer's `CancelReason` for a pause or void reason. */
export function dialerCancelReason(code: string): string {
  switch (code) {
    case 'stop':
      return 'stop';
    case 'headset_lost':
    case 'headset_off':
      return 'headset_off';
    case 'idle':
      return 'auto_pause';
    default:
      return 'operator';
  }
}

/**
 * Voids everything waiting on the person: unclaimed errands and calls become Stopped, live calls get a hang-up
 * request, and a Submitting errand is left alone because it is too late to recall.
 */
export function voidPending(ctx: Ctx, sessionId: bigint, code: string, actor: Actor, opts: { liveCalls?: boolean } = {}): void {
  for (const e of [...ctx.db.errand.errandBySession.filter(sessionId)]) {
    if (isErrandPreClaim(e)) stopErrand(ctx, e, code, { actor, cue: false });
  }
  for (const c of [...ctx.db.callRequest.callBySession.filter(sessionId)]) {
    if (isCallPreClaim(c)) stopCall(ctx, c, code, { actor, cue: false });
    else if (isCallLive(c) && opts.liveCalls !== false) {
      requestCallCancel(ctx, c, dialerCancelReason(code), { actor, cue: false });
    }
  }
}

// ---------- Made when the person picks an errand or call option (4.3, 4.4) ----------

interface ErrandAction {
  formKey: string;
  formUrl: string;
  formTitle: string;
  fields: unknown[];
}

interface CallAction {
  requestId: string;
  contactId: string;
  recipientName: string;
  readBack: string;
  digest: string;
  expiresAt: number;
}

/** Checks an errand option's `action_json` at publish time. Throws on a malformed one. */
export function checkErrandAction(json: string): ErrandAction {
  let a: Partial<ErrandAction>;
  try {
    a = JSON.parse(json) as Partial<ErrandAction>;
  } catch {
    throw new SenderError('errand action_json is not JSON');
  }
  if (!a || typeof a !== 'object') throw new SenderError('errand action_json must be an object');
  requireMatch(a.formKey as string, ID_RE, 'formKey');
  if (typeof a.formUrl !== 'string' || !(a.formUrl === 'demo' || a.formUrl.startsWith('https://')) || a.formUrl.length > 500) {
    throw new SenderError('formUrl must be https or demo');
  }
  if (typeof a.formTitle !== 'string' || a.formTitle.length > 120) throw new SenderError('bad formTitle');
  if (!Array.isArray(a.fields) || a.fields.length > 30) throw new SenderError('fields must be a list');
  return a as ErrandAction;
}

/** Checks a call option's `action_json` (the Dialer's PreparedCall). Throws on a malformed one. */
export function checkCallAction(json: string): CallAction {
  let a: Partial<CallAction>;
  try {
    a = JSON.parse(json) as Partial<CallAction>;
  } catch {
    throw new SenderError('call action_json is not JSON');
  }
  if (!a || typeof a !== 'object') throw new SenderError('call action_json must be an object');
  requireMatch(a.requestId as string, ID_RE, 'requestId');
  requireMatch(a.contactId as string, ID_RE, 'contactId');
  requireMatch(a.digest as string, DIGEST_RE, 'digest');
  requireText(a.recipientName as string, 'recipientName', 80);
  requireText(a.readBack as string, 'readBack', 500);
  // Whole epoch milliseconds inside the JavaScript date range, so the microseconds fit the i64 timestamp column
  // (a larger value would wrap when stored and disagree with the expiry check made in memory).
  if (typeof a.expiresAt !== 'number' || !Number.isSafeInteger(a.expiresAt) || a.expiresAt < 0 || a.expiresAt > MAX_EPOCH_MS) {
    throw new SenderError('bad expiresAt');
  }
  return a as CallAction;
}

/** The largest JavaScript date, in epoch milliseconds; times 1000 it is still inside the i64 range. */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

/** A YES on an errand option. Without Errand consent for its form, it is refused at once. */
export function createErrandFromPick(ctx: Ctx, cfg: Config, s: Session, q: Question, o: AnswerOption, gestureId: string): Errand {
  let action: ErrandAction | undefined;
  try {
    action = checkErrandAction(o.actionJson);
  } catch {
    action = undefined;
  }
  const base: Errand = {
    id: 0n,
    sessionId: s.id,
    questionId: q.id,
    optionId: o.id,
    status: { tag: 'Drafted' },
    formKey: action?.formKey ?? '',
    formUrl: action?.formUrl ?? '',
    formTitle: action?.formTitle ?? '',
    fieldsJson: action ? JSON.stringify(action.fields) : '[]',
    previewDigest: '',
    readBackText: '',
    readBackJson: '',
    screenshotUrl: '',
    confirmationText: '',
    reasonCode: '',
    reason: '',
    windowSeq: 0,
    readbackDoneAt: undefined,
    confirmOpensAt: undefined,
    confirmClosesAt: undefined,
    confirmedDigest: '',
    confirmGestureId: '',
    stopGestureId: '',
    confirmedAt: undefined,
    claimAttempt: 0,
    claimedBy: Identity.zero(),
    claimedAt: undefined,
    submittedAt: undefined,
    previewedAt: undefined,
    endedAt: undefined,
    previewMs: 0,
    submitMs: 0,
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  };
  const refusal = !action ? 'bad_action' : !hasConsent(ctx.db, 'Errand', action.formKey) ? 'no_consent' : '';
  if (refusal) {
    const e = ctx.db.errand.insert({
      ...base,
      status: { tag: 'Refused' },
      reasonCode: refusal,
      reason: sayFor(refusal, false),
      endedAt: ctx.timestamp,
    });
    emitCue(ctx, s.id, 'errand_refused', { reason: refusal, errandId: e.id, questionId: q.id });
    appendLedger(ctx, s.id, 'errand', 'Station', { errandId: e.id, questionId: q.id, optionId: o.id, gestureId, outcome: 'refused', reason: refusal });
    errandEvent(ctx, e, 'refused', 'error', `refused: ${refusal}`);
    return e;
  }
  const e = ctx.db.errand.insert(base);
  createJob(ctx, 'ErrandPreview', { sessionId: s.id, questionId: q.id, errandId: e.id });
  armErrandTimer(ctx, e.id, 'Preview', 0, plusMs(ctx.timestamp, cfg.previewTimeoutMs));
  emitCue(ctx, s.id, 'errand_preparing', { errandId: e.id, questionId: q.id, optionId: o.id });
  appendLedger(ctx, s.id, 'errand', 'Station', { errandId: e.id, questionId: q.id, optionId: o.id, gestureId, outcome: 'drafted' });
  errandEvent(ctx, e, 'drafted', 'started', 'preparing preview');
  return e;
}

/** A YES on a call option. The Dialer already prepared it; without Call consent or after expiry, refused. */
export function createCallFromPick(ctx: Ctx, cfg: Config, s: Session, q: Question, o: AnswerOption, gestureId: string): CallRequest | undefined {
  let action: CallAction | undefined;
  try {
    action = checkCallAction(o.actionJson);
  } catch {
    action = undefined;
  }
  if (action && ctx.db.callRequest.requestId.find(action.requestId)) {
    emitCue(ctx, s.id, 'call_refused', { reason: 'duplicate_request', questionId: q.id, optionId: o.id });
    appendLedger(ctx, s.id, 'call', 'Station', { questionId: q.id, optionId: o.id, gestureId, outcome: 'refused', reason: 'duplicate_request' });
    return undefined;
  }
  const expiresAt = action ? new Timestamp(BigInt(Math.round(action.expiresAt)) * 1000n) : ctx.timestamp;
  const base: CallRequest = {
    id: 0n,
    sessionId: s.id,
    questionId: q.id,
    optionId: o.id,
    requestId: action?.requestId ?? `bad-${o.id}`,
    contactId: action?.contactId ?? '',
    contactName: action?.recipientName ?? '',
    readBackText: action?.readBack ?? '',
    scriptDigest: action?.digest ?? '',
    preparedExpiresAt: expiresAt,
    status: { tag: 'Prepared' },
    result: '',
    endReason: '',
    reasonCode: '',
    reason: '',
    cancelRequested: false,
    cancelReason: '',
    windowSeq: 0,
    claimAttempt: 0,
    claimedBy: Identity.zero(),
    confirmGestureId: '',
    stopGestureId: '',
    readbackDoneAt: undefined,
    confirmOpensAt: undefined,
    confirmClosesAt: undefined,
    confirmedAt: undefined,
    dialedAt: undefined,
    ringingAt: undefined,
    connectedAt: undefined,
    endedAt: undefined,
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  };
  const refusal = !action
    ? 'bad_action'
    : !hasConsent(ctx.db, 'Call', action.contactId)
      ? 'no_consent'
      : isAfter(ctx.timestamp, expiresAt)
        ? 'expired'
        : '';
  if (refusal) {
    const c = ctx.db.callRequest.insert({
      ...base,
      status: { tag: 'Refused' },
      result: 'refused',
      reasonCode: refusal,
      reason: sayFor(refusal, true),
      endedAt: ctx.timestamp,
    });
    emitCue(ctx, s.id, 'call_refused', { reason: refusal, callId: c.id, questionId: q.id });
    appendLedger(ctx, s.id, 'call', 'Station', { callId: c.id, questionId: q.id, optionId: o.id, gestureId, outcome: 'refused', reason: refusal });
    callEvent(ctx, c, 'refused', 'error', `refused: ${refusal}`);
    return c;
  }
  const c = ctx.db.callRequest.insert(base);
  armCallTimer(ctx, c.id, 'Readback', 0, plusMs(ctx.timestamp, cfg.readbackDeadlineMs));
  appendLedger(ctx, s.id, 'call', 'Station', { callId: c.id, questionId: q.id, optionId: o.id, gestureId, digest: c.scriptDigest, outcome: 'prepared' });
  callEvent(ctx, c, 'prepared', 'started', 'prepared');
  return c;
}

// ---------- Read-back done (3.4) ----------

/** The station finished reading the action back: AwaitingConfirm, after a quiet hold. */
export function readbackDone(ctx: Ctx, s: Session, kind: string, id: bigint, digest: string): void {
  const cfg = getConfig(ctx.db);
  const opensAt = plusMs(ctx.timestamp, cfg.quietHoldMs);
  const closesAt = plusMs(opensAt, cfg.confirmWindowMs);
  if (kind === 'errand') {
    const e = ctx.db.errand.id.find(id);
    if (!e || e.sessionId !== s.id) throw new SenderError('no such errand');
    if (e.status.tag === 'AwaitingConfirm' && e.previewDigest === digest) return; // a retry
    if (e.status.tag !== 'Previewed') throw new SenderError('errand is not waiting for a read-back');
    if (digest !== e.previewDigest) throw new SenderError('digest mismatch: the station played a stale read-back');
    const windowSeq = e.windowSeq + 1;
    const next = saveErrand(ctx, {
      ...e,
      status: { tag: 'AwaitingConfirm' },
      readbackDoneAt: ctx.timestamp,
      confirmOpensAt: opensAt,
      confirmClosesAt: closesAt,
      windowSeq,
    });
    clearErrandTimers(ctx, e.id, ['Readback']);
    armErrandTimer(ctx, e.id, 'ConfirmWindow', windowSeq, closesAt);
    appendLedger(ctx, s.id, 'errand', 'Station', { errandId: e.id, questionId: e.questionId, digest, outcome: 'awaiting_confirm' });
    errandEvent(ctx, next, 'readback', 'ok', 'read-back done', undefined, 'Station');
    return;
  }
  if (kind === 'call') {
    const c = ctx.db.callRequest.id.find(id);
    if (!c || c.sessionId !== s.id) throw new SenderError('no such call');
    if (c.status.tag === 'AwaitingConfirm' && c.scriptDigest === digest) return; // a retry
    if (c.status.tag !== 'Prepared') throw new SenderError('call is not waiting for a read-back');
    if (digest !== c.scriptDigest) throw new SenderError('digest mismatch: the station played a stale read-back');
    const windowSeq = c.windowSeq + 1;
    const next = saveCall(ctx, {
      ...c,
      status: { tag: 'AwaitingConfirm' },
      readbackDoneAt: ctx.timestamp,
      confirmOpensAt: opensAt,
      confirmClosesAt: closesAt,
      windowSeq,
    });
    clearCallTimers(ctx, c.id, ['Readback']);
    armCallTimer(ctx, c.id, 'ConfirmWindow', windowSeq, closesAt);
    appendLedger(ctx, s.id, 'call', 'Station', { callId: c.id, questionId: c.questionId, digest, outcome: 'awaiting_confirm' });
    callEvent(ctx, next, 'readback', 'ok', 'read-back done', 'Station');
    return;
  }
  throw new SenderError('kind must be errand or call');
}

// ---------- The CONFIRM checks (3.4 step 6) ----------

export interface ConfirmInput {
  gestureId: string;
  onsetAgeMs: number;
  heardDigest: string;
}


interface Gate {
  status: string;
  readbackDoneAt: Timestamp | undefined;
  confirmOpensAt: Timestamp | undefined;
  confirmClosesAt: Timestamp | undefined;
  digest: string;
  consentOk: boolean;
}

/**
 * Checks 2 to 7 of the fail-closed rule (check 1, the session's Station, is the reducer's guard; a used gesture
 * id never reaches here). Returns '' when all pass, else the ignore reason.
 *
 * A closed window is checked before the quiet hold: an early CONFIRM restarts the hold, and a stale one that
 * arrives after the window closed (before its timer ran) must not reopen it. A timeout means no.
 */
function gateReason(ctx: Ctx, sessionId: bigint, gate: Gate, g: ConfirmInput): string {
  if (gate.status !== 'AwaitingConfirm' || !gate.readbackDoneAt || !gate.confirmOpensAt || !gate.confirmClosesAt) {
    return 'readback_not_done';
  }
  if (isAfter(ctx.timestamp, gate.confirmClosesAt)) return 'window_closed';
  const onset = plusMs(ctx.timestamp, -g.onsetAgeMs);
  if (onset.microsSinceUnixEpoch < gate.confirmOpensAt.microsSinceUnixEpoch) return 'quiet_hold';
  if (!contactIsGood(ctx.db, sessionId, ctx.timestamp)) return 'no_contact';
  if (g.heardDigest !== gate.digest) return 'digest_mismatch';
  if (!gate.consentOk) return 'no_consent';
  return '';
}

/** Restarts the quiet hold (and so the window) after a CONFIRM that came too early. */
function restartHold(ctx: Ctx, cfg: Config): { opensAt: Timestamp; closesAt: Timestamp } {
  const opensAt = plusMs(ctx.timestamp, cfg.quietHoldMs);
  return { opensAt, closesAt: plusMs(opensAt, cfg.confirmWindowMs) };
}

/** Returns '' when the errand is now Confirmed, else the ignore reason. */
export function confirmErrand(ctx: Ctx, s: Session, e: Errand, g: ConfirmInput): string {
  const cfg = getConfig(ctx.db);
  const reason = gateReason(ctx, s.id, {
    status: e.status.tag,
    readbackDoneAt: e.readbackDoneAt,
    confirmOpensAt: e.confirmOpensAt,
    confirmClosesAt: e.confirmClosesAt,
    digest: e.previewDigest,
    consentOk: hasConsent(ctx.db, 'Errand', e.formKey),
  }, g);
  if (reason === 'quiet_hold') {
    const { opensAt, closesAt } = restartHold(ctx, cfg);
    const windowSeq = e.windowSeq + 1;
    saveErrand(ctx, { ...e, confirmOpensAt: opensAt, confirmClosesAt: closesAt, windowSeq });
    armErrandTimer(ctx, e.id, 'ConfirmWindow', windowSeq, closesAt);
    return reason;
  }
  if (reason) return reason;
  const next = saveErrand(ctx, {
    ...e,
    status: { tag: 'Confirmed' },
    confirmedDigest: e.previewDigest,
    confirmGestureId: g.gestureId,
    confirmedAt: ctx.timestamp,
  });
  clearErrandTimers(ctx, e.id, ['ConfirmWindow']);
  emitCue(ctx, s.id, 'confirmed', { errandId: e.id, questionId: e.questionId });
  appendLedger(ctx, s.id, 'errand', 'Station', {
    errandId: e.id,
    questionId: e.questionId,
    gestureId: g.gestureId,
    command: 'CONFIRM',
    digest: e.previewDigest,
    outcome: 'confirmed',
  });
  errandEvent(ctx, next, 'confirmed', 'ok', 'confirmed', undefined, 'Station');
  return '';
}

/** Returns '' when the call is now Confirmed, else the ignore reason. */
export function confirmCall(ctx: Ctx, s: Session, c: CallRequest, g: ConfirmInput): string {
  const cfg = getConfig(ctx.db);
  const reason = gateReason(ctx, s.id, {
    status: c.status.tag,
    readbackDoneAt: c.readbackDoneAt,
    confirmOpensAt: c.confirmOpensAt,
    confirmClosesAt: c.confirmClosesAt,
    digest: c.scriptDigest,
    consentOk: hasConsent(ctx.db, 'Call', c.contactId),
  }, g);
  if (reason === 'quiet_hold') {
    const { opensAt, closesAt } = restartHold(ctx, cfg);
    const windowSeq = c.windowSeq + 1;
    saveCall(ctx, { ...c, confirmOpensAt: opensAt, confirmClosesAt: closesAt, windowSeq });
    armCallTimer(ctx, c.id, 'ConfirmWindow', windowSeq, closesAt);
    return reason;
  }
  if (reason) return reason;
  const next = saveCall(ctx, {
    ...c,
    status: { tag: 'Confirmed' },
    confirmGestureId: g.gestureId,
    confirmedAt: ctx.timestamp,
  });
  clearCallTimers(ctx, c.id, ['ConfirmWindow']);
  emitCue(ctx, s.id, 'confirmed', { callId: c.id, questionId: c.questionId });
  appendLedger(ctx, s.id, 'call', 'Station', {
    callId: c.id,
    questionId: c.questionId,
    gestureId: g.gestureId,
    command: 'CONFIRM',
    digest: c.scriptDigest,
    outcome: 'confirmed',
  });
  callEvent(ctx, next, 'confirmed', 'ok', 'confirmed', 'Station');
  return '';
}

// ---------- The agent's side of an errand (3.6, 4.3) ----------

export interface PreviewResult {
  status: string;
  formTitle: string;
  readBackText: string;
  readBackJson: string;
  previewDigest: string;
  screenshotUrl: string;
  reasonCode: string;
  reason: string;
  previewMs: number;
}

/** The Actor's preview for a Drafted errand. Returns false when the errand had already moved on. */
export function attachPreview(ctx: Ctx, errandId: bigint, r: PreviewResult): boolean {
  if (r.status !== 'previewed' && r.status !== 'refused' && r.status !== 'failed') {
    throw new SenderError('status must be previewed, refused or failed');
  }
  requireOptionalText(r.formTitle, 'form_title', 120);
  requireOptionalText(r.screenshotUrl, 'screenshot_url', 1000);
  requireOptionalText(r.reasonCode, 'reason_code', 40);
  requireOptionalText(r.reason, 'reason', 300);
  if (r.readBackJson.length > 16384) throw new SenderError('read_back_json is too long');
  if (r.status === 'previewed') {
    requireMatch(r.previewDigest, DIGEST_RE, 'preview_digest');
    requireText(r.readBackText, 'read_back_text', 2000);
  }
  const e = ctx.db.errand.id.find(errandId);
  if (!e || e.status.tag !== 'Drafted') return false; // STOP was quicker: the errand is unchanged
  const cfg = getConfig(ctx.db);
  clearErrandTimers(ctx, e.id, ['Preview']);
  const common = {
    formTitle: r.formTitle || e.formTitle,
    screenshotUrl: r.screenshotUrl,
    previewMs: u32(r.previewMs),
    previewedAt: ctx.timestamp,
  };
  // A reason code reaches the public ledger, cue and board: keep it code-shaped whatever the Actor sent.
  r = { ...r, reasonCode: normCode(r.reasonCode) };
  if (r.status === 'previewed' && !hasConsent(ctx.db, 'Errand', e.formKey)) {
    r = { ...r, status: 'refused', reasonCode: 'no_consent', reason: sayFor('no_consent', false) };
  }
  if (r.status === 'previewed') {
    const next = saveErrand(ctx, {
      ...e,
      ...common,
      status: { tag: 'Previewed' },
      previewDigest: r.previewDigest,
      readBackText: r.readBackText,
      readBackJson: r.readBackJson,
    });
    armErrandTimer(ctx, e.id, 'Readback', next.windowSeq, plusMs(ctx.timestamp, cfg.readbackDeadlineMs));
    appendLedger(ctx, e.sessionId, 'errand', 'Agent', { errandId: e.id, questionId: e.questionId, digest: r.previewDigest, outcome: 'previewed', ms: r.previewMs });
    errandEvent(ctx, next, 'previewed', 'ok', 'previewed', r.previewMs, 'Agent');
    return true;
  }
  const status = r.status === 'refused' ? 'Refused' : 'Failed';
  const next = saveErrand(ctx, {
    ...e,
    ...common,
    status: { tag: status },
    reasonCode: r.reasonCode || r.status,
    reason: r.reason,
    endedAt: ctx.timestamp,
  });
  clearErrandTimers(ctx, e.id);
  emitCue(ctx, e.sessionId, r.status === 'refused' ? 'errand_refused' : 'errand_failed', { reason: next.reasonCode, errandId: e.id, questionId: e.questionId });
  appendLedger(ctx, e.sessionId, 'errand', 'Agent', { errandId: e.id, questionId: e.questionId, outcome: r.status, reason: next.reasonCode });
  errandEvent(ctx, next, r.status, 'error', `${r.status}: ${codeLabel(next.reasonCode)}`, undefined, 'Agent');
  return true;
}

/** A Drafted errand whose preview job failed or whose preview never arrived. */
export function failDraftedErrand(ctx: Ctx, errandId: bigint, code: string, reason: string, actor: Actor): void {
  const e = ctx.db.errand.id.find(errandId);
  if (!e || e.status.tag !== 'Drafted') return;
  clearErrandTimers(ctx, e.id);
  cancelJobs(ctx, e.questionId, code, { errandId: e.id });
  const next = saveErrand(ctx, {
    ...e,
    status: { tag: 'Failed' },
    reasonCode: code,
    reason: reason || sayFor(code, false),
    endedAt: ctx.timestamp,
  });
  emitCue(ctx, e.sessionId, 'errand_failed', { reason: code, errandId: e.id, questionId: e.questionId });
  appendLedger(ctx, e.sessionId, 'errand', actor, { errandId: e.id, questionId: e.questionId, outcome: 'failed', reason: code });
  errandEvent(ctx, next, 'failed', 'error', `failed: ${codeLabel(code)}`, undefined, actor);
}

/**
 * A Confirmed action may leave the room only while the person is still there. A lapsed dead-man lease or a passed
 * idle deadline voids it, but their timers can run a moment after the deadline, so the claim checks the deadlines
 * itself: the session is live and not paused, the newest heartbeat is healthy and its lease has not lapsed, and the
 * idle deadline is still ahead. A refused claim throws, so the sidecar never submits or dials.
 */
function requirePresent(ctx: Ctx, sessionId: bigint): void {
  const session = ctx.db.session.id.find(sessionId);
  if (!session || session.endedAt !== undefined) throw new SenderError('session ended');
  const s = ctx.db.scanState.sessionId.find(sessionId);
  if (!s || s.phase.tag === 'Paused') throw new SenderError('session paused');
  if (!contactIsGood(ctx.db, sessionId, ctx.timestamp)) throw new SenderError('no contact');
  if (idleLapsed(ctx.db, session, ctx.timestamp)) throw new SenderError('idle deadline passed');
}

/**
 * The agent claims a Confirmed errand with the digest the person heard. Submitting, a fencing attempt, and a
 * submit lease; nothing can claim it again.
 */
export function claimErrand(ctx: Ctx, errandId: bigint, digest: string): Errand {
  const e = ctx.db.errand.id.find(errandId);
  if (!e) throw new SenderError('no such errand');
  if (e.status.tag !== 'Confirmed') throw new SenderError('errand is not confirmed');
  if (digest !== e.confirmedDigest || digest !== e.previewDigest) throw new SenderError('digest mismatch');
  if (!hasConsent(ctx.db, 'Errand', e.formKey)) throw new SenderError('no errand consent');
  requirePresent(ctx, e.sessionId);
  const cfg = getConfig(ctx.db);
  const attempt = e.claimAttempt + 1;
  const next = saveErrand(ctx, {
    ...e,
    status: { tag: 'Submitting' },
    claimAttempt: attempt,
    claimedBy: ctx.sender,
    claimedAt: ctx.timestamp,
  });
  armErrandTimer(ctx, e.id, 'Submit', attempt, plusMs(ctx.timestamp, cfg.submitLeaseMs));
  appendLedger(ctx, e.sessionId, 'errand', 'Agent', { errandId: e.id, questionId: e.questionId, digest, outcome: 'submitting', reason: `attempt:${attempt}` });
  errandEvent(ctx, next, 'submitting', 'started', 'submitting', undefined, 'Agent');
  return next;
}

export interface CompleteInput {
  attempt: number;
  status: string;
  confirmationText: string;
  screenshotUrl: string;
  reasonCode: string;
  reason: string;
  submitMs: number;
}

const COMPLETE_TO: Record<string, Errand['status']['tag']> = {
  submitted: 'Submitted',
  duplicate: 'Submitted',
  refused: 'Refused',
  failed: 'Failed',
  unknown: 'UnknownOutcome',
};

const COMPLETE_CUE: Partial<Record<Errand['status']['tag'], string>> = {
  Submitted: 'errand_sent',
  Refused: 'errand_refused',
  Failed: 'errand_failed',
  UnknownOutcome: 'errand_unknown',
};

/** The submit's result, fenced by the claim attempt. A late true result after UnknownOutcome is recorded. */
export function completeErrand(ctx: Ctx, errandId: bigint, given: CompleteInput): void {
  const target = hasKey(COMPLETE_TO, given.status) ? COMPLETE_TO[given.status] : undefined;
  if (!target) throw new SenderError('status must be submitted, duplicate, refused, failed or unknown');
  requireOptionalText(given.confirmationText, 'confirmation_text', 2000);
  requireOptionalText(given.screenshotUrl, 'screenshot_url', 1000);
  requireOptionalText(given.reasonCode, 'reason_code', 40);
  requireOptionalText(given.reason, 'reason', 300);
  // The code reaches the public ledger, cue and board: keep it code-shaped whatever the sidecar sent.
  const r: CompleteInput = { ...given, reasonCode: normCode(given.reasonCode) };
  const e = ctx.db.errand.id.find(errandId);
  if (!e || e.claimAttempt !== r.attempt || !e.claimedBy.isEqual(ctx.sender)) throw new SenderError('stale attempt');
  let late = false;
  if (e.status.tag === 'Submitting') {
    // the normal path
  } else if (e.status.tag === 'UnknownOutcome') {
    if (target === 'UnknownOutcome') return;
    late = true;
  } else if (e.status.tag === target) {
    return; // a retry of a call that already committed
  } else {
    throw new SenderError('errand is not submitting');
  }
  clearErrandTimers(ctx, e.id, ['Submit']);
  const next = saveErrand(ctx, {
    ...e,
    status: { tag: target },
    confirmationText: r.confirmationText,
    screenshotUrl: r.screenshotUrl || e.screenshotUrl,
    reasonCode: target === 'Submitted' ? '' : r.reasonCode || r.status,
    reason: target === 'Submitted' ? '' : target === 'UnknownOutcome' ? sayFor('lease_lapsed', false) : r.reason,
    submitMs: u32(r.submitMs),
    submittedAt: target === 'Submitted' ? ctx.timestamp : e.submittedAt,
    endedAt: target === 'UnknownOutcome' ? e.endedAt : ctx.timestamp,
  });
  emitCue(ctx, e.sessionId, COMPLETE_CUE[target] ?? 'errand_failed', { reason: next.reasonCode, errandId: e.id, questionId: e.questionId });
  appendLedger(ctx, e.sessionId, late ? 'late_result' : 'errand', 'Agent', {
    errandId: e.id,
    questionId: e.questionId,
    digest: e.confirmedDigest,
    outcome: r.status,
    reason: next.reasonCode,
    ms: r.submitMs,
  });
  const label = target === 'Submitted' ? 'sent' : target === 'UnknownOutcome' ? 'unknown outcome' : `${r.status}: ${codeLabel(next.reasonCode)}`;
  errandEvent(ctx, next, late ? `late:${r.status}` : r.status, target === 'Submitted' ? 'ok' : 'error', late ? `late result: ${codeLabel(r.status)}` : label, r.submitMs, 'Agent');
}

/** `errand_timeout`: each kind acts only if its row is still the one it was armed for. */
export function errandTimedOut(ctx: Ctx, errandId: bigint, kind: ErrandTimerKind['tag'], seq: number): void {
  const e = ctx.db.errand.id.find(errandId);
  if (!e) return;
  switch (kind) {
    case 'Preview':
      if (e.status.tag === 'Drafted') failDraftedErrand(ctx, e.id, 'preview_timeout', '', 'Scheduler');
      return;
    case 'Readback':
      if (e.status.tag === 'Previewed' && seq === e.windowSeq) stopErrand(ctx, e, 'readback_not_finished', { actor: 'Scheduler' });
      return;
    case 'ConfirmWindow':
      if (e.status.tag === 'AwaitingConfirm' && seq === e.windowSeq) stopErrand(ctx, e, 'window_closed', { actor: 'Scheduler' });
      return;
    case 'Submit': {
      if (e.status.tag !== 'Submitting' || seq !== e.claimAttempt) return;
      const next = saveErrand(ctx, {
        ...e,
        status: { tag: 'UnknownOutcome' },
        reasonCode: 'lease_lapsed',
        reason: sayFor('lease_lapsed', false),
      });
      emitCue(ctx, e.sessionId, 'errand_unknown', { reason: 'lease_lapsed', errandId: e.id, questionId: e.questionId });
      appendLedger(ctx, e.sessionId, 'errand', 'Scheduler', { errandId: e.id, questionId: e.questionId, digest: e.confirmedDigest, outcome: 'unknown_outcome', reason: 'lease_lapsed' });
      errandEvent(ctx, next, 'unknown', 'error', 'unknown outcome');
      return;
    }
  }
}

// ---------- The agent's side of a call (3.7, 4.4) ----------

export function claimCall(ctx: Ctx, callId: bigint, digest: string): CallRequest {
  const c = ctx.db.callRequest.id.find(callId);
  if (!c) throw new SenderError('no such call');
  if (c.status.tag !== 'Confirmed') throw new SenderError('call is not confirmed');
  if (digest !== c.scriptDigest) throw new SenderError('digest mismatch');
  if (!hasConsent(ctx.db, 'Call', c.contactId)) throw new SenderError('no call consent');
  requirePresent(ctx, c.sessionId);
  const cfg = getConfig(ctx.db);
  const attempt = c.claimAttempt + 1;
  const next = saveCall(ctx, {
    ...c,
    status: { tag: 'Dialing' },
    claimAttempt: attempt,
    claimedBy: ctx.sender,
    dialedAt: ctx.timestamp,
  });
  armCallTimer(ctx, c.id, 'Lease', attempt, plusMs(ctx.timestamp, cfg.callLeaseMs));
  appendLedger(ctx, c.sessionId, 'call', 'Agent', { callId: c.id, questionId: c.questionId, digest, outcome: 'dialing', reason: `attempt:${attempt}` });
  callEvent(ctx, next, 'dialing', 'started', 'dialing', 'Agent');
  return next;
}

const CALL_RESULTS = ['', 'answered', 'no_answer', 'busy', 'voicemail', 'cancelled', 'failed', 'refused', 'unknown'];

export interface CallStatusInput {
  attempt: number;
  status: string;
  result: string;
  endReason: string;
  reasonCode: string;
  reason: string;
}

function requireFencedCall(ctx: Ctx, callId: bigint, attempt: number): CallRequest {
  const c = ctx.db.callRequest.id.find(callId);
  if (!c || c.claimAttempt !== attempt || !c.claimedBy.isEqual(ctx.sender)) throw new SenderError('stale attempt');
  return c;
}

/** The Dialer's progress. Out-of-order or repeated reports are ignored quietly; a call is never retried. */
export function reportCallStatus(ctx: Ctx, callId: bigint, r: CallStatusInput): void {
  if (!['ringing', 'connected', 'ended', 'failed', 'refused'].includes(r.status)) {
    throw new SenderError('status must be ringing, connected, ended, failed or refused');
  }
  if (!CALL_RESULTS.includes(r.result)) throw new SenderError('unknown call result');
  requireOptionalText(r.endReason, 'end_reason', 60);
  requireOptionalText(r.reasonCode, 'reason_code', 40);
  requireOptionalText(r.reason, 'reason', 300);
  const c = requireFencedCall(ctx, callId, r.attempt);
  const from = c.status.tag;
  const terminal = r.status === 'ended' || r.status === 'failed' || r.status === 'refused';
  const allowed: Record<string, string[]> = {
    ringing: ['Dialing'],
    connected: ['Dialing', 'Ringing'],
    ended: ['Dialing', 'Ringing', 'Connected'],
    failed: ['Dialing', 'Ringing', 'Connected'],
    refused: ['Dialing', 'Ringing'],
  };
  if (!allowed[r.status]!.includes(from)) return;
  const patch: Partial<CallRequest> = {};
  if (r.status === 'ringing') Object.assign(patch, { status: { tag: 'Ringing' }, ringingAt: ctx.timestamp });
  if (r.status === 'connected') Object.assign(patch, { status: { tag: 'Connected' }, connectedAt: ctx.timestamp });
  if (r.status === 'ended') Object.assign(patch, { status: { tag: 'Ended' }, result: r.result || 'answered', endReason: r.endReason, endedAt: ctx.timestamp });
  // The code reaches the public ledger and board: keep it code-shaped whatever the Dialer sent.
  const code = normCode(r.reasonCode);
  if (r.status === 'failed') Object.assign(patch, { status: { tag: 'Failed' }, result: r.result || 'failed', endReason: r.endReason, reasonCode: code, reason: r.reason, endedAt: ctx.timestamp });
  if (r.status === 'refused') Object.assign(patch, { status: { tag: 'Refused' }, result: 'refused', reasonCode: code, reason: r.reason, endedAt: ctx.timestamp });
  const next = saveCall(ctx, { ...c, ...patch });
  if (terminal) {
    clearCallTimers(ctx, c.id);
    emitCue(ctx, c.sessionId, 'call_ended', { reason: next.result, callId: c.id, questionId: c.questionId });
  }
  appendLedger(ctx, c.sessionId, 'call', 'Agent', { callId: c.id, questionId: c.questionId, outcome: r.status, reason: next.result || code });
  const label = r.status === 'ended' ? `ended: ${codeLabel(next.result)}` : r.status === 'refused' ? `refused: ${codeLabel(code || 'refused')}` : r.status;
  callEvent(ctx, next, r.status, r.status === 'failed' || r.status === 'refused' ? 'error' : 'ok', label, 'Agent');
}

export function addCallLine(ctx: Ctx, callId: bigint, attempt: number, lineKey: string, role: string, text: string): void {
  requireMatch(lineKey, /^[A-Za-z0-9:_.-]{1,128}$/, 'line_key');
  if (role !== 'assistant' && role !== 'recipient') throw new SenderError('role must be assistant or recipient');
  requireText(text, 'text', 500);
  requireFencedCall(ctx, callId, attempt);
  if (ctx.db.callLine.lineKey.find(lineKey)) return; // a retry
  ctx.db.callLine.insert({ id: 0n, callId, lineKey, role, text, at: ctx.timestamp });
}

/** `call_timeout`: Readback and ConfirmWindow stop the call; a lapsed dial lease is Failed with `unknown`. */
export function callTimedOut(ctx: Ctx, callId: bigint, kind: CallTimerKind['tag'], seq: number): void {
  const c = ctx.db.callRequest.id.find(callId);
  if (!c) return;
  switch (kind) {
    case 'Readback':
      if (c.status.tag === 'Prepared' && seq === c.windowSeq) stopCall(ctx, c, 'readback_not_finished', { actor: 'Scheduler' });
      return;
    case 'ConfirmWindow':
      if (c.status.tag === 'AwaitingConfirm' && seq === c.windowSeq) stopCall(ctx, c, 'window_closed', { actor: 'Scheduler' });
      return;
    case 'Lease': {
      if (!isCallLive(c) || seq !== c.claimAttempt) return;
      const next = saveCall(ctx, { ...c, status: { tag: 'Failed' }, result: 'unknown', reasonCode: 'lease_lapsed', reason: sayFor('lease_lapsed', true), endedAt: ctx.timestamp });
      clearCallTimers(ctx, c.id);
      emitCue(ctx, c.sessionId, 'call_ended', { reason: 'unknown', callId: c.id, questionId: c.questionId });
      appendLedger(ctx, c.sessionId, 'call', 'Scheduler', { callId: c.id, questionId: c.questionId, outcome: 'failed', reason: 'lease_lapsed' });
      callEvent(ctx, next, 'failed', 'error', 'failed: lease_lapsed');
      return;
    }
  }
}

/** Revoking Errand or Call consent stops what it no longer covers. */
export function stopUncovered(ctx: Ctx, scope: ConsentScope['tag'], actor: Actor): void {
  if (scope === 'Errand') {
    for (const e of [...ctx.db.errand.errandByStatus.filter({ tag: 'Drafted' })]
      .concat([...ctx.db.errand.errandByStatus.filter({ tag: 'Previewed' })])
      .concat([...ctx.db.errand.errandByStatus.filter({ tag: 'AwaitingConfirm' })])
      .concat([...ctx.db.errand.errandByStatus.filter({ tag: 'Confirmed' })])) {
      if (!hasConsent(ctx.db, 'Errand', e.formKey)) stopErrand(ctx, e, 'consent_revoked', { actor });
    }
  }
  if (scope === 'Call') {
    for (const tag of ['Prepared', 'AwaitingConfirm', 'Confirmed', 'Dialing', 'Ringing', 'Connected'] as const) {
      for (const c of [...ctx.db.callRequest.callByStatus.filter({ tag })]) {
        if (hasConsent(ctx.db, 'Call', c.contactId)) continue;
        if (isCallPreClaim(c)) stopCall(ctx, c, 'consent_revoked', { actor });
        else requestCallCancel(ctx, c, 'operator', { actor });
      }
    }
  }
}

/** Milliseconds since a timestamp, for ledger durations. */
export function msSince(ctx: Ctx, ts: Timestamp | undefined): number {
  return ts ? Math.max(0, msBetween(ctx.timestamp, ts)) : 0;
}
