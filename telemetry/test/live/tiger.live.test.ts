// Live integration test against the real Tiger service. Runs only with TIGER_IT=1 (npm run test:live).
//
// It writes SYNTHETIC rows, all under one session key that starts with `test-`, through the real pipeline (fake
// source, tracker, writer, pinned TLS, the hypertables), reads the numbers back through the continuous aggregates,
// and deletes every row it wrote. These rows are test data, never usage: the stats exclude `test-` sessions.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';

import { loadTarget } from '../../src/credentials.js';
import { connectTiger, poolConfig, type TigerConnection } from '../../src/db.js';
import { memoryLogger, silentLogger } from '../../src/log.js';
import { verifySchema } from '../../src/migrate.js';
import { createPipeline } from '../../src/pipeline.js';
import { backlogRange, PgSink, refreshAggregate } from '../../src/sink.js';
import { FakeSource } from '../../src/sources/fake.js';
import { getStats, percentileCont } from '../../src/stats.js';
import { loadPin, pinnedSsl } from '../../src/tls.js';
import type { Micros, PickRow } from '../../src/types.js';
import { Scenario } from '../fixtures.js';

const LIVE = process.env.TIGER_IT === '1';
const RUN = `test-it-${Date.now().toString(36)}`;
const SESSION = `${RUN}:1`;
const TABLES = ['switch_events', 'scan_steps', 'picks', 'action_outcomes', 'rest_minutes'];
const AGGREGATES = ['switch_1m', 'idle_1m', 'picks_1m'];

/** Synthetic times: eight minutes ago plus `s` seconds, on whole milliseconds. */
const anchorMs = Date.now() - 8 * 60_000;
const anchor: Micros = BigInt(anchorMs) * 1_000n;
const ms = (s: number): number => Math.round(s * 1_000);
const at = (s: number): Micros => anchor + BigInt(ms(s)) * 1_000n;
/** Seconds (epoch) whose midpoint lies in [a, b): the rule the tracker uses, computed here on its own. */
const secondsIn = (a: number, b: number): number => Math.ceil((anchorMs + ms(b) - 500) / 1_000) - Math.ceil((anchorMs + ms(a) - 500) / 1_000);

interface Expected {
    commands: number;
    falseActivations: number;
    idleMs: number;
    timesToPick: number[];
}

/** A test session whose answers are known in advance, computed here independently of the tracker. */
function syntheticSession(): { events: Scenario['events']; expected: Expected } {
    const s = new Scenario(1n).start(at(0)).ready();
    let restSeconds = 0;
    let restStart = 0;
    const rest = (until: number) => {
        restSeconds += secondsIn(restStart, until);
    };
    // The station's device_status row every 2 s, as the module refreshes it, interleaved in time order.
    let lastBeat = 0;
    const beatTo = (until: number) => {
        while (lastBeat + 2 <= until) {
            lastBeat += 2;
            s.tick(at(lastBeat));
        }
    };
    // Three minutes at rest with three misfires that had nothing to act on.
    beatTo(20);
    s.gesture(at(20), 'NO', 'ignored:idle');
    beatTo(80);
    s.gesture(at(80), 'CONFIRM', 'ignored:nothing_to_confirm');
    beatTo(140);
    s.gesture(at(140), 'NO', 'ignored:idle');
    beatTo(180);
    rest(180);
    // 21 questions, each picked on its first option after 1.0 s, 1.2 s, ... 5.0 s.
    const timesToPick: number[] = [];
    for (let k = 0; k <= 20; k++) {
        const t0 = 180 + k * 8;
        const ttp = 1 + 0.2 * k;
        const q = BigInt(100 + k);
        if (k > 0) rest(t0);
        beatTo(t0);
        s.preparing(at(t0), q).read(at(t0 + 0.5), q, 1);
        beatTo(t0 + 0.5 + ttp);
        s.pick(at(t0 + 0.5 + ttp), q, 1, 'reply');
        s.gesture(at(t0 + 0.5 + ttp), 'YES', 'accepted:pick', { questionId: q, optionId: 1_000n + q, cursor: 1 });
        s.veto(at(t0 + 0.5 + ttp));
        beatTo(t0 + 0.5 + ttp + 0.7);
        s.idle(at(t0 + 0.5 + ttp + 0.7), 'picked');
        beatTo(t0 + 7);
        restStart = t0 + 0.5 + ttp + 0.7;
        timesToPick.push(ms(ttp));
    }
    // A STOP at rest pauses (it acted, so it is not a false activation); a second STOP while paused had nothing to do.
    // A deliberate pause is still rest.
    beatTo(352);
    s.gesture(at(352), 'STOP', 'accepted:pause');
    s.pause(at(352), 'stop');
    beatTo(360);
    s.gesture(at(360), 'STOP', 'ignored:already_paused');
    beatTo(400);
    rest(400);
    return { events: s.events, expected: { commands: 3 + 21 + 2, falseActivations: 4, idleMs: restSeconds * 1_000, timesToPick } };
}

