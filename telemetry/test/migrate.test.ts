import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { readFileSync } from 'node:fs';

import {
    choosePlan,
    EXPECTED_COLUMNS,
    EXPECTED_TEXT_CHECKS,
    FORBIDDEN_COLUMNS,
    HYPERTABLES,
    IDENTITY_COLUMNS,
    judgeColumns,
    judgeIdentityIndex,
    readMigrations,
    splitStatements,
    type ColumnRow,
    type IdentityIndexRow,
} from '../src/migrate.js';

describe('the content-free column check', () => {
    // Catalog-shaped rows for switch_events as the live service has them.
    const good: ColumnRow[] = Object.entries(EXPECTED_COLUMNS.switch_events).map(([col, type]) => ({
        tbl: 'switch_events',
        col,
        type,
        checks: type === 'text' ? [EXPECTED_TEXT_CHECKS.switch_events[col]!] : [],
    }));
    const without = (name: string) => good.filter((r) => r.col !== name);
    const replace = (name: string, patch: Partial<ColumnRow>) => good.map((r) => (r.col === name ? { ...r, ...patch } : r));

    test('exactly the expected columns, each text column held by its expected CHECK: passes', () => {
        assert.equal(judgeColumns('switch_events', good).ok, true);
        // The wording pg_get_constraintdef printed on the live service (PostgreSQL 18.6), copied verbatim.
        assert.equal(EXPECTED_TEXT_CHECKS.switch_events.heard_in, "CHECK (((heard_in IS NULL) OR (heard_in = ANY (ARRAY['reading'::text, 'window'::text]))))");
        assert.equal(EXPECTED_TEXT_CHECKS.switch_events.command, "CHECK ((command = ANY (ARRAY['YES'::text, 'NO'::text, 'CONFIRM'::text, 'STOP'::text, 'HEADSET_OFF'::text])))");
        assert.equal(EXPECTED_TEXT_CHECKS.picks.session_id, "CHECK ((session_id ~ '^(test-[A-Za-z0-9_-]{1,64}|[a-z0-9]+(-[a-z0-9]+)*:[0-9]{1,20})$'::text))");
        // A further CHECK beside the expected one can only restrict more, so it is allowed.
        assert.equal(judgeColumns('switch_events', replace('code', { checks: ['CHECK ((length(code) < 10))', EXPECTED_TEXT_CHECKS.switch_events.code!] })).ok, true);
    });

    test('an extra column, a loosened or wrong CHECK, a missing or retyped column, a gesture id or nothing found: fails', () => {
        const bad: Array<[string, ColumnRow[]]> = [
            ['an extra text column whose CHECK only tests NULL', [...good, { tbl: 'switch_events', col: 'operator_notes', type: 'text', checks: ['CHECK ((operator_notes IS NOT NULL))'] }]],
            ['an extra column of a free-text type', [...good, { tbl: 'switch_events', col: 'extra', type: 'jsonb', checks: [] }]],
            ['a text column whose only CHECK tests NULL', replace('command', { checks: ['CHECK ((command IS NOT NULL))'] })],
            ['a LIKE that matches anything', replace('code', { checks: ["CHECK ((code ~~ '%'::text))"] })],
            ['a pattern that matches anything', replace('code', { checks: ["CHECK ((code ~ '.*'::text))"] })],
            ['the right pattern with an OR that lets anything through', replace('code', { checks: ["CHECK (((code ~ '^[a-z][a-z0-9_]{0,39}$'::text) OR (code IS NOT NULL)))"] })],
            ['a word list with a word added', replace('outcome', { checks: ["CHECK ((outcome = ANY (ARRAY['accepted'::text, 'ignored'::text, 'anything at all'::text])))"] })],
            ['a text column with no validated CHECK', replace('code', { checks: [] })],
            ['a CHECK that holds another column', replace('outcome', { checks: [EXPECTED_TEXT_CHECKS.switch_events.code!] })],
            ['a missing column', without('heard_in')],
            ['a retyped column', replace('latency_ms', { type: 'bigint' })],
            ['gesture_id as varchar', [...good, { tbl: 'switch_events', col: 'gesture_id', type: 'character varying(64)', checks: [] }]],
            ['no columns found', []],
            ['another table only', good.map((r) => ({ ...r, tbl: 'picks' }))],
        ];
        for (const [name, rows] of bad) assert.equal(judgeColumns('switch_events', rows).ok, false, name);
        assert.match(judgeColumns('switch_events', [...good, { tbl: 'switch_events', col: 'gesture_id', type: 'text', checks: [] }]).detail, /gesture_id is stored/);
    });

    test('the expected columns are exactly what the sql files create, less the dropped gesture id', () => {
        const sqlType: Record<string, string> = { timestamptz: 'timestamp with time zone', text: 'text', bigint: 'bigint', integer: 'integer', smallint: 'smallint', boolean: 'boolean' };
        const file: Record<string, string> = { switch_events: '010', scan_steps: '011', picks: '012', action_outcomes: '013', rest_minutes: '014' };
        for (const t of HYPERTABLES) {
            const sql = readFileSync(new URL(`../sql/${file[t]}_${t}.sql`, import.meta.url), 'utf8');
            const created = Object.fromEntries(
                [...sql.matchAll(/^\s+([a-z_]+) (timestamptz|text|bigint|integer|smallint|boolean)\b/gm)].filter((m) => !FORBIDDEN_COLUMNS.has(m[1]!)).map((m) => [m[1]!, sqlType[m[2]!]!]),
            );
            assert.deepEqual(created, { ...EXPECTED_COLUMNS[t] }, t);
            // Every text column has an expected CHECK, and each expected CHECK's words and pattern come from the file.
            const textCols = Object.entries(EXPECTED_COLUMNS[t]).filter(([, type]) => type === 'text').map(([c]) => c);
            assert.deepEqual(Object.keys(EXPECTED_TEXT_CHECKS[t]).sort(), textCols.sort(), t);
            for (const def of Object.values(EXPECTED_TEXT_CHECKS[t])) {
                for (const m of def.matchAll(/'([^']*)'::text/g)) assert.ok(sql.includes(`'${m[1]}'`), `${t}: ${m[1]} is not in the sql file`);
            }
        }
    });
});

