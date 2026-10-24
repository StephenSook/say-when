// Eleven's SpacetimeDB module (docs/spacetime.md). This file holds the default schema export and every module
// export (reducers, views, procedures, HTTP handlers and the router) and nothing else: any other exported value
// makes the module throw "exporting something that is not a spacetime export" at load. Logic lives in the
// helper files.
//
// Wire names are snake_case (`agentClaim` is the reducer `agent_claim`); arguments are listed in order, which is
// also the order of the JSON array an HTTP `/call` takes.
import { TimeDuration } from 'spacetimedb';
import { Router, SenderError, SyncResponse, t } from 'spacetimedb/server';
import {
  agentFail as agentFailImpl,
  agentProgress as agentProgressImpl,
  leaseLapsed as leaseLapsedImpl,
  publishOptions,
} from './agent';
import {
  activeSession,
  deviceOf,
  isOwner,
  requireActiveSession,
  requireOwner,
  requireOwnerOrCaregiver,
  requireRole,
  requireRoleOrOwner,
  requireScheduler,
  requireStation,
} from './auth';
import {
  allClipsIn,
  applyDueIdle,
  clearScanTimers,
  closeQuestion,
  endPass,
  enterPreparing,
  enterReading,
  enterWindow,
  getScan,
  initialScanState,
  isScanActive,
  isSignalPause,
  optionsOf,
  pause,
  pushIdle,
  recordWordTimings,
  releaseReply,
  resume,
  startScan,
} from './clock';
import { applyTiming, defaultConfig, getConfig } from './config';
import {
  addCallLine as addCallLineImpl,
  attachPreview,
  callTimedOut,
  claimCall as claimCallImpl,
  claimErrand as claimErrandImpl,
  completeErrand as completeErrandImpl,
  errandTimedOut,
  hasConsent,
  readbackDone,
  reportCallStatus as reportCallStatusImpl,
  stopUncovered,
  voidPending,
} from './consent';
import { handleGesture } from './gesture';
import { claimJob, createJob, endJob, requireFencedJob } from './jobs';
import {
  contactGoodFor,
  contactIsGood,
  hasConnectedCall,
  idleDue,
  latestLease,
  leaseLapsed as livenessLapsed,
  nextHealthySince,
} from './liveness';
import { ensureTimers as ensureTimersImpl } from './repair';
import { DAY_MS, HOUR_MS, meter, nextSandboxSettings, requireMeter, sandboxOn, tokenKey } from './sandbox';
import spacetimedb, {
  callTimer,
  errandLease,
  idleTimer,
  jobLease,
  livenessLease,
  OptionInput,
  pairingTimer,
  scanTimer,
  SmokeResult,
  VoiceToken,
  type Role,
  type Session,
} from './schema';
import { computeStats } from './stats';
import {
  appendLedger,
  epochMs,
  emitCue,
  ID_RE,
  isAfter,
  msBetween,
  onceAt,
  parseRole,
  parseScope,
  plusMs,
  requireCountsJson,
  requireMatch,
  requireOptionalText,
  requireText,
  writePipeline,
  type Actor,
} from './util';
import { mintWithKey, tokenError } from './voice';
import type { Identity } from 'spacetimedb';
import type { Ctx } from './ctx';

export default spacetimedb;

export {
  agentConsent,
  agentQueue,
  boardCalls,
  boardErrands,
  boardEvents,
  boardLedger,
  boardPayloads,
  boardSessionLedger,
  boardWordTimings,
  callQueue,
  errandQueue,
  myOptions,
  mySession,
  partnerView,
  publicBoard,
} from './views';

const REQUEST_ID_RE = /^[A-Za-z0-9:_-]{1,64}$/;
const SESSION_LABEL_RE = /^[a-z0-9_-]{1,20}$/;
const CONSENT_METHODS = ['owner_cli', 'caregiver', 'wearer'];

// ---------- Lifecycle (3.9) ----------

/** Runs once, when the database is created. The publisher becomes the owner. */
export const init = spacetimedb.init((ctx) => {
  if (ctx.db.config.id.find(0)) return;
  ctx.db.config.insert(defaultConfig(ctx.sender));
});

/** Presence for Partner, Speaker and Agent devices only. Never pauses anything; the station is heartbeats. */
export const clientConnected = spacetimedb.clientConnected((ctx) => {
  markPresence(ctx, true);
});

export const clientDisconnected = spacetimedb.clientDisconnected((ctx) => {
  markPresence(ctx, false);
});

function markPresence(ctx: Ctx, online: boolean): void {
  const d = deviceOf(ctx.db, ctx.sender);
  if (!d || d.role.tag === 'Station') return;
  const row = { identity: d.identity, role: d.role, label: d.label, online, lastSeenAt: ctx.timestamp, decoderHealthy: undefined };
  if (ctx.db.deviceStatus.identity.find(d.identity)) ctx.db.deviceStatus.identity.update(row);
  else ctx.db.deviceStatus.insert(row);
}

// ---------- Pairing, consent, config and sessions (3.2) ----------

/** A page with no device row shows a random 6-digit code and asks to pair as one role. */
export const requestPairing = spacetimedb.reducer(
  { code: t.u32(), role: t.string(), label: t.string() },
  (ctx, { code, role, label }) => {
    if (deviceOf(ctx.db, ctx.sender)) throw new SenderError('already paired');
    if (!Number.isInteger(code) || code < 100000 || code > 999999) throw new SenderError('code must be 6 digits');
    const r = parseRole(role);
    requireText(label, 'label', 40);
    // The try sandbox (sandbox.ts): no owner at the table, so a Station, Partner or Speaker is paired at once, never as
    // a caregiver. An Agent still waits for the owner.
    const sandbox = sandboxOn(ctx.db);
    if (sandbox && r.tag !== 'Agent') {
      requireMeter(ctx, 'pairings', HOUR_MS, sandbox.pairingsPerHour, 'too many new devices this hour');
      const waiting = ctx.db.pairingRequest.requester.find(ctx.sender);
      if (waiting) ctx.db.pairingRequest.code.delete(waiting.code);
      pairDevice(ctx, ctx.sender, r, label, false);
      appendLedger(ctx, activeSession(ctx.db)?.id ?? 0n, 'device_paired', 'Module', { outcome: r.tag.toLowerCase(), reason: 'sandbox' });
      return;
    }
    const taken = ctx.db.pairingRequest.code.find(code);
    if (taken && !taken.requester.isEqual(ctx.sender)) throw new SenderError('code taken: pick a new code');
    const mine = ctx.db.pairingRequest.requester.find(ctx.sender);
    if (mine) ctx.db.pairingRequest.code.delete(mine.code);
    const cfg = getConfig(ctx.db);
    const expiresAt = plusMs(ctx.timestamp, cfg.pairingTtlMs);
    ctx.db.pairingRequest.insert({ code, requester: ctx.sender, role: r, label, requestedAt: ctx.timestamp, expiresAt });
    ctx.db.pairingTimer.insert({ scheduledId: 0n, scheduledAt: onceAt(expiresAt), code });
  },
);

