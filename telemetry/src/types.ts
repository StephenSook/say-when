// The content-free shapes on both sides of the writer: what a source hands over (already stripped to the fields
// telemetry reads) and the rows that go to Tiger. Neither has a field that could hold question, option, memory,
// read-back, confirmation, contact or transcript text.

/** Microseconds since the Unix epoch, from a SpacetimeDB server timestamp. Never a laptop clock. */
export type Micros = bigint;

// ---------- Vocabularies (docs/spacetime.md 2.2, 4.2; PLAN D11; docs/direct-select.md, D18) ----------

/**
 * Every command word switch_events stores, in the order of its CHECK (sql/010, widened by sql/070). Scan mode sends
 * YES, NO, CONFIRM and STOP; direct select (D18) sends PICK_1 (imagined left fist), PICK_2 (imagined right fist),
 * PICK_3 (single jaw clench) and STOP. HEADSET_OFF comes in both. There is no PICK_4: no gesture sends it, and a
 * PICK_4 row (the station's key 4) is a contract skip, never stored.
 */
export const COMMANDS = ['YES', 'NO', 'CONFIRM', 'STOP', 'HEADSET_OFF', 'PICK_1', 'PICK_2', 'PICK_3'] as const;
export type CommandName = (typeof COMMANDS)[number];
/** The person's commands. HEADSET_OFF is a system event (D11) and never counts as one. */
export const PERSON_COMMANDS: readonly CommandName[] = ['YES', 'NO', 'CONFIRM', 'STOP', 'PICK_1', 'PICK_2', 'PICK_3'];
/** Direct select's picks (D18): the rank is the word's number, and the option is picked by rank, not by what was heard. */
export const DIRECT_PICKS: ReadonlyMap<CommandName, number> = new Map<CommandName, number>([
    ['PICK_1', 1],
    ['PICK_2', 2],
    ['PICK_3', 3],
]);

export const PHASES = ['idle', 'preparing', 'reading', 'window', 'veto', 'paused'] as const;
export const SCAN_MODES = ['answer', 'menu'] as const;
export const ANSWER_MODES = ['pick', 'yes_no'] as const;
export const SCAN_OUTCOMES = ['picked', 'none', 'no_pick', 'stopped', 'cancelled'] as const;
export const PAUSE_REASONS = ['headset_lost', 'headset_off', 'stop', 'idle', 'operator'] as const;
export const PICK_KINDS = ['reply', 'errand', 'call', 'menu', 'yes', 'no'] as const;

export const ERRAND_STATUSES = [
    'drafted',
    'previewed',
    'awaiting_confirm',
    'confirmed',
    'submitting',
    'submitted',
    'refused',
    'failed',
    'unknown_outcome',
    'stopped',
] as const;
export const CALL_STATUSES = ['prepared', 'awaiting_confirm', 'confirmed', 'dialing', 'ringing', 'connected', 'ended', 'failed', 'stopped', 'refused'] as const;
export const CALL_RESULTS = ['answered', 'no_answer', 'busy', 'voicemail', 'cancelled', 'failed', 'refused', 'unknown'] as const;

/** An errand or call is open (something is waiting on or acting for the person) in these statuses. */
export const OPEN_ERRAND: ReadonlySet<string> = new Set(['drafted', 'previewed', 'awaiting_confirm', 'confirmed', 'submitting']);
export const OPEN_CALL: ReadonlySet<string> = new Set(['prepared', 'awaiting_confirm', 'confirmed', 'dialing', 'ringing', 'connected']);

/**
 * Ignore reasons that mean "this command had nothing to act on" (docs/spacetime.md 4.2): NO (or YES with the menu
 * off) while idle, CONFIRM with nothing awaiting confirmation, NO or CONFIRM during a pause, STOP when already
 * paused. In direct select (docs/direct-select.md 4.1): a PICK with no list on offer (`no_list`, preparing or idle),
 * and PICK_2 or PICK_3 during a pause (`paused`). Refractory, stale-step, wrong-mode (`direct_mode`, `scan_mode`) and
 * similar reasons are about a command that did have something to act on, or about the decoder, not the person.
 */
export const NOTHING_TO_ACT_ON: ReadonlySet<string> = new Set(['idle', 'nothing_to_confirm', 'paused', 'already_paused', 'no_list']);

/**
 * Pause reasons that still count as resting: the wearer or the operator paused on purpose, or the 2-minute idle
 * auto-pause fired, and the decoder is still reading the person. A lost or removed headset is not resting.
 */
