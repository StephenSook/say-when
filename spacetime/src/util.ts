// Small shared helpers: time arithmetic, input checks, wire-string parsing, and the three one-line writers
// (ledger, cue, pipeline) every state change uses. Nothing here is a module export.
import { ScheduleAt, Timestamp } from 'spacetimedb';
import { SenderError } from 'spacetimedb/server';
import type { Ctx } from './ctx';
import type { Command, ConsentScope, InputMode, PipelineEvent, Role } from './schema';

// ---------- Time ----------

export function plusMs(ts: Timestamp, ms: number): Timestamp {
  return new Timestamp(ts.microsSinceUnixEpoch + BigInt(Math.round(ms)) * 1000n);
}

/** `later - earlier` in whole milliseconds; negative when `later` is earlier. */
export function msBetween(later: Timestamp, earlier: Timestamp): number {
  return Number((later.microsSinceUnixEpoch - earlier.microsSinceUnixEpoch) / 1000n);
}

export function isAfter(a: Timestamp, b: Timestamp): boolean {
  return a.microsSinceUnixEpoch > b.microsSinceUnixEpoch;
}

/** A one-shot schedule at `ts`. Never `ScheduleAt.interval`: an interval row is never deleted. */
export function onceAt(ts: Timestamp) {
  return ScheduleAt.time(ts.microsSinceUnixEpoch);
}

/** Clamps to the u32 range, rounding; for durations written to u32 columns. */
export function u32(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(4294967295, Math.round(n));
}

/** Epoch milliseconds as a JSON-safe number. */
export function epochMs(ts: Timestamp): number {
  return Number(ts.toMillis());
}

// ---------- Input checks (throw SenderError: the caller sent something malformed) ----------

export const DIGEST_RE = /^[0-9a-f]{16}$/;
/** A pipeline `detail` label: short, lowercase, fixed vocabulary shape (2.9). */
export const DETAIL_RE = /^[a-z0-9 :_-]{1,120}$/;
/** Client-made idempotency keys: `event_key`, `line_key`. */
export const KEY_RE = /^[A-Za-z0-9:_.-]{1,128}$/;
/** `form_key`, `contact_id`, the Dialer's `requestId` (`cartesia/src/call.ts`). */
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function requireText(value: string, field: string, max: number, min = 1): string {
  if (typeof value !== 'string') throw new SenderError(`${field} must be text`);
  if (value.trim().length < min) throw new SenderError(`${field} is empty`);
  if (value.length > max) throw new SenderError(`${field} is longer than ${max} characters`);
  if (CONTROL_RE.test(value)) throw new SenderError(`${field} has control characters`);
  return value;
}

export function requireOptionalText(value: string, field: string, max: number): string {
  if (value === '') return value;
  return requireText(value, field, max, 0);
}

export function requireMatch(value: string, re: RegExp, field: string): string {
  if (typeof value !== 'string' || !re.test(value)) throw new SenderError(`bad ${field}`);
  return value;
}

