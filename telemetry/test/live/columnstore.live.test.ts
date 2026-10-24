// Live test of the columnstore (sql/050) against the real Tiger service. Runs only with TIGER_IT=1 (npm run test:live).
//
// It writes a SYNTHETIC session under one `test-` key through the real pipeline, as tiger.live.test.ts does, then
// converts the chunks that hold it to the columnstore with convert_to_columnstore and checks that: the rows read back
// unchanged; the aggregates, recomputed from the converted rows, still give the numbers computed independently in
// test/live/synthetic.ts; the idempotency index holds on the converted chunks (a duplicate is refused, a replay of the
// whole session lands each ledger row once, and a partly overlapping rest mask is stored as the union of both). It
// records the bytes before and after from TimescaleDB's own chunk_columnstore_stats.
//
// Converting a chunk converts every row in it, and the check and the conversion cannot share one transaction. So: it
// refuses to start while a writer looks active (a connection named neurolingo-telemetry-writer, or a row of a session
// that is not test data written in the last WRITER_QUIET_MINUTES); it checks that each chunk holds only test sessions
// (`test-` keys, or the team's say-when-dev module) before converting; and it checks again right after converting,
// converting everything back and failing if a row of another session arrived in between. Do not run it while a writer
// runs. Each chunk is recorded before its conversion is sent, so cleanup converts back every chunk this test may have
// converted, even if a reply was lost; cleanup failures fail the run. At the end it deletes the session, refreshes the
// aggregates, checks that no row is left, and converts the chunks back to the rowstore, where the policy (3 days) still
// leaves chunks this new. Test data only.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type pg from 'pg';

import { connectTiger, type TigerConnection } from '../../src/db.js';
import { memoryLogger, silentLogger } from '../../src/log.js';
import { AGGREGATES, HYPERTABLES, PLAIN_TABLES, verifySchema, type Hypertable } from '../../src/migrate.js';
import { createPipeline } from '../../src/pipeline.js';
import { PgSink, SPECS } from '../../src/sink.js';
import { FakeSource } from '../../src/sources/fake.js';
import { getStats, percentileCont, type DashboardStats } from '../../src/stats.js';
import { popcount } from '../../src/types.js';
import { CHUNK_RE, columnstoreState, RestoreError, restoreRowstore } from './rowstore.js';
import { syntheticSession, type Expected } from './synthetic.js';

const LIVE = process.env.TIGER_IT === '1';
const RUN = `test-cs-${Date.now().toString(36)}`;
const SESSION = `${RUN}:1`;
/** Synthetic times: eight minutes ago plus `s` seconds (test/live/synthetic.ts). */
const anchorMs = Date.now() - 8 * 60_000;
/** The only sessions a chunk may hold before this test converts it: test keys and the team's test module. */
const TEST_ONLY = "session_id LIKE 'test-%' OR session_id LIKE 'say-when-dev:%'";
/** The application name src/cli/writer.ts connects with. */
const WRITER_APP = 'neurolingo-telemetry-writer';
/** The test refuses to start if a row of a session that is not test data was written this recently. */
const WRITER_QUIET_MINUTES = 10;

interface ChunkFacts {
    table: Hypertable;
    chunk: string;
    rows: number;
    sessions: number;
    bytesBeforeByPg: number;
}

async function refreshRecent(pool: pg.Pool): Promise<void> {
    for (const ca of AGGREGATES) await pool.query(`CALL refresh_continuous_aggregate('telemetry.${ca}', now() - INTERVAL '30 minutes', now())`);
}

