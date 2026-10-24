// Views (docs/spacetime.md section 5): per-role slices for paired devices, and anonymous board views whose text
// follows the room's sharing toggle. Rules: read only through indexes (`find`, `filter`) and `count()`, never
// `iter()`; event tables cannot be read; primary keys in a result must be unique.
//
// Every export here is a module export; index.ts re-exports them by name.
import { t } from 'spacetimedb/server';
import { optionsOf } from './clock';
import { hasConsent, isHeld, publicReason } from './consent';
import { sandboxOn } from './sandbox';
import { publicCode } from './util';
import type { AnonContext, ReadDb, ViewContext } from './ctx';
import spacetimedb, {
  AnswerMode,
  CallStatus,
  ErrandStatus,
  JobKind,
  JobStatus,
  ledger,
  MenuItem,
  OptionKind,
  Origin,
  pipelineEvent,
  QuestionStatus,
  ScanOutcome,
  SourceRef,
  wordTiming,
  type AgentJob,
  type Question,
} from './schema';

// ---------- Row types (each name is unique in the module; see schema.ts) ----------

const SessionErrand = t.object('SessionErrand', {
  errandId: t.u64(),
  status: ErrandStatus,
  formTitle: t.string(),
  readBackText: t.string(),
  previewDigest: t.string(),
  confirmOpensAt: t.option(t.timestamp()),
  confirmClosesAt: t.option(t.timestamp()),
  reasonCode: t.string(),
  reason: t.string(),
});

const SessionCall = t.object('SessionCall', {
  callId: t.u64(),
  status: CallStatus,
  contactName: t.string(),
  readBackText: t.string(),
  scriptDigest: t.string(),
  confirmOpensAt: t.option(t.timestamp()),
  confirmClosesAt: t.option(t.timestamp()),
  reasonCode: t.string(),
  reason: t.string(),
});

const SessionReply = t.object('SessionReply', {
  questionId: t.u64(),
  text: t.string(),
  tone: t.string(),
  laugh: t.bool(),
  releasedAt: t.timestamp(),
});

/** `my_session`'s row. (The view itself owns the type name `MySession`.) */
const SessionView = t.row('SessionView', {
  sessionId: t.u64().primaryKey(),
  role: t.string(),
  questionId: t.u64(),
  questionText: t.string(),
  origin: Origin,
  answerMode: AnswerMode,
  errand: t.option(SessionErrand),
  call: t.option(SessionCall),
  lastGestureId: t.string(),
  lastGestureOutcome: t.string(),
  reply: t.option(SessionReply),
});

const StationOption = t.row('StationOption', {
  optionId: t.u64().primaryKey(),
  questionId: t.u64(),
  version: t.u32(),
  rank: t.u8(),
  kind: OptionKind,
  menuItem: MenuItem,
  text: t.string(),
  tone: t.string(),
  laugh: t.bool(),
  clipMs: t.option(t.u32()),
  current: t.bool(),
});

const PartnerQuestion = t.row('PartnerQuestion', {
  questionId: t.u64().primaryKey(),
  number: t.u32(),
  text: t.string(),
  via: t.string(),
  step: t.string(),
  outcome: t.string(),
  replyText: t.string(),
  releasedAt: t.option(t.timestamp()),
  spokenAt: t.option(t.timestamp()),
  askedByMe: t.bool(),
  action: t.string(),
  askedAt: t.timestamp(),
});

const AgentQueueItem = t.row('AgentQueueItem', {
  jobId: t.u64().primaryKey(),
  kind: JobKind,
  status: JobStatus,
  attempt: t.u32(),
  claimedByMe: t.bool(),
  questionId: t.u64(),
  questionText: t.string(),
  origin: Origin,
  menuItem: MenuItem,
  askedBy: t.string(),
  webSearchAllowed: t.bool(),
  memoryAllowed: t.bool(),
  errandId: t.u64(),
  formKey: t.string(),
  formUrl: t.string(),
  formTitle: t.string(),
  fieldsJson: t.string(),
  replyText: t.string(),
  recentErrandTitle: t.string(),
  recentErrandSentAt: t.option(t.timestamp()),
  createdAt: t.timestamp(),
});

