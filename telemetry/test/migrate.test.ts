import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { readFileSync } from 'node:fs';

import {
    choosePlan,
    COLUMNSTORE_AFTER,
    COLUMNSTORE_LAYOUT,
    EXPECTED_COLUMNS,
    EXPECTED_TEXT_CHECKS,
    FORBIDDEN_COLUMNS,
    HYPERTABLES,
    IDENTITY_COLUMNS,
    COLUMNSTORE_BOOTSTRAP_SECONDS,
    COLUMNSTORE_OVERDUE_GRACE_SECONDS,
    COLUMNSTORE_SCHEDULE_SECONDS,
    judgeChunkLayouts,
    judgeColumns,
    judgeColumnstore,
    judgeColumnstorePolicy,
    judgeColumnstoreRuns,
    judgeIdentityIndex,
    RAW_RETENTION,
    readMigrations,
    splitStatements,
    type ChunkColumnstoreRow,
    type ColumnRow,
    type ColumnstoreRunStat,
    type ColumnstoreSettingRow,
    type Hypertable,
    type IdentityIndexRow,
    type JobRow,
} from '../src/migrate.js';
import { INPUT_KINDS } from '../src/types.js';

/** Catalog-shaped compression_settings rows for a layout, as the live service printed them for sql/050. */
function settingRows(name: string, segmentby: readonly string[], orderby: ReadonlyArray<{ col: string; asc: boolean; nullsFirst: boolean }>): ColumnstoreSettingRow[] {
    return [
        ...segmentby.map((attname, i) => ({ hypertable_name: name, attname, segmentby_column_index: i + 1, orderby_column_index: null, orderby_asc: null, orderby_nullsfirst: null })),
        ...orderby.map((o, i) => ({ hypertable_name: name, attname: o.col, segmentby_column_index: null, orderby_column_index: i + 1, orderby_asc: o.asc, orderby_nullsfirst: o.nullsFirst })),
    ];
}

/** A layout term (`col` or `col DESC`) with PostgreSQL's default NULLS placement. */
const term = (t: string) => (t.endsWith(' DESC') ? { col: t.slice(0, -5), asc: false, nullsFirst: true } : { col: t, asc: true, nullsFirst: false });

describe('the columnstore check', () => {
    const layoutRows = (name: Hypertable) => settingRows(name, COLUMNSTORE_LAYOUT[name].segmentby, COLUMNSTORE_LAYOUT[name].orderby.map(term));
    const good = layoutRows('switch_events');

    test('on, with exactly the expected segmentby and orderby: passes, for every hypertable', () => {
        const verdict = judgeColumnstore('switch_events', true, good);
        assert.equal(verdict.ok, true);
        assert.equal(verdict.detail, 'segmentby session_id; orderby time DESC, ledger_id');
        for (const t of HYPERTABLES) assert.equal(judgeColumnstore(t, true, layoutRows(t)).ok, true, t);
        // Rows of other hypertables are ignored, not mistaken for this one's.
        assert.equal(judgeColumnstore('switch_events', true, [...good, ...layoutRows('rest_minutes')]).ok, true);
    });

    test('off, missing, no settings, or any change to segmentby, orderby, direction or NULLS: fails', () => {
        const desc = { col: 'time', asc: false, nullsFirst: true };
        const ledger = { col: 'ledger_id', asc: true, nullsFirst: false };
        const bad: Array<[string, boolean | undefined, ColumnstoreSettingRow[]]> = [
            ['columnstore not enabled', false, good],
            ['hypertable missing', undefined, good],
            ['no settings at all', true, []],
            ['another table only', true, layoutRows('rest_minutes')],
            ['no segmentby', true, settingRows('switch_events', [], [desc, ledger])],
            ['an extra segmentby column', true, settingRows('switch_events', ['session_id', 'command'], [desc, ledger])],
            ['segmented by another column', true, settingRows('switch_events', ['command'], [desc, ledger])],
            ['time ascending', true, settingRows('switch_events', ['session_id'], [{ col: 'time', asc: true, nullsFirst: false }, ledger])],
            ['ledger_id dropped from the orderby', true, settingRows('switch_events', ['session_id'], [desc])],
            ['orderby reordered', true, settingRows('switch_events', ['session_id'], [ledger, desc])],
            ['ledger_id descending', true, settingRows('switch_events', ['session_id'], [desc, { col: 'ledger_id', asc: false, nullsFirst: true }])],
            ['time DESC NULLS LAST', true, settingRows('switch_events', ['session_id'], [{ col: 'time', asc: false, nullsFirst: false }, ledger])],
        ];
        for (const [name, enabled, rows] of bad) assert.equal(judgeColumnstore('switch_events', enabled, rows).ok, false, name);
        assert.match(judgeColumnstore('switch_events', false, good).detail, /not enabled/);
        assert.match(judgeColumnstore('switch_events', true, settingRows('switch_events', ['session_id'], [{ col: 'time', asc: false, nullsFirst: false }])).detail, /time DESC NULLS LAST/);
    });

    test('every idempotency column is a segmentby or orderby column, and time leads the orderby, newest first', () => {
        for (const t of HYPERTABLES) {
            const { segmentby, orderby } = COLUMNSTORE_LAYOUT[t];
            const covered = new Set([...segmentby, ...orderby.map((o) => term(o).col)]);
            for (const col of IDENTITY_COLUMNS[t]) assert.ok(covered.has(col), `${t}.${col} is neither segmentby nor orderby`);
            assert.equal(orderby[0], 'time DESC', t);
            for (const col of segmentby) assert.ok(!orderby.some((o) => term(o).col === col), `${t}.${col} is both segmentby and orderby`);
        }
    });
});

