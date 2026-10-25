// Eleven's SpacetimeDB schema: every enum, shared object type and table (docs/spacetime.md section 2).
//
// Keys are camelCase here. The 2.13 default case policy makes the wire names snake_case, so `scanState` is the
// table `scan_state` and `stepSeq` is its column `step_seq`. Generated bindings are camelCase again.
//
// Rules that keep a publish working:
// - Every named type is declared once and reused. Each reducer and view also claims the PascalCase of its own
//   name for its parameter type (the view `mySession` owns `MySession`), so no row type may use such a name.
// - After the first demo publish: new enum variants and new columns go only at the end (columns with a default).
// - Private by default. A public table never carries conversation content.
import { schema, t, table, type Infer } from 'spacetimedb/server';

// ---------- Enums (2.2) ----------

export const Role = t.enum('Role', ['Station', 'Partner', 'Speaker', 'Agent']);
export type Role = Infer<typeof Role>;

/** Wire strings are the D11 words: YES, NO, CONFIRM, STOP, HEADSET_OFF. */
export const Command = t.enum('Command', ['Yes', 'No', 'Confirm', 'Stop', 'HeadsetOff']);
export type Command = Infer<typeof Command>;

export const Phase = t.enum('Phase', ['Idle', 'Preparing', 'Reading', 'Window', 'Veto', 'Paused']);
export type Phase = Infer<typeof Phase>;

export const ScanMode = t.enum('ScanMode', ['Answer', 'Menu']);
export type ScanMode = Infer<typeof ScanMode>;

export const AnswerMode = t.enum('AnswerMode', ['Pick', 'YesNo']);
export type AnswerMode = Infer<typeof AnswerMode>;

export const ScanOutcome = t.enum('ScanOutcome', ['Picked', 'None', 'NoPick', 'Stopped', 'Cancelled']);
export type ScanOutcome = Infer<typeof ScanOutcome>;

export const PauseReason = t.enum('PauseReason', ['HeadsetLost', 'HeadsetOff', 'Stop', 'Idle', 'Operator']);
export type PauseReason = Infer<typeof PauseReason>;

export const Origin = t.enum('Origin', ['Partner', 'Menu']);
export type Origin = Infer<typeof Origin>;

export const MenuItem = t.enum('MenuItem', ['None', 'Need', 'Request', 'Call', 'Say']);
export type MenuItem = Infer<typeof MenuItem>;

export const QuestionStatus = t.enum('QuestionStatus', [
  'Drafting',
  'Ready',
  'Scanning',
  'Released',
  'Spoken',
  'Acting',
  'None',
  'NoPick',
  'Stopped',
  'Cancelled',
  'Failed',
]);
export type QuestionStatus = Infer<typeof QuestionStatus>;

export const OptionKind = t.enum('OptionKind', ['Reply', 'Errand', 'Call', 'Menu']);
export type OptionKind = Infer<typeof OptionKind>;

export const JobKind = t.enum('JobKind', ['Options', 'ErrandPreview', 'Remember']);
export type JobKind = Infer<typeof JobKind>;

export const JobStatus = t.enum('JobStatus', ['Pending', 'Claimed', 'Done', 'Failed', 'Cancelled']);
export type JobStatus = Infer<typeof JobStatus>;

export const ErrandStatus = t.enum('ErrandStatus', [
  'Drafted',
  'Previewed',
  'AwaitingConfirm',
  'Confirmed',
  'Submitting',
  'Submitted',
  'Refused',
  'Failed',
  'UnknownOutcome',
  'Stopped',
]);
export type ErrandStatus = Infer<typeof ErrandStatus>;

export const CallStatus = t.enum('CallStatus', [
  'Prepared',
  'AwaitingConfirm',
  'Confirmed',
  'Dialing',
  'Ringing',
  'Connected',
  'Ended',
  'Failed',
  'Stopped',
  'Refused',
]);
export type CallStatus = Infer<typeof CallStatus>;

