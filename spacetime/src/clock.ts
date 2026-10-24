// The scan clock (docs/spacetime.md 2.6, 3.8, 3.10, 4.1): one public `scan_state` row per session, moved only by
// reducers and by one-shot `scan_timer` rows. Every step bumps `stepSeq`, and each timer row carries the
// `stepSeq` it was armed for, so a stale or out-of-order tick does nothing.
//
// Also here: the menu, pause and resume (the dead-man interlock acts through `pause`), and the idle timer.
import { SenderError } from 'spacetimedb/server';
import { estimateClipMs, getConfig } from './config';
import { createErrandFromPick, createCallFromPick, voidPending } from './consent';
import type { Ctx, ReadDb } from './ctx';
import { cancelJobs, createJob } from './jobs';
import { hasConsent } from './consent';
import { idleDue } from './liveness';
import type {
  AnswerOption,
  MenuItem,
  PauseReason,
  Question,
  QuestionStatus,
  ScanOutcome,
  ScanState,
  ScanTimer,
  Session,
} from './schema';
import { appendLedger, emitCue, msBetween, onceAt, plusMs, u32, writePipeline, type Actor } from './util';

// ---------- Reading the clock ----------

export function getScan(db: ReadDb, sessionId: bigint): ScanState {
  const s = db.scanState.sessionId.find(sessionId);
  if (!s) throw new SenderError('no scan state for this session');
  return s;
}

/** Options of one version, in reading order. */
export function optionsOf(db: ReadDb, questionId: bigint, version: number): AnswerOption[] {
  if (version === 0) return [];
  return [...db.answerOption.optionByQv.filter([questionId, version])].sort((a, b) => a.rank - b.rank);
}

export function optionAt(db: ReadDb, questionId: bigint, version: number, rank: number): AnswerOption | undefined {
  return optionsOf(db, questionId, version).find((o) => o.rank === rank);
}

export function allClipsIn(db: ReadDb, questionId: bigint, version: number): boolean {
  const opts = optionsOf(db, questionId, version);
  return opts.length > 0 && opts.every((o) => o.clipMs !== undefined);
}

const ACTIVE_PHASES = ['Preparing', 'Reading', 'Window', 'Veto'];

export function isScanActive(s: ScanState): boolean {
  return ACTIVE_PHASES.includes(s.phase.tag);
}

// ---------- Writing the clock ----------

export function initialScanState(ctx: Ctx, sessionId: bigint, maxPasses: number): ScanState {
  return {
    sessionId,
    questionId: 0n,
    version: 0,
    mode: { tag: 'Answer' },
    answerMode: { tag: 'Pick' },
    phase: { tag: 'Idle' },
    cursor: 0,
    optionCount: 0,
    pass: 0,
    maxPasses,
    stepSeq: 0n,
    stepStartedAt: ctx.timestamp,
    stepEndsAt: ctx.timestamp,
    optionStartSeq: 0n,
    optionStartedAt: ctx.timestamp,
    prevCursor: 0,
    prevOptionStartSeq: 0n,
    outcome: undefined,
    pickedRank: undefined,
    pickedOptionId: undefined,
    pauseReason: undefined,
    pausedAt: undefined,
    resumeCursor: 0,
    updatedAt: ctx.timestamp,
  };
}

function saveScan(ctx: Ctx, s: ScanState): ScanState {
  const next = { ...s, updatedAt: ctx.timestamp };
  ctx.db.scanState.sessionId.update(next);
  return next;
}

/** Deleting a pending one-shot row cancels it. Step changes always delete and insert, never update in place. */
export function clearScanTimers(ctx: Ctx, sessionId: bigint): void {
  for (const r of [...ctx.db.scanTimer.sessionId.filter(sessionId)]) {
    ctx.db.scanTimer.scheduledId.delete(r.scheduledId);
  }
}

function armScanTimer(ctx: Ctx, s: ScanState, kind: ScanTimer['kind']['tag']): void {
  ctx.db.scanTimer.insert({
    scheduledId: 0n,
    scheduledAt: onceAt(s.stepEndsAt),
    sessionId: s.sessionId,
    stepSeq: s.stepSeq,
    kind: { tag: kind },
  });
}

function saveQuestion(ctx: Ctx, q: Question): Question {
  ctx.db.question.id.update(q);
  return q;
}