describe('the columnstore policy check', () => {
    const job = (patch: Partial<JobRow> = {}): JobRow => ({
        job_id: 1034,
        proc_name: 'policy_compression',
        hypertable_schema: 'telemetry',
        hypertable_name: 'switch_events',
        config: { hypertable_id: 17, compress_after: '3 days' },
        every: '12:00:00',
        scheduled: true,
        ...patch,
    });

    test('a scheduled policy converting at exactly COLUMNSTORE_AFTER passes', () => {
        const verdict = judgeColumnstorePolicy('switch_events', [job()]);
        assert.equal(verdict.ok, true);
        assert.equal(verdict.detail, 'after 3 days, every 12:00:00, scheduled true');
        assert.equal(verdict.job?.job_id, 1034);
    });

    test('a dropped, altered, paused, misplaced or created_before policy fails', () => {
        const bad: Array<[string, JobRow[]]> = [
            ['dropped', []],
            ['after altered to 2 days', [job({ config: { hypertable_id: 17, compress_after: '2 days' } })]],
            ['after altered to 7 days', [job({ config: { hypertable_id: 17, compress_after: '7 days' } })]],
            ['paused', [job({ scheduled: false })]],
            ['on another hypertable', [job({ hypertable_name: 'picks' })]],
            ['a retention job of the same table', [job({ proc_name: 'policy_retention', config: { drop_after: '3 days' } })]],
            ['created_before instead of after', [job({ config: { hypertable_id: 17, created_before: '3 days' } })]],
            ['schedule altered to 30 days', [job({ every: '30 days' })]],
            ['schedule altered to 1 day', [job({ every: '1 day' })]],
            ['schedule altered to 1 hour', [job({ every: '01:00:00' })]],
        ];
        for (const [name, jobs] of bad) assert.equal(judgeColumnstorePolicy('switch_events', jobs).ok, false, name);
        assert.equal(judgeColumnstorePolicy('switch_events', []).detail, 'missing');
    });
});

