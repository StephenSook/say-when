// Multi-row, parameterized inserts into the telemetry hypertables and session_inputs. Every table is insert-only and
// idempotent on its identity index (ON CONFLICT DO NOTHING), except rest_minutes, whose rows merge with bitwise OR.
import type pg from 'pg';

import {
    SESSION_METADATA,
    type ActionOutcomeRow,
    type Micros,
    type PickRow,
    type RestMinuteRow,
    type ScanStepRow,
    type SessionInputRow,
    type SwitchEventRow,
    type TableName,
    type TelemetryRow,
} from './types.js';

/** A server timestamp (microseconds) as an ISO string with all six fractional digits, so nothing is rounded. */
export function microsToIso(micros: Micros): string {
    if (micros < 0n) throw new RangeError('a server timestamp before 1970 is not a SpacetimeDB time');
    const base = new Date(Number(micros / 1000n)).toISOString(); // 2026-10-24T08:04:00.123Z
    return `${base.slice(0, -1)}${String(Number(micros % 1000n)).padStart(3, '0')}Z`;
}

type RowOf<T extends TableName> = Extract<TelemetryRow, { table: T }>['row'];

interface Spec<T extends TableName> {
    readonly columns: readonly string[];
    readonly values: (row: RowOf<T>) => readonly unknown[];
    readonly conflict: string;
}

const big = (v: bigint | null): string | null => (v === null ? null : v.toString());

export const SPECS: { readonly [T in TableName]: Spec<T> } = {
    switch_events: {
        columns: [
            'time',
            'session_id',
            'ledger_id',
            'command',
            'outcome',
            'code',
            'resting',
            'false_activation',
            'heard_step_seq',
            'option_rank',
            'heard_in',
            'latency_ms',
            'late_by_ms',
        ],
        values: (r: SwitchEventRow) => [
            microsToIso(r.time),
            r.sessionId,
            big(r.ledgerId),
            r.command,
            r.outcome,
            r.code,
            r.resting,
            r.falseActivation,
            big(r.heardStepSeq),
            r.optionRank,
            r.heardIn,
            r.latencyMs,
            r.lateByMs,
        ],
        conflict: 'ON CONFLICT DO NOTHING',
    },
    scan_steps: {
        columns: ['time', 'session_id', 'step_seq', 'question_id', 'phase', 'mode', 'answer_mode', 'cursor', 'option_count', 'pass', 'planned_ms', 'outcome', 'pause_reason'],
        values: (r: ScanStepRow) => [
            microsToIso(r.time),
            r.sessionId,
            big(r.stepSeq),
            big(r.questionId),
            r.phase,
            r.mode,
            r.answerMode,
            r.cursor,
            r.optionCount,
            r.pass,
            r.plannedMs,
            r.outcome,
            r.pauseReason,
        ],
        conflict: 'ON CONFLICT DO NOTHING',
    },
    picks: {
        columns: ['time', 'session_id', 'ledger_id', 'question_id', 'option_rank', 'pick_kind', 'time_to_pick_ms', 'late_by_ms'],
        values: (r: PickRow) => [microsToIso(r.time), r.sessionId, big(r.ledgerId), big(r.questionId), r.optionRank, r.pickKind, r.timeToPickMs, r.lateByMs],
        conflict: 'ON CONFLICT DO NOTHING',
    },
    action_outcomes: {
        columns: ['time', 'session_id', 'kind', 'action_id', 'status', 'result'],
        values: (r: ActionOutcomeRow) => [microsToIso(r.time), r.sessionId, r.kind, big(r.actionId), r.status, r.result],
        conflict: 'ON CONFLICT DO NOTHING',
    },
    rest_minutes: {
        columns: ['time', 'session_id', 'rest_mask', 'idle_ms'],
        values: (r: RestMinuteRow) => [microsToIso(r.time), r.sessionId, r.restMask.toString(), r.idleMs],
        conflict:
            'ON CONFLICT (session_id, time) DO UPDATE SET rest_mask = telemetry.rest_minutes.rest_mask | EXCLUDED.rest_mask, ' +
            'idle_ms = bit_count((telemetry.rest_minutes.rest_mask | EXCLUDED.rest_mask)::bit(64)) * 1000, ingested_at = now()',
    },
    session_inputs: {
        columns: ['started_at', 'session_id', 'input'],
        values: (r: SessionInputRow) => [microsToIso(r.time), r.sessionId, r.input],
        conflict: 'ON CONFLICT DO NOTHING',
    },
};