/** Parses a JSON object, or throws. */
export function parseObject(json: string, field: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SenderError(`${field} is not JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SenderError(`${field} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** A `counts_json` key: an identifier (`rows`, `mossMs`, `skippedRows`), so a key cannot carry a sentence. */
const COUNT_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/**
 * `counts_json`: a JSON object whose keys are identifiers and whose values are finite numbers or booleans only.
 * Empty means `{}`. It lands in the public `pipeline_event`, so neither part may hold words about a person.
 */
export function requireCountsJson(json: string): string {
  if (json === '') return '{}';
  if (json.length > 2048) throw new SenderError('counts_json is too long');
  const obj = parseObject(json, 'counts_json');
  for (const [key, value] of Object.entries(obj)) {
    if (!COUNT_KEY_RE.test(key)) throw new SenderError('counts_json keys must be identifiers of at most 40 characters');
    const ok = typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
    if (!ok) throw new SenderError('counts_json values must be numbers or booleans');
  }
  // The checked object, not the caller's text: a duplicate key (`{"rows":"a sentence","rows":1}`) parses to its last
  // value, so returning the original string would publish the hidden first one.
  return JSON.stringify(obj);
}

/**
 * A producer's reason code made code-shaped: lowercase letters, digits, `_` and `-`, at most 40 characters. Empty
 * stays empty. It never throws, so an odd code cannot block the write that reports what happened. Shape is not
 * meaning (`alice_takes_lithium` is code-shaped), so a code that reaches a public row goes through `publicCode`.
 */
export function normCode(code: string): string {
  if (code === '') return '';
  return code.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 40);
}

/**
 * Every reason code a public row (ledger, cue, pipeline label, board) may carry: the module's own, the form-errand
 * Actor's `RefusalCode` (`apify/form-errand/src/types.ts`), the Apify client's error kinds and unknown-outcome
 * reasons, the Dialer's `RefusalCode` (`cartesia/src/call.ts`), and the sidecar's codes (`agent/src`). A code is a
 * fixed word list, never a sentence about a person.
 */
const PUBLIC_CODES: ReadonlySet<string> = new Set([
  // The module.
  'no', 'stop', 'headset_lost', 'headset_off', 'idle', 'operator', 'interrupted', 'consent_revoked', 'session_ended',
  'readback_not_finished', 'window_closed', 'preview_timeout', 'agent_lost', 'no_consent', 'bad_action', 'lease_lapsed',
  'expired', 'duplicate_request', 'agent_failed', 'refused', 'failed', 'unknown', 'submitted', 'duplicate',
  'not_wanted', 'superseded', 'cancelled',
  // The form-errand Actor's refusals.
  'bad_input', 'bad_url', 'load_failed', 'captcha', 'login', 'payment', 'upload', 'no_form', 'not_allowed',
  'unmatched_fields', 'missing_required', 'not_confirmed', 'digest_mismatch', 'no_submit_button', 'no_confirmation',
  'click_uncertain',
  // The Apify client's error kinds and unknown-outcome reasons.
  'http', 'timeout', 'network', 'aborted', 'server_error', 'bad_response', 'unconfirmed_duplicate', 'error',
  // The Dialer's refusals.
  'bad_request', 'errand_not_allowed', 'not_consented', 'consent_expired', 'do_not_call', 'opt_out_hold',
  'hold_file_error', 'emergency_number', 'bad_number', 'errand_stale', 'already_used', 'line_busy',
  'agent_mismatch', 'agent_unverified',
  // No longer produced (PLAN D20 removed calling hours); kept so a row written before then still shows its code.
  'outside_hours',
  // The sidecar, its option planner's error codes and its database error kinds.
  'agent_error', 'errands_not_configured', 'bad_fields', 'read_back_too_long', 'bad_preview', 'bad_result',
  'not_configured', 'call_failed', 'dial_unknown', 'end_unknown', 'confirm_time_unknown', 'confirm_expired',
  'empty_question', 'rate_limited', 'overloaded', 'unavailable', 'truncated', 'invalid_reply', 'auth', 'not_found',
  'stale', 'disconnected', 'unknown_result', 'internal', 'gave_up',
  // The sidecar's caps in the judge try sandbox (agent/src/sandbox.ts).
  'try_limit',
]);

/** The sidecar's prefixed codes (`planner_timeout`, `preview_http_404`, `not_sent_network`): prefix plus a known code. */
const CODE_PREFIXES = ['planner_', 'publish_', 'preview_', 'not_sent_'] as const;
const HTTP_CODE_RE = /^http_[1-5][0-9]{2}$/;

function isPublicCode(code: string): boolean {
  if (PUBLIC_CODES.has(code) || HTTP_CODE_RE.test(code)) return true;
  for (const prefix of CODE_PREFIXES) {
    if (code.startsWith(prefix)) {
      const rest = code.slice(prefix.length);
      return PUBLIC_CODES.has(rest) || HTTP_CODE_RE.test(rest);
    }
  }
  return false;
}

/**
 * The code a public row may carry for a producer's reason code: the code itself when it is on the fixed list (after
 * `normCode`), else `fallback` (a module word such as `refused`). Empty stays empty. Stored rows keep only this, so
 * every public surface (the anonymous ledger, cues, pipeline labels, the board) is content-free whatever was sent.
 */
export function publicCode(code: string, fallback: string): string {
  const c = normCode(code);
  if (c === '') return '';
  return isPublicCode(c) ? c : fallback;
}

/** `Object.hasOwn` for lookup tables keyed by caller strings, so `constructor` or `toString` never match. */
export function hasKey(table: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, key);
}

