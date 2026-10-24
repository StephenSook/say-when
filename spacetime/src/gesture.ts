// The gesture decision table (docs/spacetime.md 3.4 `gesture`, 4.2). One command from the session's Station,
// matched to what the person heard, decided against the scan and anything pending, and always recorded.
//
// A valid command with nothing to do is recorded as `ignored:<reason>` and returns success: a throw would roll
// back the record of what the person did. Only a malformed call or the wrong caller throws.
//
// Precedence when more than one thing is live (the design's table is per state; this is the order used):
//   1. a pause; 2. an errand or call nobody has claimed yet (read-back and confirm); 3. the scan (preparing, reading,
//   window, veto); 4. a live call or a submitting errand; 5. idle. STOP is the exception that adds, not orders: it
//   always hangs up every live call, then does what it does in 1 to 5.
// Before deciding, a due idle pause is applied (`applyDueIdle`), as if its late timer had run on time.
import { SenderError } from 'spacetimedb/server';
import { activeSession, requireRole } from './auth';
import {
  applyDueIdle,
  cancelVeto,
  closeQuestion,
  enterReading,
  endPass,
  enterVeto,
  finishScan,
  getScan,
  isSignalPause,
  openMenu,
  optionAt,
  optionsOf,
  pause,
  pickOption,
  pushIdle,
  resume,
} from './clock';
import { getConfig } from './config';
import {
  confirmCall,
  confirmErrand,
  pendingWork,
  requestCallCancel,
  stopCall,
  stopErrand,
  type PendingWork,
} from './consent';
import type { Ctx } from './ctx';
import { contactGoodFor } from './liveness';
import type { AnswerOption, Command, Config, ScanState, Session } from './schema';
import { appendLedger, commandWire, emitCue, msBetween, parseCommand, requireMatch, u32 } from './util';

export interface GestureArgs {
  gestureId: string;
  command: string;
  heardStepSeq: bigint;
  heardOptionId: bigint;
  heardDigest: string;
  confidence: number;
  source: string;
  onsetAgeMs: number;
}

interface Decision {
  outcome: string;
  reason: string;
  questionId?: bigint;
  optionId?: bigint;
  errandId?: bigint;
  callId?: bigint;
  lateByMs?: number;
  cursor?: number;
}

const accepted = (action: string, extra: Partial<Decision> = {}): Decision => ({ outcome: `accepted:${action}`, reason: '', ...extra });
const ignored = (reason: string, extra: Partial<Decision> = {}): Decision => ({ outcome: `ignored:${reason}`, reason, ...extra });

export const GESTURE_ID_RE = /^[A-Za-z0-9:_-]{1,64}$/;
const SOURCE_RE = /^[a-z_]{1,16}$/;