const ErrandQueueItem = t.row('ErrandQueueItem', {
  errandId: t.u64().primaryKey(),
  status: ErrandStatus,
  claimAttempt: t.u32(),
  claimedByMe: t.bool(),
  formKey: t.string(),
  formUrl: t.string(),
  fieldsJson: t.string(),
  confirmedDigest: t.string(),
  confirmedAt: t.option(t.timestamp()),
});

const CallQueueItem = t.row('CallQueueItem', {
  callId: t.u64().primaryKey(),
  status: CallStatus,
  claimAttempt: t.u32(),
  claimedByMe: t.bool(),
  requestId: t.string(),
  contactId: t.string(),
  scriptDigest: t.string(),
  cancelRequested: t.bool(),
  cancelReason: t.string(),
  /** Module v2. The CONFIRM's time, which `claim_call` refuses CALL_CLAIM_MS (12 s) later. */
  confirmedAt: t.option(t.timestamp()),
});

/** `agent_consent`'s row (module v2): the consent the agent works under now. (The view owns `AgentConsent`.) */
const ConsentState = t.row('ConsentState', {
  sessionId: t.u64().primaryKey(),
  memoryAllowed: t.bool(),
  webSearchAllowed: t.bool(),
});

const BoardOption = t.object('BoardOption', {
  optionId: t.u64(),
  rank: t.u8(),
  kind: OptionKind,
  label: t.string(),
  tone: t.string(),
  laugh: t.bool(),
  provenance: t.string(),
  sources: t.array(SourceRef),
  clipMs: t.option(t.u32()),
});

const BoardQuestion = t.row('BoardQuestion', {
  questionId: t.u64().primaryKey(),
  sessionId: t.u64(),
  number: t.u32(),
  origin: Origin,
  via: t.string(),
  textShared: t.bool(),
  text: t.string(),
  answerMode: AnswerMode,
  status: QuestionStatus,
  outcome: t.option(ScanOutcome),
  version: t.u32(),
  options: t.array(BoardOption),
  pickedOptionId: t.option(t.u64()),
  replyText: t.string(),
  releasedAt: t.option(t.timestamp()),
  spokenAt: t.option(t.timestamp()),
  askedAt: t.timestamp(),
});

const BoardPayload = t.row('BoardPayload', {
  eventId: t.u64().primaryKey(),
  questionId: t.u64(),
  stage: t.string(),
  payloadJson: t.string(),
});

const BoardErrand = t.row('BoardErrand', {
  errandId: t.u64().primaryKey(),
  sessionId: t.u64(),
  questionId: t.u64(),
  status: ErrandStatus,
  formTitle: t.string(),
  previewDigest: t.string(),
  reasonCode: t.string(),
  reason: t.string(),
  confirmGestureId: t.string(),
  stopGestureId: t.string(),
  createdAt: t.timestamp(),
  previewedAt: t.option(t.timestamp()),
  readbackDoneAt: t.option(t.timestamp()),
  confirmOpensAt: t.option(t.timestamp()),
  confirmClosesAt: t.option(t.timestamp()),
  confirmedAt: t.option(t.timestamp()),
  claimedAt: t.option(t.timestamp()),
  submittedAt: t.option(t.timestamp()),
  endedAt: t.option(t.timestamp()),
  updatedAt: t.timestamp(),
  textShared: t.bool(),
  readBackText: t.string(),
  readBackJson: t.string(),
  confirmationText: t.string(),
  screenshotUrl: t.string(),
  /** Module v2. The errand option the person picked. */
  optionId: t.u64(),
});