/** Preparing: options are being drafted or their clips synthesized. A ClipDeadline timer starts the scan anyway. */
export function enterPreparing(ctx: Ctx, s: ScanState, q: Question): ScanState {
  const cfg = getConfig(ctx.db);
  clearScanTimers(ctx, s.sessionId);
  const stepSeq = s.stepSeq + 1n;
  let next: ScanState = {
    ...s,
    questionId: q.id,
    version: q.version,
    mode: { tag: isMenuQuestion(q) ? 'Menu' : 'Answer' },
    answerMode: q.answerMode,
    phase: { tag: 'Preparing' },
    cursor: 0,
    optionCount: optionsOf(ctx.db, q.id, q.version).length,
    pass: 0,
    stepSeq,
    stepStartedAt: ctx.timestamp,
    stepEndsAt: plusMs(ctx.timestamp, cfg.clipDeadlineMs),
    prevCursor: 0,
    prevOptionStartSeq: 0n,
    outcome: undefined,
    pickedRank: undefined,
    pickedOptionId: undefined,
    pauseReason: undefined,
    pausedAt: undefined,
    resumeCursor: 0,
  };
  next = saveScan(ctx, next);
  // A yes or no prompt is a stock phrase, and a version whose clips are all in needs no wait.
  if (q.version > 0 && (q.answerMode.tag === 'YesNo' || allClipsIn(ctx.db, q.id, q.version))) {
    return startScan(ctx, next, q);
  }
  armScanTimer(ctx, next, 'ClipDeadline');
  return next;
}

export function isMenuQuestion(q: Question): boolean {
  return q.origin.tag === 'Menu' && q.menuItem.tag === 'None';
}

/** Starts reading the question's current version from the first option, pass 1. */
export function startScan(ctx: Ctx, s: ScanState, given: Question): ScanState {
  const cfg = getConfig(ctx.db);
  const q = ctx.db.question.id.find(given.id) ?? given; // the caller's copy may be older than this transaction
  const opts = optionsOf(ctx.db, q.id, q.version);
  if (opts.length === 0) return s; // nothing to read yet: stay Preparing
  saveQuestion(ctx, { ...q, status: { tag: 'Scanning' } });
  const started: ScanState = {
    ...s,
    questionId: q.id,
    version: q.version,
    mode: { tag: isMenuQuestion(q) ? 'Menu' : 'Answer' },
    answerMode: q.answerMode,
    optionCount: opts.length,
    pass: 1,
    maxPasses: cfg.maxPasses,
    prevCursor: 0,
    prevOptionStartSeq: 0n,
    outcome: undefined,
    pickedRank: undefined,
    pickedOptionId: undefined,
  };
  writePipeline(ctx, {
    eventKey: `q${q.id}:v${q.version}:scan`,
    sessionId: s.sessionId,
    questionId: q.id,
    stage: 'speak',
    status: 'started',
    detail: q.answerMode.tag === 'YesNo' ? 'yes or no prompt' : 'scan started',
    countsJson: JSON.stringify({ version: q.version, optionCount: opts.length }),
    actor: 'Module',
  });
  appendLedger(ctx, s.sessionId, 'scan_start', 'Module', { questionId: q.id, stepSeq: s.stepSeq, outcome: q.answerMode.tag === 'YesNo' ? 'yes_no' : 'pick' });
  return enterReading(ctx, started, firstCursor(started), { freshOption: true });
}

function firstCursor(s: ScanState): number {
  return s.answerMode.tag === 'YesNo' ? 0 : 1;
}

/**
 * The event key of the speak step for one read: `s<session>:read:<step_seq>` (docs/spacetime.md 14). A step number
 * belongs to one session and is never reused, so the read is found from the session and the step alone, whatever the
 * scan has moved on to since (a late word-timing report for an earlier question still finds its read).
 */
export function readEventKey(sessionId: bigint, stepSeq: bigint): string {
  return `s${sessionId}:read:${stepSeq}`;
}

/**
 * Reading of one option (or the YesNo prompt). The option before it becomes the grace-window candidate only when
 * the scan moved on from it in order (`freshOption` false); a fresh start, a resume or a cancelled veto has none.
 * Every read is its own speak step (module v2): one `pipeline_event` with the option id, rank, pass, step and dwell,
 * numbers only, that the station's word timings attach to.
 */