/** The `gesture` reducer's body. */
export function handleGesture(ctx: Ctx, a: GestureArgs): void {
  requireRole(ctx, 'Station');
  requireMatch(a.gestureId, GESTURE_ID_RE, 'gesture_id');
  const command = parseCommand(a.command);
  requireMatch(a.source, SOURCE_RE, 'source');
  if (a.heardDigest.length > 64) throw new SenderError('heard_digest is too long');

  const existing = ctx.db.gestureLog.gestureId.find(a.gestureId);
  if (existing) {
    if (existing.command.tag === command.tag) return; // a retry of a call that already committed
    throw new SenderError('gesture_id was already used for another command');
  }
  // Its log row went with a purged session, but the id was used: a replay is never a new command.
  if (ctx.db.spentGesture.gestureId.find(a.gestureId)) throw new SenderError('gesture_id was already used');

  const cfg = getConfig(ctx.db);
  const session = activeSession(ctx.db);
  let d: Decision;
  if (!session) {
    d = ignored('no_session');
  } else {
    if (!session.station.isEqual(ctx.sender)) throw new SenderError('not the session station');
    // A due idle pause is applied first, as if its late timer had run on time: otherwise an accepted command would
    // push the deadline forward and erase the pause it owed, a CONFIRM could confirm what that pause voids, and a
    // YES would pick where it should only resume.
    applyDueIdle(ctx, session);
    d = decide(ctx, cfg, session, command, a);
  }

  const sessionId = session?.id ?? 0n;
  ctx.db.gestureLog.insert({
    gestureId: a.gestureId,
    sessionId,
    device: ctx.sender,
    command,
    source: a.source,
    confidence: Number.isFinite(a.confidence) ? a.confidence : 0,
    heardStepSeq: a.heardStepSeq,
    heardOptionId: a.heardOptionId,
    heardDigest: a.heardDigest,
    onsetAgeMs: a.onsetAgeMs,
    receivedAt: ctx.timestamp,
    outcome: d.outcome,
    reason: d.reason,
    questionId: d.questionId ?? 0n,
    optionId: d.optionId ?? 0n,
    errandId: d.errandId ?? 0n,
    callId: d.callId ?? 0n,
    lateByMs: u32(d.lateByMs ?? 0),
  });
  appendLedger(ctx, sessionId, 'gesture', 'Station', {
    gestureId: a.gestureId,
    command: commandWire(command),
    questionId: d.questionId,
    optionId: d.optionId,
    errandId: d.errandId,
    callId: d.callId,
    stepSeq: a.heardStepSeq,
    cursor: d.cursor,
    outcome: d.outcome,
    reason: d.reason,
    ms: d.lateByMs ?? 0,
  });

  if (session && d.outcome.startsWith('accepted:')) {
    // Re-read: the decision may have changed the session row (question count, idle fence).
    const fresh = ctx.db.session.id.find(session.id)!;
    ctx.db.session.id.update({ ...fresh, lastAcceptedAt: ctx.timestamp, lastCommandAt: ctx.timestamp });
    const s = ctx.db.scanState.sessionId.find(session.id);
    if (s && s.phase.tag !== 'Paused') pushIdle(ctx, session.id);
  }
}

function decide(ctx: Ctx, cfg: Config, session: Session, command: Command, a: GestureArgs): Decision {
  const refractable = command.tag === 'Yes' || command.tag === 'No' || command.tag === 'Confirm';
  if (refractable && session.lastAcceptedAt && msBetween(ctx.timestamp, session.lastAcceptedAt) < cfg.refractoryMs) {
    return ignored('refractory');
  }
  const s = getScan(ctx.db, session.id);
  const p = pendingWork(ctx.db, session.id);
  switch (command.tag) {
    case 'HeadsetOff':
      if (s.phase.tag === 'Paused') return ignored('already_paused');
      pause(ctx, s, 'HeadsetOff', { actor: 'Station', gestureId: a.gestureId });
      return accepted('pause', { questionId: s.questionId });
    case 'Stop':
      return onStop(ctx, s, p, a);
    case 'Yes':
      return onYes(ctx, cfg, s, p, session, a);
    case 'No':
      return onNo(ctx, cfg, s, p, a);
    case 'Confirm':
      return onConfirm(ctx, s, p, session, a);
  }
}

// ---------- STOP: cancel, none of these, hang up, pause. Never refractory. ----------