/** Owner: `spacetime call <db> approve_pairing 482913 false` (the last argument is `caregiver`). */
export const approvePairing = spacetimedb.reducer({ code: t.u32(), caregiver: t.bool() }, (ctx, { code, caregiver }) => {
  requireOwner(ctx);
  const r = ctx.db.pairingRequest.code.find(code);
  if (!r || r.expiresAt.microsSinceUnixEpoch < ctx.timestamp.microsSinceUnixEpoch) throw new SenderError('unknown or expired code');
  pairDevice(ctx, r.requester, r.role, r.label, caregiver);
  ctx.db.pairingRequest.code.delete(code);
  appendLedger(ctx, activeSession(ctx.db)?.id ?? 0n, 'device_paired', 'Owner', { outcome: r.role.tag.toLowerCase(), reason: caregiver ? 'caregiver' : '' });
});

/** Writes the device row and its public status row (offline until it connects). */
function pairDevice(ctx: Ctx, identity: Identity, role: Role, label: string, caregiver: boolean): void {
  const device = { identity, role, label, caregiver, pairedAt: ctx.timestamp, revoked: false };
  if (ctx.db.device.identity.find(identity)) ctx.db.device.identity.update(device);
  else ctx.db.device.insert(device);
  const status = { identity, role, label, online: false, lastSeenAt: ctx.timestamp, decoderHealthy: undefined };
  if (ctx.db.deviceStatus.identity.find(identity)) ctx.db.deviceStatus.identity.update(status);
  else ctx.db.deviceStatus.insert(status);
}

/**
 * Owner: turns the judge try sandbox on or off and sets its limits (sandbox.ts), for example
 * `spacetime call say-when-try set_sandbox '"{\"on\":true}"'`. Only ever turned on for the `say-when-try` database.
 */
export const setSandbox = spacetimedb.reducer({ json: t.string() }, (ctx, { json }) => {
  requireOwner(ctx);
  const current = ctx.db.sandboxSettings.id.find(0);
  const next = nextSandboxSettings(current, json, ctx.timestamp);
  if (current) ctx.db.sandboxSettings.id.update(next);
  else ctx.db.sandboxSettings.insert(next);
  appendLedger(ctx, activeSession(ctx.db)?.id ?? 0n, 'timing', 'Owner', { outcome: next.on ? 'sandbox_on' : 'sandbox_off' });
});

export const revokeDevice = spacetimedb.reducer({ identity: t.identity() }, (ctx, { identity }) => {
  requireOwner(ctx);
  const d = ctx.db.device.identity.find(identity);
  if (!d) throw new SenderError('no such device');
  ctx.db.device.identity.update({ ...d, revoked: true });
  const ds = ctx.db.deviceStatus.identity.find(identity);
  if (ds) ctx.db.deviceStatus.identity.update({ ...ds, online: false, lastSeenAt: ctx.timestamp });
  const session = activeSession(ctx.db);
  if (session && session.station.isEqual(identity)) {
    pause(ctx, getScan(ctx.db, session.id), 'Operator', { actor: 'Owner' });
  }
  appendLedger(ctx, session?.id ?? 0n, 'device_revoked', 'Owner', { outcome: d.role.tag.toLowerCase() });
});

/** Owner or a caregiver phone. `subject` is empty (every subject), a `form_key` (errand) or a `contact_id` (call). */
export const grantConsent = spacetimedb.reducer(
  { scope: t.string(), subject: t.string(), method: t.string(), note: t.string() },
  (ctx, { scope, subject, method, note }) => {
    const who = requireOwnerOrCaregiver(ctx);
    const sc = parseScope(scope);
    if (subject !== '') requireMatch(subject, ID_RE, 'subject');
    if (!CONSENT_METHODS.includes(method)) throw new SenderError('method must be owner_cli, caregiver or wearer');
    requireOptionalText(note, 'note', 80);
    const row = ctx.db.consent.insert({
      id: 0n,
      scope: sc,
      subject,
      grantedBy: ctx.sender,
      method,
      note,
      grantedAt: ctx.timestamp,
      revokedAt: undefined,
    });
    // The subject can be a contact's id, so the public ledger gets only the scope and the row id.
    appendLedger(ctx, activeSession(ctx.db)?.id ?? 0n, 'consent', who, { outcome: `granted:${scope}`, reason: `consent:${row.id}` });
  },
);

export const revokeConsent = spacetimedb.reducer({ consentId: t.u64() }, (ctx, { consentId }) => {
  const who = requireOwnerOrCaregiver(ctx);
  const c = ctx.db.consent.id.find(consentId);
  if (!c || c.revokedAt !== undefined) throw new SenderError('no active consent with that id');
  ctx.db.consent.id.update({ ...c, revokedAt: ctx.timestamp });
  stopUncovered(ctx, c.scope.tag, who);
  const sessionId = activeSession(ctx.db)?.id ?? 0n;
  if (c.scope.tag === 'BoardText' && !hasConsent(ctx.db, 'BoardText', '')) {
    const cfg = getConfig(ctx.db);
    if (cfg.shareTextOnBoard) {
      ctx.db.config.id.update({ ...cfg, shareTextOnBoard: false });
      appendLedger(ctx, sessionId, 'board_sharing', who, { outcome: 'off', reason: 'consent_revoked' });
    }
  }
  appendLedger(ctx, sessionId, 'consent', who, { outcome: `revoked:${c.scope.tag.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()}`, reason: `consent:${c.id}` });
});

/** Owner: `spacetime call <db> set_timing '{"response_window_ms":4000}'`. Unknown keys or bad values change nothing. */
export const setTiming = spacetimedb.reducer({ json: t.string() }, (ctx, { json }) => {
  const cfg = requireOwner(ctx);
  const { next, changed } = applyTiming(cfg, json);
  ctx.db.config.id.update(next);
  appendLedger(ctx, activeSession(ctx.db)?.id ?? 0n, 'timing', 'Owner', { reason: changed.join(',').slice(0, 200) });
});

