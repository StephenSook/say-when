import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { fetchRawStats, percentileCont, sessionFilter, summarize, type RawStats } from '../src/stats.js';

const asOf = new Date('2026-10-25T17:45:30.000Z');
const windowStart = new Date('2026-10-25T17:16:00.000Z'); // 30 one-minute buckets ending with 17:45

function raw(patch: Partial<RawStats> = {}): RawStats {
    return {
        asOf,
        windowStart,
        falseActivations: 3,
        commands: 59,
        yesActedAtRest: 1,
        idleMs: 12 * 60_000,
        timedPicks: 9,
        p50: 2_812.4,
        p95: 4_960.6,
        percentiles: 'toolkit',
        rowsWritten: 1_234,
        lastWriteAt: new Date('2026-10-25T17:45:29.500Z'),
        input: 'headset',
        sessionInput: null,
        ...patch,
    };
}

describe('the dashboard numbers', () => {
    test('false activations per idle minute divide by rest, not by the window', () => {
        const s = summarize(raw());
        assert.equal(s.falseActivationsPerIdleMinute, 0.25); // 3 in 12 idle minutes
        assert.equal(s.idleMinutes, 12);
        assert.equal(s.falseActivations, 3);
    });

    test('the rate stays null until the window holds a minute of rest, and is zero when there were none', () => {
        assert.equal(summarize(raw({ idleMs: 30_000, falseActivations: 1 })).falseActivationsPerIdleMinute, null);
        assert.equal(summarize(raw({ idleMs: 0, falseActivations: 0 })).falseActivationsPerIdleMinute, null);
        assert.equal(summarize(raw({ idleMs: 5 * 60_000, falseActivations: 0 })).falseActivationsPerIdleMinute, 0);
        assert.equal(summarize(raw({ idleMs: 30_000, falseActivations: 1 }), { minIdleMinutes: 0.25 }).falseActivationsPerIdleMinute, 2);
    });

    test('commands per minute divide by the minutes the window has actually covered', () => {
        // 17:16:00 to 17:45:30 is 29.5 minutes.
        assert.equal(summarize(raw()).commandsPerMinute, 2);
        assert.equal(summarize(raw({ commands: 0 })).commandsPerMinute, 0);
    });

    test('percentiles round to whole ms, carry their count and method, and vanish with no timed picks', () => {
        const s = summarize(raw());
        assert.deepEqual(s.timeToPick, { p50Ms: 2812, p95Ms: 4961, picks: 9, method: 'toolkit-uddsketch' });
        assert.deepEqual(summarize(raw({ timedPicks: 0, p50: 5, p95: 5, percentiles: 'exact' })).timeToPick, { p50Ms: null, p95Ms: null, picks: 0, method: 'exact' });
    });

    test('rows written and the last write pass through as stored', () => {
        const s = summarize(raw());
        assert.equal(s.rowsWritten, 1_234);
        assert.equal(s.lastWriteAt, '2026-10-25T17:45:29.500Z');
        assert.equal(summarize(raw({ lastWriteAt: null })).lastWriteAt, null);
        assert.equal(s.windowStart, '2026-10-25T17:16:00.000Z');
    });
});