function onStop(ctx: Ctx, s: ScanState, p: PendingWork, a: GestureArgs): Decision {
  if (s.phase.tag === 'Paused') {
    if (!isSignalPause(s.pauseReason)) return ignored('already_paused');
    pause(ctx, s, 'Stop', { actor: 'Station', gestureId: a.gestureId }); // a signal pause becomes deliberate
    return accepted('pause', { questionId: s.questionId });
  }
  // STOP is the only command that hangs up (NO is busy during a call), so every STOP hangs up every live call, and
  // then still does what it does without a call: neither waiting work nor a scan started mid-call (a reply in its
  // veto above all) is shielded from it, and no newer call can shield an older one (D11).
  const hungUp = p.liveCalls.length > 0 ? p.liveCall : undefined;
  for (const c of p.liveCalls) requestCallCancel(ctx, c, 'stop', { actor: 'Station', gestureId: a.gestureId });
  const also = hungUp ? '_hang_up' : '';
  if (p.errand) {
    stopErrand(ctx, p.errand, 'stop', { actor: 'Station', gestureId: a.gestureId });
    return accepted(`stop_errand${also}`, { errandId: p.errand.id, callId: hungUp?.id, questionId: p.errand.questionId });
  }
  if (p.call) {
    stopCall(ctx, p.call, 'stop', { actor: 'Station', gestureId: a.gestureId });
    return accepted(`stop_call${also}`, { callId: p.call.id, questionId: p.call.questionId });
  }
  const q = ctx.db.question.id.find(s.questionId) ?? undefined;
  switch (s.phase.tag) {
    case 'Preparing':
      if (q) {
        closeQuestion(ctx, q, { status: 'Stopped', outcome: 'Stopped', reason: 'stop', actor: 'Station', cue: 'none', gestureId: a.gestureId });
      } else {
        finishScan(ctx, s, undefined, 'Stopped', { actor: 'Station', cue: 'none', reason: 'stop', gestureId: a.gestureId });
      }
      return accepted(`stop${also}`, { questionId: s.questionId, callId: hungUp?.id });
    case 'Reading':
    case 'Window':
      finishScan(ctx, s, q, 'None', { actor: 'Station', cue: 'none', reason: 'stop', gestureId: a.gestureId });
      return accepted(`none${also}`, { questionId: s.questionId, callId: hungUp?.id, cursor: s.cursor });
    case 'Veto':
      finishScan(ctx, s, q, 'Stopped', { actor: 'Station', cue: 'veto_cancelled', reason: 'stop', gestureId: a.gestureId });
      return accepted(`stop_reply${also}`, { questionId: s.questionId, callId: hungUp?.id, optionId: s.pickedOptionId });
    default:
      if (hungUp) return accepted('hang_up', { callId: hungUp.id, questionId: hungUp.questionId });
      if (p.submitting) {
        emitCue(ctx, s.sessionId, 'too_late', { errandId: p.submitting.id, questionId: p.submitting.questionId });
        return ignored('too_late', { errandId: p.submitting.id });
      }
      pause(ctx, s, 'Stop', { actor: 'Station', gestureId: a.gestureId });
      return accepted('pause', { questionId: s.questionId });
  }
}

// ---------- YES: pick the option just heard, answer yes, open the menu, resume. ----------