describe('the columnstore run check', () => {
    const limit = COLUMNSTORE_SCHEDULE_SECONDS + COLUMNSTORE_OVERDUE_GRACE_SECONDS;
    const ran = (patch: Partial<ColumnstoreRunStat> = {}): ColumnstoreRunStat => ({
        runs: 1,
        failures: 0,
        lastStatus: 'Success',
        lastSuccessAgeSeconds: 1_080,
        policyAgeSeconds: 1_085,
        ...patch,
    });

    test('a last success within the schedule plus the grace passes, and so does a policy inside its bootstrap allowance', () => {
        assert.equal(judgeColumnstoreRuns(ran()).ok, true);
        assert.equal(judgeColumnstoreRuns(ran({ lastSuccessAgeSeconds: limit, policyAgeSeconds: 10 * 86_400 })).ok, true);
        assert.match(judgeColumnstoreRuns(ran()).detail, /^1 runs, 0 failures, last Success; last success 0\.3 h ago \(overdue after 13 h\)$/);
        const fresh = ran({ runs: 0, lastStatus: null, lastSuccessAgeSeconds: null, policyAgeSeconds: 600 });
        assert.equal(judgeColumnstoreRuns(fresh).ok, true);
        assert.equal(judgeColumnstoreRuns({ ...fresh, policyAgeSeconds: COLUMNSTORE_BOOTSTRAP_SECONDS }).ok, true);
        assert.match(judgeColumnstoreRuns(fresh).detail, /not run yet; policy 0\.2 h old \(bootstrap allowance 13 h\)/);
    });

    test('an overdue, failing, never-successful or unanchored job fails', () => {
        const bad: Array<[string, ColumnstoreRunStat]> = [
            ['last success one second past the limit', ran({ lastSuccessAgeSeconds: limit + 1 })],
            ['last success two days ago', ran({ lastSuccessAgeSeconds: 2 * 86_400 })],
            ['the last run failed, though an earlier one succeeded recently', ran({ runs: 2, failures: 1, lastStatus: 'Failed' })],
            ['runs but never succeeded', ran({ runs: 3, failures: 3, lastStatus: 'Failed', lastSuccessAgeSeconds: null })],
            ['never run, past the bootstrap allowance', ran({ runs: 0, lastStatus: null, lastSuccessAgeSeconds: null, policyAgeSeconds: COLUMNSTORE_BOOTSTRAP_SECONDS + 1 })],
            ['never run, and sql/050 not recorded', ran({ runs: 0, lastStatus: null, lastSuccessAgeSeconds: null, policyAgeSeconds: null })],
        ];
        for (const [name, stat] of bad) assert.equal(judgeColumnstoreRuns(stat).ok, false, name);
    });
});