/** The room's privacy toggle. Turning it on needs an active `board_text` consent row. */
export const setBoardSharing = spacetimedb.reducer({ on: t.bool() }, (ctx, { on }) => {
  const who = requireOwnerOrCaregiver(ctx);
  if (on && !hasConsent(ctx.db, 'BoardText', '')) throw new SenderError('no board_text consent');
  const cfg = getConfig(ctx.db);
  ctx.db.config.id.update({ ...cfg, shareTextOnBoard: on });
  appendLedger(ctx, activeSession(ctx.db)?.id ?? 0n, 'board_sharing', who, { outcome: on ? 'on' : 'off' });
});

/** Owner, after every publish: re-arms any schedule row that should exist and does not. */
export const ensureTimers = spacetimedb.reducer((ctx) => {
  requireOwner(ctx);
  const repaired = ensureTimersImpl(ctx);
  if (repaired.length > 0) appendLedger(ctx, activeSession(ctx.db)?.id ?? 0n, 'timing', 'Owner', { outcome: 'ensure_timers', reason: repaired.join(',').slice(0, 200) });
});

/** The wearer is ready. The first dead-man lease is already counting, so the station beats at once. */
export const startSession = spacetimedb.reducer({ label: t.string() }, (ctx, { label }) => {
  const device = requireRole(ctx, 'Station');
  requireMatch(label, SESSION_LABEL_RE, 'label');
  const sandbox = sandboxOn(ctx.db);
  const active = activeSession(ctx.db);
  if (active && !sandbox) throw new SenderError('a session is active');
  if (sandbox) {
    // One try at a time. A try whose station went quiet (the judge closed the tab) or that ran past its time gives
    // way; a live one does not.
    if (active) {
      const lease = latestLease(ctx.db, active.id);
      const quietMs = msBetween(ctx.timestamp, lease ? lease.lastBeatAt : active.startedAt);
      const ageMs = msBetween(ctx.timestamp, active.startedAt);
      if (quietMs < sandbox.staleTryMs && ageMs < sandbox.maxTryMs) throw new SenderError('busy: someone else is trying Eleven right now');
    }
    requireMeter(ctx, 'tries', HOUR_MS, sandbox.triesPerHour, 'the tries for this hour are used up');
    if (active) closeSession(ctx, active, 'Module', 'replaced');
  }
  const cfg = getConfig(ctx.db);
  const session = ctx.db.session.insert({
    id: 0n,
    station: ctx.sender,
    label,
    startedAt: ctx.timestamp,
    endedAt: undefined,
    questionCount: 0,
    lastAcceptedAt: undefined,
    lastCommandAt: ctx.timestamp,
    idleSeq: 0n,
  });
  ctx.db.scanState.insert(initialScanState(ctx, session.id, cfg.maxPasses));
  ctx.db.livenessLease.insert({
    scheduledId: 0n,
    scheduledAt: onceAt(plusMs(ctx.timestamp, cfg.livenessLeaseMs)),
    sessionId: session.id,
    beatSeq: 0n,
    lastBeatAt: ctx.timestamp,
    decoderHealthy: false,
    healthySince: undefined,
  });
  ctx.db.config.id.update({ ...cfg, activeSessionId: session.id });
  pushIdle(ctx, session.id);
  const ds = ctx.db.deviceStatus.identity.find(ctx.sender);
  const status = { identity: ctx.sender, role: device.role, label: device.label, online: true, lastSeenAt: ctx.timestamp, decoderHealthy: ds?.decoderHealthy };
  if (ds) ctx.db.deviceStatus.identity.update(status);
  else ctx.db.deviceStatus.insert(status);
  appendLedger(ctx, session.id, 'session_start', 'Station', { outcome: label });
});

/** The session's Station or the owner. Voids everything pending and stops the clock and the dead-man timers. */
export const endSession = spacetimedb.reducer((ctx) => {
  const session = requireActiveSession(ctx);
  const owner = isOwner(ctx);
  if (!owner) {
    requireRole(ctx, 'Station');
    if (!session.station.isEqual(ctx.sender)) throw new SenderError('not the session station');
  }
  closeSession(ctx, session, owner ? 'Owner' : 'Station');
});

/**
 * Ends a session: voids everything pending, cancels open questions and their jobs, and stops the clock and the
 * dead-man timers. `reason` goes on the ledger row (the sandbox's `replaced` and `try_time`).
 */
function closeSession(ctx: Ctx, session: Session, actor: Actor, reason = ''): void {
  voidPending(ctx, session.id, 'session_ended', actor);
  for (const q of [...ctx.db.question.questionBySession.filter(session.id)]) {
    if (['Drafting', 'Ready', 'Scanning'].includes(q.status.tag)) {
      ctx.db.question.id.update({ ...q, status: { tag: 'Cancelled' }, outcome: { tag: 'Cancelled' }, endedAt: ctx.timestamp });
      for (const j of [...ctx.db.agentJob.jobByQuestion.filter(q.id)]) {
        if (j.status.tag === 'Pending' || j.status.tag === 'Claimed') endJob(ctx, j, 'Cancelled', 'session_ended');
      }
    }
  }
  clearScanTimers(ctx, session.id);
  for (const r of [...ctx.db.livenessLease.sessionId.filter(session.id)]) ctx.db.livenessLease.scheduledId.delete(r.scheduledId);
  for (const r of [...ctx.db.idleTimer.sessionId.filter(session.id)]) ctx.db.idleTimer.scheduledId.delete(r.scheduledId);
  const s = getScan(ctx.db, session.id);
  // A scan still open (or paused before it ended) ends Cancelled with no pick. One that already ended keeps its outcome
  // and, for Picked, its pick (module v2): the board still names the option the person chose.
  const open = isScanActive(s) || (s.phase.tag === 'Paused' && s.outcome === undefined);
  ctx.db.scanState.sessionId.update({
    ...s,
    phase: { tag: 'Idle' },
    outcome: open ? { tag: 'Cancelled' } : s.outcome,
    pickedRank: open ? undefined : s.pickedRank,
    pickedOptionId: open ? undefined : s.pickedOptionId,
    pauseReason: undefined,
    pausedAt: undefined,
    stepSeq: s.stepSeq + 1n,
    stepStartedAt: ctx.timestamp,
    stepEndsAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  });
  ctx.db.session.id.update({ ...ctx.db.session.id.find(session.id)!, endedAt: ctx.timestamp });
  appendLedger(ctx, session.id, 'session_end', actor, reason ? { reason } : {});
}