function onYes(ctx: Ctx, cfg: Config, s: ScanState, p: PendingWork, session: Session, a: GestureArgs): Decision {
  if (s.phase.tag === 'Paused') {
    const reason = s.pauseReason?.tag;
    if (reason === 'Operator') return ignored('operator_pause');
    if (isSignalPause(s.pauseReason) && !contactGoodFor(ctx.db, s.sessionId, ctx.timestamp, cfg.resumeGoodContactMs, s.pausedAt)) {
      return ignored('no_contact');
    }
    resume(ctx, s, 'Station', a.gestureId);
    return accepted('resume', { questionId: s.questionId });
  }
  if (p.errand) {
    if (p.errand.status.tag === 'Previewed' || p.errand.status.tag === 'AwaitingConfirm') {
      emitCue(ctx, s.sessionId, 'say_confirm', { errandId: p.errand.id, questionId: p.errand.questionId });
      return ignored('yes_is_not_confirm', { errandId: p.errand.id });
    }
    return ignored('busy', { errandId: p.errand.id });
  }
  if (p.call) {
    if (p.call.status.tag === 'Prepared' || p.call.status.tag === 'AwaitingConfirm') {
      emitCue(ctx, s.sessionId, 'say_confirm', { callId: p.call.id, questionId: p.call.questionId });
      return ignored('yes_is_not_confirm', { callId: p.call.id });
    }
    return ignored('busy', { callId: p.call.id });
  }
  switch (s.phase.tag) {
    case 'Preparing':
      emitCue(ctx, s.sessionId, 'not_ready', { questionId: s.questionId });
      return ignored('not_ready', { questionId: s.questionId });
    case 'Veto':
      return ignored('veto', { questionId: s.questionId });
    case 'Reading':
    case 'Window': {
      const heard = resolveHeard(ctx, cfg, s, a.heardStepSeq, a.heardOptionId);
      if ('fail' in heard) return ignored(heard.fail, { questionId: s.questionId });
      const q = ctx.db.question.id.find(s.questionId);
      if (!q) return ignored('stale_step');
      if (s.answerMode.tag === 'YesNo') {
        const yes = optionAt(ctx.db, q.id, s.version, 1);
        if (!yes) return ignored('no_option', { questionId: q.id });
        enterVeto(ctx, s, yes);
        appendLedger(ctx, s.sessionId, 'pick', 'Station', { questionId: q.id, optionId: yes.id, gestureId: a.gestureId, stepSeq: s.stepSeq, cursor: 1, outcome: 'yes', ms: heard.lateByMs });
        emitCue(ctx, s.sessionId, 'picked', { questionId: q.id, optionId: yes.id, rank: 1 });
        return accepted('answer_yes', { questionId: q.id, optionId: yes.id, lateByMs: heard.lateByMs, cursor: 1 });
      }
      const o = heard.option!;
      const action = pickOption(ctx, s, session, q, o, a.gestureId, heard.lateByMs);
      return accepted(action, { questionId: q.id, optionId: o.id, lateByMs: heard.lateByMs, cursor: o.rank });
    }
    default: {
      if (p.liveCall) return ignored('busy', { callId: p.liveCall.id });
      if (p.submitting) return ignored('busy', { errandId: p.submitting.id });
      if (!cfg.menuEnabled) return ignored('idle');
      const menu = openMenu(ctx, s, session, a.gestureId);
      return accepted('menu_open', { questionId: menu.id });
    }
  }
}

// ---------- NO: skip, answer no, do not send. ----------

function onNo(ctx: Ctx, cfg: Config, s: ScanState, p: PendingWork, a: GestureArgs): Decision {
  if (s.phase.tag === 'Paused') return ignored('paused');
  if (p.errand) {
    stopErrand(ctx, p.errand, 'no', { actor: 'Station', gestureId: a.gestureId });
    return accepted('stop_errand', { errandId: p.errand.id, questionId: p.errand.questionId });
  }
  if (p.call) {
    stopCall(ctx, p.call, 'no', { actor: 'Station', gestureId: a.gestureId });
    return accepted('stop_call', { callId: p.call.id, questionId: p.call.questionId });
  }
  switch (s.phase.tag) {
    case 'Preparing':
      return ignored('not_ready', { questionId: s.questionId });
    case 'Veto':
      cancelVeto(ctx, s, a.gestureId);
      return accepted('veto_cancel', { questionId: s.questionId, optionId: s.pickedOptionId });
    case 'Reading':
    case 'Window': {
      const heard = resolveHeard(ctx, cfg, s, a.heardStepSeq, a.heardOptionId);
      if ('fail' in heard) return ignored(heard.fail, { questionId: s.questionId });
      if (s.answerMode.tag === 'YesNo') {
        const no = optionAt(ctx.db, s.questionId, s.version, 2);
        if (!no) return ignored('no_option', { questionId: s.questionId });
        enterVeto(ctx, s, no);
        appendLedger(ctx, s.sessionId, 'pick', 'Station', { questionId: s.questionId, optionId: no.id, gestureId: a.gestureId, stepSeq: s.stepSeq, cursor: 2, outcome: 'no', ms: heard.lateByMs });
        emitCue(ctx, s.sessionId, 'picked', { questionId: s.questionId, optionId: no.id, rank: 2 });
        return accepted('answer_no', { questionId: s.questionId, optionId: no.id, lateByMs: heard.lateByMs, cursor: 2 });
      }
      if (heard.which === 'previous') return ignored('already_passed', { questionId: s.questionId, optionId: heard.option?.id });
      // The option the person just said NO to never becomes the grace candidate, so a late YES cannot land on it
      // (with grace_ms equal to refractory_ms, a YES exactly refractory_ms later would otherwise pass both checks).
      if (s.cursor < s.optionCount) enterReading(ctx, s, s.cursor + 1, { freshOption: true });
      else endPass(ctx, s, { freshOption: true });
      return accepted('skip', { questionId: s.questionId, optionId: heard.option?.id, cursor: s.cursor });
    }
    default:
      if (p.liveCall) return ignored('busy', { callId: p.liveCall.id });
      if (p.submitting) return ignored('too_late', { errandId: p.submitting.id });
      return ignored('idle');
  }
}

