// Applies sql/*.sql to Tiger, one statement per call, and checks the result against the live catalog.
//
// Files run in name order. A file named NNN_name.variant.sql is one of several variants of migration NNN_name;
// the runner picks one (today: `toolkit` when the service has timescaledb_toolkit, else `exact`). Each applied
// migration is recorded in telemetry.migrations with a checksum, so a re-run skips it and an edited file is refused
// rather than silently re-applied. Every statement is idempotent (IF NOT EXISTS, if_not_exists => TRUE), and none
// runs inside a transaction block, because continuous aggregates cannot be created inside one.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import type pg from 'pg';

export const SQL_DIR = new URL('../sql/', import.meta.url);

export type PercentileMode = 'toolkit' | 'exact';

export interface MigrationFile {
    /** NNN_name, shared by all variants of one migration. */
    readonly id: string;
    readonly variant: string | null;
    readonly file: string;
    readonly checksum: string;
    readonly statements: readonly string[];
}

/** Splits a file into statements: comment lines dropped, then a semicolon at the end of a line ends a statement. */
export function splitStatements(sql: string): string[] {
    const text = sql
        .split(/\r?\n/)
        .filter((line) => !/^\s*--/.test(line))
        .join('\n');
    return text
        .split(/;[ \t]*$/m)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

const FILE_RE = /^(\d{3}_[a-z0-9_]+?)(?:\.([a-z0-9]+))?\.sql$/;

export function readMigrations(dir: URL = SQL_DIR): MigrationFile[] {
    const files = readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .sort();
    return files.map((file) => {
        const m = FILE_RE.exec(file);
        if (!m) throw new Error(`sql/${file} does not match NNN_name.sql or NNN_name.variant.sql`);
        const sql = readFileSync(new URL(file, dir), 'utf8');
        const statements = splitStatements(sql);
        if (statements.length === 0) throw new Error(`sql/${file} has no statements`);
        return {
            id: m[1]!,
            variant: m[2] ?? null,
            file,
            checksum: createHash('sha256').update(sql).digest('hex'),
            statements,
        };
    });
}

/** One file per migration id: the only file, or the variant that matches `mode`. */
export function choosePlan(files: readonly MigrationFile[], mode: PercentileMode): MigrationFile[] {
    const byId = new Map<string, MigrationFile[]>();
    for (const f of files) byId.set(f.id, [...(byId.get(f.id) ?? []), f]);
    const plan: MigrationFile[] = [];
    for (const [id, group] of [...byId.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (group.length === 1 && group[0]!.variant === null) {
            plan.push(group[0]!);
            continue;
        }
        const chosen = group.find((f) => f.variant === mode);
        if (!chosen) throw new Error(`migration ${id} has no ${mode} variant`);
        plan.push(chosen);
    }
    return plan;
}

export interface MigrateReport {
    readonly timescaledbVersion: string | null;
    readonly percentiles: PercentileMode;
    readonly applied: string[];
    readonly skipped: string[];
}

export interface MigrateOptions {
    /** `auto` (default) uses timescaledb_toolkit when the service offers it. */
    percentiles?: PercentileMode | 'auto';
    dir?: URL;
    log?: (line: string) => void;
}

async function scalar<T>(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<T | null> {
    const r = await pool.query(sql, params);
    const row = r.rows[0] as Record<string, unknown> | undefined;
    return row ? (Object.values(row)[0] as T) : null;
}

export async function detectPercentiles(pool: pg.Pool): Promise<PercentileMode> {
    const available = await scalar<number>(pool, "SELECT count(*)::int FROM pg_available_extensions WHERE name = 'timescaledb_toolkit'");
    return (available ?? 0) > 0 ? 'toolkit' : 'exact';
}

export async function migrate(pool: pg.Pool, options: MigrateOptions = {}): Promise<MigrateReport> {
    const log = options.log ?? (() => {});
    const version = await scalar<string>(pool, "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'");
    if (!version) throw new Error('This Postgres service has no timescaledb extension.');
    await pool.query('CREATE SCHEMA IF NOT EXISTS telemetry');
    await pool.query(
        'CREATE TABLE IF NOT EXISTS telemetry.migrations (id text PRIMARY KEY, variant text, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const recorded = new Map<string, { variant: string | null; checksum: string }>();
    for (const row of (await pool.query('SELECT id, variant, checksum FROM telemetry.migrations')).rows as Array<{ id: string; variant: string | null; checksum: string }>) {
        recorded.set(row.id, { variant: row.variant, checksum: row.checksum });
    }
    // A variant already applied wins over detection, so a re-run never switches the picks aggregate's shape.
    const appliedPicks = [...recorded.entries()].find(([id]) => id.startsWith('022_'))?.[1].variant as PercentileMode | undefined;
    const requested = options.percentiles ?? 'auto';
    const mode: PercentileMode = appliedPicks ?? (requested === 'auto' ? await detectPercentiles(pool) : requested);

    const plan = choosePlan(readMigrations(options.dir), mode);
    const applied: string[] = [];
    const skipped: string[] = [];
    for (const m of plan) {
        const done = recorded.get(m.id);
        if (done) {
            if (done.checksum !== m.checksum || done.variant !== m.variant) {
                throw new Error(`sql/${m.file} changed after it was applied (recorded ${done.variant ?? 'no'} variant, checksum ${done.checksum.slice(0, 12)}). Write a new migration instead of editing an applied one.`);
            }
            skipped.push(m.file);
            continue;
        }
        for (const [i, statement] of m.statements.entries()) {
            try {
                await pool.query(statement);
            } catch (error) {
                throw new Error(`sql/${m.file} statement ${i + 1} of ${m.statements.length} failed: ${(error as Error).message}`);
            }
        }
        await pool.query('INSERT INTO telemetry.migrations (id, variant, checksum) VALUES ($1, $2, $3)', [m.id, m.variant, m.checksum]);
        applied.push(m.file);
        log(`applied sql/${m.file} (${m.statements.length} statements)`);
    }
    return { timescaledbVersion: version, percentiles: mode, applied, skipped };
}

// ---------- Verification against the live catalog ----------

export const HYPERTABLES = ['switch_events', 'scan_steps', 'picks', 'action_outcomes', 'rest_minutes'] as const;
export type Hypertable = (typeof HYPERTABLES)[number];
export const AGGREGATES = ['switch_1m', 'idle_1m', 'picks_1m'] as const;
/** Each hypertable's idempotency index, column by column (sql/01*.sql). */
export const IDENTITY_COLUMNS: Record<Hypertable, readonly string[]> = {
    switch_events: ['session_id', 'ledger_id', 'time'],
    scan_steps: ['session_id', 'step_seq', 'time'],
    picks: ['session_id', 'ledger_id', 'time'],
    action_outcomes: ['session_id', 'kind', 'action_id', 'status', 'time'],
    rest_minutes: ['session_id', 'time'],
};
export const RAW_RETENTION = '7 days';
export const AGGREGATE_RETENTION = '30 days';
/** A raw chunk moves to the columnstore once its end is this old (sql/050): at or past every refresh window. */
export const COLUMNSTORE_AFTER = '3 days';
/**
 * Each hypertable's columnstore layout (sql/050_columnstore.sql). An orderby term is a column (ascending) or
 * `column DESC`, with the default NULLS placement. Together they cover every column of the idempotency index.
 */
export const COLUMNSTORE_LAYOUT: { readonly [T in Hypertable]: { readonly segmentby: readonly string[]; readonly orderby: readonly string[] } } = {
    switch_events: { segmentby: ['session_id'], orderby: ['time DESC', 'ledger_id'] },
    scan_steps: { segmentby: ['session_id'], orderby: ['time DESC', 'step_seq'] },
    picks: { segmentby: ['session_id'], orderby: ['time DESC', 'ledger_id'] },
    action_outcomes: { segmentby: ['session_id'], orderby: ['time DESC', 'kind', 'action_id', 'status'] },
    rest_minutes: { segmentby: ['session_id'], orderby: ['time DESC'] },
};

/** One row of timescaledb_information.compression_settings: one segmentby or orderby column of one hypertable. */
export interface ColumnstoreSettingRow {
    readonly hypertable_name: string;
    readonly attname: string;
    readonly segmentby_column_index: number | null;
    readonly orderby_column_index: number | null;
    readonly orderby_asc: boolean | null;
    readonly orderby_nullsfirst: boolean | null;
}

/** An orderby column written as sql/050 writes it: DESC when descending, NULLS only when it is not the default. */
function orderTerm(r: ColumnstoreSettingRow): string {
    const desc = r.orderby_asc === false;
    // PostgreSQL's default: NULLS FIRST for DESC, NULLS LAST for ASC.
    const nulls = r.orderby_nullsfirst === desc ? '' : r.orderby_nullsfirst ? ' NULLS FIRST' : ' NULLS LAST';
    return `${r.attname}${desc ? ' DESC' : ''}${nulls}`;
}

/**
 * Whether a hypertable's columnstore is on with exactly the expected segmentby and orderby, in order. `enabled` is
 * timescaledb_information.hypertables.compression_enabled (undefined when the hypertable is missing).
 */
export function judgeColumnstore(name: Hypertable, enabled: boolean | undefined, rows: readonly ColumnstoreSettingRow[]): { ok: boolean; detail: string } {
    if (enabled === undefined) return { ok: false, detail: 'missing' };
    const want = COLUMNSTORE_LAYOUT[name];
    const mine = rows.filter((r) => r.hypertable_name === name);
    const byIndex = (key: 'segmentby_column_index' | 'orderby_column_index') =>
        mine.filter((r) => r[key] !== null).sort((a, b) => Number(a[key]) - Number(b[key]));
    const segmentby = byIndex('segmentby_column_index').map((r) => r.attname);
    const orderby = byIndex('orderby_column_index').map(orderTerm);
    const got = `segmentby ${segmentby.join(', ') || '(none)'}; orderby ${orderby.join(', ') || '(none)'}`;
    const ok = enabled && segmentby.join(',') === want.segmentby.join(',') && orderby.join(',') === want.orderby.join(',');
    return { ok, detail: enabled ? got : `columnstore not enabled; ${got}` };
}

/** A timescaledb_information.jobs row, as verifySchema reads it. */
export interface JobRow {
    readonly job_id: number;
    readonly proc_name: string;
    readonly hypertable_schema: string;
    readonly hypertable_name: string;
    readonly config: Record<string, unknown>;
    readonly every: string;
    readonly scheduled: boolean;
}

/**
 * How often each columnstore policy runs, as timescaledb_information.jobs prints it. sql/050 leaves the default, which
 * TimescaleDB sets for a policy on a time hypertable to half the chunk interval, at most 12 hours (compression_api.c):
 * 12 hours for 1-day chunks.
 */
export const COLUMNSTORE_SCHEDULE = '12:00:00';
export const COLUMNSTORE_SCHEDULE_SECONDS = 12 * 3_600;
/** A columnstore job is overdue once its last success is older than its schedule plus this much. */
export const COLUMNSTORE_OVERDUE_GRACE_SECONDS = 3_600;
/**
 * The bootstrap allowance: a policy that has never run passes only while sql/050 was applied less than this long ago
 * (one schedule plus the grace). After that, a policy with no successful run fails.
 */
export const COLUMNSTORE_BOOTSTRAP_SECONDS = COLUMNSTORE_SCHEDULE_SECONDS + COLUMNSTORE_OVERDUE_GRACE_SECONDS;
/** The migration that creates the columnstore policies; its applied_at is the policies' age for the bootstrap rule. */
export const COLUMNSTORE_MIGRATION = '050_columnstore';

/** Whether a hypertable's columnstore policy exists, is scheduled every COLUMNSTORE_SCHEDULE, and converts at exactly COLUMNSTORE_AFTER. */
export function judgeColumnstorePolicy(name: Hypertable, jobs: readonly JobRow[]): { ok: boolean; detail: string; job?: JobRow } {
    const job = jobs.find((j) => j.proc_name === 'policy_compression' && j.hypertable_schema === 'telemetry' && j.hypertable_name === name);
    if (!job) return { ok: false, detail: 'missing' };
    const after = String(job.config.compress_after ?? '');
    return {
        ok: job.scheduled && after === COLUMNSTORE_AFTER && job.every === COLUMNSTORE_SCHEDULE,
        detail: `after ${after || '(none)'}, every ${job.every}, scheduled ${job.scheduled}`,
        job,
    };
}

/** A columnstore job's run history, with ages in seconds measured on the database clock. */
export interface ColumnstoreRunStat {
    readonly runs: number;
    readonly failures: number;
    readonly lastStatus: string | null;
    /** Seconds since the last successful run finished; null if it never succeeded. */
    readonly lastSuccessAgeSeconds: number | null;
    /** Seconds since sql/050 was applied; null if it is not recorded. */
    readonly policyAgeSeconds: number | null;
}

const hours = (s: number) => `${Math.round((s / 3_600) * 10) / 10} h`;

/**
 * Whether a columnstore job is running on time: its last run succeeded and its last success is no older than the
 * schedule plus the grace. A job that has never run passes only inside the bootstrap allowance after sql/050.
 */
export function judgeColumnstoreRuns(stat: ColumnstoreRunStat): { ok: boolean; detail: string } {
    const limit = COLUMNSTORE_SCHEDULE_SECONDS + COLUMNSTORE_OVERDUE_GRACE_SECONDS;
    if (stat.runs === 0) {
        const young = stat.policyAgeSeconds !== null && stat.policyAgeSeconds <= COLUMNSTORE_BOOTSTRAP_SECONDS;
        const age = stat.policyAgeSeconds === null ? 'unknown' : hours(stat.policyAgeSeconds);
        return { ok: young, detail: `not run yet; policy ${age} old (bootstrap allowance ${hours(COLUMNSTORE_BOOTSTRAP_SECONDS)})` };
    }
    const fresh = stat.lastSuccessAgeSeconds !== null && stat.lastSuccessAgeSeconds <= limit;
    const age = stat.lastSuccessAgeSeconds === null ? 'never' : `${hours(stat.lastSuccessAgeSeconds)} ago`;
    return {
        ok: stat.lastStatus === 'Success' && fresh,
        detail: `${stat.runs} runs, ${stat.failures} failures, last ${stat.lastStatus ?? 'unknown'}; last success ${age} (overdue after ${hours(limit)})`,
    };
}

/** One row of timescaledb_information.chunk_columnstore_settings: the layout a chunk in the columnstore was converted with. */
export interface ChunkColumnstoreRow {
    /** `telemetry.<hypertable>` */
    readonly hypertable: string;
    /** `_timescaledb_internal._hyper_N_M_chunk` */
    readonly chunk: string;
    readonly segmentby: string | null;
    /** As TimescaleDB prints it, for example `"time" DESC,ledger_id`. */
    readonly orderby: string | null;
}

/** A printed column list as layout terms: quotes dropped, split on commas. */
function printedTerms(text: string | null): string[] {
    return (text ?? '')
        .split(',')
        .map((t) => t.replaceAll('"', '').trim())
        .filter((t) => t.length > 0);
}

/**
 * Whether every chunk of a hypertable that is in the columnstore was converted with the expected layout. TimescaleDB
 * keeps a converted chunk on the layout it was converted with when the hypertable's settings change later, so the
 * hypertable's own settings say nothing about chunks already converted. A chunk in the columnstore with no recorded
 * layout fails too.
 */
export function judgeChunkLayouts(name: Hypertable, compressedChunks: readonly string[], rows: readonly ChunkColumnstoreRow[]): { ok: boolean; detail: string } {
    const want = COLUMNSTORE_LAYOUT[name];
    const mine = rows.filter((r) => r.hypertable === `telemetry.${name}`);
    const problems: string[] = [];
    for (const r of mine) {
        const segmentby = printedTerms(r.segmentby);
        const orderby = printedTerms(r.orderby);
        if (segmentby.join(',') !== want.segmentby.join(',') || orderby.join(',') !== want.orderby.join(',')) {
            problems.push(`${r.chunk} has segmentby ${segmentby.join(', ') || '(none)'}; orderby ${orderby.join(', ') || '(none)'}`);
        }
    }
    for (const chunk of compressedChunks) if (!mine.some((r) => r.chunk === chunk)) problems.push(`${chunk} is in the columnstore with no recorded layout`);
    const n = new Set([...mine.map((r) => r.chunk), ...compressedChunks]).size;
    return {
        ok: problems.length === 0,
        detail: problems.length > 0 ? problems.join('; ') : n === 0 ? 'no chunk in the columnstore yet' : `${n} chunk${n === 1 ? '' : 's'} in the columnstore, each on the expected layout`,
    };
}

export interface Check {
    readonly name: string;
    readonly ok: boolean;
    readonly detail: string;
}

export interface VerifyReport {
    readonly checks: Check[];
    readonly ok: boolean;
    readonly percentiles: PercentileMode | null;
    readonly databaseBytes: number;
    readonly telemetryBytes: number;
}

/** One telemetry identity index as pg_index describes it (the query in verifySchema). */
export interface IdentityIndexRow {
    readonly index: string;
    readonly tbl: string;
    readonly is_unique: boolean;
    readonly is_valid: boolean;
    readonly no_predicate: boolean;
    readonly no_expressions: boolean;
    readonly key_count: number | string;
    readonly att_count: number | string;
    readonly cols: string[] | null;
}

/**
 * Whether an identity index can deduplicate every row: unique, valid, on the right hypertable, not partial, no
 * expressions, no INCLUDE columns, and exactly the expected key columns in order.
 */
export function judgeIdentityIndex(name: Hypertable, got: IdentityIndexRow | undefined): { ok: boolean; detail: string } {
    if (!got) return { ok: false, detail: 'missing' };
    const want = IDENTITY_COLUMNS[name];
    const cols = got.cols ?? [];
    const ok =
        got.tbl === name &&
        got.is_unique &&
        got.is_valid &&
        got.no_predicate &&
        got.no_expressions &&
        Number(got.key_count) === want.length &&
        Number(got.att_count) === want.length &&
        cols.join(',') === want.join(',');
    const detail = `${got.is_unique ? 'unique' : 'NOT unique'}, ${got.is_valid ? 'valid' : 'NOT valid'}, ${got.no_predicate ? 'no predicate' : 'PARTIAL'}, ${
        got.no_expressions ? 'plain columns' : 'EXPRESSIONS'
    }, on ${got.tbl} (${cols.join(', ')})${Number(got.att_count) > Number(got.key_count) ? ' plus INCLUDE columns' : ''}`;
    return { ok, detail };
}

/** One column of a telemetry hypertable, as the live catalog describes it (the query in verifySchema). */
export interface ColumnRow {
    readonly tbl: string;
    readonly col: string;
    /** `format_type`: for example `text`, `bigint`, `timestamp with time zone`, `character varying(64)`. */
    readonly type: string;
    /** The definitions (`pg_get_constraintdef`) of the validated CHECK constraints that cover the column. */
    readonly checks: readonly string[];
}

const TSZ = 'timestamp with time zone';
/** Every column of every hypertable and its type, exactly as sql/01*.sql and sql/040 leave them. Nothing else. */
export const EXPECTED_COLUMNS: { readonly [T in Hypertable]: Readonly<Record<string, string>> } = {
    switch_events: {
        time: TSZ,
        session_id: 'text',
        ledger_id: 'bigint',
        command: 'text',
        outcome: 'text',
        code: 'text',
        resting: 'boolean',
        false_activation: 'boolean',
        heard_step_seq: 'bigint',
        option_rank: 'smallint',
        heard_in: 'text',
        latency_ms: 'integer',
        late_by_ms: 'integer',
        ingested_at: TSZ,
    },
    scan_steps: {
        time: TSZ,
        session_id: 'text',
        step_seq: 'bigint',
        question_id: 'bigint',
        phase: 'text',
        mode: 'text',
        answer_mode: 'text',
        cursor: 'smallint',
        option_count: 'smallint',
        pass: 'smallint',
        planned_ms: 'integer',
        outcome: 'text',
        pause_reason: 'text',
        ingested_at: TSZ,
    },
    picks: {
        time: TSZ,
        session_id: 'text',
        ledger_id: 'bigint',
        question_id: 'bigint',
        option_rank: 'smallint',
        pick_kind: 'text',
        time_to_pick_ms: 'integer',
        late_by_ms: 'integer',
        ingested_at: TSZ,
    },
    action_outcomes: { time: TSZ, session_id: 'text', kind: 'text', action_id: 'bigint', status: 'text', result: 'text', ingested_at: TSZ },
    rest_minutes: { time: TSZ, session_id: 'text', rest_mask: 'bigint', idle_ms: 'integer', ingested_at: TSZ },
};
/** Columns that must never be stored, under any type: the station chooses gesture ids (sql/040). */
export const FORBIDDEN_COLUMNS: ReadonlySet<string> = new Set(['gesture_id']);

const SESSION_SHAPE = "CHECK ((session_id ~ '^(test-[A-Za-z0-9_-]{1,64}|[a-z0-9]+(-[a-z0-9]+)*:[0-9]{1,20})$'::text))";
/** A word-list CHECK as PostgreSQL deparses `col IN (...)`, optionally `col IS NULL OR col IN (...)`. */
function wordList(col: string, words: readonly string[], nullable = false): string {
    const any = `${col} = ANY (ARRAY[${words.map((w) => `'${w}'::text`).join(', ')}])`;
    return nullable ? `CHECK (((${col} IS NULL) OR (${any})))` : `CHECK ((${any}))`;
}

/**
 * The exact CHECK that holds each text column, as PostgreSQL 18.6 deparses the constraints of sql/01*.sql
 * (pg_get_constraintdef). Whole definitions are compared, so a loosened pattern, a LIKE '%' or an added OR branch
 * cannot pass; a PostgreSQL upgrade that words them differently makes verify fail, never pass.
 */
export const EXPECTED_TEXT_CHECKS: { readonly [T in Hypertable]: Readonly<Record<string, string>> } = {
    switch_events: {
        session_id: SESSION_SHAPE,
        command: wordList('command', ['YES', 'NO', 'CONFIRM', 'STOP', 'HEADSET_OFF']),
        outcome: wordList('outcome', ['accepted', 'ignored']),
        code: "CHECK ((code ~ '^[a-z][a-z0-9_]{0,39}$'::text))",
        heard_in: wordList('heard_in', ['reading', 'window'], true),
    },
    scan_steps: {
        session_id: SESSION_SHAPE,
        phase: wordList('phase', ['idle', 'preparing', 'reading', 'window', 'veto', 'paused', 'other']),
        mode: wordList('mode', ['answer', 'menu', 'other']),
        answer_mode: wordList('answer_mode', ['pick', 'yes_no', 'other']),
        outcome: wordList('outcome', ['picked', 'none', 'no_pick', 'stopped', 'cancelled', 'other'], true),
        pause_reason: wordList('pause_reason', ['headset_lost', 'headset_off', 'stop', 'idle', 'operator', 'other'], true),
    },
    picks: {
        session_id: SESSION_SHAPE,
        pick_kind: wordList('pick_kind', ['reply', 'errand', 'call', 'menu', 'yes', 'no', 'other']),
    },
    action_outcomes: {
        session_id: SESSION_SHAPE,
        kind: wordList('kind', ['errand', 'call']),
        status: wordList('status', [
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
            'prepared',
            'dialing',
            'ringing',
            'connected',
            'ended',
            'other',
        ]),
        result: wordList('result', ['answered', 'no_answer', 'busy', 'voicemail', 'cancelled', 'failed', 'refused', 'unknown', 'other'], true),
    },
    rest_minutes: { session_id: SESSION_SHAPE },
};

/**
 * Whether a hypertable can hold only content-free values: exactly the expected columns with their types (so no
 * column was added, and the check can never pass by finding nothing), no forbidden column, and every text column
 * held by a validated CHECK whose whole definition is the expected one. (Any further CHECK can only restrict more.)
 */
export function judgeColumns(name: Hypertable, rows: readonly ColumnRow[]): { ok: boolean; detail: string } {
    const want = EXPECTED_COLUMNS[name];
    const checks = EXPECTED_TEXT_CHECKS[name];
    const mine = rows.filter((r) => r.tbl === name);
    const problems: string[] = [];
    for (const [col, type] of Object.entries(want)) {
        const got = mine.find((r) => r.col === col);
        if (!got) problems.push(`${col} is missing`);
        else if (got.type !== type) problems.push(`${col} has type ${got.type}, not ${type}`);
    }
    for (const r of mine) {
        if (FORBIDDEN_COLUMNS.has(r.col)) problems.push(`${r.col} is stored (run npm run migrate)`);
        else if (!Object.hasOwn(want, r.col)) problems.push(`unexpected column ${r.col} (${r.type})`);
        if (r.type === 'text') {
            const expected = Object.hasOwn(checks, r.col) ? checks[r.col] : undefined;
            if (expected === undefined || !r.checks.includes(expected)) problems.push(`${r.col} is not held by its expected CHECK`);
        }
    }
    const text = mine.filter((r) => r.type === 'text').map((r) => r.col);
    return {
        ok: problems.length === 0,
        detail: problems.length > 0 ? problems.join('; ') : `exactly the ${mine.length} expected columns; text columns ${text.join(', ')}, each held by its expected CHECK`,
    };
}

export async function verifySchema(pool: pg.Pool): Promise<VerifyReport> {
    const checks: Check[] = [];
    const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

    const hypertables = new Map<string, { dims: number; columnstore: boolean }>();
    for (const row of (
        await pool.query(
            "SELECT hypertable_name, num_dimensions, compression_enabled FROM timescaledb_information.hypertables WHERE hypertable_schema = 'telemetry'",
        )
    ).rows as Array<{ hypertable_name: string; num_dimensions: number; compression_enabled: boolean }>) {
        hypertables.set(row.hypertable_name, { dims: row.num_dimensions, columnstore: row.compression_enabled });
    }
    for (const name of HYPERTABLES) {
        add(`hypertable telemetry.${name}`, hypertables.has(name), hypertables.has(name) ? 'present' : 'missing');
    }

    const timeColumns = new Map<string, string>();
    for (const row of (
        await pool.query(
            "SELECT hypertable_name, column_name, time_interval::text AS chunk FROM timescaledb_information.dimensions WHERE hypertable_schema = 'telemetry'",
        )
    ).rows as Array<{ hypertable_name: string; column_name: string; chunk: string }>) {
        timeColumns.set(row.hypertable_name, `${row.column_name} by ${row.chunk}`);
    }
    for (const name of HYPERTABLES) {
        const dim = timeColumns.get(name);
        add(`partitioning telemetry.${name}`, dim === 'time by 1 day', dim ?? 'none');
    }

    const caRows = (
        await pool.query(
            "SELECT view_name, materialized_only, compression_enabled, materialization_hypertable_name AS mat FROM timescaledb_information.continuous_aggregates WHERE view_schema = 'telemetry'",
        )
    ).rows as Array<{ view_name: string; materialized_only: boolean; compression_enabled: boolean; mat: string }>;
    const aggregates = new Map(caRows.map((r) => [r.view_name, r]));
    for (const name of AGGREGATES) {
        const ca = aggregates.get(name);
        add(`continuous aggregate telemetry.${name}`, !!ca, ca ? 'present' : 'missing');
        add(`real-time telemetry.${name}`, !!ca && ca.materialized_only === false, ca ? `materialized_only = ${ca.materialized_only}` : 'missing');
        // sql/050 keeps the aggregates in the rowstore (its header says why); a columnstore turned on later fails here.
        add(`rowstore telemetry.${name}`, !!ca && ca.compression_enabled === false, ca ? `columnstore ${ca.compression_enabled ? 'ON' : 'off'}` : 'missing');
    }

    const jobs = (
        await pool.query(
            `SELECT job_id, proc_name, hypertable_schema, hypertable_name, config, schedule_interval::text AS every, scheduled
             FROM timescaledb_information.jobs
             WHERE proc_name IN ('policy_retention', 'policy_refresh_continuous_aggregate', 'policy_compression')`,
        )
    ).rows as JobRow[];
    // A policy that exists but fails is no policy: read the job's own run history.
    const jobRuns = async (jobId: number): Promise<{ ok: boolean; detail: string }> => {
        const stat = (
            await pool.query(
                `SELECT s.total_runs, s.total_failures, s.last_run_status, s.last_run_started_at::text AS last_run
                 FROM timescaledb_information.job_stats s WHERE s.job_id = $1`,
                [jobId],
            )
        ).rows[0] as { total_runs: string | number; total_failures: string | number; last_run_status: string | null; last_run: string | null } | undefined;
        const runs = Number(stat?.total_runs ?? 0);
        return {
            ok: runs === 0 || stat?.last_run_status === 'Success',
            detail: runs === 0 ? 'scheduled, not run yet' : `${runs} runs, ${Number(stat?.total_failures ?? 0)} failures, last ${stat?.last_run_status ?? 'unknown'} at ${stat?.last_run ?? 'unknown'}`,
        };
    };
    const retentionOf = (schema: string, table: string) =>
        jobs.find((j) => j.proc_name === 'policy_retention' && j.hypertable_schema === schema && j.hypertable_name === table);
    for (const name of HYPERTABLES) {
        const job = retentionOf('telemetry', name);
        const dropAfter = job ? String(job.config.drop_after ?? '') : '';
        add(`retention telemetry.${name}`, !!job && job.scheduled && dropAfter === RAW_RETENTION, job ? `drop_after ${dropAfter}, scheduled ${job.scheduled}` : 'missing');
    }
    // TimescaleDB 2.31 lists an aggregate's jobs under the view's own name; older releases used the materialization
    // hypertable. Accept either, so the check reads the real job rather than guessing.
    const isAggregateJob = (j: (typeof jobs)[number], name: string, mat: string) =>
        (j.hypertable_schema === 'telemetry' && j.hypertable_name === name) || (j.hypertable_schema === '_timescaledb_internal' && j.hypertable_name === mat);
    /** Every refresh policy's start_offset that was found, for the columnstore invariant below. */
    const refreshStarts: string[] = [];
    for (const name of AGGREGATES) {
        const ca = aggregates.get(name);
        const retention = ca ? jobs.find((j) => j.proc_name === 'policy_retention' && isAggregateJob(j, name, ca.mat)) : undefined;
        const dropAfter = retention ? String(retention.config.drop_after ?? '') : '';
        add(`retention telemetry.${name}`, !!retention && retention.scheduled && dropAfter === AGGREGATE_RETENTION, retention ? `drop_after ${dropAfter}, scheduled ${retention.scheduled}` : 'missing');
        const refresh = ca
            ? jobs.find((j) => j.proc_name === 'policy_refresh_continuous_aggregate' && isAggregateJob(j, name, ca.mat))
            : undefined;
        const start = refresh ? String(refresh.config.start_offset ?? '') : '';
        const end = refresh ? String(refresh.config.end_offset ?? '') : '';
        add(
            `refresh policy telemetry.${name}`,
            !!refresh && refresh.scheduled,
            refresh ? `start_offset ${start}, end_offset ${end}, every ${refresh.every}` : 'missing',
        );
        if (refresh) {
            refreshStarts.push(start);
            // The retention invariant: raw rows must outlive the window the refresh recomputes.
            const safe = await scalar<boolean>(pool, 'SELECT $1::interval > $2::interval', [RAW_RETENTION, start]);
            add(`raw retention outlives telemetry.${name} refresh`, safe === true, `${RAW_RETENTION} > ${start}`);
            const runs = await jobRuns(refresh.job_id);
            add(`refresh job runs telemetry.${name}`, runs.ok, runs.detail);
        }
    }

    // The columnstore (sql/050), read from the live catalog: on, with exactly the expected segmentby and orderby (so
    // every idempotency column stays a segmentby or orderby column), every chunk already in the columnstore converted
    // with that layout, a policy scheduled every COLUMNSTORE_SCHEDULE at exactly COLUMNSTORE_AFTER, the invariant that
    // the policy starts at or past every refresh window and before raw retention, and the policy's run history (not
    // overdue). A dropped, altered, late or failing policy, or a changed layout, fails here.
    const settings = (
        await pool.query(
            `SELECT hypertable_name, attname, segmentby_column_index, orderby_column_index, orderby_asc, orderby_nullsfirst
             FROM timescaledb_information.compression_settings WHERE hypertable_schema = 'telemetry'`,
        )
    ).rows as ColumnstoreSettingRow[];
    const chunkLayouts = (
        await pool.query(
            `SELECT hypertable::text AS hypertable, chunk::text AS chunk, segmentby, orderby
             FROM timescaledb_information.chunk_columnstore_settings WHERE hypertable::text LIKE 'telemetry.%'`,
        )
    ).rows as ChunkColumnstoreRow[];
    const compressedChunks = (
        await pool.query(
            `SELECT hypertable_name, chunk_schema || '.' || chunk_name AS chunk
             FROM timescaledb_information.chunks WHERE hypertable_schema = 'telemetry' AND is_compressed`,
        )
    ).rows as Array<{ hypertable_name: string; chunk: string }>;
    const columnstoreRuns = async (jobId: number): Promise<{ ok: boolean; detail: string }> => {
        const r = (
            await pool.query(
                `SELECT coalesce(s.total_runs, 0)::int AS runs, coalesce(s.total_failures, 0)::int AS failures, s.last_run_status,
                        extract(epoch FROM now() - s.last_successful_finish)::float8 AS success_age,
                        (SELECT extract(epoch FROM now() - m.applied_at)::float8 FROM telemetry.migrations m WHERE m.id = $2) AS policy_age
                 FROM (SELECT 1) one LEFT JOIN timescaledb_information.job_stats s ON s.job_id = $1`,
                [jobId, COLUMNSTORE_MIGRATION],
            )
        ).rows[0] as { runs: number; failures: number; last_run_status: string | null; success_age: number | null; policy_age: number | null };
        return judgeColumnstoreRuns({
            runs: r.runs,
            failures: r.failures,
            lastStatus: r.last_run_status,
            lastSuccessAgeSeconds: r.success_age,
            policyAgeSeconds: r.policy_age,
        });
    };
    for (const name of HYPERTABLES) {
        const verdict = judgeColumnstore(name, hypertables.get(name)?.columnstore, settings);
        add(`columnstore telemetry.${name}`, verdict.ok, verdict.detail);
        const chunks = judgeChunkLayouts(
            name,
            compressedChunks.filter((c) => c.hypertable_name === name).map((c) => c.chunk),
            chunkLayouts,
        );
        add(`columnstore chunks telemetry.${name}`, chunks.ok, chunks.detail);
        const policy = judgeColumnstorePolicy(name, jobs);
        add(`columnstore policy telemetry.${name}`, policy.ok, policy.detail);
        const after = policy.job ? String(policy.job.config.compress_after ?? '') : '';
        const ordered =
            after !== '' && refreshStarts.length === AGGREGATES.length
                ? await scalar<boolean>(pool, 'SELECT $1::interval >= ALL ($2::interval[]) AND $1::interval < $3::interval', [after, refreshStarts, RAW_RETENTION])
                : false;
        add(
            `columnstore after the refresh windows, before raw retention: telemetry.${name}`,
            ordered === true,
            after === '' ? 'no columnstore policy' : `${refreshStarts.join(', ') || 'no refresh policy'} <= ${after} < ${RAW_RETENTION}`,
        );
        if (policy.job) {
            const runs = await columnstoreRuns(policy.job.job_id);
            add(`columnstore job runs telemetry.${name}`, runs.ok, runs.detail);
        } else {
            add(`columnstore job runs telemetry.${name}`, false, 'no columnstore policy');
        }
    }

    // A name is not an index: read pg_index for uniqueness, validity, the owning table and the exact key columns, and
    // refuse a partial index (a predicate), an expression index or extra INCLUDE columns. ON CONFLICT DO NOTHING
    // silently stops deduplicating on a non-unique or partial index of the same name, and the rest_minutes upsert
    // names its conflict target, which only a plain unique index on exactly (session_id, time) can satisfy.
    // indpred and indexprs are pg_node_tree, which has no equality operator, so only their IS NULL tests are grouped.
    const indexRows = (
        await pool.query(
            `SELECT c.relname AS index, t.relname AS tbl, i.indisunique AS is_unique, i.indisvalid AS is_valid,
                    i.indpred IS NULL AS no_predicate, i.indexprs IS NULL AS no_expressions,
                    i.indnkeyatts AS key_count, i.indnatts AS att_count,
                    array_agg(coalesce(a.attname::text, '(expression)') ORDER BY k.ord) FILTER (WHERE k.ord <= i.indnkeyatts) AS cols
             FROM pg_index i
             JOIN pg_class c ON c.oid = i.indexrelid
             JOIN pg_class t ON t.oid = i.indrelid
             JOIN pg_namespace n ON n.oid = t.relnamespace
             CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
             LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum AND k.attnum > 0
             WHERE n.nspname = 'telemetry' AND c.relname = ANY($1::text[])
             GROUP BY c.relname, t.relname, i.indisunique, i.indisvalid, (i.indpred IS NULL), (i.indexprs IS NULL), i.indnkeyatts, i.indnatts`,
            [HYPERTABLES.map((h) => `${h}_identity`)],
        )
    ).rows as IdentityIndexRow[];
    for (const name of HYPERTABLES) {
        const verdict = judgeIdentityIndex(name, indexRows.find((r) => r.index === `${name}_identity`));
        add(`idempotency index telemetry.${name}_identity`, verdict.ok, verdict.detail);
    }

    // Content-free storage, read from the live catalog over every column (of any type) of every hypertable: exactly
    // the expected columns and types, no gesture id (sql/040), and each text column held by a validated CHECK to a
    // pattern or a word list (judgeColumns reads the constraint definitions).
    const columns = (
        await pool.query(
            `SELECT c.relname AS tbl, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS type,
                    coalesce(array_agg(pg_get_constraintdef(k.oid)) FILTER (WHERE k.oid IS NOT NULL), '{}') AS checks
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
             LEFT JOIN pg_constraint k ON k.conrelid = c.oid AND k.contype = 'c' AND k.convalidated AND a.attnum = ANY (k.conkey)
             WHERE n.nspname = 'telemetry' AND c.relname = ANY($1::text[])
             GROUP BY c.relname, a.attname, a.attnum, a.atttypid, a.atttypmod
             ORDER BY c.relname, a.attnum`,
            [[...HYPERTABLES]],
        )
    ).rows as ColumnRow[];
    for (const name of HYPERTABLES) {
        const verdict = judgeColumns(name, columns);
        add(`columns telemetry.${name}`, verdict.ok, verdict.detail);
    }

    const variant = await scalar<string>(pool, "SELECT variant FROM telemetry.migrations WHERE id LIKE '022_%'").catch(() => null);
    const percentiles = variant === 'toolkit' || variant === 'exact' ? variant : null;
    add('time-to-pick percentiles', percentiles !== null, percentiles ? `${percentiles} (sql/022_picks_1m.${percentiles}.sql)` : 'not migrated');

    const databaseBytes = Number((await scalar<string>(pool, 'SELECT pg_database_size(current_database())::text')) ?? 0);
    let telemetryBytes = 0;
    for (const name of HYPERTABLES) {
        if (!hypertables.has(name)) continue;
        telemetryBytes += Number((await scalar<string>(pool, 'SELECT hypertable_size($1::regclass)::text', [`telemetry.${name}`])) ?? 0);
    }
    const limit = 750 * 1024 * 1024;
    add('storage under the free limit', databaseBytes < limit / 2, `${(databaseBytes / 1024 / 1024).toFixed(1)} MB of 750 MB used`);

    return { checks, ok: checks.every((c) => c.ok), percentiles, databaseBytes, telemetryBytes };
}