async function refreshRecent(pool: pg.Pool): Promise<void> {
    for (const ca of AGGREGATES) {
        await pool.query(`CALL refresh_continuous_aggregate('telemetry.${ca}', now() - INTERVAL '30 minutes', now())`);
    }
}

describe('the live Tiger service', { skip: !LIVE && 'set TIGER_IT=1 (npm run test:live)' }, () => {
    let conn: TigerConnection;
    const tmp = mkdtempSync(join(tmpdir(), 'telemetry-live-'));
    let backlog: { from: string; to: string } | null = null;

    before(async () => {
        assert.match(RUN, /^test-/);
        conn = await connectTiger({ log: silentLogger, max: 2, applicationName: 'neurolingo-telemetry-it' });
    });

    after(async () => {
        if (conn) {
            // Delete exactly this run's session, then let the aggregates forget it, including the old backlog bucket.
            for (const t of TABLES) await conn.pool.query(`DELETE FROM telemetry.${t} WHERE session_id = $1`, [SESSION]);
            await refreshRecent(conn.pool);
            if (backlog) await refreshAggregate(conn.pool, 'picks_1m', backlog.from, backlog.to);
            const left = (await conn.pool.query(
                `SELECT (SELECT count(*) FROM telemetry.switch_1m WHERE session_id = $1) + (SELECT count(*) FROM telemetry.idle_1m WHERE session_id = $1)
                      + (SELECT count(*) FROM telemetry.picks_1m WHERE session_id = $1) AS n`,
                [SESSION],
            )).rows[0] as { n: string };
            console.log(`aggregate rows left for ${SESSION} after cleanup: ${left.n}`);
            await conn.close();
        }
        rmSync(tmp, { recursive: true, force: true });
    });

    test('the connection is TLS 1.3, verified against the pin', async () => {
        const r = (await conn.pool.query('SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()')).rows[0] as { ssl: boolean; version: string };
        assert.equal(r.ssl, true);
        assert.equal(r.version, 'TLSv1.3');
        assert.equal(conn.leafMatchesPin(), true);
    });

    test('every hypertable, aggregate, policy and idempotency index is in the live catalog', async () => {
        const report = await verifySchema(conn.pool);
        const failed = report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
        assert.deepEqual(failed, []);
        assert.equal(report.percentiles, 'toolkit');
    });

    test('a read-only session reads the stats, and the server refuses its writes', async () => {
        const ro = await connectTiger({ log: silentLogger, max: 1, readOnly: true, applicationName: 'neurolingo-telemetry-it-ro' });
        try {
            const stats = await getStats(ro.pool, { windowMinutes: 5 });
            assert.equal(typeof stats.rowsWritten, 'number');
            // If this ever succeeded it would land under this run's test session, which `after` deletes.
            await assert.rejects(ro.pool.query('INSERT INTO telemetry.rest_minutes (time, session_id, rest_mask, idle_ms) VALUES (date_trunc($2, now()), $1, 1, 1000)', [SESSION, 'minute']), (e: unknown) => {
                const m = (e as Error).message;
                console.log(`read-only write refused: ${ro.redact(m)}`);
                return /read[- ]only/i.test(m);
            });
        } finally {
            await ro.close();
        }
    });

    test('a synthetic test session written through the pipeline reads back as the expected numbers', async () => {
        const { events, expected } = syntheticSession();
        const log = memoryLogger();
        const pipeline = createPipeline({ source: new FakeSource(RUN, events), sink: new PgSink(conn.pool), log, describeError: (e) => conn.describe(e) });
        await pipeline.start();
        await pipeline.stop(20_000);
        const w = pipeline.writer.stats();
        assert.equal(w.unsentAtStop, 0, `rows not written: ${w.lastError ?? ''}`);
        assert.equal(w.failedFlushes, 0, w.lastError ?? '');

        // Raw rows, exactly.
        const one = async (sql: string) => (await conn.pool.query(sql, [SESSION])).rows[0] as Record<string, string | number>;
        const ev = await one('SELECT count(*)::int AS n, count(*) FILTER (WHERE false_activation)::int AS fa FROM telemetry.switch_events WHERE session_id = $1');
        assert.equal(ev.n, expected.commands);
        assert.equal(ev.fa, expected.falseActivations);
        const rest = await one('SELECT coalesce(sum(idle_ms), 0)::int AS ms, count(*)::int AS minutes, bool_and(idle_ms = bit_count(rest_mask::bit(64)) * 1000) AS consistent FROM telemetry.rest_minutes WHERE session_id = $1');
        assert.equal(rest.ms, expected.idleMs);
        assert.equal(rest.consistent, true);
        const picks = await one('SELECT count(*)::int AS n, count(time_to_pick_ms)::int AS timed FROM telemetry.picks WHERE session_id = $1');
        assert.equal(picks.n, 21);
        assert.equal(picks.timed, 21);

        // Through the continuous aggregates (refreshed now, as the 1-minute policy would within a minute).
        await refreshRecent(conn.pool);
        const stats = await getStats(conn.pool, { sessionId: SESSION, windowMinutes: 30 });
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
        assert.ok(stats.rowsWritten > 0);
        assert.ok(stats.lastWriteAt !== null && Date.now() - Date.parse(stats.lastWriteAt) < 10 * 60_000);
        console.log(`live stats for ${SESSION}: ${JSON.stringify(stats)}`);

        // Writing the same rest minutes again (a restarted writer) adds nothing: the minutes merge as a union.
        const before = await one('SELECT coalesce(sum(idle_ms), 0)::int AS ms FROM telemetry.rest_minutes WHERE session_id = $1');
        const replay = createPipeline({ source: new FakeSource(RUN, events), sink: new PgSink(conn.pool), log, describeError: (e) => conn.describe(e) });
        await replay.start();
        await replay.stop(20_000);
        const afterReplay = await one('SELECT coalesce(sum(idle_ms), 0)::int AS ms FROM telemetry.rest_minutes WHERE session_id = $1');
        assert.equal(afterReplay.ms, before.ms);
        const evAgain = await one('SELECT count(*)::int AS n FROM telemetry.switch_events WHERE session_id = $1');
        assert.equal(evAgain.n, expected.commands, 'a replayed ledger row lands once');

        // Real-usage numbers never include it.
        const realOnly = await getStats(conn.pool, { windowMinutes: 30 });
        const withTest = await getStats(conn.pool, { windowMinutes: 30, includeTest: true });
        assert.ok(withTest.commands - realOnly.commands >= expected.commands, 'the default stats leave test sessions out');
        assert.equal(log.lines.filter((l) => /password|postgres(ql)?:\/\//i.test(l)).length, 0);
    });

    test('a row older than the refresh window still reaches its aggregate (the sink refreshes it)', async () => {
        const old: PickRow = {
            time: BigInt(Date.now() - 4 * 86_400_000) * 1_000n,
            sessionId: SESSION,
            ledgerId: 999_999n,
            questionId: 1n,
            optionRank: 1,
            pickKind: 'reply',
            timeToPickMs: 1_234,
            lateByMs: 0,
        };
        backlog = backlogRange([old], Date.now());
        assert.ok(backlog, 'four days old is a backlog');
        await new PgSink(conn.pool).insert('picks', [old]);
        const r = (await conn.pool.query(
            "SELECT coalesce(sum(picks), 0)::int AS n FROM telemetry.picks_1m WHERE session_id = $1 AND bucket < now() - INTERVAL '3 days'",
            [SESSION],
        )).rows[0] as { n: number };
        assert.equal(r.n, 1);
    });

    test('the live server is refused under a CA that is not the pin, and under a host it does not hold', async () => {
        const { target } = await loadTarget();
        const loaded = loadPin();
        // A throwaway CA, made here, deleted after.
        execFileSync(process.env.OPENSSL ?? 'openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'k.pem', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=not timescale',
            '-addext', 'basicConstraints=critical,CA:TRUE'], { cwd: tmp, stdio: 'pipe' });
        const otherCa = readFileSync(join(tmp, 'ca.pem'), 'utf8');
        const tryWith = async (host: string, ssl: ReturnType<typeof pinnedSsl>) => {
            const client = new pg.Client(poolConfig({ ...target, host }, ssl, { statementTimeoutMs: 5_000 }));
            try {
                await client.connect();
                await client.query('SELECT 1');
                return 'connected';
            } catch (error) {
                return conn.redact((error as Error).message);
            } finally {
                await client.end().catch(() => {});
            }
        };
        const wrongCa = await tryWith(target.host, pinnedSsl(target, { ...loaded, caPem: otherCa }));
        assert.match(wrongCa, /certificate/i);
        // Reach the real service (real SNI, so its proxy routes us and presents the real chain), but run the host
        // check for a name the live leaf does not hold: the check must refuse it.
        const right = pinnedSsl(target, loaded);
        const elsewhere = pinnedSsl({ host: 'telemetry.example.com', port: target.port }, { ...loaded, pin: { ...loaded.pin, host: 'telemetry.example.com' } });
        const wrongHost = await tryWith(target.host, { ...right, checkServerIdentity: (_host, cert) => elsewhere.checkServerIdentity!('telemetry.example.com', cert) });
        assert.match(wrongHost, /TLS host check failed/);
        // And the right pin still connects, by the same path.
        assert.equal(await tryWith(target.host, pinnedSsl(target, loaded)), 'connected');
    });
});
