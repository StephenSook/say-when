/**
 * Maps the rows of the live SpacetimeDB module onto lib/data/types.ts. Pure: lib/data/spacetime-bindings.ts reads
 * the client cache into a `BoardSnapshot`, and `boardRows` turns it into the dashboard's `DataRows`
 * (docs/spacetime.md 7.1). The row types come from the generated bindings in ./module_bindings, imported as types
 * only, so nothing here loads the SDK.
 *
 * Privacy, on top of what the module's anonymous views already hold back (docs/spacetime.md 5):
 * - Text (questions, option words, the reply, read-backs, payloads) shows only while the board's sharing toggle is
 *   on; with it off the screens get "Question N" and "Option N" and no words.
 * - Memory text arrives only as `sharedText` (`withoutMemoryText`).
 * - Free text goes through maskPhoneNumbers, and a contact is a name only.
 */
import { maskPhoneNumbers } from '../format';
import type {
  BoardCall,
  BoardCallLine,
  BoardErrand,
  BoardOption,
  BoardPayload,
  BoardQuestion,
  Config as BoardConfig,
  DeviceStatus as BoardDevice,
  Ledger as BoardLedgerRow,
  PipelineEvent as BoardPipelineRow,
  ScanState as BoardScanRow,
  SourceRef as BoardSourceRef,
  WordTiming as BoardWordTimingRow,
} from './module_bindings/types';
import {
  COMMANDS,
  EMPTY_ROWS,
  STAGES,
  type AnswerOption,
  type CallRequest,
  type CallResult,
  type CallStatus,
  type CommandEvent,
  type CommandName,
  type DataRows,
  type Errand,
  type ErrandStatus,
  type InputKind,
  type OptionKind,
  type PipelineEvent,
  type PipelineEventOf,
  type PipelineStatus,
  type Question,
  type ReadBackItem,
  type SafetyState,
  type ScanOutcome,
  type ScanPhase,
  type ScanState,
  type SourceRef,
  type Stage,
  type StageDetailMap,
  type TranscriptLine,
  type WordTiming,
} from './types';

/** A SpacetimeDB Timestamp (spacetimedb 2.13.0 `Timestamp.toMillis(): bigint`) as epoch milliseconds. */
export function timestampToMillis(ts: { toMillis(): bigint } | null | undefined): number | null {
  if (!ts) return null;
  return Number(ts.toMillis());
}

export function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

/**
 * The D11 command names only: YES, NO, CONFIRM, STOP, plus the system's HEADSET_OFF.
 * Anything else, including the names from the first command map (PLAN D3), is not a command; drop the row.
 */
export function isCommand(value: string): value is CommandName {
  return (COMMANDS as readonly string[]).includes(value);
}

export function asPipelineStatus(value: string): PipelineStatus | null {
  return value === 'started' || value === 'ok' || value === 'error' ? value : null;
}

/**
 * `pipeline_event.detail` as a parsed object (docs/ui.md gap 2: a JSON string per stage).
 * Never throws: unreadable JSON becomes a detail whose `error` carries the raw text.
 * Retrieve details pass through `withoutMemoryText`, so memory text can only arrive as `sharedText`.
 */
export function parseDetail<S extends Stage>(stage: S, json: string | null | undefined): StageDetailMap[S] {
  if (json === null || json === undefined || json.trim() === '') return {} as StageDetailMap[S];
  try {
    const value: unknown = JSON.parse(json);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if (stage === 'retrieve') return withoutMemoryText(value as StageDetailMap['retrieve']) as StageDetailMap[S];
      return value as StageDetailMap[S];
    }
  } catch {
    // Fall through to the error below.
  }
  return { error: { sentence: "This step's details could not be read.", raw: json.slice(0, 500) } } as StageDetailMap[S];
}

/** The sentence a failed step shows when its payload carries none. The same words as Live data's fallbacks. */
export const STAGE_ERROR_SENTENCES: Readonly<Record<Stage, string>> = {
  listen: 'Could not hear the question.',
  search: 'The search failed.',
  retrieve: 'Could not recall memory.',
  plan: 'Could not draft options. Ask again.',
  speak: 'Could not play the option.',
  select: 'Could not record the pick.',
  errand: 'The errand failed.',
  call: 'The call failed.',
};

/** Count names that would hide a payload list of the same name, and the names they take instead. */
const COUNT_RENAMES: Readonly<Record<string, string>> = { rows: 'rowCount', hits: 'hitCount', words: 'wordCount' };

/** A JSON object, or null for anything else. `bad` collects what could not be read. */
function jsonObject(json: string | null | undefined, bad: string[]): Record<string, unknown> | null {
  if (json === null || json === undefined || json.trim() === '') return null;
  try {
    const value: unknown = JSON.parse(json);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Reported below.
  }
  bad.push(json.slice(0, 200));
  return null;
}