describe('the identity index check', () => {
    const good: IdentityIndexRow = {
        index: 'rest_minutes_identity',
        tbl: 'rest_minutes',
        is_unique: true,
        is_valid: true,
        no_predicate: true,
        no_expressions: true,
        key_count: 2,
        att_count: 2,
        cols: ['session_id', 'time'],
    };

    test('a plain unique index on exactly the identity columns passes', () => {
        assert.equal(judgeIdentityIndex('rest_minutes', good).ok, true);
    });

    test('a partial, expression, INCLUDE, non-unique, invalid, misplaced or missing index fails', () => {
        const bad: Array<[string, IdentityIndexRow | undefined]> = [
            ['partial', { ...good, no_predicate: false }],
            ['expression', { ...good, no_expressions: false, cols: ['session_id', '(expression)'] }],
            ['INCLUDE columns', { ...good, att_count: 3 }],
            ['not unique', { ...good, is_unique: false }],
            ['not valid', { ...good, is_valid: false }],
            ['other table', { ...good, tbl: 'picks' }],
            ['wrong columns', { ...good, cols: ['time', 'session_id'] }],
            ['extra key column', { ...good, key_count: 3, att_count: 3, cols: ['session_id', 'time', 'idle_ms'] }],
            ['missing', undefined],
        ];
        for (const [name, row] of bad) assert.equal(judgeIdentityIndex('rest_minutes', row).ok, false, name);
        assert.match(judgeIdentityIndex('rest_minutes', { ...good, no_predicate: false }).detail, /PARTIAL/);
    });
});

describe('the sql files', () => {
    const files = readMigrations();

    test('split into the expected statements, one call each', () => {
        const counts = Object.fromEntries(files.map((f) => [f.file, f.statements.length]));
        assert.deepEqual(counts, {
            '001_schema.sql': 1,
            '010_switch_events.sql': 3,
            '011_scan_steps.sql': 3,
            '012_picks.sql': 3,
            '013_action_outcomes.sql': 3,
            '014_rest_minutes.sql': 3,
            '020_switch_1m.sql': 2,
            '021_idle_1m.sql': 2,
            '022_picks_1m.exact.sql': 2,
            '022_picks_1m.toolkit.sql': 3,
            '030_retention.sql': 8,
            '040_switch_events_no_gesture_id.sql': 1,
        });
        for (const f of files) for (const s of f.statements) assert.ok(!s.includes(';'), `${f.file}: a statement still holds a semicolon`);
    });

    test('the splitter drops comment lines and keeps multi-line statements whole', () => {
        assert.deepEqual(splitStatements('-- a; comment;\nSELECT 1;\nSELECT\n  2 ;\n\n'), ['SELECT 1', 'SELECT\n  2']);
    });

    test('the plan takes one variant per migration', () => {
        assert.deepEqual(
            choosePlan(files, 'toolkit').map((f) => f.file),
            ['001_schema.sql', '010_switch_events.sql', '011_scan_steps.sql', '012_picks.sql', '013_action_outcomes.sql', '014_rest_minutes.sql', '020_switch_1m.sql', '021_idle_1m.sql', '022_picks_1m.toolkit.sql', '030_retention.sql', '040_switch_events_no_gesture_id.sql'],
        );
        assert.equal(choosePlan(files, 'exact').find((f) => f.id === '022_picks_1m')?.variant, 'exact');
    });

    test('every aggregate is real-time and refreshed inside the raw retention window', () => {
        const sql = files.map((f) => f.statements.join('\n')).join('\n');
        const views = [...sql.matchAll(/CREATE MATERIALIZED VIEW IF NOT EXISTS (telemetry\.\w+)\s+WITH \(([^)]*)\)/g)];
        assert.equal(new Set(views.map((v) => v[1])).size, 3);
        for (const v of views) assert.match(v[2]!, /timescaledb\.materialized_only = false/, v[1]);
        const starts = [...sql.matchAll(/start_offset => INTERVAL '(\d+) days'/g)].map((m) => Number(m[1]));
        const rawDrops = [...sql.matchAll(/add_retention_policy\('telemetry\.(switch_events|scan_steps|picks|action_outcomes|rest_minutes)', drop_after => INTERVAL '(\d+) days'/g)].map((m) => Number(m[2]));
        assert.equal(rawDrops.length, 5);
        for (const d of rawDrops) for (const s of starts) assert.ok(d > s, `raw retention ${d} days must exceed refresh start_offset ${s} days`);
    });

    test('every hypertable has the idempotency index the verifier expects, ending with time', () => {
        const sql = files.map((f) => f.statements.join('\n')).join('\n');
        for (const t of HYPERTABLES) {
            assert.match(sql, new RegExp(`create_hypertable\\('telemetry\\.${t}', by_range\\('time', INTERVAL '1 day'\\)`), t);
            const m = new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS ${t}_identity ON telemetry\\.${t} \\(([^)]*)\\)`).exec(sql);
            assert.ok(m, `${t}_identity`);
            assert.deepEqual(m![1]!.split(',').map((c) => c.trim()), [...IDENTITY_COLUMNS[t]], t);
            assert.equal(IDENTITY_COLUMNS[t].at(-1), 'time');
        }
    });
});