export const ConsentScope = t.enum('ConsentScope', ['WebSearch', 'Memory', 'Errand', 'Call', 'BoardText']);
export type ConsentScope = Infer<typeof ConsentScope>;

export const ScanTimerKind = t.enum('ScanTimerKind', ['StepEnd', 'VetoEnd', 'ClipDeadline']);
export type ScanTimerKind = Infer<typeof ScanTimerKind>;

export const ErrandTimerKind = t.enum('ErrandTimerKind', ['Preview', 'Readback', 'ConfirmWindow', 'Submit']);
export type ErrandTimerKind = Infer<typeof ErrandTimerKind>;

export const CallTimerKind = t.enum('CallTimerKind', ['Readback', 'ConfirmWindow', 'Lease']);
export type CallTimerKind = Infer<typeof CallTimerKind>;

// ---------- Shared object types ----------

/** The existing Option row contract: `{ source, url?, place_id?, fetched_at }`. */
export const SourceRef = t.object('SourceRef', {
  source: t.string(),
  url: t.option(t.string()),
  placeId: t.option(t.string()),
  fetchedAt: t.string(),
});
export type SourceRef = Infer<typeof SourceRef>;

/** One option as the planner sends it to `agent_publish_options` (3.6). */
export const OptionInput = t.object('OptionInput', {
  kind: t.string(),
  text: t.string(),
  tone: t.string(),
  laugh: t.bool(),
  provenance: t.string(),
  sources: t.array(SourceRef),
  memoryRefs: t.array(t.string()),
  actionJson: t.string(),
});
export type OptionInput = Infer<typeof OptionInput>;

/** What `mint_voice_token` returns. `error` is a code; it never carries the key or the token. */
export const VoiceToken = t.object('VoiceToken', {
  token: t.string(),
  expiresAtMs: t.u64(),
  error: t.string(),
});
export type VoiceToken = Infer<typeof VoiceToken>;

/** What the owner-only `smoke_fetch` probe returns (smoke step S1). */
export const SmokeResult = t.object('SmokeResult', {
  status: t.u32(),
  ms: t.u32(),
  error: t.string(),
});
export type SmokeResult = Infer<typeof SmokeResult>;

// ---------- Config, devices, consent, sessions (2.4) ----------

/** One row, id 0. Public: no secrets and no content, so the station and anonymous views read it directly. */
export const config = table(
  { public: true },
  t.row('Config', {
    id: t.u8().primaryKey(),
    owner: t.identity(),
    activeSessionId: t.u64(),
    shareTextOnBoard: t.bool(),
    menuEnabled: t.bool(),
    autoResume: t.bool(),
    dispatchMode: t.string(),
    responseWindowMs: t.u32(),
    graceMs: t.u32(),
    refractoryMs: t.u32(),
    quietHoldMs: t.u32(),
    confirmWindowMs: t.u32(),
    replyVetoMs: t.u32(),
    yesNoCueMs: t.u32(),
    audioPadMs: t.u32(),
    clipDeadlineMs: t.u32(),
    maxPasses: t.u8(),
    maxOptions: t.u8(),
    heartbeatMs: t.u32(),
    livenessLeaseMs: t.u32(),
    resumeGoodContactMs: t.u32(),
    idlePauseMs: t.u32(),
    readbackDeadlineMs: t.u32(),
    previewTimeoutMs: t.u32(),
    submitLeaseMs: t.u32(),
    callLeaseMs: t.u32(),
    jobLeaseMs: t.u32(),
    jobMaxAttempts: t.u8(),
    pairingTtlMs: t.u32(),
  }),
);
export type Config = Infer<typeof config.rowType>;

/** Identity to role. One role per identity. */
export const device = table(
  { indexes: [{ accessor: 'deviceByRole', algorithm: 'btree', columns: ['role'] }] },
  t.row('Device', {
    identity: t.identity().primaryKey(),
    role: Role,
    label: t.string(),
    caregiver: t.bool(),
    pairedAt: t.timestamp(),
    revoked: t.bool(),
  }),
);
export type Device = Infer<typeof device.rowType>;