/**
 * One pipeline event's `detail` for the screens, from the three places the module keeps apart
 * (docs/spacetime.md 2.9 and 7.1): the content-free label in `pipeline_event.detail`, the numbers in
 * `counts_json`, and the content in `board_payloads.payload_json` (there only while the room shares
 * text). Pass null for a payload the board does not share.
 * - Counts first, then the payload, so content wins on a shared name. A count named like a payload
 *   list (`rows`, `hits`, `words`) is renamed (`rowCount`, `hitCount`, `wordCount`), so a number never
 *   stands in for the list.
 * - The label rides as `label`. An `error` status gets an error whose raw text is the label (for
 *   example "failed: timeout"), unless the payload brings its own.
 * - Retrieve hits lose any memory text that is not `sharedText` (moss/README.md).
 * Never throws: JSON that cannot be read is skipped and named in the error's raw text.
 */
export function pipelineDetail<S extends Stage>(
  stage: S,
  status: PipelineStatus,
  label: string | null | undefined,
  countsJson: string | null | undefined,
  payloadJson: string | null | undefined,
): StageDetailMap[S] {
  const bad: string[] = [];
  const counts = jsonObject(countsJson, bad) ?? {};
  const payload = jsonObject(payloadJson, bad) ?? {};
  const detail: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value !== 'number' && typeof value !== 'boolean') continue;
    const name = typeof value === 'number' ? (COUNT_RENAMES[key] ?? key) : key;
    detail[name] = value;
  }
  Object.assign(detail, payload);
  const cleanLabel = label?.trim();
  if (cleanLabel) detail.label = cleanLabel;
  if (status === 'error' && detail.error === undefined) {
    detail.error = { sentence: STAGE_ERROR_SENTENCES[stage], raw: cleanLabel || undefined };
  }
  if (bad.length > 0 && detail.error === undefined) {
    detail.error = { sentence: "This step's details could not be read.", raw: bad.join(' ') };
  }
  if (stage === 'retrieve') return withoutMemoryText(detail as StageDetailMap['retrieve']) as StageDetailMap[S];
  return detail as StageDetailMap[S];
}

/**
 * Drops `text` from every hit that is not a web hit (moss/README.md: memory text never goes to a
 * screen unless the person shared it, and then it arrives as `sharedText`).
 */
export function withoutMemoryText(detail: StageDetailMap['retrieve']): StageDetailMap['retrieve'] {
  if (!Array.isArray(detail.hits)) return detail;
  return {
    ...detail,
    // A producer's payload is not trusted to be well formed: anything that is not an object is dropped.
    hits: detail.hits
      .filter((hit) => hit !== null && typeof hit === 'object')
      .map((hit) => {
        if (hit.origin === 'web' || hit.text === undefined) return hit;
        const { text: _dropped, ...rest } = hit;
        return rest;
      }),
  };
}

/** Copies rows out of a client cache iterator and sorts them oldest first. */
export function sortedBy<T>(rows: Iterable<T>, time: (row: T) => number): T[] {
  return Array.from(rows).sort((a, b) => time(a) - time(b));
}

// ---------------------------------------------------------------------------------------------
// The live board: the anonymous tables and views, read into DataRows (docs/spacetime.md 7.1)

/**
 * Every row the anonymous dashboard subscribes to, as the generated bindings give them. The board views cover the
 * board's session only (`config.active_session_id`, kept after the session ends). `scan_state` is a public table with
 * one row per session, so `boardRows` keeps the board session's row and drops the rest; it filters the session views
 * the same way, which costs nothing and keeps a recording of the older unscoped rows right.
 */
export interface BoardSnapshot {
  /** `config`: one row, id 0. */
  config: readonly BoardConfig[];
  /** `scan_state`: one row per session. */
  scanStates: readonly BoardScanRow[];
  /** `board_events` (module v2): the board session's content-free steps, the `pipeline_event` rows of that session. */
  pipelineEvents: readonly BoardPipelineRow[];
  /** `device_status`: whether the station is online. */
  devices: readonly BoardDevice[];
  /** `public_board`: the last 20 questions of the board's session, each with its scanned options. */
  questions: readonly BoardQuestion[];
  /** `board_payloads`: the content behind pipeline events, only while sharing is on. */
  payloads: readonly BoardPayload[];
  /** `board_errands`: the board session's errands. */
  errands: readonly BoardErrand[];
  /** `board_calls`: the board session's calls. Never a phone number. */
  calls: readonly BoardCall[];
  /** `board_session_ledger` (module v2): the board session's content-free ledger. Its gesture rows are the command events. */
  ledger: readonly BoardLedgerRow[];
  /**
   * `board_word_timings` (module v2): the station's word timings for the board session's reads, keyed by the read's
   * speak step (`event_id`). Numbers only, so they show whatever the sharing toggle says. Absent in recordings made
   * before module v2.
   */
  wordTimings?: readonly BoardWordTimingRow[];
}