// ---------- Wire strings (lowercase snake case) to enums ----------

export function parseRole(value: string): Role {
  switch (value) {
    case 'station':
      return { tag: 'Station' };
    case 'partner':
      return { tag: 'Partner' };
    case 'speaker':
      return { tag: 'Speaker' };
    case 'agent':
      return { tag: 'Agent' };
    default:
      throw new SenderError('role must be station, partner, speaker or agent');
  }
}

export function parseScope(value: string): ConsentScope {
  switch (value) {
    case 'web_search':
      return { tag: 'WebSearch' };
    case 'memory':
      return { tag: 'Memory' };
    case 'errand':
      return { tag: 'Errand' };
    case 'call':
      return { tag: 'Call' };
    case 'board_text':
      return { tag: 'BoardText' };
    default:
      throw new SenderError('scope must be web_search, memory, errand, call or board_text');
  }
}

/** The D11 words. Anything else is malformed. */
export function parseCommand(value: string): Command {
  switch (value) {
    case 'YES':
      return { tag: 'Yes' };
    case 'NO':
      return { tag: 'No' };
    case 'CONFIRM':
      return { tag: 'Confirm' };
    case 'STOP':
      return { tag: 'Stop' };
    case 'HEADSET_OFF':
      return { tag: 'HeadsetOff' };
    case 'PICK_1':
      return { tag: 'Pick1' };
    case 'PICK_2':
      return { tag: 'Pick2' };
    case 'PICK_3':
      return { tag: 'Pick3' };
    case 'PICK_4':
      return { tag: 'Pick4' };
    default:
      throw new SenderError('command must be YES, NO, CONFIRM, STOP, HEADSET_OFF or PICK_1 to PICK_4');
  }
}

const COMMAND_WIRE: Record<Command['tag'], string> = {
  Yes: 'YES',
  No: 'NO',
  Confirm: 'CONFIRM',
  Stop: 'STOP',
  HeadsetOff: 'HEADSET_OFF',
  Pick1: 'PICK_1',
  Pick2: 'PICK_2',
  Pick3: 'PICK_3',
  Pick4: 'PICK_4',
};

/** The rank a PICK command names (1 to 4), or 0 for any other command (D18). */
export function pickRank(command: Command): number {
  switch (command.tag) {
    case 'Pick1':
      return 1;
    case 'Pick2':
      return 2;
    case 'Pick3':
      return 3;
    case 'Pick4':
      return 4;
    default:
      return 0;
  }
}

/** `set_input_mode`'s argument: `direct` or `scan`. */
export function parseInputMode(value: string): InputMode {
  if (value === 'direct') return { tag: 'Direct' };
  if (value === 'scan') return { tag: 'Scan' };
  throw new SenderError('mode must be direct or scan');
}

/**
 * A 16-hex-character FNV-1a 64-bit digest, for the module's own read-backs (a search request's). Each request
 * hashes its own id with its text, so a digest heard for one request never matches another.
 */