export const pairingRequest = table(
  {},
  t.row('PairingRequest', {
    code: t.u32().primaryKey(),
    requester: t.identity().unique(),
    role: Role,
    label: t.string(),
    requestedAt: t.timestamp(),
    expiresAt: t.timestamp(),
  }),
);
export type PairingRequest = Infer<typeof pairingRequest.rowType>;

/** A scope check finds a row with `revokedAt` unset and `subject` equal to the asked subject or empty. */
export const consent = table(
  { indexes: [{ accessor: 'consentByScope', algorithm: 'btree', columns: ['scope'] }] },
  t.row('Consent', {
    id: t.u64().primaryKey().autoInc(),
    scope: ConsentScope,
    subject: t.string(),
    grantedBy: t.identity(),
    method: t.string(),
    note: t.string(),
    grantedAt: t.timestamp(),
    revokedAt: t.option(t.timestamp()),
  }),
);
export type Consent = Infer<typeof consent.rowType>;

/** One armed run of the station. The active one is `config.activeSessionId` with `endedAt` unset. */
export const session = table(
  {},
  t.row('Session', {
    id: t.u64().primaryKey().autoInc(),
    station: t.identity(),
    label: t.string(),
    startedAt: t.timestamp(),
    endedAt: t.option(t.timestamp()),
    questionCount: t.u32(),
    lastAcceptedAt: t.option(t.timestamp()),
    lastCommandAt: t.timestamp(),
    idleSeq: t.u64(),
  }),
);
export type Session = Infer<typeof session.rowType>;

// ---------- Questions and options (2.5) ----------

export const question = table(
  { indexes: [{ accessor: 'questionBySession', algorithm: 'btree', columns: ['sessionId'] }] },
  t.row('Question', {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64(),
    requestId: t.string().unique(),
    origin: Origin,
    via: t.string(),
    menuItem: MenuItem,
    askedBy: t.identity(),
    text: t.string(),
    number: t.u32(),
    answerMode: AnswerMode,
    version: t.u32(),
    pendingVersion: t.u32(),
    /** The answer mode of `pendingVersion`, switched in with it at the end of a pass. */
    pendingAnswerMode: AnswerMode,
    status: QuestionStatus,
    outcome: t.option(ScanOutcome),
    pickedOptionId: t.option(t.u64()),
    replyText: t.option(t.string()),
    replyTone: t.option(t.string()),
    listenMs: t.u32(),
    askedAt: t.timestamp(),
    readyAt: t.option(t.timestamp()),
    releasedAt: t.option(t.timestamp()),
    spokenAt: t.option(t.timestamp()),
    endedAt: t.option(t.timestamp()),
  }),
);
export type Question = Infer<typeof question.rowType>;

export const answerOption = table(
  {
    indexes: [
      { accessor: 'optionByQv', algorithm: 'btree', columns: ['questionId', 'version'] },
      { accessor: 'optionByQuestion', algorithm: 'btree', columns: ['questionId'] },
    ],
  },
  t.row('AnswerOption', {
    id: t.u64().primaryKey().autoInc(),
    questionId: t.u64(),
    version: t.u32(),
    rank: t.u8(),
    kind: OptionKind,
    menuItem: MenuItem,
    text: t.string(),
    tone: t.string(),
    laugh: t.bool(),
    provenance: t.string(),
    sources: t.array(SourceRef),
    memoryRefs: t.array(t.string()),
    actionJson: t.string(),
    clipMs: t.option(t.u32()),
    createdAt: t.timestamp(),
  }),
);
export type AnswerOption = Infer<typeof answerOption.rowType>;

// ---------- The scan clock (2.6) ----------