type Micros = { readonly microsSinceUnixEpoch: bigint };
type Moment = Micros & { toMillis(): bigint };

/** A row time that is always set, as epoch milliseconds. */
function millis(ts: Moment): number {
  return Number(ts.toMillis());
}

/** Oldest first by a microsecond row time, then by id, so rows written in the same millisecond keep their order. */
function byTime<T>(rows: readonly T[], time: (row: T) => Micros, id: (row: T) => bigint): T[] {
  return [...rows].sort((a, b) => {
    const ta = time(a).microsSinceUnixEpoch;
    const tb = time(b).microsSinceUnixEpoch;
    if (ta !== tb) return ta < tb ? -1 : 1;
    const ia = id(a);
    const ib = id(b);
    return ia === ib ? 0 : ia < ib ? -1 : 1;
  });
}

/** A u64 id as the screens' string id. */
function idText(id: bigint): string {
  return id.toString();
}

/** A u64 id where 0 means none (docs/spacetime.md 2.1): the string id, or null. */
function optionalId(id: bigint | undefined): string | null {
  return id === undefined || id === 0n ? null : id.toString();
}

/** Free text for a screen: trimmed, phone numbers hidden. null when empty. */
function shownText(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  return trimmed ? maskPhoneNumbers(trimmed) : null;
}

/** Only http and https addresses may become a link or an image. Anything else is dropped. */
function webUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

/** The session the board shows: `config.active_session_id`, the current or most recent one. 0n before the first. */
export function boardSessionId(config: readonly BoardConfig[]): bigint {
  return config.find((row) => row.id === 0)?.activeSessionId ?? 0n;
}

const OPTION_KINDS: Readonly<Record<BoardOption['kind']['tag'], OptionKind>> = {
  Reply: 'reply',
  Errand: 'errand',
  Call: 'call',
  Menu: 'menu',
};

const SCAN_PHASES: Readonly<Record<BoardScanRow['phase']['tag'], ScanPhase>> = {
  Idle: 'idle',
  Preparing: 'preparing',
  Reading: 'reading',
  Window: 'window',
  Veto: 'veto',
  Paused: 'paused',
};

const SCAN_OUTCOMES: Readonly<Record<NonNullable<BoardScanRow['outcome']>['tag'], ScanOutcome>> = {
  Picked: 'picked',
  None: 'none',
  NoPick: 'no_pick',
  Stopped: 'stopped',
  Cancelled: 'cancelled',
};

/**
 * The module's errand states (docs/spacetime.md 4.3) in the web's words. Drafted: the Actor is filling the form
 * ('preparing'). Previewed: the preview exists and the station is reading it back in the earpiece, which the web
 * calls 'reading_back'; the confirm window opens only after that read-back ('awaiting_confirm').
 */
export const ERRAND_STATUSES: Readonly<Record<BoardErrand['status']['tag'], ErrandStatus>> = {
  Drafted: 'preparing',
  Previewed: 'reading_back',
  AwaitingConfirm: 'awaiting_confirm',
  Confirmed: 'confirmed',
  Submitting: 'submitting',
  Submitted: 'sent',
  Refused: 'refused',
  Failed: 'failed',
  UnknownOutcome: 'unknown_outcome',
  Stopped: 'stopped',
};

/** The module's call states (docs/spacetime.md 4.4): the same names in snake case. */
export const CALL_STATUSES: Readonly<Record<BoardCall['status']['tag'], CallStatus>> = {
  Prepared: 'prepared',
  AwaitingConfirm: 'awaiting_confirm',
  Confirmed: 'confirmed',
  Dialing: 'dialing',
  Ringing: 'ringing',
  Connected: 'connected',
  Ended: 'ended',
  Failed: 'failed',
  Stopped: 'stopped',
  Refused: 'refused',
};

const CALL_RESULTS: ReadonlySet<string> = new Set<CallResult>(['answered', 'no_answer', 'busy', 'voicemail', 'cancelled', 'failed', 'refused', 'unknown']);

/**
 * Plain words for the reasons the module records when it ignores a command (`ignored:<reason>` in the ledger,
 * docs/spacetime.md 4.2 and section 13), for the event feed. The ledger keeps codes only.
 */