const BoardCallLine = t.object('BoardCallLine', {
  role: t.string(),
  text: t.string(),
  at: t.timestamp(),
});

const BoardCall = t.row('BoardCall', {
  callId: t.u64().primaryKey(),
  sessionId: t.u64(),
  questionId: t.u64(),
  status: CallStatus,
  result: t.string(),
  endReason: t.string(),
  reasonCode: t.string(),
  reason: t.string(),
  scriptDigest: t.string(),
  consentOnFile: t.bool(),
  cancelRequested: t.bool(),
  createdAt: t.timestamp(),
  confirmedAt: t.option(t.timestamp()),
  dialedAt: t.option(t.timestamp()),
  ringingAt: t.option(t.timestamp()),
  connectedAt: t.option(t.timestamp()),
  endedAt: t.option(t.timestamp()),
  updatedAt: t.timestamp(),
  textShared: t.bool(),
  contactName: t.string(),
  readBackText: t.string(),
  transcript: t.array(BoardCallLine),
  // Module v2 (docs/spacetime.md 14), all content-free. The call option, the read-back and confirm window times, the
  // commands that confirmed and stopped it, and whether the Dialer put the contact on hold.
  optionId: t.u64(),
  readbackDoneAt: t.option(t.timestamp()),
  confirmOpensAt: t.option(t.timestamp()),
  confirmClosesAt: t.option(t.timestamp()),
  confirmGestureId: t.string(),
  stopGestureId: t.string(),
  held: t.bool(),
});

// ---------- Shared reads ----------

function liveRole(db: ReadDb, sender: ViewContext['sender']): string {
  const d = db.device.identity.find(sender);
  return d && !d.revoked ? d.role.tag : '';
}

/** The active session id, or 0n (the board keeps showing the most recent one after it ends). */
function boardSessionId(db: ReadDb): bigint {
  return db.config.id.find(0)?.activeSessionId ?? 0n;
}

function activeSessionId(db: ReadDb): bigint {
  const id = boardSessionId(db);
  if (id === 0n) return 0n;
  const s = db.session.id.find(id);
  return s && s.endedAt === undefined ? id : 0n;
}

/**
 * The active session a Station may read: any Station normally; in the try sandbox only the Station that armed it, so
 * an earlier judge's page never reads the next judge's try (sandbox.ts). 0n for none.
 */
function stationSessionId(db: ReadDb, sender: ViewContext['sender']): bigint {
  const id = activeSessionId(db);
  if (id === 0n || !sandboxOn(db)) return id;
  return db.session.id.find(id)?.station.isEqual(sender) ? id : 0n;
}

function sharing(db: ReadDb): boolean {
  return db.config.id.find(0)?.shareTextOnBoard ?? false;
}

function newestBy<T extends { id: bigint }>(rows: Iterable<T>, keep: (r: T) => boolean = () => true): T | undefined {
  let best: T | undefined;
  for (const r of rows) if (keep(r) && (!best || r.id > best.id)) best = r;
  return best;
}

function lastQuestions(db: ReadDb, sessionId: bigint, n: number): Question[] {
  return [...db.question.questionBySession.filter(sessionId)].sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, n);
}

/** The step word the partner's phone shows (`docs/spacetime.md` 5). */
function partnerStep(db: ReadDb, q: Question): string {
  switch (q.status.tag) {
    case 'Drafting': {
      const claimed = [...db.agentJob.jobByQuestion.filter(q.id)].some((j) => j.status.tag === 'Claimed' || j.attempt > 0);
      return claimed ? 'looking_up' : 'heard';
    }
    case 'Ready':
      return 'looking_up';
    case 'Scanning': {
      const s = db.scanState.sessionId.find(q.sessionId);
      return s && s.questionId === q.id && s.phase.tag === 'Veto' ? 'picked' : 'reading';
    }
    case 'Released':
    case 'Acting':
      return 'picked';
    case 'Spoken':
      return 'said';
    case 'None':
      return 'none';
    case 'NoPick':
      return 'no_pick';
    case 'Stopped':
      return 'stopped';
    case 'Cancelled':
      return 'cancelled';
    case 'Failed':
      return 'failed';
  }
}