describe('the columnstore chunk layout check', () => {
    const CHUNK = '_timescaledb_internal._hyper_17_8_chunk';
    // As timescaledb_information.chunk_columnstore_settings printed the converted picks chunk on the live service.
    const row = (patch: Partial<ChunkColumnstoreRow> = {}): ChunkColumnstoreRow => ({
        hypertable: 'telemetry.switch_events',
        chunk: CHUNK,
        segmentby: 'session_id',
        orderby: '"time" DESC,ledger_id',
        ...patch,
    });

    test('every chunk in the columnstore on the expected layout passes, and so does no chunk at all', () => {
        assert.equal(judgeChunkLayouts('switch_events', [CHUNK], [row()]).ok, true);
        assert.equal(judgeChunkLayouts('switch_events', [CHUNK], [row()]).detail, '1 chunk in the columnstore, each on the expected layout');
        assert.deepEqual(judgeChunkLayouts('switch_events', [], []), { ok: true, detail: 'no chunk in the columnstore yet' });
        // Another hypertable's chunks are not this one's business.
        assert.equal(judgeChunkLayouts('switch_events', [CHUNK], [row(), row({ hypertable: 'telemetry.picks', chunk: 'x', orderby: 'ledger_id' })]).ok, true);
        for (const t of HYPERTABLES) {
            const printed = COLUMNSTORE_LAYOUT[t].orderby.map((o) => (o.startsWith('time') ? `"${o.replace(' DESC', '')}"${o.endsWith(' DESC') ? ' DESC' : ''}` : o)).join(',');
            assert.equal(judgeChunkLayouts(t, ['c'], [row({ hypertable: `telemetry.${t}`, chunk: 'c', orderby: printed })]).ok, true, t);
        }
    });

    test('a chunk on an older or different layout, or in the columnstore with no recorded layout, fails', () => {
        const bad: Array<[string, string[], ChunkColumnstoreRow[]]> = [
            ['converted before ledger_id was in the orderby', [CHUNK], [row({ orderby: '"time" DESC' })]],
            ['time ascending', [CHUNK], [row({ orderby: '"time",ledger_id' })]],
            ['NULLS LAST on time DESC', [CHUNK], [row({ orderby: '"time" DESC NULLS LAST,ledger_id' })]],
            ['no segmentby', [CHUNK], [row({ segmentby: null })]],
            ['segmented by another column', [CHUNK], [row({ segmentby: 'command' })]],
            ['in the columnstore with no recorded layout', [CHUNK], []],
            ['one good chunk and one on an old layout', [CHUNK, 'old'], [row(), row({ chunk: 'old', orderby: '"time" DESC' })]],
        ];
        for (const [name, chunks, rows] of bad) assert.equal(judgeChunkLayouts('switch_events', chunks, rows).ok, false, name);
        assert.match(judgeChunkLayouts('switch_events', [CHUNK], []).detail, /no recorded layout/);
    });
});

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

    test('session_inputs (sql/060): the expected columns and CHECKs are what the file creates, and its words are INPUT_KINDS', () => {
        const sql = readFileSync(new URL('../sql/060_session_inputs.sql', import.meta.url), 'utf8');
        const sqlType: Record<string, string> = { timestamptz: 'timestamp with time zone', text: 'text' };
        const created = Object.fromEntries([...sql.matchAll(/^\s+([a-z_]+) (timestamptz|text)\b/gm)].map((m) => [m[1]!, sqlType[m[2]!]!]));
        assert.deepEqual(created, { ...EXPECTED_COLUMNS.session_inputs });
        assert.deepEqual(Object.keys(EXPECTED_TEXT_CHECKS.session_inputs).sort(), ['input', 'session_id']);
        assert.equal(EXPECTED_TEXT_CHECKS.session_inputs.session_id, EXPECTED_TEXT_CHECKS.picks.session_id);
        assert.equal(EXPECTED_TEXT_CHECKS.session_inputs.input, `CHECK ((input = ANY (ARRAY[${INPUT_KINDS.map((w) => `'${w}'::text`).join(', ')}])))`);
        assert.match(sql, new RegExp(`CHECK \\(input IN \\(${INPUT_KINDS.map((w) => `'${w}'`).join(', ')}\\)\\)`));
        const m = /CREATE UNIQUE INDEX IF NOT EXISTS session_inputs_identity ON telemetry\.session_inputs \(([^)]*)\)/.exec(sql);
        assert.deepEqual(m?.[1]?.split(',').map((c) => c.trim()), [...IDENTITY_COLUMNS.session_inputs]);
        assert.doesNotMatch(sql, /create_hypertable|columnstore|retention/i);
        // Catalog-shaped rows as the live service would describe the table: they pass, and a loosened word list fails.
        const good: ColumnRow[] = Object.entries(EXPECTED_COLUMNS.session_inputs).map(([col, type]) => ({
            tbl: 'session_inputs',
            col,
            type,
            checks: type === 'text' ? [EXPECTED_TEXT_CHECKS.session_inputs[col]!] : [],
        }));
        assert.equal(judgeColumns('session_inputs', good).ok, true);
        const loose = good.map((r) => (r.col === 'input' ? { ...r, checks: ["CHECK ((input = ANY (ARRAY['headset'::text, 'keyboard'::text, 'switch'::text, 'unknown'::text, 'keyboard-test'::text])))"] } : r));
        assert.equal(judgeColumns('session_inputs', loose).ok, false);
        assert.equal(judgeColumns('session_inputs', [...good, { tbl: 'session_inputs', col: 'label', type: 'text', checks: [] }]).ok, false, 'a stored label');
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
            '050_columnstore.sql': 10,
            '060_session_inputs.sql': 2,
        });
        for (const f of files) for (const s of f.statements) assert.ok(!s.includes(';'), `${f.file}: a statement still holds a semicolon`);
    });

    test('a file applied to the live service is frozen byte for byte, comments included', () => {
        // The checksums recorded in telemetry.migrations on the live service (npm run migrate compares the whole file,
        // so even a comment edit makes it refuse every later migration). The Eleven rename once edited a comment in
        // 001 this way; its applied bytes were restored. A change belongs in a new file.
        const applied: Record<string, string> = {
            '001_schema.sql': '0a0c58ee60a68cbba72c0c7b570d316d9b4f0f7d58d7380ff1f3ba0688cbfb38',
            '010_switch_events.sql': 'ae4833103862f3ebdbfee578d79349c8c203d95301a9492aea96ff1ec9cbf716',
            '011_scan_steps.sql': '3c99d9794df3f7dd317b15c22e6d2a9f8be4475dfc1034c9517e5e7f8ca180d7',
            '012_picks.sql': '6e52e4d7171df593d0ff31f7218f92120ec6ffbc19a4367de73359e8eca7cc09',
            '013_action_outcomes.sql': '1e331c73bb405e668beabd973fd2729a2d5636321f62886da92d95676ef5a4f1',
            '014_rest_minutes.sql': '31489be79eb215975f236a7bef8e18533c91206caaef2dd5cd1b56a488cc9846',
            '020_switch_1m.sql': '157c26bfe834d3539a19283ee37981f4416ee85a9c32da61d6ebbc0ed031229b',
            '021_idle_1m.sql': '0db07c958f6d061118e610630daa611351aabc62423b38c54b18e4cfb35ea499',
            '022_picks_1m.toolkit.sql': 'b51818b947aa58f2c31e160e92cdeabf172d92a00504507e961fda6de1acbd30',
            '030_retention.sql': '5a9363f19bc56f2e1350dcf7db9deca0d792facd2dd4bb90342ebf81e2ea5a92',
            '040_switch_events_no_gesture_id.sql': 'e86c569c48949d2d9ae10ae97fa0ede73b25581a520da2992c546c14a3640ad7',
            '050_columnstore.sql': '5e68db9864fbaebe9573d1454a9e0f595e1d4aee0c075a87f0ef10dbe1b0bed4',
            '060_session_inputs.sql': 'fafe164b46c3d5a64678eb4224582485c69e19150bc509b146c0e832100d2fb8',
        };
        for (const [file, checksum] of Object.entries(applied)) assert.equal(files.find((f) => f.file === file)?.checksum, checksum, `sql/${file} was edited after it was applied`);
    });

    test('the splitter drops comment lines and keeps multi-line statements whole', () => {
        assert.deepEqual(splitStatements('-- a; comment;\nSELECT 1;\nSELECT\n  2 ;\n\n'), ['SELECT 1', 'SELECT\n  2']);
    });

    test('the plan takes one variant per migration', () => {
        assert.deepEqual(
            choosePlan(files, 'toolkit').map((f) => f.file),
            [
                '001_schema.sql',
                '010_switch_events.sql',
                '011_scan_steps.sql',
                '012_picks.sql',
                '013_action_outcomes.sql',
                '014_rest_minutes.sql',
                '020_switch_1m.sql',
                '021_idle_1m.sql',
                '022_picks_1m.toolkit.sql',
                '030_retention.sql',
                '040_switch_events_no_gesture_id.sql',
                '050_columnstore.sql',
                '060_session_inputs.sql',
            ],
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

    test('sql/050 sets exactly the layout and policy the verifier expects on the five hypertables, and no aggregate', () => {
        const sql = files.map((f) => f.statements.join('\n')).join('\n');
        const layouts = [...sql.matchAll(/ALTER TABLE telemetry\.(\w+) SET \(timescaledb\.enable_columnstore = true, timescaledb\.segmentby = '([^']*)', timescaledb\.orderby = '([^']*)'\)/g)];
        assert.deepEqual(layouts.map((m) => m[1]).sort(), [...HYPERTABLES].sort());
        for (const m of layouts) {
            const t = m[1] as Hypertable;
            assert.deepEqual({ segmentby: m[2]!.split(', '), orderby: m[3]!.split(', ') }, { segmentby: [...COLUMNSTORE_LAYOUT[t].segmentby], orderby: [...COLUMNSTORE_LAYOUT[t].orderby] }, t);
        }
        const policies = [...sql.matchAll(/CALL add_columnstore_policy\('telemetry\.(\w+)', after => INTERVAL '([^']*)', if_not_exists => true\)/g)];
        assert.deepEqual(policies.map((m) => m[1]).sort(), [...HYPERTABLES].sort());
        for (const m of policies) assert.equal(m[2], COLUMNSTORE_AFTER, m[1]);
        // Exactly these ten statements touch the columnstore; the aggregates stay in the rowstore.
        assert.equal([...sql.matchAll(/columnstore/g)].length, 10);
        assert.doesNotMatch(sql, /ALTER MATERIALIZED VIEW/);
    });

    test('the columnstore starts at or past every refresh window and before raw retention', () => {
        const sql = files.map((f) => f.statements.join('\n')).join('\n');
        const days = (interval: string) => Number(/^(\d+) days$/.exec(interval)![1]);
        const after = days(COLUMNSTORE_AFTER);
        const starts = [...sql.matchAll(/start_offset => INTERVAL '(\d+) days'/g)].map((m) => Number(m[1]));
        const rawDrops = [...sql.matchAll(/add_retention_policy\('telemetry\.(switch_events|scan_steps|picks|action_outcomes|rest_minutes)', drop_after => INTERVAL '(\d+) days'/g)].map((m) => Number(m[2]));
        assert.ok(starts.length >= 3 && rawDrops.length === 5);
        for (const s of starts) assert.ok(after >= s, `columnstore after ${after} days must not start inside the refresh window of ${s} days`);
        for (const d of rawDrops) assert.ok(after < d, `columnstore after ${after} days must come before raw retention ${d} days`);
        assert.equal(days(RAW_RETENTION), Math.max(...rawDrops));
    });
});