/** Anyone paired as Partner or Speaker, or the owner, can pause. Only the owner lifts an operator pause. */
export const operatorPause = spacetimedb.reducer((ctx) => {
  const device = requireRoleOrOwner(ctx, 'Partner', 'Speaker');
  const session = requireActiveSession(ctx);
  pause(ctx, getScan(ctx.db, session.id), 'Operator', { actor: device ? (device.role.tag === 'Speaker' ? 'Speaker' : 'Partner') : 'Owner' });
});

export const operatorResume = spacetimedb.reducer((ctx) => {
  requireOwner(ctx);
  const session = requireActiveSession(ctx);
  const s = getScan(ctx.db, session.id);
  if (s.phase.tag !== 'Paused') throw new SenderError('not paused');
  resume(ctx, s, 'Owner');
});

/**
 * Owner, after the event: deletes an ended session's questions, options, agent jobs, payloads, gestures, ledger,
 * errands and calls. Each deleted gesture leaves only its random id in `spent_gesture`, so a replayed request from
 * this session can never count as a new gesture later (a used CONFIRM stays used).
 */
export const purgeSession = spacetimedb.reducer({ sessionId: t.u64() }, (ctx, { sessionId }) => {
  requireOwner(ctx);
  const session = ctx.db.session.id.find(sessionId);
  if (!session) throw new SenderError('no such session');
  if (session.endedAt === undefined) throw new SenderError('session still active');
  for (const q of [...ctx.db.question.questionBySession.filter(sessionId)]) {
    for (const o of [...ctx.db.answerOption.optionByQuestion.filter(q.id)]) ctx.db.answerOption.id.delete(o.id);
    // Jobs carry the question's work (a Remember job would still write the reply into memory): delete them too.
    for (const j of [...ctx.db.agentJob.jobByQuestion.filter(q.id)]) {
      for (const l of [...ctx.db.jobLease.jobId.filter(j.id)]) ctx.db.jobLease.scheduledId.delete(l.scheduledId);
      ctx.db.agentJob.id.delete(j.id);
    }
    ctx.db.question.id.delete(q.id);
  }
  for (const p of [...ctx.db.pipelinePayload.payloadBySession.filter(sessionId)]) ctx.db.pipelinePayload.eventId.delete(p.eventId);
  for (const w of [...ctx.db.wordTiming.timingBySession.filter(sessionId)]) ctx.db.wordTiming.eventId.delete(w.eventId);
  for (const g of [...ctx.db.gestureLog.gestureBySession.filter(sessionId)]) {
    if (!ctx.db.spentGesture.gestureId.find(g.gestureId)) ctx.db.spentGesture.insert({ gestureId: g.gestureId, spentAt: ctx.timestamp });
    ctx.db.gestureLog.gestureId.delete(g.gestureId);
  }
  for (const l of [...ctx.db.ledger.ledgerBySession.filter(sessionId)]) ctx.db.ledger.id.delete(l.id);
  for (const e of [...ctx.db.errand.errandBySession.filter(sessionId)]) {
    for (const r of [...ctx.db.errandLease.errandId.filter(e.id)]) ctx.db.errandLease.scheduledId.delete(r.scheduledId);
    ctx.db.errand.id.delete(e.id);
  }
  for (const c of [...ctx.db.callRequest.callBySession.filter(sessionId)]) {
    for (const l of [...ctx.db.callLine.callId.filter(c.id)]) ctx.db.callLine.id.delete(l.id);
    for (const r of [...ctx.db.callTimer.callId.filter(c.id)]) ctx.db.callTimer.scheduledId.delete(r.scheduledId);
    ctx.db.callRequest.id.delete(c.id);
  }
});

// ---------- The partner (3.3) ----------

/** The partner's question. A repeated `request_id` is a retry and does nothing. */
export const askQuestion = spacetimedb.reducer(
  { requestId: t.string(), text: t.string(), via: t.string(), listenMs: t.u32() },
  (ctx, { requestId, text, via, listenMs }) => {
    requireRoleOrOwner(ctx, 'Partner');
    const session = requireActiveSession(ctx);
    requireMatch(requestId, REQUEST_ID_RE, 'request_id');
    if (ctx.db.question.requestId.find(requestId)) return;
    requireText(text, 'text', 500);
    if (via !== 'voice' && via !== 'typed') throw new SenderError('via must be voice or typed');
    const sandbox = sandboxOn(ctx.db);
    if (sandbox) {
      if (session.questionCount >= sandbox.questionsPerTry) {
        throw new SenderError(`try limit: ${sandbox.questionsPerTry} questions per try. Start a new try.`);
      }
      requireMeter(ctx, 'questions', DAY_MS, sandbox.questionsPerDay, 'the questions for today are used up');
    }
    const number = session.questionCount + 1;
    ctx.db.session.id.update({ ...session, questionCount: number });
    const q = ctx.db.question.insert({
      id: 0n,
      sessionId: session.id,
      requestId,
      origin: { tag: 'Partner' },
      via,
      menuItem: { tag: 'None' },
      askedBy: ctx.sender,
      text,
      number,
      answerMode: { tag: 'Pick' },
      version: 0,
      pendingVersion: 0,
      pendingAnswerMode: { tag: 'Pick' },
      status: { tag: 'Drafting' },
      outcome: undefined,
      pickedOptionId: undefined,
      replyText: undefined,
      replyTone: undefined,
      listenMs,
      askedAt: ctx.timestamp,
      readyAt: undefined,
      releasedAt: undefined,
      spokenAt: undefined,
      endedAt: undefined,
    });
    createJob(ctx, 'Options', {
      sessionId: session.id,
      questionId: q.id,
      webSearchAllowed: hasConsent(ctx.db, 'WebSearch', ''),
      memoryAllowed: hasConsent(ctx.db, 'Memory', ''),
    });
    writePipeline(ctx, {
      eventKey: `listen:${requestId}`,
      sessionId: session.id,
      questionId: q.id,
      stage: 'listen',
      status: 'ok',
      detail: via === 'voice' ? 'heard' : 'typed',
      ms: listenMs,
      countsJson: JSON.stringify({ wordCount: text.trim().split(/\s+/).length }),
      actor: 'Partner',
      payloadJson: JSON.stringify({ words: text }),
    });
    appendLedger(ctx, session.id, 'question', 'Partner', { questionId: q.id, outcome: 'asked', reason: via });

    const s = getScan(ctx.db, session.id);
    if (s.phase.tag === 'Paused') {
      emitCue(ctx, session.id, 'question_waiting', { questionId: q.id });
      if (s.pauseReason?.tag === 'Idle') resume(ctx, s, 'Partner');
      return;
    }
    if (s.phase.tag === 'Veto') return; // waits for the reply to be said or cancelled
    // Supersede: an older open question (including an open menu) is cancelled with its job, and anything nobody has
    // claimed yet is stopped. Then this question is prepared.
    for (const older of [...ctx.db.question.questionBySession.filter(session.id)]) {
      if (older.id === q.id || !['Drafting', 'Ready', 'Scanning'].includes(older.status.tag)) continue;
      ctx.db.question.id.update({ ...older, status: { tag: 'Cancelled' }, outcome: { tag: 'Cancelled' }, endedAt: ctx.timestamp });
      for (const j of [...ctx.db.agentJob.jobByQuestion.filter(older.id)]) {
        if (j.kind.tag === 'Options' && (j.status.tag === 'Pending' || j.status.tag === 'Claimed')) endJob(ctx, j, 'Cancelled', 'superseded');
      }
      appendLedger(ctx, session.id, 'question', 'Partner', { questionId: older.id, outcome: 'cancelled', reason: 'superseded' });
    }
    voidPending(ctx, session.id, 'interrupted', 'Partner', { liveCalls: false });
    enterPreparing(ctx, getScan(ctx.db, session.id), ctx.db.question.id.find(q.id)!);
  },
);