const snake = (tag: string) => tag.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** Content-free: the errand or call a question started, as `errand:previewed`. */
function partnerAction(db: ReadDb, q: Question): string {
  const e = newestBy(db.errand.errandBySession.filter(q.sessionId), (r) => r.questionId === q.id);
  if (e) return `errand:${snake(e.status.tag)}`;
  const c = newestBy(db.callRequest.callBySession.filter(q.sessionId), (r) => r.questionId === q.id);
  if (c) return `call:${snake(c.status.tag)}`;
  return '';
}

// ---------- Per-identity views ----------

/**
 * Station: the session, the scanned question, the active errand and call, the last gesture. Speaker: only the
 * newest released reply to say aloud. Anyone else: nothing.
 */
export const mySession = spacetimedb.view({ public: true }, t.option(SessionView), (ctx) => {
  const role = liveRole(ctx.db, ctx.sender);
  if (role !== 'Station' && role !== 'Speaker') return undefined;
  const sessionId = role === 'Station' ? stationSessionId(ctx.db, ctx.sender) : activeSessionId(ctx.db);
  if (sessionId === 0n) return undefined;
  const empty = {
    sessionId,
    role: role.toLowerCase(),
    questionId: 0n,
    questionText: '',
    origin: { tag: 'Partner' as const },
    answerMode: { tag: 'Pick' as const },
    errand: undefined,
    call: undefined,
    lastGestureId: '',
    lastGestureOutcome: '',
    reply: undefined,
  };
  if (role === 'Speaker') {
    const q = newestBy(ctx.db.question.questionBySession.filter(sessionId), (r) => r.status.tag === 'Released');
    if (!q || q.releasedAt === undefined) return empty;
    const picked = q.pickedOptionId !== undefined ? ctx.db.answerOption.id.find(q.pickedOptionId) : undefined;
    return {
      ...empty,
      reply: { questionId: q.id, text: q.replyText ?? '', tone: q.replyTone ?? '', laugh: picked?.laugh ?? false, releasedAt: q.releasedAt },
    };
  }
  const scan = ctx.db.scanState.sessionId.find(sessionId);
  const q = scan && scan.questionId !== 0n ? ctx.db.question.id.find(scan.questionId) : undefined;
  const e = newestBy(ctx.db.errand.errandBySession.filter(sessionId));
  const c = newestBy(ctx.db.callRequest.callBySession.filter(sessionId));
  let last: { id: string; outcome: string; at: bigint } | undefined;
  for (const g of ctx.db.gestureLog.gestureBySession.filter(sessionId)) {
    const at = g.receivedAt.microsSinceUnixEpoch;
    if (!last || at >= last.at) last = { id: g.gestureId, outcome: g.outcome, at };
  }
  return {
    ...empty,
    questionId: q?.id ?? 0n,
    questionText: q?.text ?? '',
    origin: q?.origin ?? empty.origin,
    answerMode: q?.answerMode ?? empty.answerMode,
    errand: e
      ? {
          errandId: e.id,
          status: e.status,
          formTitle: e.formTitle,
          readBackText: e.readBackText,
          previewDigest: e.previewDigest,
          confirmOpensAt: e.confirmOpensAt,
          confirmClosesAt: e.confirmClosesAt,
          reasonCode: e.reasonCode,
          reason: e.reason,
        }
      : undefined,
    call: c
      ? {
          callId: c.id,
          status: c.status,
          contactName: c.contactName,
          readBackText: c.readBackText,
          scriptDigest: c.scriptDigest,
          confirmOpensAt: c.confirmOpensAt,
          confirmClosesAt: c.confirmClosesAt,
          reasonCode: c.reasonCode,
          reason: c.reason,
        }
      : undefined,
    lastGestureId: last?.id ?? '',
    lastGestureOutcome: last?.outcome ?? '',
  };
});