export function enterReading(ctx: Ctx, s: ScanState, cursor: number, opts: { freshOption?: boolean } = {}): ScanState {
  const cfg = getConfig(ctx.db);
  clearScanTimers(ctx, s.sessionId);
  const movingOn = !opts.freshOption && (s.phase.tag === 'Reading' || s.phase.tag === 'Window');
  const stepSeq = s.stepSeq + 1n;
  const yesNo = s.answerMode.tag === 'YesNo';
  const o = yesNo ? undefined : optionAt(ctx.db, s.questionId, s.version, cursor);
  const dwell = yesNo ? cfg.yesNoCueMs : (o?.clipMs ?? estimateClipMs(o?.text ?? '')) + cfg.audioPadMs;
  writePipeline(ctx, {
    eventKey: readEventKey(s.sessionId, stepSeq),
    sessionId: s.sessionId,
    questionId: s.questionId,
    stage: 'speak',
    status: 'started',
    detail: yesNo ? 'yes or no prompt' : 'reading option',
    countsJson: JSON.stringify({
      optionId: o ? Number(o.id) : 0,
      rank: yesNo ? 0 : cursor,
      pass: s.pass,
      stepSeq: Number(stepSeq),
      durationMs: dwell,
      estimated: !yesNo && o?.clipMs === undefined,
    }),
    actor: 'Module',
  });
  const next = saveScan(ctx, {
    ...s,
    phase: { tag: 'Reading' },
    prevCursor: movingOn ? s.cursor : 0,
    prevOptionStartSeq: movingOn ? s.optionStartSeq : 0n,
    cursor,
    stepSeq,
    stepStartedAt: ctx.timestamp,
    stepEndsAt: plusMs(ctx.timestamp, dwell),
    optionStartSeq: stepSeq,
    optionStartedAt: ctx.timestamp,
  });
  armScanTimer(ctx, next, 'StepEnd');
  appendLedger(ctx, s.sessionId, 'step', 'Module', { questionId: s.questionId, stepSeq, cursor, outcome: 'reading', ms: dwell });
  return next;
}

/** The silent response window after an option. */
export function enterWindow(ctx: Ctx, s: ScanState): ScanState {
  const cfg = getConfig(ctx.db);
  clearScanTimers(ctx, s.sessionId);
  const next = saveScan(ctx, {
    ...s,
    phase: { tag: 'Window' },
    stepSeq: s.stepSeq + 1n,
    stepStartedAt: ctx.timestamp,
    stepEndsAt: plusMs(ctx.timestamp, cfg.responseWindowMs),
  });
  armScanTimer(ctx, next, 'StepEnd');
  return next;
}

// ---------- The station's word timings for a read (module v2) ----------

/** At most this many words per read: an option is at most 200 characters, so 100 words leaves room. */
export const MAX_TIMED_WORDS = 100;
/** No word ends later than this into its clip: the longest clip `report_clip_ready` accepts. */
export const MAX_WORD_MS = 30_000;

/**
 * `report_word_timings`: the station's word timings for one read (Cartesia's word timestamps, milliseconds into the
 * clip), numbers only, never the words. The read is named by its session (step numbers restart in each session, so
 * the report must name the session it heard; only the active one is accepted), the step it began at, and its option
 * (0 for a yes or no prompt), so a report that arrives after the scan moved on still finds it. Only a read the module
 * wrote counts. One row per read: a repeat is a retry and changes nothing.
 */
export function recordWordTimings(
  ctx: Ctx,
  session: Session,
  sessionId: bigint,
  stepSeq: bigint,
  optionId: bigint,
  startsMs: number[],
  endsMs: number[],
): void {
  if (sessionId !== session.id) throw new SenderError('not the active session');
  if (startsMs.length < 1 || startsMs.length > MAX_TIMED_WORDS) throw new SenderError(`word timings: 1 to ${MAX_TIMED_WORDS} words`);
  if (endsMs.length !== startsMs.length) throw new SenderError('starts_ms and ends_ms must have the same length');
  let previous = 0;
  for (let i = 0; i < startsMs.length; i++) {
    const start = startsMs[i]!;
    const end = endsMs[i]!;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < previous || end < start || end > MAX_WORD_MS) {
      throw new SenderError(`word timings must be in order, each end at or after its start, at most ${MAX_WORD_MS} ms`);
    }
    previous = start;
  }
  const read = ctx.db.pipelineEvent.eventKey.find(readEventKey(session.id, stepSeq));
  if (!read || read.sessionId !== session.id || read.stage !== 'speak' || read.actor !== 'Module') throw new SenderError('no such read');
  const counts = JSON.parse(read.countsJson) as { optionId?: number; rank?: number };
  if (counts.optionId !== Number(optionId)) throw new SenderError('not the option read at that step');
  if (ctx.db.wordTiming.eventId.find(read.id)) return; // a retry: one row per read
  ctx.db.wordTiming.insert({
    eventId: read.id,
    sessionId: session.id,
    questionId: read.questionId,
    optionId,
    rank: counts.rank ?? 0,
    stepSeq,
    startsMs,
    endsMs,
    at: ctx.timestamp,
  });
}