export const cancelQuestion = spacetimedb.reducer({ questionId: t.u64() }, (ctx, { questionId }) => {
  const device = requireRoleOrOwner(ctx, 'Partner');
  const q = ctx.db.question.id.find(questionId);
  if (!q) throw new SenderError('no such question');
  if (!['Drafting', 'Ready', 'Scanning'].includes(q.status.tag)) throw new SenderError('already released, picked or ended');
  closeQuestion(ctx, q, { status: 'Cancelled', outcome: 'Cancelled', reason: 'cancelled', actor: device ? 'Partner' : 'Owner' });
});

/** Optional: the board shows "Listening" while the partner holds to talk. */
export const partnerListening = spacetimedb.reducer({ requestId: t.string(), on: t.bool() }, (ctx, { requestId, on }) => {
  requireRole(ctx, 'Partner');
  const session = requireActiveSession(ctx);
  requireMatch(requestId, REQUEST_ID_RE, 'request_id');
  writePipeline(ctx, {
    eventKey: `listen:${requestId}:${on ? 'started' : 'stopped'}`,
    sessionId: session.id,
    questionId: 0n,
    stage: 'listen',
    status: on ? 'started' : 'ok',
    detail: on ? 'listening' : 'stopped listening',
    actor: 'Partner',
  });
});

// ---------- The station (3.4) ----------

/** The station measured an option's synthesized clip. When every clip is in, a Preparing scan starts. */
export const reportClipReady = spacetimedb.reducer(
  { optionId: t.u64(), clipMs: t.u32(), synthMs: t.u32() },
  (ctx, { optionId, clipMs, synthMs }) => {
    const { session } = requireStation(ctx);
    if (clipMs < 1 || clipMs > 30000) throw new SenderError('clip_ms must be 1 to 30000');
    const o = ctx.db.answerOption.id.find(optionId);
    if (!o) return;
    const q = ctx.db.question.id.find(o.questionId);
    if (!q || q.sessionId !== session.id) return;
    if (o.version !== q.version && o.version !== q.pendingVersion) return; // late clips are normal
    ctx.db.answerOption.id.update({ ...o, clipMs });
    if (allClipsIn(ctx.db, q.id, o.version)) {
      const opts = optionsOf(ctx.db, q.id, o.version);
      writePipeline(ctx, {
        eventKey: `q${q.id}:v${o.version}:clips`,
        sessionId: session.id,
        questionId: q.id,
        stage: 'speak',
        status: 'ok',
        detail: 'earpiece',
        ms: Math.max(0, msBetween(ctx.timestamp, opts[0]!.createdAt)),
        countsJson: JSON.stringify({ clips: opts.length, synthMs }),
        actor: 'Station',
      });
      appendLedger(ctx, session.id, 'clips_ready', 'Station', { questionId: q.id, outcome: `version:${o.version}` });
      const s = getScan(ctx.db, session.id);
      if (s.phase.tag === 'Preparing' && s.questionId === q.id && q.version === o.version) startScan(ctx, s, q);
    }
  },
);

/** The station finished reading an errand or call back, with the digest it played. A mismatch throws. */
export const reportReadbackDone = spacetimedb.reducer(
  { kind: t.string(), id: t.u64(), digest: t.string() },
  (ctx, { kind, id, digest }) => {
    const { session } = requireStation(ctx);
    readbackDone(ctx, session, kind, id, digest);
  },
);

/**
 * Module v2: the word timings of one read, from Cartesia's word timestamps for the clip the station played. The
 * read is its session (the active one), the step it began at and its option (0 for a yes or no prompt). Numbers
 * only, at most 100 words, each end at or after its start, at most 30000 ms; one row per read, so a repeat is a
 * retry (clock.ts `recordWordTimings`).
 */
export const reportWordTimings = spacetimedb.reducer(
  { sessionId: t.u64(), stepSeq: t.u64(), optionId: t.u64(), startsMs: t.array(t.u32()), endsMs: t.array(t.u32()) },
  (ctx, { sessionId, stepSeq, optionId, startsMs, endsMs }) => {
    const { session } = requireStation(ctx);
    recordWordTimings(ctx, session, sessionId, stepSeq, optionId, startsMs, endsMs);
  },
);

/**
 * Every `heartbeat_ms`: pushes the dead-man lease forward (delete and insert), pauses on a bad decoder, and resumes
 * a signal pause after `resume_good_contact_ms` of healthy beats.
 */