/** Station only: the options of the scanned version and of a waiting newer version, to synthesize early. */
export const myOptions = spacetimedb.view({ public: true }, t.array(StationOption), (ctx) => {
  if (liveRole(ctx.db, ctx.sender) !== 'Station') return [];
  const sessionId = stationSessionId(ctx.db, ctx.sender);
  const scan = sessionId === 0n ? undefined : ctx.db.scanState.sessionId.find(sessionId);
  if (!scan || scan.questionId === 0n) return [];
  const q = ctx.db.question.id.find(scan.questionId);
  if (!q) return [];
  const rows = [];
  for (const [version, current] of [[q.version, true], [q.pendingVersion, false]] as const) {
    if (version === 0 || (!current && version === q.version)) continue;
    for (const o of optionsOf(ctx.db, q.id, version)) {
      rows.push({
        optionId: o.id,
        questionId: o.questionId,
        version: o.version,
        rank: o.rank,
        kind: o.kind,
        menuItem: o.menuItem,
        text: o.text,
        tone: o.tone,
        laugh: o.laugh,
        clipMs: o.clipMs,
        current,
      });
    }
  }
  return rows;
});

/** Partner: progress and the reply for each question of the active session. Never the candidate options. */
export const partnerView = spacetimedb.view({ public: true }, t.array(PartnerQuestion), (ctx) => {
  if (liveRole(ctx.db, ctx.sender) !== 'Partner') return [];
  const sessionId = activeSessionId(ctx.db);
  if (sessionId === 0n) return [];
  return [...ctx.db.question.questionBySession.filter(sessionId)].map((q) => ({
    questionId: q.id,
    number: q.number,
    text: q.text,
    via: q.via,
    step: partnerStep(ctx.db, q),
    outcome: q.outcome ? snake(q.outcome.tag) : '',
    replyText: q.replyText ?? '',
    releasedAt: q.releasedAt,
    spokenAt: q.spokenAt,
    askedByMe: q.askedBy.isEqual(ctx.sender),
    action: partnerAction(ctx.db, q),
    askedAt: q.askedAt,
  }));
});

function queueItem(db: ReadDb, j: AgentJob, me: ViewContext['sender'], sessionId: bigint) {
  const q = db.question.id.find(j.questionId);
  const e = j.errandId !== 0n ? db.errand.id.find(j.errandId) : undefined;
  const recent = sessionId === 0n ? undefined : newestBy(db.errand.errandBySession.filter(sessionId), (r) => r.status.tag === 'Submitted');
  return {
    jobId: j.id,
    kind: j.kind,
    status: j.status,
    attempt: j.attempt,
    claimedByMe: j.status.tag === 'Claimed' && j.claimedBy.isEqual(me),
    questionId: j.questionId,
    questionText: q?.text ?? '',
    origin: q?.origin ?? { tag: 'Partner' as const },
    menuItem: q?.menuItem ?? { tag: 'None' as const },
    askedBy: q ? q.askedBy.toHexString() : '',
    webSearchAllowed: j.webSearchAllowed,
    memoryAllowed: j.memoryAllowed,
    errandId: j.errandId,
    formKey: e?.formKey ?? '',
    formUrl: e?.formUrl ?? '',
    formTitle: e?.formTitle ?? '',
    fieldsJson: e?.fieldsJson ?? '',
    replyText: q?.replyText ?? '',
    recentErrandTitle: recent?.formTitle ?? '',
    recentErrandSentAt: recent?.submittedAt,
    createdAt: j.createdAt,
  };
}

/** Agent: every Pending job, plus the jobs this agent holds. The sidecar applies its own 10-minute rule to the
 * recent errand (a view has no clock). */