/** Every bucket of the session, from its first minute to the minute after its last row; it ends before the current minute. */
function sessionWindow(): { from: string; to: string } {
    const minute = 60_000;
    const from = new Date(Math.floor(anchorMs / minute) * minute).toISOString();
    const to = new Date(Math.floor((anchorMs + 401_000) / minute) * minute + minute).toISOString();
    for (const t of [from, to]) assert.match(t, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
    return { from, to };
}

function checkStats(stats: DashboardStats, expected: Expected): void {
    assert.equal(stats.falseActivations, expected.falseActivations);
    assert.equal(stats.commands, expected.commands);
    assert.equal(stats.idleMinutes, Math.round((expected.idleMs / 60_000) * 100) / 100);
    assert.equal(stats.falseActivationsPerIdleMinute, Math.round((expected.falseActivations / (expected.idleMs / 60_000)) * 1_000) / 1_000);
    assert.equal(stats.timeToPick.picks, 21);
    assert.equal(stats.timeToPick.method, 'toolkit-uddsketch');
    const p50 = percentileCont(expected.timesToPick, 0.5)!;
    const p95 = percentileCont(expected.timesToPick, 0.95)!;
    assert.ok(Math.abs(stats.timeToPick.p50Ms! - p50) / p50 < 0.03, `p50 ${stats.timeToPick.p50Ms} vs exact ${p50}`);
    assert.ok(Math.abs(stats.timeToPick.p95Ms! - p95) / p95 < 0.03, `p95 ${stats.timeToPick.p95Ms} vs exact ${p95}`);
}

/** The numbers the dashboard shows, without the times of the read. */
const numbers = (s: DashboardStats) => ({
    rate: s.falseActivationsPerIdleMinute,
    falseActivations: s.falseActivations,
    idleMinutes: s.idleMinutes,
    yesActedAtRest: s.yesActedAtRest,
    commands: s.commands,
    p50: s.timeToPick.p50Ms,
    p95: s.timeToPick.p95Ms,
    picks: s.timeToPick.picks,
});

describe('the columnstore on the live Tiger service', { skip: !LIVE && 'set TIGER_IT=1 (npm run test:live)' }, () => {
    let conn: TigerConnection;
    /** Every chunk this test may have converted, recorded before the conversion is sent. */
    const touched: string[] = [];
    /** The chunks that hold the session, found before converting them. */
    const facts: ChunkFacts[] = [];
    let expected: Expected;
    let events: ReturnType<typeof syntheticSession>['events'];
    let rowstoreDigest: Record<string, { n: number; digest: string }>;
    let cleaned = false;
    /** Set when a row of another session reached a chunk during the conversion and the conversion was undone. */
    let conversionUndone = false;

    /** Per table: the session's row count and an md5 of its rows (every column but ingested_at, which an upsert sets). */
    const digests = async (): Promise<Record<string, { n: number; digest: string }>> => {
        const out: Record<string, { n: number; digest: string }> = {};
        for (const t of HYPERTABLES) {
            const r = (await conn.pool.query(
                `SELECT count(*)::int AS n, md5(coalesce(string_agg((to_jsonb(t) - 'ingested_at')::text, '|' ORDER BY (to_jsonb(t) - 'ingested_at')::text), '')) AS digest
                 FROM telemetry.${t} t WHERE session_id = $1`,
                [SESSION],
            )).rows[0] as { n: number; digest: string };
            out[t] = r;
        }
        return out;
    };

    const compressedState = () => columnstoreState(conn.pool);

    const flagsOf = async (chunk: string): Promise<string[]> =>
        ((await conn.pool.query('SELECT _timescaledb_functions.chunk_status_text($1::text::regclass) AS flags', [chunk])).rows[0] as { flags: string[] }).flags;

    /** Rows in a chunk of any session that is not test data. */
    const foreignRows = async (chunk: string): Promise<number> => {
        assert.match(chunk, CHUNK_RE);
        return ((await conn.pool.query(`SELECT count(*) FILTER (WHERE NOT (${TEST_ONLY}))::int AS n FROM ${chunk}`)).rows[0] as { n: number }).n;
    };

    /** Signs that a writer is running: its connection, or recent rows of a session that is not test data. */
    const writerActivity = async (): Promise<string[]> => {
        const signs: string[] = [];
        const writers = (await conn.pool.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()', [WRITER_APP]))
            .rows[0] as { n: number };
        if (writers.n > 0) signs.push(`${writers.n} connection(s) named ${WRITER_APP}`);
        for (const t of HYPERTABLES) {
            const r = (await conn.pool.query(
                `SELECT count(*)::int AS n FROM telemetry.${t} WHERE NOT (${TEST_ONLY}) AND ingested_at > now() - make_interval(mins => $1::int)`,
                [WRITER_QUIET_MINUTES],
            )).rows[0] as { n: number };
            if (r.n > 0) signs.push(`${r.n} ${t} row(s) of a session that is not test data written in the last ${WRITER_QUIET_MINUTES} minutes`);
        }
        return signs;
    };

    /**
     * Converts back to the rowstore every touched chunk still in the columnstore (test/live/rowstore.ts): every chunk is
     * attempted even if one fails, and one error then names every failure and every chunk left in the columnstore.
     */
    const restore = () => restoreRowstore(conn.pool, touched, (e) => conn.describe(e));

    const run = async () => {
        const pipeline = createPipeline({ source: new FakeSource(RUN, events), sink: new PgSink(conn.pool), log: memoryLogger(), describeError: (e) => conn.describe(e) });
        await pipeline.start();
        await pipeline.stop(20_000);
        const w = pipeline.writer.stats();
        assert.equal(w.unsentAtStop, 0, `rows not written: ${w.lastError ?? ''}`);
        assert.equal(w.failedFlushes, 0, w.lastError ?? '');
    };

    before(async () => {
        assert.match(RUN, /^test-/);
        // Converting a chunk can wait for a refresh job that is reading it, so allow a minute per statement.
        conn = await connectTiger({ log: silentLogger, max: 1, statementTimeoutMs: 60_000, applicationName: 'neurolingo-telemetry-it-columnstore' });
        ({ events, expected } = syntheticSession(anchorMs, { errand: true }));
        const signs = await writerActivity();
        assert.deepEqual(signs, [], `refusing to start: a writer looks active (${signs.join('; ')}). Stop the writer before npm run test:live.`);
    });

    after(async () => {
        if (!conn) return;
        // A safety net if a test stopped early (the cleanup test does this and asserts it). Every failure is reported.
        const errors: string[] = [];
        if (!cleaned) {
            for (const t of [...HYPERTABLES, ...PLAIN_TABLES]) {
                try {
                    await conn.pool.query(`DELETE FROM telemetry.${t} WHERE session_id = $1`, [SESSION]);
                } catch (error) {
                    errors.push(`deleting from ${t}: ${conn.describe(error)}`);
                }
            }
            try {
                await refreshRecent(conn.pool);
            } catch (error) {
                errors.push(`refreshing the aggregates: ${conn.describe(error)}`);
            }
            try {
                const back = await restore();
                if (back.length > 0) console.log(`after an early stop, converted back to the rowstore: ${back.join(', ')}`);
            } catch (error) {
                // A RestoreError is already described part by part; describing it again would cut the chunk list.
                errors.push(`converting back to the rowstore: ${error instanceof RestoreError ? error.message : conn.describe(error)}`);
            }
        }
        await conn.close();
        if (errors.length > 0) throw new Error(`columnstore live test cleanup failed: ${errors.join('; ')}`);
    });

    test('the columnstore layout and policies are in the live catalog, and the aggregates are not in it', async () => {
        const report = await verifySchema(conn.pool);
        assert.deepEqual(report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`), []);
        const columnstore = report.checks.filter((c) => /^(columnstore|rowstore) /.test(c.name));
        assert.equal(columnstore.length, HYPERTABLES.length * 5 + AGGREGATES.length);
    });

    test('a session converted to the columnstore reads back unchanged, refuses a duplicate, and the aggregates recomputed from it agree', async () => {
        await run();
        rowstoreDigest = await digests();
        assert.equal(rowstoreDigest.switch_events!.n, expected.commands);
        assert.equal(rowstoreDigest.picks!.n, 21);
        assert.equal(rowstoreDigest.action_outcomes!.n, expected.outcomes);
        assert.ok(rowstoreDigest.scan_steps!.n > 0 && rowstoreDigest.rest_minutes!.n > 0);
        const idle = (await conn.pool.query('SELECT coalesce(sum(idle_ms), 0)::int AS ms FROM telemetry.rest_minutes WHERE session_id = $1', [SESSION])).rows[0] as { ms: number };
        assert.equal(idle.ms, expected.idleMs);

        // Through the aggregates while the rows are in the rowstore, as tiger.live.test.ts reads them.
        await refreshRecent(conn.pool);
        const fromRowstore = await getStats(conn.pool, { sessionId: SESSION, windowMinutes: 30 });
        checkStats(fromRowstore, expected);

        // The chunks that hold the session, and everything else in them: converting a chunk converts every row.
        for (const t of HYPERTABLES) {
            const chunks = (await conn.pool.query(`SELECT DISTINCT tableoid::regclass::text AS chunk FROM telemetry.${t} WHERE session_id = $1 ORDER BY 1`, [SESSION])).rows as Array<{ chunk: string }>;
            for (const { chunk } of chunks) {
                assert.match(chunk, CHUNK_RE);
                const r = (await conn.pool.query(
                    `SELECT count(*)::int AS rows, count(DISTINCT session_id)::int AS sessions, count(*) FILTER (WHERE NOT (${TEST_ONLY}))::int AS other,
                            pg_total_relation_size('${chunk}'::regclass)::bigint AS bytes
                     FROM ${chunk}`,
                )).rows[0] as { rows: number; sessions: number; other: number; bytes: string };
                assert.equal(r.other, 0, `${chunk} holds rows of a session that is not test data; not converting it`);
                facts.push({ table: t, chunk, rows: r.rows, sessions: r.sessions, bytesBeforeByPg: Number(r.bytes) });
            }
        }
        const state = await compressedState();
        for (const f of facts) assert.equal(state.get(f.chunk), false, `${f.chunk} is already in the columnstore`);

        for (const f of facts) {
            // Recorded first: if the server converts the chunk but the reply is lost, cleanup still converts it back.
            touched.push(f.chunk);
            await conn.pool.query(`CALL convert_to_columnstore('${f.chunk}')`);
        }
        // The check above and the conversion are separate statements, so a writer could have added a row in between.
        const late: string[] = [];
        for (const f of facts) {
            const n = await foreignRows(f.chunk);
            if (n > 0) late.push(`${f.chunk} (${n})`);
        }
        if (late.length > 0) {
            conversionUndone = true;
            let outcome: string;
            try {
                outcome = `converted ${(await restore()).join(', ')} back to the rowstore`;
            } catch (error) {
                outcome = (error as Error).message;
            }
            assert.fail(`rows of a session that is not test data reached ${late.join(', ')} during the conversion; ${outcome}. Do not run npm run test:live while a writer runs.`);
        }
        const now = await compressedState();
        for (const f of facts) assert.equal(now.get(f.chunk), true, `${f.chunk} was not converted`);

        // The bytes, from TimescaleDB's own statistics for each converted chunk: total, and table, index and toast.
        type Bytes = { table: number; index: number; toast: number; total: number };
        const sizes: Array<ChunkFacts & { status: string; flags: string[]; before: Bytes; after: Bytes }> = [];
        for (const f of facts) {
            const s = (await conn.pool.query(
                `SELECT compression_status AS status, _timescaledb_functions.chunk_status_text($1::text::regclass) AS flags,
                        before_compression_table_bytes AS bt, before_compression_index_bytes AS bi, before_compression_toast_bytes AS bo, before_compression_total_bytes AS b,
                        after_compression_table_bytes AS at, after_compression_index_bytes AS ai, after_compression_toast_bytes AS ao, after_compression_total_bytes AS a
                 FROM chunk_columnstore_stats('telemetry.${f.table}'::regclass) WHERE chunk_schema || '.' || chunk_name = $1::text`,
                [f.chunk],
            )).rows[0] as Record<string, string> & { flags: string[] } | undefined;
            assert.ok(s, `no columnstore stats for ${f.chunk}`);
            const n = (k: string) => Number(s[k]);
            sizes.push({
                ...f,
                status: s.status!,
                flags: s.flags,
                before: { table: n('bt'), index: n('bi'), toast: n('bo'), total: n('b') },
                after: { table: n('at'), index: n('ai'), toast: n('ao'), total: n('a') },
            });
        }
        const before = sizes.reduce((n, s) => n + s.before.total, 0);
        const afterBytes = sizes.reduce((n, s) => n + s.after.total, 0);
        const rows = sizes.reduce((n, s) => n + s.rows, 0);
        console.log(
            `columnstore measurement: ${JSON.stringify({
                session: SESSION,
                chunks: sizes.map((s) => ({ table: s.table, chunk: s.chunk, rows: s.rows, sessions: s.sessions, status: s.status, flags: s.flags, before: s.before, after: s.after, pgTotalRelationSizeBefore: s.bytesBeforeByPg })),
                rows,
                beforeBytes: before,
                afterBytes,
                ratio: Math.round((before / afterBytes) * 100) / 100,
            })}`,
        );
        for (const s of sizes) assert.equal(s.status, 'Compressed', s.chunk);

        // The rows read back unchanged from the columnstore.
        assert.deepEqual(await digests(), rowstoreDigest);

        // The idempotency index holds on the converted chunks: a plain INSERT of an existing key is refused.
        for (const t of HYPERTABLES) {
            const cols = SPECS[t].columns;
            const row = (await conn.pool.query(
                `SELECT ${cols.map((c) => (c === 'time' ? 'time::text AS time' : c)).join(', ')} FROM telemetry.${t} WHERE session_id = $1 ORDER BY time LIMIT 1`,
                [SESSION],
            )).rows[0] as Record<string, unknown>;
            await assert.rejects(
                conn.pool.query(`INSERT INTO telemetry.${t} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, cols.map((c) => row[c])),
                (e: unknown) => (e as { code?: string }).code === '23505',
                `${t}: a duplicate key was accepted on a converted chunk`,
            );
        }
        assert.deepEqual(await digests(), rowstoreDigest);

        // Recompute every bucket of the session from the converted rows, and read the numbers again.
        const { from, to } = sessionWindow();
        for (const ca of AGGREGATES) {
            await conn.pool.query(`CALL refresh_continuous_aggregate('telemetry.${ca}', '${from}'::timestamptz, '${to}'::timestamptz, force => true)`);
        }
        const fromColumnstore = await getStats(conn.pool, { sessionId: SESSION, windowMinutes: 30 });
        checkStats(fromColumnstore, expected);
        assert.deepEqual(numbers(fromColumnstore), numbers(fromRowstore));
        console.log(`columnstore stats for ${SESSION}: ${JSON.stringify(numbers(fromColumnstore))}`);
    });

    test('a replay into the converted chunks lands each ledger row once, and the rest_minutes upsert runs on them', async () => {
        assert.ok(touched.length > 0 && !conversionUndone, 'runs after the conversion');
        const startedAt =((await conn.pool.query('SELECT clock_timestamp()::text AS t')).rows[0] as { t: string }).t;
        await run();
        assert.deepEqual(await digests(), rowstoreDigest, 'the replay changed no stored value');
        // Which rows the replay rewrote: the rest_minutes upsert sets ingested_at, ON CONFLICT DO NOTHING leaves a row as
        // it was. So the upsert ran through the converted chunk, and every other replayed row was skipped, not rewritten.
        // The replayed masks equal the stored ones, so this cannot tell a union from a replacement: the next test does.
        const rewritten: Record<string, string> = {};
        for (const t of HYPERTABLES) {
            const r = (await conn.pool.query(
                `SELECT count(*) FILTER (WHERE ingested_at > $2::timestamptz)::int AS rewritten, count(*)::int AS n FROM telemetry.${t} WHERE session_id = $1`,
                [SESSION, startedAt],
            )).rows[0] as { rewritten: number; n: number };
            rewritten[t] = `${r.rewritten} of ${r.n} rewritten`;
            if (t === 'rest_minutes') assert.ok(r.rewritten > 0, 'the rest_minutes upsert did not run on the converted chunk');
            else assert.equal(r.rewritten, 0, `${t}: a replayed row was rewritten or added`);
        }
        const flags = await Promise.all(touched.map(async (chunk) => `${chunk} ${(await flagsOf(chunk)).join('+') || 'rowstore'}`));
        console.log(`after the replay: ${JSON.stringify(rewritten)}; ${flags.join(', ')}`);
        await refreshRecent(conn.pool);
        checkStats(await getStats(conn.pool, { sessionId: SESSION, windowMinutes: 30 }), expected);
    });

    test('a partly overlapping rest mask written into a columnstore chunk is stored as the union of both', async () => {
        assert.ok(touched.length > 0 && !conversionUndone, 'runs after the conversion');
        // A stored minute with at least two rest seconds and at least one second not at rest, and the chunk that holds
        // it, found together from the chunk's time range: across UTC midnight the session spans two daily chunks.
        const stored = (await conn.pool.query(
            `SELECT c.chunk_schema || '.' || c.chunk_name AS chunk, extract(epoch FROM r.time)::bigint::text AS epoch, r.rest_mask::text AS mask
             FROM telemetry.rest_minutes r
             JOIN timescaledb_information.chunks c
               ON c.hypertable_schema = 'telemetry' AND c.hypertable_name = 'rest_minutes' AND r.time >= c.range_start AND r.time < c.range_end
             WHERE r.session_id = $1 AND bit_count(r.rest_mask::bit(64)) BETWEEN 2 AND 59 ORDER BY r.time LIMIT 1`,
            [SESSION],
        )).rows[0] as { chunk: string; epoch: string; mask: string } | undefined;
        assert.ok(stored, 'no stored minute with both rest and non-rest seconds');
        const restChunk = stored.chunk;
        assert.match(restChunk, CHUNK_RE);
        assert.ok(touched.includes(restChunk), `${restChunk}, which holds the minute, was not converted by this test`);
        // The replay left that chunk partly in the rowstore; convert it fully again so the write meets a compressed batch.
        await conn.pool.query(`CALL convert_to_columnstore('${restChunk}', recompress => true)`);
        assert.deepEqual(await flagsOf(restChunk), ['COMPRESSED'], `${restChunk} before the write`);
        const old = BigInt(stored.mask);
        const sharedSecond = old & -old;
        let newSecond = 1n;
        while (old & newSecond) newSecond <<= 1n;
        assert.ok(newSecond < 1n << 60n);
        const incoming = sharedSecond | newSecond;
        const union = old | incoming;
        // Union, replace (incoming), keep (old) and intersect differ here, so the stored mask says which one happened.
        assert.equal(new Set([union, incoming, old, old & incoming]).size, 4);
        await new PgSink(conn.pool).insert('rest_minutes', [{ time: BigInt(stored.epoch) * 1_000_000n, sessionId: SESSION, restMask: incoming, idleMs: popcount(incoming) * 1_000 }]);
        const now = (await conn.pool.query(
            'SELECT count(*)::int AS rows, max(rest_mask)::text AS mask, max(idle_ms)::int AS idle_ms FROM telemetry.rest_minutes WHERE session_id = $1 AND time = to_timestamp($2::bigint)',
            [SESSION, stored.epoch],
        )).rows[0] as { rows: number; mask: string; idle_ms: number };
        assert.equal(now.rows, 1, 'the minute is one row');
        assert.equal(BigInt(now.mask), union, `stored ${now.mask}, expected the union ${union}`);
        assert.equal(now.idle_ms, popcount(union) * 1_000);
        // The write met a compressed batch of exactly that chunk: the batch it conflicted with moved to the rowstore part.
        const flags = await flagsOf(restChunk);
        assert.deepEqual(flags, ['COMPRESSED', 'PARTIAL'], `${restChunk} after the write`);
        console.log(
            `union on a columnstore chunk: the minute held ${popcount(old)} rest seconds, the write carried ${popcount(incoming)} (1 shared, 1 new), now ${popcount(union)} seconds and idle_ms ${now.idle_ms}; ${restChunk} ${flags.join('+')}`,
        );
    });

    test('cleanup: the session is deleted from the converted chunks, no row is left, and the chunks go back to the rowstore', async () => {
        for (const t of [...HYPERTABLES, ...PLAIN_TABLES]) await conn.pool.query(`DELETE FROM telemetry.${t} WHERE session_id = $1`, [SESSION]);
        await refreshRecent(conn.pool);
        const left = (await conn.pool.query(
            `SELECT ${[...HYPERTABLES, ...PLAIN_TABLES].map((t) => `(SELECT count(*) FROM telemetry.${t} WHERE session_id = $1)`).join(' + ')} AS raw,
                    ${AGGREGATES.map((a) => `(SELECT count(*) FROM telemetry.${a} WHERE session_id = $1)`).join(' + ')} AS aggregates`,
            [SESSION],
        )).rows[0] as { raw: string; aggregates: string };
        console.log(`rows left for ${SESSION} after cleanup: raw ${left.raw}, aggregates ${left.aggregates}`);
        assert.equal(Number(left.raw), 0);
        assert.equal(Number(left.aggregates), 0);
        const back = await restore();
        if (!conversionUndone) assert.deepEqual([...back].sort(), [...touched].sort(), 'every converted chunk was still in the columnstore before cleanup');
        console.log(`converted back to the rowstore: ${back.join(', ')}`);
        cleaned = true;
    });
});