const IGNORED_REASONS: ReadonlyMap<string, string> = new Map([
  ['refractory', 'Repeat inside the refractory time'],
  ['stale_step', 'Arrived after its option had moved on'],
  ['heard_mismatch', 'Did not match the option that was heard'],
  ['already_passed', 'That option had already passed'],
  ['idle', 'Nothing was being read'],
  ['not_ready', 'The options were not ready yet'],
  ['no_option', 'No option was being read'],
  ['nothing_to_confirm', 'Nothing was waiting for a confirm'],
  ['veto', 'A reply was already picked'],
  ['yes_is_not_confirm', 'YES does not confirm. Only CONFIRM sends'],
  ['readback_not_done', 'The read-back had not finished'],
  ['quiet_hold', 'Too soon after the read-back'],
  ['window_closed', 'The confirm window had closed'],
  ['no_contact', 'The headset contact was not good'],
  ['digest_mismatch', 'Did not match the read-back the person heard'],
  ['no_consent', 'There is no consent on file'],
  ['busy', 'Busy with an errand or a call'],
  ['too_late', 'Too late: the form was already being sent'],
  ['paused', 'The system was paused'],
  ['already_paused', 'The system was already paused'],
  ['operator_pause', 'Paused by a helper. Only the owner can resume'],
  ['no_session', 'No session was running'],
]);

/** A reason code as words for the feed: the known sentence, else the code with its underscores as spaces. */
export function ignoredReasonWords(code: string): string {
  const clean = code.trim();
  const known = IGNORED_REASONS.get(clean);
  if (known !== undefined) return known;
  const words = clean.replace(/[_:]+/g, ' ').trim();
  return words === '' ? 'Ignored' : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** The form-errand Actor's read-back (`read_back_json`, ReadBackItem[]), item by item. Never throws. */
export function readBackItems(json: string | null | undefined): ReadBackItem[] {
  if (!json || json.trim() === '') return [];
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const items: ReadBackItem[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const fields = entry as Record<string, unknown>;
    if (typeof fields.label !== 'string' || typeof fields.value !== 'string') continue;
    const item: ReadBackItem = { label: maskPhoneNumbers(fields.label.trim()), value: maskPhoneNumbers(fields.value.trim()) };
    if (typeof fields.source === 'string' && fields.source.trim() !== '') item.source = maskPhoneNumbers(fields.source.trim());
    items.push(item);
  }
  return items;
}

/** Payload keys that hold free text, which gets phone numbers hidden. Addresses (`url`), ids and times are left alone. */
const PAYLOAD_TEXT_KEYS: ReadonlySet<string> = new Set(['words', 'text', 'title', 'sharedText', 'reason', 'address']);

/** A copy of a parsed payload with phone numbers hidden in its free text. Drops `__proto__` keys. */
function maskPayloadText(value: unknown, key: string | null, depth: number): unknown {
  if (typeof value === 'string') return key !== null && PAYLOAD_TEXT_KEYS.has(key) ? maskPhoneNumbers(value) : value;
  if (value === null || typeof value !== 'object' || depth > 8) return value;
  if (Array.isArray(value)) return value.map((item) => maskPayloadText(item, key, depth + 1));
  const copy: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(value)) {
    if (name !== '__proto__') copy[name] = maskPayloadText(item, name, depth + 1);
  }
  return copy;
}

/**
 * One live pipeline event's detail: `pipelineDetail` over the label, `counts_json` and the shared payload, then
 * - phone numbers hidden in the payload's free text;
 * - ids in a payload or the counts (`optionId`, `errandId`, `callId`, numbers in the module's JSON) as the screens'
 *   string ids, with 0 meaning none; a `rank` of 0 means none too (a read of the yes or no prompt has no option);
 * - the errand or call an errand or call step belongs to, from its event key (`e<id>:...`, `c<id>:...`,
 *   docs/spacetime.md 11.4), since those steps carry no payload;
 * - the audio channel of a speak step from its label when no shared payload says it: "aloud" is the reply said out
 *   loud for the room, every other speak step is the earpiece.
 */
export function liveDetail<S extends Stage>(
  stage: S,
  status: PipelineStatus,
  row: Pick<BoardPipelineRow, 'detail' | 'countsJson' | 'eventKey'>,
  payloadJson: string | null | undefined,
): StageDetailMap[S] {
  const detail = maskPayloadText(pipelineDetail(stage, status, row.detail, row.countsJson, payloadJson), null, 0) as Record<string, unknown>;
  for (const key of ['optionId', 'errandId', 'callId']) {
    const value = detail[key];
    if (typeof value === 'number' || typeof value === 'bigint') {
      if (Number(value) > 0) detail[key] = String(value);
      else delete detail[key];
    }
  }
  if (typeof detail.rank === 'number' && !(detail.rank > 0)) delete detail.rank;
  const owner = /^([ec])(\d+):/.exec(row.eventKey);
  if (owner && stage === 'errand' && owner[1] === 'e' && detail.errandId === undefined) detail.errandId = owner[2];
  if (owner && stage === 'call' && owner[1] === 'c' && detail.callId === undefined) detail.callId = owner[2];
  if (stage === 'speak' && detail.channel !== 'aloud' && detail.channel !== 'earpiece') {
    detail.channel = detail.label === 'aloud' ? 'aloud' : 'earpiece';
  }
  return detail as StageDetailMap[S];
}