export const RESTING_PAUSES: ReadonlySet<string> = new Set(['stop', 'idle', 'operator']);

/** Accepted actions and ignore reasons are snake_case codes; anything else becomes `other`. */
export const CODE_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** docs/spacetime.md 3.4: the decoder's gesture id, as the module checks it. */
export const GESTURE_ID_RE = /^[A-Za-z0-9:_-]{1,64}$/;
/** SpacetimeDB database names (docs/spacetime.md 9.4). */
export const DATABASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Synthetic rows from tests carry this prefix and are never counted as real usage. */
export const TEST_SESSION_RE = /^test-[A-Za-z0-9_-]{1,64}(:[0-9]{1,20})?$/;

/**
 * The input a session ran with, from the label the station gives `start_session` (`<mode>-<purpose>`, the
 * `session_start` ledger row's outcome; docs/station.md 2.3): `headset-demo`, `keyboard-test`, `switch-demo` and so
 * on. A label that names no input (`smoke`, `demo`, empty) is `unknown`. Only this word is stored, never the label.
 */
export const INPUT_KINDS = ['headset', 'keyboard', 'switch', 'unknown'] as const;
export type InputKind = (typeof INPUT_KINDS)[number];

export function inputOf(label: string): InputKind {
    if (label.startsWith('headset-')) return 'headset';
    if (label.startsWith('keyboard-')) return 'keyboard';
    if (label.startsWith('switch-')) return 'switch';
    return 'unknown';
}

/**
 * Accepted codes of a gesture that made a pick; its ledger row shares the gesture id with the `pick` row. Scan mode:
 * pick, pick_errand, pick_call, menu_item, answer_yes, answer_no. Direct select adds pick_reply, pick_search and
 * pick_category (clock.ts `pickDirect`, which writes the `pick` row for every kind it accepts).
 */
export const PICK_CODES: ReadonlySet<string> = new Set([
    'pick',
    'pick_errand',
    'pick_call',
    'menu_item',
    'answer_yes',
    'answer_no',
    'pick_reply',
    'pick_search',
    'pick_category',
]);

export function oneOf<T extends string>(value: string, allowed: readonly T[]): T | 'other' {
    return (allowed as readonly string[]).includes(value) ? (value as T) : 'other';
}

export function codeOf(value: string): string {
    return CODE_RE.test(value) ? value : 'other';
}

// ---------- What a source hands the tracker ----------

/** A ledger row (docs/spacetime.md 2.7), only the fields telemetry reads. `digest` and free fields are not here. */
export interface LedgerIn {
    readonly id: bigint;
    readonly sessionId: bigint;
    readonly at: Micros;
    readonly kind: string;
    readonly questionId: bigint;
    readonly optionId: bigint;
    readonly errandId: bigint;
    readonly callId: bigint;
    readonly gestureId: string;
    readonly command: string;
    readonly stepSeq: bigint;
    readonly cursor: number;
    readonly outcome: string;
    readonly reason: string;
    readonly ms: number;
}

/** The public `scan_state` row (docs/spacetime.md 2.6). Enum tags are snake_case words here. */
export interface ScanIn {
    readonly sessionId: bigint;
    readonly questionId: bigint;
    readonly phase: string;
    readonly mode: string;
    readonly answerMode: string;
    readonly cursor: number;
    readonly optionCount: number;
    readonly pass: number;
    readonly stepSeq: bigint;
    readonly stepStartedAt: Micros;
    readonly stepEndsAt: Micros;
    readonly outcome: string | null;
    readonly pauseReason: string | null;
    readonly updatedAt: Micros;
}

/** An errand from `board_errands` or a call from `board_calls`: status only. */
export interface ActionIn {
    readonly kind: 'errand' | 'call';
    readonly id: bigint;
    readonly sessionId: bigint;
    readonly status: string;
    /** Calls only: the Dialer's result word, or empty. */
    readonly result: string;
    /** When the row last changed (server). Orders updates and places open and close on the rest timeline. */
    readonly updatedAt: Micros;
    /**
     * When the row reached its current status (server): the status's own column where the view has one
     * (`previewed_at`, `confirmed_at`, `ended_at`, ...), else `updated_at`. Stable across replays, so a restarted
     * writer lands the same outcome row on the same key.
     */
    readonly statusAt: Micros;
}

/**
 * A public `device_status` row (docs/spacetime.md 2.9). Only the station's rows matter: whether it is online and
 * its decoder healthy, and `last_seen_at`, which the heartbeat refreshes about every 2 s. The identity is held in
 * memory to tell devices apart and is never stored; the label is never read.
 */
