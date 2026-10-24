import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { backlogRange, BACKLOG_AFTER_MS, buildInsert, insertParams, microsToIso, OLDEST_ROW_MS, PgSink, SPECS } from '../src/sink.js';
import { TABLE_NAMES } from '../src/types.js';
import { BASE } from './fixtures.js';
import { restRow, switchRow } from './helpers.js';

describe('inserts', () => {
    test('one numbered placeholder per value, rows in order, and the right conflict clause', () => {
        const sql = buildInsert('switch_events', 2);
        assert.match(sql, /^INSERT INTO telemetry\.switch_events \(time, session_id, ledger_id, command, outcome, code, resting, false_activation, heard_step_seq, option_rank, heard_in, latency_ms, late_by_ms\) VALUES \(\$1, .*\$13\), \(\$14, .*\$26\) ON CONFLICT DO NOTHING$/);
        assert.ok(!SPECS.switch_events.columns.includes('gesture_id'), 'the station-chosen gesture id is never stored');
        const rest = buildInsert('rest_minutes', 1);
        assert.match(rest, /ON CONFLICT \(session_id, time\) DO UPDATE SET rest_mask = telemetry\.rest_minutes\.rest_mask \| EXCLUDED\.rest_mask/);
        assert.match(rest, /idle_ms = bit_count\(\(telemetry\.rest_minutes\.rest_mask \| EXCLUDED\.rest_mask\)::bit\(64\)\) \* 1000/);
    });

    test('params line up with the columns for every table', () => {
        for (const table of TABLE_NAMES) assert.ok(SPECS[table].columns.length > 2, table);
        const r = switchRow(5);
        const params = insertParams('switch_events', [r.row as never, r.row as never]);
        assert.equal(params.length, SPECS.switch_events.columns.length * 2);
        assert.equal(params[2], '5'); // ledger_id as a string, so no bigint precision is lost
        const m = restRow(60, [0, 1, 59]);
        assert.deepEqual(insertParams('rest_minutes', [m.row as never]).slice(1), ['test-unit:1', ((1n << 59n) | 3n).toString(), 3000]);
    });

    test('server timestamps keep all six fractional digits', () => {
        assert.equal(microsToIso(1_761_300_000_123_456n), '2025-10-24T10:00:00.123456Z');
        assert.equal(microsToIso(1_761_300_000_000_001n), '2025-10-24T10:00:00.000001Z');
        assert.throws(() => microsToIso(-1n), RangeError);
    });
});

describe('rows older than the aggregates refresh on their own', () => {
    const now = Number(BASE / 1000n);
    const at = (msAgo: number) => ({ time: BigInt(now - msAgo) * 1000n });

    test('recent rows need nothing; a backlog gets the minute range of its old rows only', () => {
        assert.equal(backlogRange([at(1_000), at(60_000)], now), null);
        assert.equal(backlogRange([at(BACKLOG_AFTER_MS - 1_000)], now), null);
        // A current row in the same batch never pulls the range forward: refreshing the still-filling minute would
        // move the watermark past it and hide its later rows from the real-time view.
        const r = backlogRange([at(4 * 86_400_000 + 30_000), at(4 * 86_400_000 - 90_000), at(5_000)], now);
        assert.deepEqual(r, {
            from: microsToIso(BASE - 4n * 86_400_000_000n - 60_000_000n),
            to: microsToIso(BASE - 4n * 86_400_000_000n + 120_000_000n),
        });
        assert.equal(backlogRange([], now), null);
    });

    test('rows older than six days are never refreshed: raw retention may already have removed their neighbours', () => {
        assert.equal(OLDEST_ROW_MS, 6 * 86_400_000);
        assert.equal(backlogRange([at(OLDEST_ROW_MS + 60_000)], now), null);
        assert.equal(backlogRange([at(10 * 86_400_000)], now), null);
        const r = backlogRange([at(10 * 86_400_000), at(5 * 86_400_000)], now);
        assert.deepEqual(r, { from: microsToIso(BASE - 5n * 86_400_000_000n), to: microsToIso(BASE - 5n * 86_400_000_000n + 60_000_000n) });
    });

    test('the sink refuses rows older than six days, counts them, and sends nothing for them', async () => {
        const sent: string[] = [];
        const pool = { query: async (sql: string) => void sent.push(sql) } as never;
        const sink = new PgSink(pool, () => now);
        const old = { time: BASE - 8n * 86_400_000_000n, sessionId: 'test-unit:1', ledgerId: 2n, questionId: 1n, optionRank: 1, pickKind: 'reply' as const, timeToPickMs: 900, lateByMs: 0 };
        await sink.insert('picks', [old]);
        assert.equal(sent.length, 0);
        assert.deepEqual(sink.tooOld, { picks: 1 });
    });

    test('the sink refreshes the matching aggregate after inserting a backlog, and only then', async () => {
        const sent: string[] = [];
        const pool = { query: async (sql: string) => void sent.push(sql) } as never;
        const sink = new PgSink(pool, () => now);
        await sink.insert('picks', [{ time: BASE - 4n * 86_400_000_000n, sessionId: 'test-unit:1', ledgerId: 1n, questionId: 1n, optionRank: 1, pickKind: 'reply', timeToPickMs: 900, lateByMs: 0 }]);
        await sink.insert('switch_events', [switchRow(9).row as never]);
        assert.equal(sent.length, 3, 'two inserts and one refresh');
        assert.match(sent[1]!, /^CALL refresh_continuous_aggregate\('telemetry\.picks_1m', '\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z'::timestamptz, '[^']+'::timestamptz\)$/);
        await sink.insert('scan_steps', [{ time: BASE - 5n * 86_400_000_000n, sessionId: 'test-unit:1', stepSeq: 1n, questionId: 0n, phase: 'idle', mode: 'answer', answerMode: 'pick', cursor: 0, optionCount: 0, pass: 0, plannedMs: 0, outcome: null, pauseReason: null }]);
        assert.equal(sent.length, 4, 'scan_steps has no aggregate to refresh');
    });
});