/**
 * After the last option's window: a waiting version, another pass, or No pick. Silence never picks.
 * `freshOption` starts the next pass with no grace candidate (after a NO, the option just refused).
 */
export function endPass(ctx: Ctx, s: ScanState, opts: { freshOption?: boolean } = {}): ScanState {
  const q = ctx.db.question.id.find(s.questionId);
  if (!q) return finishScan(ctx, s, undefined, 'NoPick', { actor: 'Scheduler', cue: 'no_pick' });
  if (q.pendingVersion > 0) {
    const switched = saveQuestion(ctx, {
      ...q,
      version: q.pendingVersion,
      answerMode: q.pendingAnswerMode,
      pendingVersion: 0,
    });
    emitCue(ctx, s.sessionId, 'more_options', { questionId: q.id });
    return enterPreparing(ctx, s, switched);
  }
  if (s.pass < s.maxPasses) {
    emitCue(ctx, s.sessionId, 'again', { questionId: q.id });
    return enterReading(ctx, { ...s, pass: s.pass + 1 }, firstCursor(s), { freshOption: opts.freshOption });
  }
  return finishScan(ctx, s, q, 'NoPick', { actor: 'Scheduler', cue: 'no_pick' });
}

export interface FinishOpts {
  actor: Actor;
  /** The picked option, for Picked. */
  option?: AnswerOption;
  /** Overrides the question status the outcome implies (Failed). */
  status?: QuestionStatus['tag'];
  cue?: string;
  reason?: string;
  gestureId?: string;
}

const OUTCOME_STATUS: Record<ScanOutcome['tag'], QuestionStatus['tag']> = {
  Picked: 'Acting',
  None: 'None',
  NoPick: 'NoPick',
  Stopped: 'Stopped',
  Cancelled: 'Cancelled',
};

/**
 * Ends a scan: Idle, the outcome, the question's status, the select and speak events, the ledger. A picked reply
 * becomes Released here, after its veto. Then a waiting question, if any, goes to Preparing.
 *
 * A select step means a pick (module v2, docs/spacetime.md 14): it is written only for a Picked outcome, with the
 * option id and rank in its counts. Any other ending (none of these, no pick, stopped, cancelled, failed) writes no
 * select step; the outcome stays on `scan_state` and the question, and a failed question shows on its plan step.
 */
export function finishScan(ctx: Ctx, s: ScanState, given: Question | undefined, outcome: ScanOutcome['tag'], opts: FinishOpts): ScanState {
  clearScanTimers(ctx, s.sessionId);
  const q = given ? (ctx.db.question.id.find(given.id) ?? given) : undefined; // write over the latest row
  const o = opts.option;
  const next = saveScan(ctx, {
    ...s,
    phase: { tag: 'Idle' },
    outcome: { tag: outcome },
    pickedRank: outcome === 'Picked' && o ? o.rank : undefined,
    pickedOptionId: outcome === 'Picked' && o ? o.id : undefined,
    stepSeq: s.stepSeq + 1n,
    stepStartedAt: ctx.timestamp,
    stepEndsAt: ctx.timestamp,
  });
  if (q) {
    let status: QuestionStatus['tag'] = opts.status ?? OUTCOME_STATUS[outcome];
    const released = outcome === 'Picked' && o?.kind.tag === 'Reply';
    if (released && !opts.status) status = 'Released';
    saveQuestion(ctx, {
      ...q,
      status: { tag: status },
      outcome: { tag: outcome },
      pickedOptionId: outcome === 'Picked' && o ? o.id : q.pickedOptionId,
      replyText: released ? o!.text : q.replyText,
      replyTone: released ? o!.tone : q.replyTone,
      releasedAt: released ? ctx.timestamp : q.releasedAt,
      endedAt: released ? q.endedAt : ctx.timestamp,
    });
    // Further options for an ended question are of no use; its preview or remember jobs are left alone.
    cancelJobs(ctx, q.id, `question_${outcome.toLowerCase()}`, { kind: 'Options' });
    if (outcome === 'Picked' && o) {
      writePipeline(ctx, {
        eventKey: `q${q.id}:select`,
        sessionId: s.sessionId,
        questionId: q.id,
        stage: 'select',
        status: 'ok',
        detail: 'picked',
        ms: 0,
        countsJson: JSON.stringify({ optionId: Number(o.id), rank: o.rank, pass: s.pass }),
        actor: 'Module',
        payloadJson: JSON.stringify({ optionId: Number(o.id), rank: o.rank, text: o.text }),
      });
    }
    writePipeline(ctx, {
      eventKey: `q${q.id}:scan:end`,
      sessionId: s.sessionId,
      questionId: q.id,
      stage: 'speak',
      status: 'ok',
      detail: 'scan ended',
      ms: Math.max(0, msBetween(ctx.timestamp, q.readyAt ?? q.askedAt)),
      actor: 'Module',
    });
  }
  appendLedger(ctx, s.sessionId, 'scan_end', opts.actor, {
    questionId: q?.id ?? s.questionId,
    optionId: o?.id ?? 0n,
    gestureId: opts.gestureId,
    stepSeq: next.stepSeq,
    cursor: s.cursor,
    outcome: outcome.toLowerCase(),
    reason: opts.reason ?? '',
  });
  if (opts.cue) emitCue(ctx, s.sessionId, opts.cue, { questionId: q?.id ?? 0n, reason: opts.reason, optionId: o?.id, rank: o?.rank });
  return startNextIfQueued(ctx, next);
}