export const agentQueue = spacetimedb.view({ public: true }, t.array(AgentQueueItem), (ctx) => {
  if (liveRole(ctx.db, ctx.sender) !== 'Agent') return [];
  const sessionId = activeSessionId(ctx.db);
  const rows = [];
  for (const j of ctx.db.agentJob.jobByStatus.filter({ tag: 'Pending' })) rows.push(queueItem(ctx.db, j, ctx.sender, sessionId));
  for (const j of ctx.db.agentJob.jobByStatus.filter({ tag: 'Claimed' })) {
    if (j.claimedBy.isEqual(ctx.sender)) rows.push(queueItem(ctx.db, j, ctx.sender, sessionId));
  }
  return rows;
});

/** Agent: Confirmed errands to claim, plus the Submitting ones this agent holds. */
export const errandQueue = spacetimedb.view({ public: true }, t.array(ErrandQueueItem), (ctx) => {
  if (liveRole(ctx.db, ctx.sender) !== 'Agent') return [];
  const rows = [];
  for (const tag of ['Confirmed', 'Submitting'] as const) {
    for (const e of ctx.db.errand.errandByStatus.filter({ tag })) {
      const mine = e.claimedBy.isEqual(ctx.sender);
      if (tag === 'Submitting' && !mine) continue;
      rows.push({
        errandId: e.id,
        status: e.status,
        claimAttempt: e.claimAttempt,
        claimedByMe: tag === 'Submitting' && mine,
        formKey: e.formKey,
        formUrl: e.formUrl,
        fieldsJson: e.fieldsJson,
        confirmedDigest: e.confirmedDigest,
        confirmedAt: e.confirmedAt,
      });
    }
  }
  return rows;
});

/**
 * Agent (stretch): Confirmed calls to claim, plus the live ones this agent holds, plus its calls whose dial lease
 * lapsed: those are Failed with `cancel_requested`, and stay here so the sidecar still hangs up a call that may be on
 * the line (its `reconcile` cancels on `cancel_requested`; a row that leaves the view is only forgotten).
 */
export const callQueue = spacetimedb.view({ public: true }, t.array(CallQueueItem), (ctx) => {
  if (liveRole(ctx.db, ctx.sender) !== 'Agent') return [];
  const rows = [];
  for (const tag of ['Confirmed', 'Dialing', 'Ringing', 'Connected', 'Failed'] as const) {
    for (const c of ctx.db.callRequest.callByStatus.filter({ tag })) {
      const mine = c.claimedBy.isEqual(ctx.sender);
      if (tag !== 'Confirmed' && !mine) continue;
      if (tag === 'Failed' && !(c.reasonCode === 'lease_lapsed' && c.cancelRequested)) continue;
      rows.push({
        callId: c.id,
        status: c.status,
        claimAttempt: c.claimAttempt,
        claimedByMe: tag !== 'Confirmed' && mine,
        requestId: c.requestId,
        contactId: c.contactId,
        scriptDigest: c.scriptDigest,
        cancelRequested: c.cancelRequested,
        cancelReason: c.cancelReason,
        confirmedAt: c.confirmedAt,
      });
    }
  }
  return rows;
});

/**
 * Agent (module v2): the consent the agent works under now, one row. Memory and web search consent are rows for every
 * subject (an empty subject), so this is what `memory_allowed` and `web_search_allowed` on a new job would say. The
 * sidecar forgets the conversation it keeps as soon as `memory_allowed` turns false, with or without a job. The
 * session id is the active session, or 0 between sessions.
 */
export const agentConsent = spacetimedb.view({ public: true }, t.array(ConsentState), (ctx) => {
  if (liveRole(ctx.db, ctx.sender) !== 'Agent') return [];
  return [
    {
      sessionId: activeSessionId(ctx.db),
      memoryAllowed: hasConsent(ctx.db, 'Memory', ''),
      webSearchAllowed: hasConsent(ctx.db, 'WebSearch', ''),
    },
  ];
});