/** One row per session. Ids and numbers only, so it is safe to publish. */
export const scanState = table(
  { public: true },
  t.row('ScanState', {
    sessionId: t.u64().primaryKey(),
    questionId: t.u64(),
    version: t.u32(),
    mode: ScanMode,
    answerMode: AnswerMode,
    phase: Phase,
    cursor: t.u8(),
    optionCount: t.u8(),
    pass: t.u8(),
    maxPasses: t.u8(),
    stepSeq: t.u64(),
    stepStartedAt: t.timestamp(),
    stepEndsAt: t.timestamp(),
    optionStartSeq: t.u64(),
    optionStartedAt: t.timestamp(),
    prevCursor: t.u8(),
    prevOptionStartSeq: t.u64(),
    outcome: t.option(ScanOutcome),
    pickedRank: t.option(t.u8()),
    pickedOptionId: t.option(t.u64()),
    pauseReason: t.option(PauseReason),
    pausedAt: t.option(t.timestamp()),
    resumeCursor: t.u8(),
    updatedAt: t.timestamp(),
  }),
);
export type ScanState = Infer<typeof scanState.rowType>;

/** Schedule table bound to `scan_tick`. One-shot rows; `stepSeq` is the fence. */
export const scanTimer = table(
  {},
  t.row('ScanTimer', {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    sessionId: t.u64().index('btree'),
    stepSeq: t.u64(),
    kind: ScanTimerKind,
  }),
);
export type ScanTimer = Infer<typeof scanTimer.rowType>;

// ---------- Gestures and the ledger (2.7) ----------

/** One row per gesture call, accepted or not. */
export const gestureLog = table(
  { indexes: [{ accessor: 'gestureBySession', algorithm: 'btree', columns: ['sessionId'] }] },
  t.row('GestureLog', {
    gestureId: t.string().primaryKey(),
    sessionId: t.u64(),
    device: t.identity(),
    command: Command,
    source: t.string(),
    confidence: t.f32(),
    heardStepSeq: t.u64(),
    heardOptionId: t.u64(),
    heardDigest: t.string(),
    onsetAgeMs: t.u32(),
    receivedAt: t.timestamp(),
    outcome: t.string(),
    reason: t.string(),
    questionId: t.u64(),
    optionId: t.u64(),
    errandId: t.u64(),
    callId: t.u64(),
    lateByMs: t.u32(),
  }),
);
export type GestureLog = Infer<typeof gestureLog.rowType>;

/** Append-only and content-free; written in the same transaction as every state change. */
export const ledger = table(
  { indexes: [{ accessor: 'ledgerBySession', algorithm: 'btree', columns: ['sessionId'] }] },
  t.row('Ledger', {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64(),
    at: t.timestamp(),
    kind: t.string(),
    actor: t.string(),
    questionId: t.u64(),
    optionId: t.u64(),
    errandId: t.u64(),
    callId: t.u64(),
    jobId: t.u64(),
    gestureId: t.string(),
    command: t.string(),
    stepSeq: t.u64(),
    cursor: t.u8(),
    digest: t.string(),
    outcome: t.string(),
    reason: t.string(),
    ms: t.u32(),
  }),
);
export type Ledger = Infer<typeof ledger.rowType>;

// ---------- Errands and calls (2.8) ----------