/**
 * The newest waiting (Drafting or Ready) question newer than the last scanned one goes to Preparing; older waiting
 * ones are superseded. Returns the scan state either way.
 */
export function startNextIfQueued(ctx: Ctx, s: ScanState): ScanState {
  const waiting = [...ctx.db.question.questionBySession.filter(s.sessionId)]
    .filter((q) => q.id > s.questionId && (q.status.tag === 'Drafting' || q.status.tag === 'Ready'))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const newest = waiting.pop();
  if (!newest) return s;
  for (const old of waiting) {
    closeQuestion(ctx, old, { status: 'Cancelled', outcome: 'Cancelled', reason: 'superseded', actor: 'Module' });
  }
  return enterPreparing(ctx, s, newest);
}

/** Ends a question that is not finishing through its own scan (superseded, cancelled, failed). */
export function closeQuestion(
  ctx: Ctx,
  q: Question,
  end: { status: QuestionStatus['tag']; outcome: ScanOutcome['tag']; reason: string; actor: Actor; cue?: string; gestureId?: string },
): void {
  const s = ctx.db.scanState.sessionId.find(q.sessionId);
  if (s && s.questionId === q.id && isScanActive(s)) {
    finishScan(ctx, s, q, end.outcome, { actor: end.actor, status: end.status, cue: end.cue, reason: end.reason, gestureId: end.gestureId });
    return;
  }
  saveQuestion(ctx, {
    ...q,
    status: { tag: end.status },
    outcome: { tag: end.outcome },
    endedAt: ctx.timestamp,
  });
  cancelJobs(ctx, q.id, end.reason, { kind: 'Options' });
  if (s && s.questionId === q.id && s.phase.tag === 'Paused') {
    saveScan(ctx, { ...s, outcome: { tag: end.outcome } });
  }
  appendLedger(ctx, q.sessionId, 'question', end.actor, { questionId: q.id, gestureId: end.gestureId, outcome: end.status.toLowerCase(), reason: end.reason });
  if (end.cue) emitCue(ctx, q.sessionId, end.cue, { questionId: q.id, reason: end.reason });
}

// ---------- Picks ----------

/** YES on a reply (or a yes or no answer): the veto window, in which STOP or NO cancels before anything is said. */
export function enterVeto(ctx: Ctx, s: ScanState, o: AnswerOption): ScanState {
  const cfg = getConfig(ctx.db);
  clearScanTimers(ctx, s.sessionId);
  const next = saveScan(ctx, {
    ...s,
    phase: { tag: 'Veto' },
    pickedRank: o.rank,
    pickedOptionId: o.id,
    stepSeq: s.stepSeq + 1n,
    stepStartedAt: ctx.timestamp,
    stepEndsAt: plusMs(ctx.timestamp, cfg.replyVetoMs),
  });
  armScanTimer(ctx, next, 'VetoEnd');
  return next;
}