export const heartbeat = spacetimedb.reducer({ beatSeq: t.u64(), decoderHealthy: t.bool() }, (ctx, { beatSeq, decoderHealthy }) => {
  const { device, session } = requireStation(ctx);
  const sandbox = sandboxOn(ctx.db);
  if (sandbox && msBetween(ctx.timestamp, session.startedAt) >= sandbox.maxTryMs) {
    // A try has a time limit. The beat that finds it over ends it; the station sees its session end.
    closeSession(ctx, session, 'Module', 'try_time');
    return;
  }
  const cfg = getConfig(ctx.db);
  const previous = latestLease(ctx.db, session.id);
  // A beat that arrives after its lease ran out found the dead-man deadline passed before `liveness_expired` ran.
  // Deleting that lease would cancel the pause, so the beat pauses here first, exactly as the timer would have
  // (voiding anything waiting for a confirm); recovery is the usual healthy-contact resume below.
  if (previous && livenessLapsed(previous, ctx.timestamp)) {
    pause(ctx, getScan(ctx.db, session.id), 'HeadsetLost', { actor: 'Module', latencyMs: Math.max(0, msBetween(ctx.timestamp, previous.lastBeatAt)) });
  }
  for (const l of [...ctx.db.livenessLease.sessionId.filter(session.id)]) {
    ctx.db.livenessLease.scheduledId.delete(l.scheduledId);
  }
  // Kept only across continuous healthy beats: a lapsed lease or a bad beat starts the count again.
  const healthySince = nextHealthySince(previous, decoderHealthy, ctx.timestamp);
  ctx.db.livenessLease.insert({
    scheduledId: 0n,
    scheduledAt: onceAt(plusMs(ctx.timestamp, cfg.livenessLeaseMs)),
    sessionId: session.id,
    beatSeq,
    lastBeatAt: ctx.timestamp,
    decoderHealthy,
    healthySince,
  });
  // Board traffic: only on a change, or every 2 s.
  const ds = ctx.db.deviceStatus.identity.find(ctx.sender);
  if (!ds || !ds.online || ds.decoderHealthy !== decoderHealthy || msBetween(ctx.timestamp, ds.lastSeenAt) >= 2000) {
    const row = { identity: ctx.sender, role: device.role, label: device.label, online: true, lastSeenAt: ctx.timestamp, decoderHealthy };
    if (ds) ctx.db.deviceStatus.identity.update(row);
    else ctx.db.deviceStatus.insert(row);
  }
  const s = getScan(ctx.db, session.id);
  if (!decoderHealthy) {
    pause(ctx, s, 'HeadsetOff', { actor: 'Station' }); // never replaces a deliberate pause
  } else if (
    s.phase.tag === 'Paused' &&
    isSignalPause(s.pauseReason) &&
    cfg.autoResume &&
    contactGoodFor(ctx.db, session.id, ctx.timestamp, cfg.resumeGoodContactMs, s.pausedAt)
  ) {
    resume(ctx, s, 'Station');
  }
});

/** The heart of the module: one decoded command, matched to the step the person heard (gesture.ts). */
export const gesture = spacetimedb.reducer(
  {
    gestureId: t.string(),
    command: t.string(),
    heardStepSeq: t.u64(),
    heardOptionId: t.u64(),
    heardDigest: t.string(),
    confidence: t.f32(),
    source: t.string(),
    onsetAgeMs: t.u32(),
  },
  (ctx, args) => {
    handleGesture(ctx, args);
  },
);

// ---------- The speaker (3.5) ----------

export const replySpoken = spacetimedb.reducer({ questionId: t.u64(), ms: t.u32() }, (ctx, { questionId, ms }) => {
  requireRole(ctx, 'Speaker');
  const q = ctx.db.question.id.find(questionId);
  if (!q) throw new SenderError('no such question');
  if (q.status.tag === 'Spoken') return; // a second speaker
  if (q.status.tag !== 'Released') throw new SenderError('reply is not released');
  ctx.db.question.id.update({ ...q, status: { tag: 'Spoken' }, spokenAt: ctx.timestamp, endedAt: ctx.timestamp });
  const picked = q.pickedOptionId !== undefined ? ctx.db.answerOption.id.find(q.pickedOptionId) : undefined;
  writePipeline(ctx, {
    eventKey: `q${q.id}:aloud`,
    sessionId: q.sessionId,
    questionId: q.id,
    stage: 'speak',
    status: 'ok',
    detail: 'aloud',
    ms,
    actor: 'Speaker',
    payloadJson: JSON.stringify({
      optionId: picked ? Number(picked.id) : 0,
      rank: picked?.rank ?? 0,
      text: q.replyText ?? '',
      channel: 'aloud',
      durationMs: ms,
    }),
  });
  appendLedger(ctx, q.sessionId, 'reply_spoken', 'Speaker', { questionId: q.id, optionId: picked?.id, ms });
  if (hasConsent(ctx.db, 'Memory', '')) createJob(ctx, 'Remember', { sessionId: q.sessionId, questionId: q.id, memoryAllowed: true });
});

// ---------- The agent sidecar (3.6, 3.7) ----------

export const agentClaim = spacetimedb.reducer({ jobId: t.u64() }, (ctx, { jobId }) => {
  requireRole(ctx, 'Agent');
  const job = ctx.db.agentJob.id.find(jobId);
  const sessionId = job ? (ctx.db.question.id.find(job.questionId)?.sessionId ?? 0n) : 0n;
  claimJob(ctx, jobId, sessionId);
});

/** One pipeline stage from the sidecar; also extends the lease. A repeated `event_key` does nothing. */
export const agentProgress = spacetimedb.reducer(
  {
    jobId: t.u64(),
    attempt: t.u32(),
    eventKey: t.string(),
    stage: t.string(),
    status: t.string(),
    detail: t.string(),
    ms: t.u32(),
    countsJson: t.string(),
    payloadJson: t.string(),
  },
  (ctx, { jobId, attempt, eventKey, stage, status, detail, ms, countsJson, payloadJson }) => {
    const job = requireFencedJob(ctx, jobId, attempt);
    agentProgressImpl(ctx, job, { eventKey, stage, status, detail, ms, countsJson, payloadJson });
  },
);

/** Up to `max_options` options (exactly 2 for `yes_no`). `final = false` keeps the job for a later version. */
export const agentPublishOptions = spacetimedb.reducer(
  { jobId: t.u64(), attempt: t.u32(), answerMode: t.string(), options: t.array(OptionInput), final: t.bool() },
  (ctx, { jobId, attempt, answerMode, options, final }) => {
    const job = requireFencedJob(ctx, jobId, attempt);
    publishOptions(ctx, job, answerMode, options, final);
  },
);

