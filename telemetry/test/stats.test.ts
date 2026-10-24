import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { percentileCont, summarize, type RawStats } from '../src/stats.js';

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