// ---------- Anonymous board views (dashboards and judges, no login) ----------

/** The last 20 questions with their scanned options nested. With sharing off: "Question N" and "Option N". */
export const publicBoard = spacetimedb.anonymousView({ public: true }, t.array(BoardQuestion), (ctx: AnonContext) => {
  const sessionId = boardSessionId(ctx.db);
  if (sessionId === 0n) return [];
  const share = sharing(ctx.db);
  return lastQuestions(ctx.db, sessionId, 20)
    .reverse()
    .map((q) => ({
      questionId: q.id,
      sessionId: q.sessionId,
      number: q.number,
      origin: q.origin,
      via: q.via,
      textShared: share,
      text: share ? q.text : q.number === 0 ? 'Menu' : `Question ${q.number}`,
      answerMode: q.answerMode,
      status: q.status,
      outcome: q.outcome,
      version: q.version,
      options: optionsOf(ctx.db, q.id, q.version).map((o) => ({
        optionId: o.id,
        rank: o.rank,
        kind: o.kind,
        label: share ? o.text : `Option ${o.rank}`,
        tone: o.tone,
        laugh: o.laugh,
        provenance: o.provenance,
        sources: share ? o.sources : [],
        clipMs: o.clipMs,
      })),
      pickedOptionId: q.pickedOptionId,
      replyText: share ? (q.replyText ?? '') : '',
      releasedAt: q.releasedAt,
      spokenAt: q.spokenAt,
      askedAt: q.askedAt,
    }));
});

/** The content behind pipeline events for the last 5 questions, only while sharing is on. */
export const boardPayloads = spacetimedb.anonymousView({ public: true }, t.array(BoardPayload), (ctx: AnonContext) => {
  if (!sharing(ctx.db)) return [];
  const sessionId = boardSessionId(ctx.db);
  if (sessionId === 0n) return [];
  const rows = [];
  for (const q of lastQuestions(ctx.db, sessionId, 5)) {
    for (const p of ctx.db.pipelinePayload.payloadByQuestion.filter(q.id)) {
      if (p.sessionId !== sessionId) continue;
      rows.push({ eventId: p.eventId, questionId: p.questionId, stage: p.stage, payloadJson: p.payloadJson });
    }
  }
  return rows;
});

/**
 * Every errand of the session: status, digest, reason code and times. While sharing is off the form title is
 * "Form" and the reason is the module's own sentence for its code (or empty): titles come from the planner and the
 * page, and reason sentences from the Actor or the sidecar, so they can carry a name. The read-back, the result
 * and the screenshot appear only while sharing is on.
 */
export const boardErrands = spacetimedb.anonymousView({ public: true }, t.array(BoardErrand), (ctx: AnonContext) => {
  const sessionId = boardSessionId(ctx.db);
  if (sessionId === 0n) return [];
  const share = sharing(ctx.db);
  return [...ctx.db.errand.errandBySession.filter(sessionId)].map((e) => ({
    errandId: e.id,
    sessionId: e.sessionId,
    questionId: e.questionId,
    status: e.status,
    formTitle: share ? e.formTitle : 'Form',
    previewDigest: e.previewDigest,
    reasonCode: publicCode(e.reasonCode, snake(e.status.tag)),
    reason: share ? e.reason : publicReason(e.reasonCode, false),
    confirmGestureId: e.confirmGestureId,
    stopGestureId: e.stopGestureId,
    createdAt: e.createdAt,
    previewedAt: e.previewedAt,
    readbackDoneAt: e.readbackDoneAt,
    confirmOpensAt: e.confirmOpensAt,
    confirmClosesAt: e.confirmClosesAt,
    confirmedAt: e.confirmedAt,
    claimedAt: e.claimedAt,
    submittedAt: e.submittedAt,
    endedAt: e.endedAt,
    updatedAt: e.updatedAt,
    textShared: share,
    readBackText: share ? e.readBackText : '',
    readBackJson: share ? e.readBackJson : '',
    confirmationText: share ? e.confirmationText : '',
    screenshotUrl: share ? e.screenshotUrl : '',
    optionId: e.optionId,
  }));
});