/** The form-errand Actor's preview for a Drafted errand. If STOP was quicker, the job is Done and nothing changes. */
export const agentAttachPreview = spacetimedb.reducer(
  {
    jobId: t.u64(),
    attempt: t.u32(),
    status: t.string(),
    formTitle: t.string(),
    readBackText: t.string(),
    readBackJson: t.string(),
    previewDigest: t.string(),
    screenshotUrl: t.string(),
    reasonCode: t.string(),
    reason: t.string(),
    previewMs: t.u32(),
  },
  (ctx, a) => {
    const job = requireFencedJob(ctx, a.jobId, a.attempt);
    if (job.kind.tag !== 'ErrandPreview') throw new SenderError('not a preview job');
    attachPreview(ctx, job.errandId, a);
    endJob(ctx, job, 'Done');
  },
);

export const agentFail = spacetimedb.reducer(
  { jobId: t.u64(), attempt: t.u32(), reasonCode: t.string(), reason: t.string() },
  (ctx, { jobId, attempt, reasonCode, reason }) => {
    const job = requireFencedJob(ctx, jobId, attempt);
    agentFailImpl(ctx, job, reasonCode, reason);
  },
);

/** A Remember job is done (the spoken reply is in Moss). */
export const agentDone = spacetimedb.reducer({ jobId: t.u64(), attempt: t.u32(), countsJson: t.string() }, (ctx, { jobId, attempt, countsJson }) => {
  const job = requireFencedJob(ctx, jobId, attempt);
  if (job.kind.tag !== 'Remember') throw new SenderError('not a remember job');
  requireCountsJson(countsJson);
  endJob(ctx, job, 'Done');
});

/** Only a Confirmed errand, with the digest the person heard, and only once. */
export const claimErrand = spacetimedb.reducer({ errandId: t.u64(), digest: t.string() }, (ctx, { errandId, digest }) => {
  requireRole(ctx, 'Agent');
  claimErrandImpl(ctx, errandId, digest);
});

export const completeErrand = spacetimedb.reducer(
  {
    errandId: t.u64(),
    attempt: t.u32(),
    status: t.string(),
    confirmationText: t.string(),
    screenshotUrl: t.string(),
    reasonCode: t.string(),
    reason: t.string(),
    submitMs: t.u32(),
  },
  (ctx, { errandId, ...rest }) => {
    requireRole(ctx, 'Agent');
    completeErrandImpl(ctx, errandId, rest);
  },
);

/** Stretch. The sidecar must call `dialer.place(requestId, digest)` at once: the Dialer refuses after 30 s. */
export const claimCall = spacetimedb.reducer({ callId: t.u64(), digest: t.string() }, (ctx, { callId, digest }) => {
  requireRole(ctx, 'Agent');
  claimCallImpl(ctx, callId, digest);
});

export const reportCallStatus = spacetimedb.reducer(
  {
    callId: t.u64(),
    attempt: t.u32(),
    status: t.string(),
    result: t.string(),
    endReason: t.string(),
    reasonCode: t.string(),
    reason: t.string(),
  },
  (ctx, { callId, ...rest }) => {
    requireRole(ctx, 'Agent');
    // Once a call is Connected, `idle_pause` only re-arms. So an idle pause already due (its timer late) is applied
    // before the call counts as Connected: it voids waiting work and asks for the hang-up, then the report lands
    // on the re-read row and keeps that request. A refused report rolls the pause back with it.
    if (rest.status === 'connected') {
      const c = ctx.db.callRequest.id.find(callId);
      const session = c ? ctx.db.session.id.find(c.sessionId) : undefined;
      if (session) applyDueIdle(ctx, session);
    }
    reportCallStatusImpl(ctx, callId, rest);
  },
);

export const addCallLine = spacetimedb.reducer(
  { callId: t.u64(), attempt: t.u32(), lineKey: t.string(), role: t.string(), text: t.string() },
  (ctx, { callId, attempt, lineKey, role, text }) => {
    requireRole(ctx, 'Agent');
    addCallLineImpl(ctx, callId, attempt, lineKey, role, text);
  },
);

// ---------- Scheduled reducers (3.8): each checks the scheduler, then its row's fence ----------

/** The scan clock's tick. A row whose `stepSeq` is not the current one is stale and does nothing. */
export const scanTick = spacetimedb.reducer({ onSchedule: scanTimer }, { job: scanTimer.rowType }, (ctx, { job }) => {
  requireScheduler(ctx);
  const s = ctx.db.scanState.sessionId.find(job.sessionId);
  if (!s || s.stepSeq !== job.stepSeq) return;
  const session = ctx.db.session.id.find(job.sessionId);
  if (!session || session.endedAt !== undefined) return;
  switch (job.kind.tag) {
    case 'StepEnd':
      if (s.phase.tag === 'Reading') {
        enterWindow(ctx, s);
      } else if (s.phase.tag === 'Window') {
        if (s.answerMode.tag === 'Pick' && s.cursor < s.optionCount) enterReading(ctx, s, s.cursor + 1);
        else endPass(ctx, s);
      }
      return;
    case 'VetoEnd': {
      if (s.phase.tag !== 'Veto') return;
      // The reply is said only with good contact now: the newest lease healthy and not run out. A lease that ran out
      // before this tick (its own timer due but perhaps not run, since overdue timers need not run in order), or no
      // lease at all (the host deletes a fired one, and a deliberate resume needs no heartbeat), pauses here instead,
      // as `liveness_expired` would have: the pick is cancelled and nothing is said.
      if (!contactIsGood(ctx.db, session.id, ctx.timestamp)) {
        const lease = latestLease(ctx.db, session.id);
        pause(ctx, s, 'HeadsetLost', { actor: 'Scheduler', latencyMs: lease ? Math.max(0, msBetween(ctx.timestamp, lease.lastBeatAt)) : 0 });
        return;
      }
      // The same for a due idle pause (the YES that started the veto pushed the deadline, so this guards a late tick).
      if (idleDue(ctx.db, session, ctx.timestamp)) {
        pause(ctx, s, 'Idle', { actor: 'Scheduler' });
        return;
      }
      releaseReply(ctx, s);
      return;
    }
    case 'ClipDeadline':
      if (s.phase.tag === 'Preparing') {
        const q = ctx.db.question.id.find(s.questionId);
        if (q && q.version > 0) startScan(ctx, s, q); // with estimated clip lengths
      }
      return;
  }
});