/** No word ends later than this into its clip; the module refuses longer (docs/spacetime.md 14, `MAX_WORD_MS`). */
const MAX_WORD_MS = 30_000;

/**
 * A `board_word_timings` row as word timings for one read: `starts_ms[i]` and `ends_ms[i]` are milliseconds into the
 * clip for the i-th word. Numbers only, never the words (docs/spacetime.md 14). The module checks the same rules on
 * the way in; this check keeps a malformed row off the word mark: null unless the two lists pair up, in order, each
 * end at or after its start and at most 30 s into the clip.
 */
export function wordTimingsFromBoard(row: Pick<BoardWordTimingRow, 'startsMs' | 'endsMs'>): WordTiming[] | null {
  const starts: unknown = row.startsMs;
  const ends: unknown = row.endsMs;
  if (!Array.isArray(starts) || !Array.isArray(ends) || starts.length === 0 || starts.length !== ends.length) return null;
  const words: WordTiming[] = [];
  let previous = 0;
  for (let i = 0; i < starts.length; i++) {
    const startMs: unknown = starts[i];
    const endMs: unknown = ends[i];
    if (typeof startMs !== 'number' || typeof endMs !== 'number' || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
    if (startMs < previous || endMs < startMs || endMs > MAX_WORD_MS) return null;
    previous = startMs;
    words.push({ startMs, endMs });
  }
  return words;
}

function liveEvent<S extends Stage>(stage: S, status: PipelineStatus, row: BoardPipelineRow, payloadJson: string | undefined): PipelineEvent {
  const event = {
    id: idText(row.id),
    sessionId: idText(row.sessionId),
    questionId: idText(row.questionId),
    stage,
    status,
    detail: liveDetail(stage, status, row, payloadJson),
    ms: status === 'started' || row.ms === undefined ? null : row.ms,
    at: millis(row.at),
  };
  return event as unknown as PipelineEventOf<S>;
}

/** A `public_board` row as a question. With sharing off the words stay off the screen ("Question N"). */
function questionFromBoard(row: BoardQuestion): Question {
  const menu = row.origin.tag === 'Menu';
  return {
    id: idText(row.questionId),
    sessionId: idText(row.sessionId),
    number: row.number,
    text: row.textShared ? shownText(row.text) : null,
    via: menu ? 'menu' : row.via === 'typed' ? 'typed' : 'voice',
    origin: menu ? 'menu' : 'partner',
    askedAt: millis(row.askedAt),
    replyText: row.textShared ? shownText(row.replyText) : null,
    spokenAt: timestampToMillis(row.spokenAt),
  };
}

function sourceFromBoard(ref: BoardSourceRef): SourceRef {
  const source: SourceRef = { source: ref.source, fetchedAt: ref.fetchedAt };
  const url = webUrl(ref.url);
  if (url !== null) source.url = url;
  if (ref.placeId) source.placeId = ref.placeId;
  return source;
}

/** The scanned version's options nested in a `public_board` row. With sharing off the text is "Option N". */
function optionsFromBoard(row: BoardQuestion): AnswerOption[] {
  const questionId = idText(row.questionId);
  return row.options.map((option) => ({
    id: idText(option.optionId),
    questionId,
    version: row.version,
    rank: option.rank,
    text: shownText(option.label) ?? `Option ${option.rank}`,
    kind: OPTION_KINDS[option.kind.tag],
    tone: option.tone.trim() || null,
    sources: row.textShared ? option.sources.map(sourceFromBoard) : [],
  }));
}

/**
 * The option YES picked on a question, when it is of `kind`: the fallback for errand and call rows recorded before
 * module v2, which carry no option id. An errand or a call row is made the moment the person picks its option, and
 * that pick ends the question's scan (docs/spacetime.md 4.1 and 10.1 item 8), so the question's pick is the row's own
 * option. Since module v2 the rows name it themselves (`option_id`, docs/spacetime.md 14), and that wins.
 */
function pickedOptionOfKind(question: BoardQuestion | undefined, kind: BoardOption['kind']['tag']): string | null {
  if (!question || question.pickedOptionId === undefined) return null;
  const picked = question.options.find((option) => option.optionId === question.pickedOptionId);
  return picked && picked.kind.tag === kind ? idText(picked.optionId) : null;
}

/** A string column the row may lack (a recording made before the module added it): trimmed, null when empty. */
function optionalCode(value: string | undefined): string | null {
  return typeof value === 'string' ? value.trim() || null : null;
}

/**
 * A `board_errands` row as an errand. Its option id is the row's own `option_id` (module v2), and its read-back,
 * result and screenshot are empty unless sharing is on.
 */
function errandFromBoard(row: BoardErrand, question: BoardQuestion | undefined): Errand {
  const shared = row.textShared;
  return {
    id: idText(row.errandId),
    questionId: optionalId(row.questionId),
    optionId: optionalId(row.optionId) ?? pickedOptionOfKind(question, 'Errand'),
    form: shownText(row.formTitle) ?? 'Form',
    status: ERRAND_STATUSES[row.status.tag],
    previewDigest: row.previewDigest.trim() || null,
    readBackText: shared ? shownText(row.readBackText) : null,
    readBack: shared ? readBackItems(row.readBackJson) : [],
    confirmationText: shared ? shownText(row.confirmationText) : null,
    screenshotUrl: shared ? webUrl(row.screenshotUrl) : null,
    confirmClosesAt: timestampToMillis(row.confirmClosesAt),
    confirmOpensAt: timestampToMillis(row.confirmOpensAt),
    reason: shownText(row.reason),
    reasonCode: row.reasonCode.trim() || null,
    confirmCommandId: row.confirmGestureId.trim() || null,
    stopCommandId: row.stopGestureId.trim() || null,
    createdAt: millis(row.createdAt),
    previewedAt: timestampToMillis(row.previewedAt),
    previewMs: null,
    readAloudAt: timestampToMillis(row.readbackDoneAt),
    confirmedAt: timestampToMillis(row.confirmedAt),
    sentAt: timestampToMillis(row.submittedAt),
    endedAt: timestampToMillis(row.endedAt),
  };
}

/**
 * A call's end reason as words, or null. The call agent reports Cartesia's own end reason, which is a code such as
 * `api_cancelled` or `dial_no_answer` (cartesia/src/call.ts), not a sentence; `result` already says the same thing
 * in the screens' words, so a bare code is dropped rather than shown as a sentence.
 */
function endReasonWords(value: string): string | null {
  const text = shownText(value);
  return text === null || /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(text) ? null : text;
}

function transcriptLine(callId: string, line: BoardCallLine, index: number): TranscriptLine | null {
  if (line.role !== 'assistant' && line.role !== 'recipient') return null;
  const text = shownText(line.text);
  if (text === null) return null;
  return { id: `${callId}:${index}`, role: line.role, text, at: millis(line.at) };
}

/**
 * A `board_calls` row as a call: a contact name only ("Contact" with sharing off), never a number. Since module v2
 * (docs/spacetime.md 14) the row names its option, the read-back time, the confirm window, the CONFIRM that released
 * it, the command that stopped or hung it up, and whether the contact is on hold; all of it is content-free. A row
 * recorded before v2 lacks them: its option comes from its question's pick and the rest stays null.
 */
function callFromBoard(row: BoardCall, question: BoardQuestion | undefined): CallRequest {
  const shared = row.textShared;
  const id = idText(row.callId);
  const result = row.result.trim();
  return {
    id,
    questionId: optionalId(row.questionId),
    optionId: optionalId(row.optionId) ?? pickedOptionOfKind(question, 'Call'),
    contactName: shownText(row.contactName) ?? 'Contact',
    scriptDigest: row.scriptDigest.trim() || null,
    readBackText: shared ? shownText(row.readBackText) : null,
    status: CALL_STATUSES[row.status.tag],
    result: CALL_RESULTS.has(result) ? (result as CallResult) : null,
    endReason: shared ? endReasonWords(row.endReason) : null,
    reason: shownText(row.reason),
    reasonCode: optionalCode(row.reasonCode),
    held: row.held === true,
    consentOnFile: row.consentOnFile,
    readAloudAt: timestampToMillis(row.readbackDoneAt),
    confirmClosesAt: timestampToMillis(row.confirmClosesAt),
    confirmOpensAt: timestampToMillis(row.confirmOpensAt),
    confirmCommandId: optionalCode(row.confirmGestureId),
    stopCommandId: optionalCode(row.stopGestureId),
    cancelRequested: row.cancelRequested,
    createdAt: millis(row.createdAt),
    confirmedAt: timestampToMillis(row.confirmedAt),
    dialedAt: timestampToMillis(row.dialedAt),
    ringingAt: timestampToMillis(row.ringingAt),
    startedAt: timestampToMillis(row.connectedAt),
    endedAt: timestampToMillis(row.endedAt),
    transcript: shared ? row.transcript.map((line, index) => transcriptLine(id, line, index)).filter((line) => line !== null) : [],
  };
}

/** An ignored command's reason in words. `no_contact` names the headset only in a headset session. */
function ignoredWords(code: string, input: InputKind): string {
  return code.trim() === 'no_contact' && input !== 'headset' ? 'The input was not ready' : ignoredReasonWords(code);
}

/**
 * The ledger's gesture rows as command events, ignored ones included so the feed shows the debounce. The ledger has
 * no decoder confidence, so it is null.
 */
function commandsFromLedger(ledger: readonly BoardLedgerRow[], input: InputKind): CommandEvent[] {
  const commands: CommandEvent[] = [];
  for (const row of ledger) {
    if (row.kind !== 'gesture' || !isCommand(row.command)) continue;
    const accepted = row.outcome.startsWith('accepted:');
    commands.push({
      id: row.gestureId.trim() || `ledger:${idText(row.id)}`,
      command: row.command,
      at: millis(row.at),
      accepted,
      ignoredReason: accepted ? null : ignoredWords(row.reason || row.outcome.replace(/^ignored:/, ''), input),
      confidence: null,
      questionId: optionalId(row.questionId),
      optionId: optionalId(row.optionId),
    });
  }
  return commands;
}

/**
 * The scan clock from `scan_state`. Since module v2 a scan that ended Picked keeps its `picked_option_id` through a
 * pause, a resume and the end of the session (docs/spacetime.md 14), so the pick survives a pause. For rows written
 * before v2, which cleared it, the scanned question in `public_board` still names the pick.
 */
function scanFromBoard(row: BoardScanRow, questions: readonly BoardQuestion[]): ScanState {
  const outcome = row.outcome ? SCAN_OUTCOMES[row.outcome.tag] : null;
  let picked = row.pickedOptionId;
  if (picked === undefined && outcome === 'picked') picked = questions.find((q) => q.questionId === row.questionId)?.pickedOptionId;
  return {
    questionId: idText(row.questionId),
    version: row.version,
    mode: row.mode.tag === 'Menu' ? 'menu' : 'answer',
    answerMode: row.answerMode.tag === 'YesNo' ? 'yes_no' : 'pick',
    phase: SCAN_PHASES[row.phase.tag],
    cursor: row.cursor === 0 ? null : row.cursor,
    stepStartedAt: millis(row.stepStartedAt),
    stepEndsAt: millis(row.stepEndsAt),
    pass: row.pass,
    maxPasses: row.maxPasses,
    outcome,
    pickedOptionId: optionalId(picked),
  };
}

const UNKNOWN_SAFETY: SafetyState = { state: 'unknown', since: null };

/**
 * The headset state behind the shell banner and chip (docs/spacetime.md 7.1): a pause for HeadsetOff is
 * 'headset_off'; any other pause (Stop, Idle, Operator, HeadsetLost) is 'paused'. 'ok' needs a live session with
 * its station online and healthy; an ended session, or no station online, is 'unknown', never a guess.
 */
function safetyFromBoard(scan: BoardScanRow | undefined, devices: readonly BoardDevice[], ledger: readonly BoardLedgerRow[]): SafetyState {
  if (!scan || ledger.some((row) => row.kind === 'session_end')) return UNKNOWN_SAFETY;
  if (scan.phase.tag === 'Paused') {
    return {
      state: scan.pauseReason?.tag === 'HeadsetOff' ? 'headset_off' : 'paused',
      since: timestampToMillis(scan.pausedAt) ?? millis(scan.stepStartedAt),
    };
  }
  const stationOnline = devices.some((device) => device.role.tag === 'Station' && device.online && device.decoderHealthy !== false);
  if (!stationOnline) return UNKNOWN_SAFETY;
  let since: number | null = null;
  for (const row of ledger) {
    if (row.kind === 'session_start' || row.kind === 'resume') since = millis(row.at);
  }
  return { state: 'ok', since };
}

/** A session label's input mode: `headset`, `keyboard` or `switch` as the whole label or before its first hyphen. */
const LABEL_INPUT = /^(headset|keyboard|switch)(?:-|$)/;

/**
 * The input mode a session label names (docs/station.md 2.3: the station starts a session with `<mode>-<purpose>`,
 * such as `keyboard-test` or `headset-demo`). Any other label, or none, is 'unknown'.
 */
export function inputFromLabel(label: string | null | undefined): InputKind {
  const match = LABEL_INPUT.exec(label?.trim() ?? '');
  return match ? (match[1] as Exclude<InputKind, 'unknown'>) : 'unknown';
}

/**
 * The board session's input mode, from its ledger: the module writes the session label as the `session_start` row's
 * outcome (`startSession`, docs/station.md 2.3). The ledger is public and content-free; it has no source per command
 * (request R1), so the whole session is labelled by its mode. Rows oldest first; the newest `session_start` wins.
 */
export function inputFromLedger(ledger: readonly BoardLedgerRow[]): InputKind {
  for (let i = ledger.length - 1; i >= 0; i--) {
    const row = ledger[i];
    if (row && row.kind === 'session_start') return inputFromLabel(row.outcome);
  }
  return 'unknown';
}

/**
 * A select step is the pick itself, and the module says so explicitly: since module v2 it writes a select step only
 * for a pick, with the option's id, rank and pass in the counts even while sharing is off (docs/spacetime.md 14);
 * none of these, no pick, stopped, cancelled and failed write none, and stay on the scan row's outcome, the question
 * and the plan step. The label is not read. A select step that names no option is not a pick and is dropped: only a
 * row written before v2 can be one (its counts named only the pass).
 */
function isPickStep(stage: Stage, detail: Record<string, unknown>): boolean {
  if (stage !== 'select') return true;
  // `liveDetail` has already made a positive option id a string id and dropped a zero one.
  return (typeof detail.optionId === 'string' && detail.optionId !== '') || (typeof detail.rank === 'number' && detail.rank > 0);
}

/**
 * A pick's kind, and its id when only the rank names it, from the question's options. Ids and kinds are not content,
 * so the screens know which option was picked while sharing is off.
 */
function withPickedOption(detail: StageDetailMap['select'], question: BoardQuestion | undefined): StageDetailMap['select'] {
  if (!question) return detail;
  const option =
    detail.optionId !== undefined
      ? question.options.find((candidate) => idText(candidate.optionId) === detail.optionId)
      : typeof detail.rank === 'number'
        ? question.options.find((candidate) => candidate.rank === detail.rank)
        : undefined;
  if (!option) return detail;
  return { ...detail, optionId: idText(option.optionId), kind: detail.kind ?? OPTION_KINDS[option.kind.tag] };
}

/**
 * Everything the screens read, from the anonymous board (docs/spacetime.md 7.1). Row times stay on the server's
 * clock; the SpacetimeDB source moves them onto this laptop's clock (lib/data/clock-offset.ts). Never throws on a
 * malformed payload: `pipelineDetail` reports it on the step instead.
 */
export function boardRows(board: BoardSnapshot): DataRows {
  const sessionId = boardSessionId(board.config);
  if (sessionId === 0n) return EMPTY_ROWS;
  const ofSession = <T extends { sessionId: bigint }>(rows: readonly T[]): T[] => rows.filter((row) => row.sessionId === sessionId);

  const questions = byTime(ofSession(board.questions), (row) => row.askedAt, (row) => row.questionId);
  const questionById = new Map(questions.map((row) => [row.questionId, row] as const));
  const ledger = byTime(ofSession(board.ledger), (row) => row.at, (row) => row.id);
  const input = inputFromLedger(ledger);
  const scan = board.scanStates.find((row) => row.sessionId === sessionId);
  const payloads = new Map<bigint, string>();
  for (const row of board.payloads) payloads.set(row.eventId, row.payloadJson);
  const timings = new Map<bigint, WordTiming[]>();
  for (const row of ofSession(board.wordTimings ?? [])) {
    const words = wordTimingsFromBoard(row);
    if (words !== null) timings.set(row.eventId, words);
  }

  const pipelineEvents: PipelineEvent[] = [];
  for (const row of byTime(ofSession(board.pipelineEvents), (event) => event.at, (event) => event.id)) {
    const stage = row.stage;
    const status = asPipelineStatus(row.status);
    if (!isStage(stage) || status === null) continue;
    const event = liveEvent(stage, status, row, payloads.get(row.id));
    if (!isPickStep(event.stage, event.detail as Record<string, unknown>)) continue;
    if (event.stage === 'select') {
      pipelineEvents.push({ ...event, detail: withPickedOption(event.detail, questionById.get(row.questionId)) });
    } else if (event.stage === 'speak' && event.detail.words === undefined && timings.has(row.id)) {
      // The station's word timings for this read (docs/spacetime.md 14): the word mark on Live conversation.
      pipelineEvents.push({ ...event, detail: { ...event.detail, words: timings.get(row.id) } });
    } else {
      pipelineEvents.push(event);
    }
  }

  return {
    questions: questions.map(questionFromBoard),
    pipelineEvents,
    options: questions.flatMap(optionsFromBoard),
    errands: byTime(ofSession(board.errands), (row) => row.createdAt, (row) => row.errandId).map((row) => errandFromBoard(row, questionById.get(row.questionId))),
    calls: byTime(ofSession(board.calls), (row) => row.createdAt, (row) => row.callId).map((row) => callFromBoard(row, questionById.get(row.questionId))),
    commands: commandsFromLedger(ledger, input),
    scan: scan ? scanFromBoard(scan, questions) : null,
    safety: safetyFromBoard(scan, board.devices, ledger),
    input,
  };
}