/**
 * Every call of the session (stretch). Never a number. While sharing is off the name is "Contact", the Dialer's end
 * reason is hidden and the reason is the module's own sentence for its code (or empty).
 */
export const boardCalls = spacetimedb.anonymousView({ public: true }, t.array(BoardCall), (ctx: AnonContext) => {
  const sessionId = boardSessionId(ctx.db);
  if (sessionId === 0n) return [];
  const share = sharing(ctx.db);
  return [...ctx.db.callRequest.callBySession.filter(sessionId)].map((c) => ({
    callId: c.id,
    sessionId: c.sessionId,
    questionId: c.questionId,
    status: c.status,
    result: c.result,
    endReason: share ? c.endReason : '',
    reasonCode: publicCode(c.reasonCode, snake(c.status.tag)),
    reason: share ? c.reason : publicReason(c.reasonCode, true),
    scriptDigest: c.scriptDigest,
    consentOnFile: hasConsent(ctx.db, 'Call', c.contactId),
    cancelRequested: c.cancelRequested,
    createdAt: c.createdAt,
    confirmedAt: c.confirmedAt,
    dialedAt: c.dialedAt,
    ringingAt: c.ringingAt,
    connectedAt: c.connectedAt,
    endedAt: c.endedAt,
    updatedAt: c.updatedAt,
    textShared: share,
    contactName: share ? c.contactName : 'Contact',
    readBackText: share ? c.readBackText : '',
    transcript: share
      ? [...ctx.db.callLine.callId.filter(c.id)]
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .map((l) => ({ role: l.role, text: l.text, at: l.at }))
      : [],
    optionId: c.optionId,
    readbackDoneAt: c.readbackDoneAt,
    confirmOpensAt: c.confirmOpensAt,
    confirmClosesAt: c.confirmClosesAt,
    confirmGestureId: c.confirmGestureId,
    stopGestureId: c.stopGestureId,
    held: isHeld(c),
  }));
});

/** Every ledger row (content-free). The query-builder form is evaluated incrementally as the ledger grows. */
export const boardLedger = spacetimedb.anonymousView({ public: true }, t.array(ledger.rowType), (ctx: AnonContext) => ctx.from.ledger);

// ---------- Session-scoped board views (module v2) ----------
// `pipeline_event` and `board_ledger` hold every session, so a database that runs for days grows on every screen.
// These hold the board's session only (the active one, kept after it ends, as `public_board` does): the same rows,
// filtered by the session index.

/** The board session's pipeline events: the rows of `pipeline_event` for that session. */
export const boardEvents = spacetimedb.anonymousView({ public: true }, t.array(pipelineEvent.rowType), (ctx: AnonContext) => {
  const sessionId = boardSessionId(ctx.db);
  return sessionId === 0n ? [] : [...ctx.db.pipelineEvent.eventBySession.filter(sessionId)];
});

/** The board session's ledger rows (content-free): `board_ledger` for that session. */
export const boardSessionLedger = spacetimedb.anonymousView({ public: true }, t.array(ledger.rowType), (ctx: AnonContext) => {
  const sessionId = boardSessionId(ctx.db);
  return sessionId === 0n ? [] : [...ctx.db.ledger.ledgerBySession.filter(sessionId)];
});

/** The station's word timings for the board session's reads: numbers only, keyed by the speak step's event id. */
export const boardWordTimings = spacetimedb.anonymousView({ public: true }, t.array(wordTiming.rowType), (ctx: AnonContext) => {
  const sessionId = boardSessionId(ctx.db);
  return sessionId === 0n ? [] : [...ctx.db.wordTiming.timingBySession.filter(sessionId)];
});
