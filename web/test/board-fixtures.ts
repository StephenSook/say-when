/**
 * Rows shaped exactly as the generated SpacetimeDB bindings give them (lib/data/module_bindings/types), so a schema
 * change breaks the tests at the typecheck. The values follow what the module writes: labels and event keys from
 * docs/spacetime.md 11.4 and 14, ledger kinds and outcomes from spacetime/src, and the config row as say-when-dev held
 * it on Oct 24 (owner and session aside). All content is made-up smoke content.
 */
import { Identity, Timestamp } from 'spacetimedb';
import type {
  BoardCall,
  BoardErrand,
  BoardOption,
  BoardQuestion,
  Config,
  DeviceStatus,
  Ledger,
  PipelineEvent as PipelineRow,
  ScanState as ScanRow,
  WordTiming as WordTimingRow,
} from '../lib/data/module_bindings/types';
import type { BoardSnapshot } from '../lib/data/spacetime-map';

export const SESSION = 6n;
/** Server clock, Oct 24 2026 about 6 AM PDT, in milliseconds. */
export const BASE_MS = 1_792_846_800_000;
/** A row time `offsetMs` after the base, as the SDK gives it. */
export const ts = (offsetMs: number) => new Timestamp(BigInt(BASE_MS + offsetMs) * 1000n);
/** The same time as the screens get it: epoch milliseconds. */
export const ms = (offsetMs: number) => BASE_MS + offsetMs;

export function config(partial: Partial<Config> = {}): Config {
  return {
    id: 0,
    owner: Identity.zero(),
    activeSessionId: SESSION,
    shareTextOnBoard: false,
    menuEnabled: true,
    autoResume: true,
    dispatchMode: 'sidecar',
    responseWindowMs: 3500,
    graceMs: 1000,
    refractoryMs: 1000,
    quietHoldMs: 1000,
    confirmWindowMs: 8000,
    replyVetoMs: 700,
    yesNoCueMs: 900,
    audioPadMs: 150,
    clipDeadlineMs: 4000,
    maxPasses: 2,
    maxOptions: 4,
    heartbeatMs: 500,
    livenessLeaseMs: 1500,
    resumeGoodContactMs: 3000,
    idlePauseMs: 120000,
    readbackDeadlineMs: 30000,
    previewTimeoutMs: 60000,
    submitLeaseMs: 60000,
    callLeaseMs: 240000,
    jobLeaseMs: 45000,
    jobMaxAttempts: 3,
    pairingTtlMs: 300000,
    inputMode: { tag: 'Direct' },
    ...partial,
  };
}

export function option(rank: number, partial: Partial<BoardOption> = {}): BoardOption {
  return {
    optionId: 100n + BigInt(rank),
    rank,
    kind: { tag: 'Reply' },
    label: `Option ${rank}`,
    tone: 'warm',
    laugh: false,
    provenance: 'smoke',
    sources: [],
    clipMs: undefined,
    shortLabel: `Option ${rank}`,
    ...partial,
  };
}

export function question(partial: Partial<BoardQuestion> = {}): BoardQuestion {
  return {
    questionId: 21n,
    sessionId: SESSION,
    number: 1,
    origin: { tag: 'Partner' },
    via: 'typed',
    textShared: false,
    text: 'Question 1',
    answerMode: { tag: 'Pick' },
    status: { tag: 'Scanning' },
    outcome: undefined,
    version: 1,
    options: [1, 2, 3, 4].map((rank) => option(rank)),
    pickedOptionId: undefined,
    replyText: '',
    releasedAt: undefined,
    spokenAt: undefined,
    askedAt: ts(0),
    parentQuestionId: 0n,
    category: '',
    ...partial,
  };
}

export function event(
  id: number,
  eventKey: string,
  stage: string,
  status: string,
  label: string,
  offsetMs: number,
  partial: Partial<PipelineRow> = {},
): PipelineRow {
  return {
    id: BigInt(id),
    eventKey,
    sessionId: SESSION,
    questionId: 21n,
    stage,
    status,
    detail: label,
    ms: status === 'started' ? undefined : 120,
    countsJson: '{}',
    actor: 'Module',
    at: ts(offsetMs),
    ...partial,
  };
}

export function scan(partial: Partial<ScanRow> = {}): ScanRow {
  return {
    sessionId: SESSION,
    questionId: 21n,
    version: 1,
    mode: { tag: 'Answer' },
    answerMode: { tag: 'Pick' },
    phase: { tag: 'Window' },
    cursor: 2,
    optionCount: 4,
    pass: 1,
    maxPasses: 2,
    stepSeq: 9n,
    stepStartedAt: ts(6_000),
    stepEndsAt: ts(9_500),
    optionStartSeq: 8n,
    optionStartedAt: ts(5_000),
    prevCursor: 1,
    prevOptionStartSeq: 6n,
    outcome: undefined,
    pickedRank: undefined,
    pickedOptionId: undefined,
    pauseReason: undefined,
    pausedAt: undefined,
    resumeCursor: 0,
    updatedAt: ts(6_000),
    listStartSeq: 4n,
    ...partial,
  };
}