describe('which sessions count, by input (T1)', () => {
    /** A pool that records every statement and answers with fixed rows, so the filter's parameters can be read. */
    function stubPool(stored: string | null = 'keyboard') {
        const calls: Array<{ sql: string; params: unknown[] }> = [];
        const pool = {
            query: async (sql: string, params: unknown[] = []) => {
                calls.push({ sql, params });
                if (sql.includes('telemetry.migrations')) return { rows: [{ variant: 'toolkit' }] };
                if (sql.startsWith('WITH w AS')) return { rows: [{ as_of: asOf, start: windowStart, false_activations: 0, commands: 4, yes_acted: 0, idle_ms: 0 }] };
                if (sql.includes('FROM telemetry.picks_1m')) return { rows: [{ n: 0, p50: null, p95: null }] };
                if (sql.startsWith('SELECT input FROM telemetry.session_inputs')) return { rows: stored === null ? [] : [{ input: stored }] };
                return { rows: [{ n: 9, last: null }] };
            },
        };
        return { pool: pool as never, calls };
    }
    /** Every $n a statement uses has a parameter, and every parameter is used. */
    const placeholdersMatch = (c: { sql: string; params: unknown[] }) => {
        const used = new Set([...c.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
        return used.size === c.params.length && [...used].every((n) => n >= 1 && n <= c.params.length);
    };

    test('with no session, only headset sessions count by default, and any input can be asked for', async () => {
        const { pool, calls } = stubPool();
        const s = summarize(await fetchRawStats(pool));
        assert.equal(s.input, 'headset');
        assert.equal(s.sessionInput, null);
        const filtered = calls.filter((c) => c.sql.includes('telemetry.session_inputs i'));
        assert.equal(filtered.length, 3, 'counts, picks and rows written all filter by input');
        for (const c of filtered) {
            assert.equal(c.params.at(-1), 'headset');
            assert.ok(placeholdersMatch(c), c.sql);
        }
        assert.ok(!calls.some((c) => c.sql.startsWith('SELECT input FROM')), 'no session was named');
        const any = stubPool();
        assert.equal(summarize(await fetchRawStats(any.pool, { input: 'any' })).input, 'any');
        assert.equal(any.calls.filter((c) => c.params.at(-1) === 'any').length, 3);
        await assert.rejects(fetchRawStats(stubPool().pool, { input: 'brain' as never }), RangeError);
    });

    test('a named session is read whatever its input, and its stored input is returned', async () => {
        const { pool, calls } = stubPool('keyboard');
        const s = summarize(await fetchRawStats(pool, { sessionId: 'say-when-dev:13', input: 'headset' }));
        assert.equal(s.input, 'any');
        assert.equal(s.sessionInput, 'keyboard');
        for (const c of calls.filter((c) => c.sql.includes('telemetry.session_inputs i'))) {
            assert.equal(c.params[0], 'say-when-dev:13');
            assert.equal(c.params.at(-1), 'any');
        }
        assert.equal(summarize(await fetchRawStats(stubPool(null).pool, { sessionId: 'say-when-dev:13' })).sessionInput, null);
        assert.equal(summarize(await fetchRawStats(stubPool('label-text').pool, { sessionId: 'say-when-dev:13' })).sessionInput, null);
    });

    test('the filter: a named session by equality alone; otherwise the test rule and the input rule together', () => {
        const f = sessionFilter(4);
        assert.equal(
            f,
            "(($1::text IS NOT NULL AND session_id = $1::text) OR ($1::text IS NULL AND ($2::boolean OR session_id NOT LIKE 'test-%') AND ($4::text = 'any' OR session_id IN (SELECT i.session_id FROM telemetry.session_inputs i WHERE i.input = $4::text))))",
        );
    });
});

describe('percentile_cont', () => {
    test('matches Postgres interpolation on known values', () => {
        const ms = [1_200, 1_900, 2_300, 2_800, 3_100, 3_600, 4_200, 5_000, 6_400, 9_000];
        assert.equal(percentileCont(ms, 0.5), 3_350);
        assert.ok(Math.abs(percentileCont(ms, 0.95)! - 7_830) < 1e-9); // 6400 + 2600 * 0.55
        assert.equal(percentileCont([5], 0.95), 5);
        assert.equal(percentileCont([], 0.5), null);
        // Postgres: SELECT percentile_cont(ARRAY[0.5,0.95]) WITHIN GROUP (ORDER BY x) FROM generate_series(1,1000) x = {500.5, 950.05}
        const series = Array.from({ length: 1_000 }, (_, i) => i + 1);
        assert.equal(percentileCont(series, 0.5), 500.5);
        assert.ok(Math.abs(percentileCont(series, 0.95)! - 950.05) < 1e-9);
    });
});