/** The dead-man interlock: no heartbeat for `liveness_lease_ms` pauses everything and voids pending confirms. */
export const livenessExpired = spacetimedb.reducer({ onSchedule: livenessLease }, { job: livenessLease.rowType }, (ctx, { job }) => {
  requireScheduler(ctx);
  const session = activeSession(ctx.db);
  if (!session || session.id !== job.sessionId) return;
  const current = ctx.db.livenessLease.scheduledId.find(job.scheduledId);
  if (!current || current.beatSeq !== job.beatSeq) return; // a newer heartbeat replaced it
  const latencyMs = Math.max(0, msBetween(ctx.timestamp, job.lastBeatAt));
  pause(ctx, getScan(ctx.db, session.id), 'HeadsetLost', { actor: 'Scheduler', latencyMs });
  const ds = ctx.db.deviceStatus.identity.find(session.station);
  if (ds && ds.online) ctx.db.deviceStatus.identity.update({ ...ds, online: false });
});

/** Two minutes (`idle_pause_ms`) with no accepted command pauses, except during a connected call: then it re-arms. */
export const idlePause = spacetimedb.reducer({ onSchedule: idleTimer }, { job: idleTimer.rowType }, (ctx, { job }) => {
  requireScheduler(ctx);
  const session = ctx.db.session.id.find(job.sessionId);
  if (!session || session.endedAt !== undefined || session.idleSeq !== job.idleSeq) return;
  const s = getScan(ctx.db, session.id);
  if (s.phase.tag === 'Paused') return;
  if (hasConnectedCall(ctx.db, session.id)) {
    pushIdle(ctx, session.id);
    return;
  }
  pause(ctx, s, 'Idle', { actor: 'Scheduler' });
});

/** An agent job's lease lapsed: requeue (read-only work is safe to rerun) or fail. Fenced by attempt. */
export const leaseExpired = spacetimedb.reducer({ onSchedule: jobLease }, { job: jobLease.rowType }, (ctx, { job }) => {
  requireScheduler(ctx);
  const row = ctx.db.agentJob.id.find(job.jobId);
  if (!row || row.status.tag !== 'Claimed' || row.attempt !== job.attempt) return;
  // Progress extends a lease by replacing its row with the same attempt; an older row of that attempt is stale.
  if (row.leaseExpiresAt && isAfter(row.leaseExpiresAt, ctx.timestamp)) return;
  leaseLapsedImpl(ctx, row);
});

export const errandTimeout = spacetimedb.reducer({ onSchedule: errandLease }, { job: errandLease.rowType }, (ctx, { job }) => {
  requireScheduler(ctx);
  errandTimedOut(ctx, job.errandId, job.kind.tag, job.seq);
});

export const callTimeout = spacetimedb.reducer({ onSchedule: callTimer }, { job: callTimer.rowType }, (ctx, { job }) => {
  requireScheduler(ctx);
  callTimedOut(ctx, job.callId, job.kind.tag, job.seq);
});

export const pairingExpired = spacetimedb.reducer({ onSchedule: pairingTimer }, { job: pairingTimer.rowType }, (ctx, { job }) => {
  requireScheduler(ctx);
  const r = ctx.db.pairingRequest.code.find(job.code);
  if (r && r.expiresAt.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch) ctx.db.pairingRequest.code.delete(job.code);
});

// ---------- Procedures (6.1, 6.3) ----------

/**
 * A 60-second Cartesia token for a paired browser: `tts` for a Station or Speaker, `stt` for a Partner. The key is
 * the module env var `CARTESIA_API_KEY`; the token goes only to the caller. Untested on Maincloud (smoke step S1).
 */
export const mintVoiceToken = spacetimedb.procedure({ purpose: t.string() }, VoiceToken, (ctx, { purpose }) => {
  if (purpose !== 'tts' && purpose !== 'stt') return tokenError('bad_purpose');
  const allowed = ctx.withTx((tx): 'yes' | 'no' | 'limit' => {
    const d = deviceOf(tx.db, tx.sender);
    if (!d) return 'no';
    const fits = purpose === 'stt' ? d.role.tag === 'Partner' : d.role.tag === 'Station' || d.role.tag === 'Speaker';
    if (!fits) return 'no';
    // The try sandbox: a cap per device and one for every device, per hour (sandbox.ts).
    const sandbox = sandboxOn(tx.db);
    if (sandbox) {
      if (!meter(tx, tokenKey(tx.sender), HOUR_MS, sandbox.tokensPerDevicePerHour)) return 'limit';
      if (!meter(tx, 'tokens', HOUR_MS, sandbox.tokensPerHour)) return 'limit';
    }
    return 'yes';
  });
  if (allowed === 'no') return tokenError('not_paired_for_purpose');
  if (allowed === 'limit') return tokenError('voice_try_limit');
  let key: string | undefined;
  try {
    key = ctx.env.CARTESIA_API_KEY;
  } catch {
    key = undefined;
  }
  if (!key) return tokenError('voice_key_missing');
  return mintWithKey(ctx, key, purpose);
});

/** Owner-only probe for smoke step S1: does outbound HTTP from a procedure work on this host? */
export const smokeFetch = spacetimedb.procedure({ url: t.string() }, SmokeResult, (ctx, { url }) => {
  const owner = ctx.withTx((tx) => {
    const c = tx.db.config.id.find(0);
    return !!c && c.owner.isEqual(tx.sender);
  });
  if (!owner) return { status: 0, ms: 0, error: 'owner only' };
  if (!url.startsWith('https://')) return { status: 0, ms: 0, error: 'https only' };
  const elapsed = () => Math.max(0, msBetween(ctx.withTx((tx) => tx.timestamp), ctx.timestamp));
  try {
    const r = ctx.http.fetch(url, { method: 'GET', timeout: TimeDuration.fromMillis(5000) });
    return { status: r.status, ms: elapsed(), error: '' };
  } catch (e) {
    return { status: 0, ms: elapsed(), error: e instanceof Error ? e.message.slice(0, 200) : 'fetch failed' };
  }
});

// ---------- HTTP routes (6.2, beta; untested on Maincloud: smoke step S2) ----------

/** `GET /v1/database/<db>/route/stats`: numbers any judge can check with no key, recomputed from stored rows. */
export const stats = spacetimedb.httpHandler((ctx, _req) => {
  const body = ctx.withTx((tx) => computeStats(tx.db));
  return new SyncResponse(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });
});

/** Smoke step S2 only. */
export const ping = spacetimedb.httpHandler((ctx, _req) => {
  return new SyncResponse(JSON.stringify({ ok: true, at: epochMs(ctx.timestamp) }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });
});

export const routes = spacetimedb.httpRouter(new Router().get('/stats', stats).get('/ping', ping));