export function ledger(id: number, kind: string, offsetMs: number, partial: Partial<Ledger> = {}): Ledger {
  return {
    id: BigInt(id),
    sessionId: SESSION,
    at: ts(offsetMs),
    kind,
    actor: 'Station',
    questionId: 0n,
    optionId: 0n,
    errandId: 0n,
    callId: 0n,
    jobId: 0n,
    gestureId: '',
    command: '',
    stepSeq: 0n,
    cursor: 0,
    digest: '',
    outcome: '',
    reason: '',
    ms: 0,
    ...partial,
  };
}

export function station(partial: Partial<DeviceStatus> = {}): DeviceStatus {
  return {
    identity: Identity.zero(),
    role: { tag: 'Station' },
    label: 'smoke station',
    online: true,
    lastSeenAt: ts(5_500),
    decoderHealthy: true,
    ...partial,
  };
}

export function errand(partial: Partial<BoardErrand> = {}): BoardErrand {
  return {
    errandId: 12n,
    sessionId: SESSION,
    questionId: 21n,
    status: { tag: 'AwaitingConfirm' },
    formTitle: 'Form',
    previewDigest: '9f2c4a1b7e3d5c60',
    reasonCode: '',
    reason: '',
    confirmGestureId: '',
    stopGestureId: '',
    createdAt: ts(10_000),
    previewedAt: ts(11_000),
    readbackDoneAt: ts(14_000),
    confirmOpensAt: ts(15_000),
    confirmClosesAt: ts(23_000),
    confirmedAt: undefined,
    claimedAt: undefined,
    submittedAt: undefined,
    endedAt: undefined,
    updatedAt: ts(14_000),
    textShared: false,
    readBackText: '',
    readBackJson: '',
    confirmationText: '',
    screenshotUrl: '',
    optionId: 0n,
    ...partial,
  };
}

export function call(partial: Partial<BoardCall> = {}): BoardCall {
  return {
    callId: 3n,
    sessionId: SESSION,
    questionId: 21n,
    status: { tag: 'Connected' },
    result: '',
    endReason: '',
    reasonCode: '',
    reason: '',
    scriptDigest: '0123456789abcdef',
    consentOnFile: true,
    cancelRequested: false,
    createdAt: ts(30_000),
    confirmedAt: ts(33_000),
    dialedAt: ts(33_200),
    ringingAt: ts(34_000),
    connectedAt: ts(39_000),
    endedAt: undefined,
    updatedAt: ts(39_000),
    textShared: false,
    contactName: 'Contact',
    readBackText: '',
    transcript: [],
    optionId: 0n,
    readbackDoneAt: undefined,
    confirmOpensAt: undefined,
    confirmClosesAt: undefined,
    confirmGestureId: '',
    stopGestureId: '',
    held: false,
    ...partial,
  };
}

/** A `board_word_timings` row (module v2): the station's word timings for the read whose speak step is `eventId`. */
export function wordTiming(eventId: number, startsMs: number[], endsMs: number[], partial: Partial<WordTimingRow> = {}): WordTimingRow {
  return {
    eventId: BigInt(eventId),
    sessionId: SESSION,
    questionId: 21n,
    optionId: 102n,
    rank: 2,
    stepSeq: 8n,
    startsMs,
    endsMs,
    at: ts(5_300),
    ...partial,
  };
}

/** One question mid-scan: option 2's response window is open, sharing is off, the station is online. */
export function midScan(partial: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    config: [config()],
    scanStates: [scan()],
    pipelineEvents: [
      event(40, 'listen:smoke-a1', 'listen', 'ok', 'typed', 0, { countsJson: '{"wordCount":4}', ms: 0, actor: 'Partner' }),
      event(41, '7:1:plan:started', 'plan', 'started', 'smoke options', 200, { actor: 'Agent' }),
      event(42, 'q21:v1:plan', 'plan', 'ok', 'options', 300, { countsJson: '{"version":1,"optionCount":4,"final":true}', actor: 'Agent' }),
      event(43, 'q21:v1:scan', 'speak', 'started', 'scan started', 4_300, { countsJson: '{"version":1,"optionCount":4}' }),
    ],
    devices: [station()],
    questions: [question()],
    payloads: [],
    errands: [],
    calls: [],
    ledger: [
      ledger(500, 'session_start', -5_000, { outcome: 'smoke' }),
      ledger(501, 'question', 0, { actor: 'Partner', questionId: 21n, outcome: 'asked', reason: 'typed' }),
    ],
    wordTimings: [],
    ...partial,
  };
}

/**
 * One read as the module writes it since v2 (docs/spacetime.md 14): a `started` speak step keyed
 * `s<session>:read:<step>`, labelled "reading option" (or "yes or no prompt", with option 0 and rank 0), with the
 * option, rank, pass, step and planned dwell in its counts.
 */
export function read(id: number, offsetMs: number, counts: { optionId: number; rank: number; pass?: number; stepSeq: number; durationMs?: number }): PipelineRow {
  const prompt = counts.optionId === 0;
  return event(id, `s6:read:${counts.stepSeq}`, 'speak', 'started', prompt ? 'yes or no prompt' : 'reading option', offsetMs, {
    countsJson: JSON.stringify({ pass: 1, durationMs: 750, estimated: !prompt, ...counts }),
  });
}