export interface DeviceIn {
    readonly id: string;
    readonly role: string;
    readonly online: boolean;
    readonly decoderHealthy: boolean | null;
    readonly lastSeenAt: Micros;
}

// ---------- Rows for Tiger (sql/0*.sql) ----------

/**
 * No gesture id: the station chooses it (any 1 to 64 letters, digits and `_:-`), so it could carry words. It is used
 * in memory only, to pair a pick with its gesture; `ledgerId` links a row to the module's ledger.
 */
export interface SwitchEventRow {
    readonly time: Micros;
    readonly sessionId: string;
    readonly ledgerId: bigint;
    readonly command: CommandName;
    readonly outcome: 'accepted' | 'ignored';
    readonly code: string;
    readonly resting: boolean | null;
    readonly falseActivation: boolean;
    readonly heardStepSeq: bigint | null;
    readonly optionRank: number | null;
    readonly heardIn: 'reading' | 'window' | null;
    readonly latencyMs: number | null;
    readonly lateByMs: number | null;
}

export interface ScanStepRow {
    readonly time: Micros;
    readonly sessionId: string;
    readonly stepSeq: bigint;
    readonly questionId: bigint;
    readonly phase: string;
    readonly mode: string;
    readonly answerMode: string;
    readonly cursor: number;
    readonly optionCount: number;
    readonly pass: number;
    readonly plannedMs: number | null;
    readonly outcome: string | null;
    readonly pauseReason: string | null;
}

export interface PickRow {
    readonly time: Micros;
    readonly sessionId: string;
    readonly ledgerId: bigint;
    readonly questionId: bigint;
    readonly optionRank: number;
    readonly pickKind: string;
    readonly timeToPickMs: number | null;
    readonly lateByMs: number;
}

export interface ActionOutcomeRow {
    readonly time: Micros;
    readonly sessionId: string;
    readonly kind: 'errand' | 'call';
    readonly actionId: bigint;
    readonly status: string;
    readonly result: string | null;
}

/**
 * Rest time of one session in one UTC minute, at one-second resolution: bit k (0 to 59) is set when second k of the
 * minute was at rest (its midpoint fell inside a rest period). Rows merge with bitwise OR, so two writers, or one
 * writer before and after a restart, can only ever add seconds that one of them saw: the union, never a double count.
 */
export interface RestMinuteRow {
    /** The minute (UTC, on the minute). */
    readonly time: Micros;
    readonly sessionId: string;
    readonly restMask: bigint;
    /** 1000 times the number of bits set. */
    readonly idleMs: number;
}

/** The input a session ran with (sql/060), one row per session, so keyboard and switch sessions stay apart (T1). */
export interface SessionInputRow {
    /** The session's start (its `session_start` ledger row). */
    readonly time: Micros;
    readonly sessionId: string;
    readonly input: InputKind;
}

export type TelemetryRow =
    | { readonly table: 'switch_events'; readonly row: SwitchEventRow }
    | { readonly table: 'scan_steps'; readonly row: ScanStepRow }
    | { readonly table: 'picks'; readonly row: PickRow }
    | { readonly table: 'action_outcomes'; readonly row: ActionOutcomeRow }
    | { readonly table: 'rest_minutes'; readonly row: RestMinuteRow }
    | { readonly table: 'session_inputs'; readonly row: SessionInputRow };

export type TableName = TelemetryRow['table'];
export const TABLE_NAMES: readonly TableName[] = ['switch_events', 'scan_steps', 'picks', 'action_outcomes', 'rest_minutes', 'session_inputs'];

/**
 * Session metadata: one row per session, keyed by session, not time-series data. Its `time` is the session's start,
 * so it is never dropped for age (a session can start long before its current commands). The writer never queues it:
 * it keeps it in memory and sends it at the start of each flush until an insert of it succeeds, so a full queue can
 * never drop it, and a flush whose metadata insert fails sends none of its rows.
 */
export const SESSION_METADATA: ReadonlySet<TableName> = new Set<TableName>(['session_inputs']);

/** Number of set bits. */
export function popcount(mask: bigint): number {
    let n = 0;
    for (let m = mask; m > 0n; m &= m - 1n) n++;
    return n;
}

/** `<database>:<session id>`: SpacetimeDB session ids restart at 1 in each database, so the name is part of the key. */
export function sessionKey(database: string, sessionId: bigint): string {
    return `${database}:${sessionId}`;
}