export const errand = table(
  {
    indexes: [
      { accessor: 'errandByStatus', algorithm: 'btree', columns: ['status'] },
      { accessor: 'errandBySession', algorithm: 'btree', columns: ['sessionId'] },
    ],
  },
  t.row('Errand', {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64(),
    questionId: t.u64(),
    optionId: t.u64(),
    status: ErrandStatus,
    formKey: t.string(),
    formUrl: t.string(),
    formTitle: t.string(),
    fieldsJson: t.string(),
    previewDigest: t.string(),
    readBackText: t.string(),
    readBackJson: t.string(),
    screenshotUrl: t.string(),
    confirmationText: t.string(),
    reasonCode: t.string(),
    reason: t.string(),
    windowSeq: t.u32(),
    readbackDoneAt: t.option(t.timestamp()),
    confirmOpensAt: t.option(t.timestamp()),
    confirmClosesAt: t.option(t.timestamp()),
    confirmedDigest: t.string(),
    confirmGestureId: t.string(),
    stopGestureId: t.string(),
    confirmedAt: t.option(t.timestamp()),
    claimAttempt: t.u32(),
    claimedBy: t.identity(),
    claimedAt: t.option(t.timestamp()),
    submittedAt: t.option(t.timestamp()),
    previewedAt: t.option(t.timestamp()),
    endedAt: t.option(t.timestamp()),
    previewMs: t.u32(),
    submitMs: t.u32(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }),
);
export type Errand = Infer<typeof errand.rowType>;

/** Schedule table bound to `errand_timeout`. `seq` is `windowSeq` or `claimAttempt`, 0 for Preview. */
export const errandLease = table(
  {},
  t.row('ErrandLease', {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    errandId: t.u64().index('btree'),
    kind: ErrandTimerKind,
    seq: t.u32(),
  }),
);
export type ErrandLease = Infer<typeof errandLease.rowType>;

/** Stretch. No phone number is ever stored here; the Dialer keeps numbers on the agent laptop. */
export const callRequest = table(
  {
    indexes: [
      { accessor: 'callByStatus', algorithm: 'btree', columns: ['status'] },
      { accessor: 'callBySession', algorithm: 'btree', columns: ['sessionId'] },
    ],
  },
  t.row('CallRequest', {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64(),
    questionId: t.u64(),
    optionId: t.u64(),
    requestId: t.string().unique(),
    contactId: t.string(),
    contactName: t.string(),
    readBackText: t.string(),
    scriptDigest: t.string(),
    preparedExpiresAt: t.timestamp(),
    status: CallStatus,
    result: t.string(),
    endReason: t.string(),
    reasonCode: t.string(),
    reason: t.string(),
    cancelRequested: t.bool(),
    cancelReason: t.string(),
    windowSeq: t.u32(),
    claimAttempt: t.u32(),
    claimedBy: t.identity(),
    confirmGestureId: t.string(),
    stopGestureId: t.string(),
    readbackDoneAt: t.option(t.timestamp()),
    confirmOpensAt: t.option(t.timestamp()),
    confirmClosesAt: t.option(t.timestamp()),
    confirmedAt: t.option(t.timestamp()),
    dialedAt: t.option(t.timestamp()),
    ringingAt: t.option(t.timestamp()),
    connectedAt: t.option(t.timestamp()),
    endedAt: t.option(t.timestamp()),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }),
);
export type CallRequest = Infer<typeof callRequest.rowType>;

/** Stretch: call transcript lines, numbers already masked by the Dialer. */
export const callLine = table(
  {},
  t.row('CallLine', {
    id: t.u64().primaryKey().autoInc(),
    callId: t.u64().index('btree'),
    lineKey: t.string().unique(),
    role: t.string(),
    text: t.string(),
    at: t.timestamp(),
  }),
);
export type CallLine = Infer<typeof callLine.rowType>;

/** Schedule table bound to `call_timeout`. */
export const callTimer = table(
  {},
  t.row('CallTimer', {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    callId: t.u64().index('btree'),
    kind: CallTimerKind,
    seq: t.u32(),
  }),
);
export type CallTimer = Infer<typeof callTimer.rowType>;

// ---------- Agent work, pipeline, devices, cues and the other schedules (2.9) ----------

export const agentJob = table(
  {
    indexes: [
      { accessor: 'jobByStatus', algorithm: 'btree', columns: ['status'] },
      { accessor: 'jobByClaimer', algorithm: 'btree', columns: ['claimedBy'] },
      { accessor: 'jobByQuestion', algorithm: 'btree', columns: ['questionId'] },
    ],
  },
  t.row('AgentJob', {
    id: t.u64().primaryKey().autoInc(),
    kind: JobKind,
    status: JobStatus,
    questionId: t.u64(),
    errandId: t.u64(),
    attempt: t.u32(),
    claimedBy: t.identity(),
    leaseExpiresAt: t.option(t.timestamp()),
    webSearchAllowed: t.bool(),
    memoryAllowed: t.bool(),
    reason: t.string(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }),
);
export type AgentJob = Infer<typeof agentJob.rowType>;

/** Schedule table bound to `lease_expired`. `attempt` is the fence. */
export const jobLease = table(
  {},
  t.row('JobLease', {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    jobId: t.u64().index('btree'),
    attempt: t.u32(),
  }),
);
export type JobLease = Infer<typeof jobLease.rowType>;

/** Public and content-free: ids, fixed-vocabulary words, numbers. The content lives in `pipeline_payload`. */
export const pipelineEvent = table(
  {
    public: true,
    indexes: [{ accessor: 'eventBySession', algorithm: 'btree', columns: ['sessionId'] }],
  },
  t.row('PipelineEvent', {
    id: t.u64().primaryKey().autoInc(),
    eventKey: t.string().unique(),
    sessionId: t.u64(),
    questionId: t.u64(),
    stage: t.string(),
    status: t.string(),
    detail: t.string(),
    ms: t.option(t.u32()),
    countsJson: t.string(),
    actor: t.string(),
    at: t.timestamp(),
  }),
);
export type PipelineEvent = Infer<typeof pipelineEvent.rowType>;

/** Private: the content behind a pipeline event. Reaches the board only through `board_payloads`. */
export const pipelinePayload = table(
  {
    indexes: [
      { accessor: 'payloadBySession', algorithm: 'btree', columns: ['sessionId'] },
      { accessor: 'payloadByQuestion', algorithm: 'btree', columns: ['questionId'] },
    ],
  },
  t.row('PipelinePayload', {
    eventId: t.u64().primaryKey(),
    sessionId: t.u64(),
    questionId: t.u64(),
    stage: t.string(),
    payloadJson: t.string(),
  }),
);
export type PipelinePayload = Infer<typeof pipelinePayload.rowType>;

export const deviceStatus = table(
  { public: true },
  t.row('DeviceStatus', {
    identity: t.identity().primaryKey(),
    role: Role,
    label: t.string(),
    online: t.bool(),
    lastSeenAt: t.timestamp(),
    decoderHealthy: t.option(t.bool()),
  }),
);
export type DeviceStatus = Infer<typeof deviceStatus.rowType>;

/** Public EVENT table: broadcast on commit, never stored, `onInsert` only. The flag cannot change later. */
export const cueEvent = table(
  { public: true, event: true },
  t.row('CueEvent', {
    sessionId: t.u64(),
    kind: t.string(),
    reason: t.string(),
    questionId: t.u64(),
    optionId: t.u64(),
    errandId: t.u64(),
    callId: t.u64(),
    rank: t.u8(),
    at: t.timestamp(),
  }),
);
export type CueEvent = Infer<typeof cueEvent.rowType>;

/** Schedule table bound to `liveness_expired`. The row is the dead-man deadline and the last heartbeat at once. */
export const livenessLease = table(
  {},
  t.row('LivenessLease', {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    sessionId: t.u64().index('btree'),
    beatSeq: t.u64(),
    lastBeatAt: t.timestamp(),
    decoderHealthy: t.bool(),
    healthySince: t.option(t.timestamp()),
  }),
);
export type LivenessLease = Infer<typeof livenessLease.rowType>;

/** Schedule table bound to `idle_pause`. `idleSeq` is the fence against `session.idleSeq`. */
export const idleTimer = table(
  {},
  t.row('IdleTimer', {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    sessionId: t.u64().index('btree'),
    idleSeq: t.u64(),
  }),
);
export type IdleTimer = Infer<typeof idleTimer.rowType>;

/** Schedule table bound to `pairing_expired`. */
export const pairingTimer = table(
  {},
  t.row('PairingTimer', {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    code: t.u32(),
  }),
);
export type PairingTimer = Infer<typeof pairingTimer.rowType>;

/**
 * Gesture ids whose `gesture_log` rows `purge_session` deleted. Only the random id is kept, so a replayed request
 * from a purged session can never count as a new gesture (a CONFIRM is used once, even after a purge).
 * Added after the first publish: a new table is a safe migration.
 */
export const spentGesture = table(
  {},
  t.row('SpentGesture', {
    gestureId: t.string().primaryKey(),
    spentAt: t.timestamp(),
  }),
);
export type SpentGesture = Infer<typeof spentGesture.rowType>;

/**
 * The station's word timings for one option read (module v2, docs/spacetime.md 14): the speak step's event id and
 * numbers only, never the words. One row per read, written once by `report_word_timings`; the board reads them
 * through `board_word_timings`. Added after the first publish: a new table is a safe migration.
 */
export const wordTiming = table(
  { indexes: [{ accessor: 'timingBySession', algorithm: 'btree', columns: ['sessionId'] }] },
  t.row('WordTiming', {
    eventId: t.u64().primaryKey(),
    sessionId: t.u64(),
    questionId: t.u64(),
    optionId: t.u64(),
    rank: t.u8(),
    stepSeq: t.u64(),
    startsMs: t.array(t.u32()),
    endsMs: t.array(t.u32()),
    at: t.timestamp(),
  }),
);
export type WordTiming = Infer<typeof wordTiming.rowType>;

/**
 * The judge try sandbox (PLAN 5.11, docs/spacetime.md 15). One row, id 0, written only by the owner's `set_sandbox`.
 * No row, or `on` false, means every rule in the module is exactly as before: the sandbox is turned on only on the
 * `say-when-try` database. Public: limits only, no content, so the try page can show them.
 * Added after the first publish: a new table is a safe migration.
 */
export const sandboxSettings = table(
  { public: true },
  t.row('SandboxSettings', {
    id: t.u8().primaryKey(),
    on: t.bool(),
    questionsPerTry: t.u32(),
    triesPerHour: t.u32(),
    questionsPerDay: t.u32(),
    pairingsPerHour: t.u32(),
    tokensPerDevicePerHour: t.u32(),
    tokensPerHour: t.u32(),
    maxTryMs: t.u32(),
    staleTryMs: t.u32(),
    updatedAt: t.timestamp(),
  }),
);
export type SandboxSettings = Infer<typeof sandboxSettings.rowType>;

/**
 * The sandbox's counters: one row per key (`pairings`, `tries`, `questions`, `tokens`, `tokens:<identity>`), each a
 * count inside a fixed window that starts at its first use. Private; numbers only.
 */
export const sandboxMeter = table(
  {},
  t.row('SandboxMeter', {
    key: t.string().primaryKey(),
    windowStartedAt: t.timestamp(),
    count: t.u32(),
  }),
);
export type SandboxMeter = Infer<typeof sandboxMeter.rowType>;

const spacetimedb = schema(
  {
    config,
    device,
    pairingRequest,
    consent,
    session,
    question,
    answerOption,
    scanState,
    scanTimer,
    gestureLog,
    ledger,
    errand,
    errandLease,
    callRequest,
    callLine,
    callTimer,
    agentJob,
    jobLease,
    pipelineEvent,
    pipelinePayload,
    deviceStatus,
    cueEvent,
    livenessLease,
    idleTimer,
    pairingTimer,
    spentGesture,
    wordTiming,
    sandboxSettings,
    sandboxMeter,
  },
  {
    // Optional, so a teammate can publish a dev database with no secrets. Values arrive from shell variables
    // at publish time and never live in a file.
    env: {
      CARTESIA_API_KEY: t.string().optional(),
    },
  },
);
export default spacetimedb;