/** `INSERT INTO telemetry.<table> (...) VALUES ($1, ...), (...) <conflict>` for `count` rows. */
export function buildInsert(table: TableName, count: number): string {
    const spec = SPECS[table];
    const width = spec.columns.length;
    const tuples: string[] = [];
    for (let i = 0; i < count; i++) {
        tuples.push(`(${spec.columns.map((_, j) => `$${i * width + j + 1}`).join(', ')})`);
    }
    return `INSERT INTO telemetry.${table} (${spec.columns.join(', ')}) VALUES ${tuples.join(', ')} ${spec.conflict}`;
}

export function insertParams<T extends TableName>(table: T, rows: readonly RowOf<T>[]): unknown[] {
    const spec = SPECS[table] as Spec<T>;
    return rows.flatMap((r) => [...spec.values(r)]);
}

/** The continuous aggregate built on each table (sql/02*.sql). */
export const AGGREGATE_OF: Partial<Record<TableName, string>> = {
    switch_events: 'switch_1m',
    rest_minutes: 'idle_1m',
    picks: 'picks_1m',
};

/** The aggregates' refresh policies recompute the last 3 days; anything older needs an explicit refresh. */
export const POLICY_WINDOW_MS = 3 * 24 * 3_600_000;
/** Refresh explicitly once rows are this old: an hour inside the policy window, so nothing falls between them. */
export const BACKLOG_AFTER_MS = POLICY_WINDOW_MS - 3_600_000;
/** Raw rows are kept 7 days (sql/030_retention.sql). */
export const RAW_RETENTION_MS = 7 * 24 * 3_600_000;
/**
 * Never refresh or insert rows older than this: a refresh recomputes a bucket from the raw rows it can see, and once
 * retention has removed some of them it would replace a complete aggregate bucket with a partial one. A day of margin.
 */
export const OLDEST_ROW_MS = RAW_RETENTION_MS - 24 * 3_600_000;

/**
 * The minute range to refresh after a batch: only the rows older than the policy window (they sit below the
 * materialization watermark, where real-time aggregation does not look) and newer than OLDEST_ROW_MS. The range is
 * built from those rows alone, so it never reaches the current, still-filling minute.
 */
export function backlogRange(rows: readonly { time: Micros }[], nowMs: number): { from: string; to: string } | null {
    let min: Micros | null = null;
    let max: Micros | null = null;
    for (const r of rows) {
        const ageMs = nowMs - Number(r.time / 1000n);
        if (ageMs <= BACKLOG_AFTER_MS || ageMs > OLDEST_ROW_MS) continue;
        if (min === null || r.time < min) min = r.time;
        if (max === null || r.time > max) max = r.time;
    }
    if (min === null || max === null) return null;
    const minute = 60_000_000n;
    const floor = (t: Micros) => t - (t % minute);
    return { from: microsToIso(floor(min)), to: microsToIso(floor(max) + minute) };
}

/** Where the writer sends a batch. One call per table; throws if the rows did not land. */
export interface RowSink {
    insert<T extends TableName>(table: T, rows: readonly RowOf<T>[]): Promise<void>;
}

export class PgSink implements RowSink {
    /** Rows refused because they were older than OLDEST_ROW_MS, per table (the tracker drops them first). */
    readonly tooOld: Partial<Record<TableName, number>> = {};

    constructor(
        private readonly pool: pg.Pool,
        private readonly now: () => number = Date.now,
    ) {}

    async insert<T extends TableName>(table: T, rows: readonly RowOf<T>[]): Promise<void> {
        const nowMs = this.now();
        // Session metadata is keyed by session and its time is the session's start: never refused for age.
        const fresh = SESSION_METADATA.has(table) ? rows : rows.filter((r) => nowMs - Number((r as { time: Micros }).time / 1000n) <= OLDEST_ROW_MS);
        if (fresh.length < rows.length) this.tooOld[table] = (this.tooOld[table] ?? 0) + rows.length - fresh.length;
        if (fresh.length === 0) return;
        await this.pool.query(buildInsert(table, fresh.length), insertParams(table, fresh));
        const aggregate = AGGREGATE_OF[table];
        const range = aggregate ? backlogRange(fresh as readonly { time: Micros }[], nowMs) : null;
        if (aggregate && range) await refreshAggregate(this.pool, aggregate, range.from, range.to);
    }
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/**
 * Recomputes an aggregate's buckets in [from, to). Sent as one simple-protocol statement (no bind parameters), the
 * form refresh_continuous_aggregate accepts outside a transaction block; both times are checked ISO strings.
 */
export async function refreshAggregate(pool: pg.Pool, aggregate: string, from: string, to: string): Promise<void> {
    if (!/^[a-z_0-9]+$/.test(aggregate) || !ISO_RE.test(from) || !ISO_RE.test(to)) throw new RangeError('refreshAggregate: bad arguments');
    await pool.query(`CALL refresh_continuous_aggregate('telemetry.${aggregate}', '${from}'::timestamptz, '${to}'::timestamptz)`);
}