export function digest16(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

export function commandWire(command: Command): string {
  return COMMAND_WIRE[command.tag];
}

/** `AwaitingConfirm` to `awaiting_confirm`, the form the web and the ledger use. */
export function snake(tag: string): string {
  return tag.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

// ---------- Writers ----------

export type Actor = 'Station' | 'Partner' | 'Speaker' | 'Agent' | 'Owner' | 'Scheduler' | 'Module';

export interface LedgerExtra {
  questionId?: bigint;
  optionId?: bigint;
  errandId?: bigint;
  callId?: bigint;
  jobId?: bigint;
  gestureId?: string;
  command?: string;
  stepSeq?: bigint;
  cursor?: number;
  digest?: string;
  outcome?: string;
  reason?: string;
  ms?: number;
}

/** Appends one content-free ledger row in the caller's transaction. */
export function appendLedger(ctx: Ctx, sessionId: bigint, kind: string, actor: Actor, extra: LedgerExtra = {}): void {
  ctx.db.ledger.insert({
    id: 0n,
    sessionId,
    at: ctx.timestamp,
    kind,
    actor,
    questionId: extra.questionId ?? 0n,
    optionId: extra.optionId ?? 0n,
    errandId: extra.errandId ?? 0n,
    callId: extra.callId ?? 0n,
    jobId: extra.jobId ?? 0n,
    gestureId: extra.gestureId ?? '',
    command: extra.command ?? '',
    stepSeq: extra.stepSeq ?? 0n,
    cursor: extra.cursor ?? 0,
    digest: extra.digest ?? '',
    outcome: extra.outcome ?? '',
    reason: extra.reason ?? '',
    ms: u32(extra.ms ?? 0),
  });
}

export interface CueExtra {
  reason?: string;
  questionId?: bigint;
  optionId?: bigint;
  errandId?: bigint;
  callId?: bigint;
  rank?: number;
}

/** Inserts into the `cue_event` event table: broadcast on commit, never stored. `reason` is a code. */
export function emitCue(ctx: Ctx, sessionId: bigint, kind: string, extra: CueExtra = {}): void {
  ctx.db.cueEvent.insert({
    sessionId,
    kind,
    reason: extra.reason ?? '',
    questionId: extra.questionId ?? 0n,
    optionId: extra.optionId ?? 0n,
    errandId: extra.errandId ?? 0n,
    callId: extra.callId ?? 0n,
    rank: extra.rank ?? 0,
    at: ctx.timestamp,
  });
}

export const STAGES = ['listen', 'search', 'retrieve', 'plan', 'speak', 'select', 'errand', 'call'] as const;
export const STAGE_STATUSES = ['started', 'ok', 'error'] as const;

export interface PipelineInput {
  eventKey: string;
  sessionId: bigint;
  questionId: bigint;
  stage: (typeof STAGES)[number];
  status: (typeof STAGE_STATUSES)[number];
  detail: string;
  ms?: number;
  countsJson?: string;
  actor: Actor;
  payloadJson?: string;
}

/**
 * Writes one public, content-free `pipeline_event` (and its private payload). Idempotent on `eventKey`:
 * a second write with the same key does nothing and returns undefined, so a retry never throws.
 */
export function writePipeline(ctx: Ctx, input: PipelineInput): PipelineEvent | undefined {
  if (ctx.db.pipelineEvent.eventKey.find(input.eventKey)) return undefined;
  const row = ctx.db.pipelineEvent.insert({
    id: 0n,
    eventKey: input.eventKey,
    sessionId: input.sessionId,
    questionId: input.questionId,
    stage: input.stage,
    status: input.status,
    detail: input.detail,
    ms: input.status === 'started' || input.ms === undefined ? undefined : u32(input.ms),
    countsJson: input.countsJson ?? '{}',
    actor: input.actor,
    at: ctx.timestamp,
  });
  if (input.payloadJson && input.payloadJson !== '') {
    ctx.db.pipelinePayload.insert({
      eventId: row.id,
      sessionId: input.sessionId,
      questionId: input.questionId,
      stage: input.stage,
      payloadJson: input.payloadJson,
    });
  }
  return row;
}