// ---------- CONFIRM: the only way anything leaves the room. ----------

function onConfirm(ctx: Ctx, s: ScanState, p: PendingWork, session: Session, a: GestureArgs): Decision {
  if (s.phase.tag === 'Paused') return ignored('paused');
  const g = { gestureId: a.gestureId, onsetAgeMs: a.onsetAgeMs, heardDigest: a.heardDigest };
  if (p.errand) {
    const e = p.errand;
    if (e.status.tag === 'Previewed') return ignored('readback_not_done', { errandId: e.id });
    if (e.status.tag !== 'AwaitingConfirm') return ignored('nothing_to_confirm', { errandId: e.id });
    const reason = confirmErrand(ctx, session, e, g);
    return reason ? ignored(reason, { errandId: e.id, questionId: e.questionId }) : accepted('confirm', { errandId: e.id, questionId: e.questionId });
  }
  if (p.call) {
    const c = p.call;
    if (c.status.tag === 'Prepared') return ignored('readback_not_done', { callId: c.id });
    if (c.status.tag !== 'AwaitingConfirm') return ignored('nothing_to_confirm', { callId: c.id });
    const reason = confirmCall(ctx, session, c, g);
    return reason ? ignored(reason, { callId: c.id, questionId: c.questionId }) : accepted('confirm', { callId: c.id, questionId: c.questionId });
  }
  return ignored('nothing_to_confirm');
}

// ---------- Which option did the person hear? ----------

type Heard =
  | { which: 'current' | 'previous'; cursor: number; option?: AnswerOption; lateByMs: number }
  | { fail: 'stale_step' | 'heard_mismatch' };

/**
 * The step the station was playing at the gesture's onset decides the option: the current one, or the previous
 * one if the step changed no more than `grace_ms` ago. Anything else is stale. A non-zero `heard_option_id`
 * that disagrees is refused (fail closed).
 */
function resolveHeard(ctx: Ctx, cfg: Config, s: ScanState, heardStepSeq: bigint, heardOptionId: bigint): Heard {
  let which: 'current' | 'previous';
  let cursor: number;
  let lateByMs = 0;
  if (s.optionStartSeq <= heardStepSeq && heardStepSeq <= s.stepSeq) {
    which = 'current';
    cursor = s.cursor;
  } else {
    const hasPrevious = s.prevOptionStartSeq > 0n && (s.answerMode.tag === 'YesNo' || s.prevCursor > 0);
    if (!hasPrevious || heardStepSeq < s.prevOptionStartSeq || heardStepSeq >= s.optionStartSeq) return { fail: 'stale_step' };
    lateByMs = Math.max(0, msBetween(ctx.timestamp, s.optionStartedAt));
    if (lateByMs > cfg.graceMs) return { fail: 'stale_step' };
    which = 'previous';
    cursor = s.prevCursor;
  }
  if (s.answerMode.tag === 'YesNo') {
    if (heardOptionId !== 0n && !optionsOf(ctx.db, s.questionId, s.version).some((o) => o.id === heardOptionId)) {
      return { fail: 'heard_mismatch' };
    }
    return { which, cursor, lateByMs };
  }
  const option = optionAt(ctx.db, s.questionId, s.version, cursor);
  if (!option) return { fail: 'stale_step' };
  if (heardOptionId !== 0n && option.id !== heardOptionId) return { fail: 'heard_mismatch' };
  return { which, cursor, option, lateByMs };
}