/** VetoEnd: the reply is released and the Speaker says it. */
export function releaseReply(ctx: Ctx, s: ScanState): ScanState {
  const q = ctx.db.question.id.find(s.questionId);
  const o = s.pickedOptionId !== undefined ? ctx.db.answerOption.id.find(s.pickedOptionId) : undefined;
  if (!q || !o) return finishScan(ctx, s, q ?? undefined, 'Cancelled', { actor: 'Scheduler', reason: 'pick_missing' });
  appendLedger(ctx, s.sessionId, 'reply_released', 'Scheduler', { questionId: q.id, optionId: o.id, stepSeq: s.stepSeq, cursor: o.rank });
  return finishScan(ctx, s, q, 'Picked', { actor: 'Scheduler', option: o, cue: 'reply_released' });
}

/** NO during the veto: cancel the pick and go back to scanning at the next option (or the prompt again). */
export function cancelVeto(ctx: Ctx, s: ScanState, gestureId: string): ScanState {
  emitCue(ctx, s.sessionId, 'veto_cancelled', { questionId: s.questionId, optionId: s.pickedOptionId, rank: s.pickedRank });
  appendLedger(ctx, s.sessionId, 'veto_cancel', 'Station', { questionId: s.questionId, optionId: s.pickedOptionId, gestureId, cursor: s.pickedRank ?? 0 });
  const cleared: ScanState = { ...s, pickedRank: undefined, pickedOptionId: undefined };
  if (s.answerMode.tag === 'YesNo') return enterReading(ctx, cleared, 0, { freshOption: true });
  const rank = s.pickedRank ?? s.cursor;
  if (rank < s.optionCount) return enterReading(ctx, { ...cleared, cursor: rank }, rank + 1, { freshOption: true });
  return endPass(ctx, cleared);
}

/**
 * YES on the option the person heard (Pick mode). Replies go to the veto; errands, calls and menu items end the
 * scan as Picked and start their own work. Returns the accepted action word.
 */
export function pickOption(ctx: Ctx, s: ScanState, session: Session, q: Question, o: AnswerOption, gestureId: string, lateByMs: number): string {
  const cfg = getConfig(ctx.db);
  appendLedger(ctx, s.sessionId, 'pick', 'Station', { questionId: q.id, optionId: o.id, gestureId, stepSeq: s.stepSeq, cursor: o.rank, outcome: o.kind.tag.toLowerCase(), ms: lateByMs });
  emitCue(ctx, s.sessionId, 'picked', { questionId: q.id, optionId: o.id, rank: o.rank });
  switch (o.kind.tag) {
    case 'Reply':
      enterVeto(ctx, s, o);
      return 'pick';
    case 'Errand':
      finishScan(ctx, s, q, 'Picked', { actor: 'Station', option: o, gestureId });
      createErrandFromPick(ctx, cfg, session, q, o, gestureId);
      return 'pick_errand';
    case 'Call':
      finishScan(ctx, s, q, 'Picked', { actor: 'Station', option: o, gestureId });
      createCallFromPick(ctx, cfg, session, q, o, gestureId);
      return 'pick_call';
    case 'Menu':
      pickMenuItem(ctx, s, session, q, o, gestureId);
      return 'menu_item';
  }
}

// ---------- The person's own menu (D11, PLAN Q9) ----------

export const MENU_ITEMS: ReadonlyArray<{ item: MenuItem['tag']; text: string }> = [
  { item: 'Need', text: 'I need something' },
  { item: 'Request', text: 'Send a request' },
  { item: 'Call', text: 'Call' },
  { item: 'Say', text: 'Say something else' },
];

/** YES while idle with nothing pending: a Menu-origin question whose four options the module writes. */
export function openMenu(ctx: Ctx, s: ScanState, session: Session, gestureId: string): Question {
  const q = ctx.db.question.insert({
    id: 0n,
    sessionId: session.id,
    requestId: `menu:${gestureId}`,
    origin: { tag: 'Menu' },
    via: 'menu',
    menuItem: { tag: 'None' },
    askedBy: ctx.sender,
    text: 'Menu',
    number: 0,
    answerMode: { tag: 'Pick' },
    version: 1,
    pendingVersion: 0,
    pendingAnswerMode: { tag: 'Pick' },
    status: { tag: 'Ready' },
    outcome: undefined,
    pickedOptionId: undefined,
    replyText: undefined,
    replyTone: undefined,
    listenMs: 0,
    askedAt: ctx.timestamp,
    readyAt: ctx.timestamp,
    releasedAt: undefined,
    spokenAt: undefined,
    endedAt: undefined,
  });
  MENU_ITEMS.forEach((m, i) => {
    ctx.db.answerOption.insert({
      id: 0n,
      questionId: q.id,
      version: 1,
      rank: i + 1,
      kind: { tag: 'Menu' },
      menuItem: { tag: m.item },
      text: m.text,
      tone: '',
      laugh: false,
      provenance: 'menu',
      sources: [],
      memoryRefs: [],
      actionJson: '',
      clipMs: undefined,
      createdAt: ctx.timestamp,
    });
  });
  emitCue(ctx, session.id, 'menu_open', { questionId: q.id });
  appendLedger(ctx, session.id, 'menu_open', 'Station', { questionId: q.id, gestureId });
  enterPreparing(ctx, s, q);
  return q;
}

/** YES on a menu item: the menu ends Picked and a follow-up question asks the agent for options. */
function pickMenuItem(ctx: Ctx, s: ScanState, session: Session, menuQ: Question, o: AnswerOption, gestureId: string): void {
  const number = session.questionCount + 1;
  ctx.db.session.id.update({ ...session, questionCount: number });
  const follow = ctx.db.question.insert({
    id: 0n,
    sessionId: session.id,
    requestId: `item:${gestureId}`,
    origin: { tag: 'Menu' },
    via: 'menu',
    menuItem: o.menuItem,
    askedBy: ctx.sender,
    text: o.text,
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
    listenMs: 0,
    askedAt: ctx.timestamp,
    readyAt: undefined,
    releasedAt: undefined,
    spokenAt: undefined,
    endedAt: undefined,
  });
  createJob(ctx, 'Options', {
    sessionId: session.id,
    questionId: follow.id,
    webSearchAllowed: hasConsent(ctx.db, 'WebSearch', ''),
    memoryAllowed: hasConsent(ctx.db, 'Memory', ''),
  });
  appendLedger(ctx, session.id, 'question', 'Station', { questionId: follow.id, optionId: o.id, gestureId, outcome: `menu:${o.menuItem.tag.toLowerCase()}` });
  // Ends the menu; startNextIfQueued then prepares the follow-up, which is the newest waiting question.
  finishScan(ctx, s, menuQ, 'Picked', { actor: 'Station', option: o, gestureId });
}

// ---------- Pause and resume (the dead-man interlock acts here) ----------

/** A signal pause never replaces a deliberate one, and only the owner lifts an operator pause. */
const PAUSE_RANK: Record<PauseReason['tag'], number> = {
  HeadsetLost: 1,
  HeadsetOff: 1,
  Stop: 2,
  Idle: 2,
  Operator: 3,
};

export function isSignalPause(reason: PauseReason | undefined): boolean {
  return reason?.tag === 'HeadsetLost' || reason?.tag === 'HeadsetOff';
}

const PAUSE_CODE: Record<PauseReason['tag'], string> = {
  HeadsetLost: 'headset_lost',
  HeadsetOff: 'headset_off',
  Stop: 'stop',
  Idle: 'idle',
  Operator: 'operator',
};

function clearIdleTimers(ctx: Ctx, sessionId: bigint): void {
  for (const r of [...ctx.db.idleTimer.sessionId.filter(sessionId)]) {
    ctx.db.idleTimer.scheduledId.delete(r.scheduledId);
  }
}

/** A fresh idle timer: `idleSeq + 1`, so any older one is fenced off. */
export function pushIdle(ctx: Ctx, sessionId: bigint): void {
  const session = ctx.db.session.id.find(sessionId);
  if (!session || session.endedAt !== undefined) return;
  const cfg = getConfig(ctx.db);
  const idleSeq = session.idleSeq + 1n;
  ctx.db.session.id.update({ ...session, idleSeq });
  clearIdleTimers(ctx, sessionId);
  ctx.db.idleTimer.insert({
    scheduledId: 0n,
    scheduledAt: onceAt(plusMs(ctx.timestamp, cfg.idlePauseMs)),
    sessionId,
    idleSeq,
  });
}

/**
 * Pauses the scan, keeping the cursor so a resume re-reads the same option. A veto pick is cancelled (nothing is
 * said), and everything waiting for a confirm is voided. A scan that already ended Picked keeps its pick (module v2):
 * the outcome stays Picked, so `picked_option_id` and `picked_rank` stay with it. Returns whether anything changed.
 */
export function pause(ctx: Ctx, s: ScanState, reason: PauseReason['tag'], opts: { actor: Actor; gestureId?: string; latencyMs?: number }): boolean {
  if (s.phase.tag === 'Paused') {
    const current = s.pauseReason?.tag;
    if (current && PAUSE_RANK[reason] <= PAUSE_RANK[current]) return false;
    const next = saveScan(ctx, { ...s, pauseReason: { tag: reason }, stepSeq: s.stepSeq + 1n });
    appendLedger(ctx, s.sessionId, 'pause', opts.actor, { questionId: s.questionId, gestureId: opts.gestureId, stepSeq: next.stepSeq, outcome: PAUSE_CODE[reason], reason: `was:${current ? PAUSE_CODE[current] : 'none'}` });
    emitCue(ctx, s.sessionId, 'paused', { reason: PAUSE_CODE[reason], questionId: s.questionId });
    return true;
  }
  const midScan = s.phase.tag === 'Reading' || s.phase.tag === 'Window' || s.phase.tag === 'Veto';
  const inVeto = s.phase.tag === 'Veto';
  clearScanTimers(ctx, s.sessionId);
  clearIdleTimers(ctx, s.sessionId);
  const next = saveScan(ctx, {
    ...s,
    phase: { tag: 'Paused' },
    resumeCursor: midScan ? s.cursor : 0,
    pickedRank: inVeto ? undefined : s.pickedRank,
    pickedOptionId: inVeto ? undefined : s.pickedOptionId,
    pauseReason: { tag: reason },
    pausedAt: ctx.timestamp,
    stepSeq: s.stepSeq + 1n,
    stepStartedAt: ctx.timestamp,
    stepEndsAt: ctx.timestamp,
  });
  voidPending(ctx, s.sessionId, PAUSE_CODE[reason], opts.actor);
  appendLedger(ctx, s.sessionId, 'pause', opts.actor, {
    questionId: s.questionId,
    gestureId: opts.gestureId,
    stepSeq: next.stepSeq,
    cursor: next.resumeCursor,
    outcome: PAUSE_CODE[reason],
    reason: s.phase.tag.toLowerCase(),
    ms: opts.latencyMs ?? 0,
  });
  emitCue(ctx, s.sessionId, 'paused', { reason: PAUSE_CODE[reason], questionId: s.questionId });
  return true;
}

/**
 * The idle pause is due (no accepted command for `idle_pause_ms`, no call Connected) but `idle_pause` has not run:
 * a timer can run late. Applies it now, as that timer would have, so nothing can act as if the deadline had not
 * passed. Called before a command is decided (gesture.ts) and before a call is reported Connected (which would turn
 * the owed pause into a re-arm). Returns whether it paused.
 */
export function applyDueIdle(ctx: Ctx, session: Session): boolean {
  if (session.endedAt !== undefined) return false;
  const s = ctx.db.scanState.sessionId.find(session.id);
  if (!s || s.phase.tag === 'Paused' || !idleDue(ctx.db, session, ctx.timestamp)) return false;
  return pause(ctx, s, 'Idle', { actor: 'Module' });
}

/**
 * Lifts a pause. A question that was mid-scan re-reads `resumeCursor` from its start (new stepSeq, same pass, no
 * grace candidate); one that was being prepared goes back to Preparing; otherwise a waiting question starts, or
 * the clock idles. Voided confirms stay void.
 */
export function resume(ctx: Ctx, s: ScanState, by: Actor, gestureId?: string): ScanState {
  if (s.phase.tag !== 'Paused') throw new SenderError('not paused');
  const was = s.pauseReason ? PAUSE_CODE[s.pauseReason.tag] : '';
  const cleared: ScanState = { ...s, phase: { tag: 'Idle' }, pauseReason: undefined, pausedAt: undefined };
  const q = ctx.db.question.id.find(s.questionId);
  let next: ScanState;
  if (q && q.status.tag === 'Scanning') {
    const cursor = s.answerMode.tag === 'YesNo' ? 0 : Math.max(1, s.resumeCursor);
    next = enterReading(ctx, cleared, cursor, { freshOption: true });
  } else if (q && (q.status.tag === 'Drafting' || q.status.tag === 'Ready')) {
    next = enterPreparing(ctx, cleared, q);
  } else {
    next = saveScan(ctx, { ...cleared, stepSeq: s.stepSeq + 1n, stepStartedAt: ctx.timestamp, stepEndsAt: ctx.timestamp });
    next = startNextIfQueued(ctx, next);
  }
  pushIdle(ctx, s.sessionId);
  appendLedger(ctx, s.sessionId, 'resume', by, { questionId: next.questionId, gestureId, stepSeq: next.stepSeq, cursor: next.cursor, reason: was });
  emitCue(ctx, s.sessionId, 'resumed', { reason: was, questionId: next.questionId });
  return next;
}
