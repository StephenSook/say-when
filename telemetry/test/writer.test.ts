import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { memoryLogger } from '../src/log.js';
import type { RestMinuteRow, SwitchEventRow } from '../src/types.js';
import { TelemetryWriter } from '../src/writer.js';
import { LEAKY_ERROR_TEXT, ManualTimers, MemorySink, restRow, settle, switchRow } from './helpers.js';

function setup(opts: { maxBatch?: number; capacity?: number; beforeFlush?: () => void } = {}) {
    const timers = new ManualTimers();
    const sink = new MemorySink();
    const log = memoryLogger();
    const writer = new TelemetryWriter({ sink, log, timers, maxBatch: opts.maxBatch ?? 500, capacity: opts.capacity ?? 1_000, beforeFlush: opts.beforeFlush });
    return { timers, sink, log, writer };
}

describe('batching', () => {
    test('rows go out on the one-second tick, at most maxBatch per insert, each once', async () => {
        const { timers, sink, writer } = setup({ maxBatch: 3 });
        for (let i = 0; i < 7; i++) writer.push(switchRow());
        writer.start();
        await timers.advance(999);
        assert.equal(sink.count('switch_events'), 0, 'nothing before the first tick');
        await timers.advance(1);
        assert.equal(sink.count('switch_events'), 7);
        assert.deepEqual(
            sink.calls.map((c) => c.count),
            [3, 3, 1],
        );
        assert.equal(writer.stats().written.switch_events, 7);
        assert.equal(writer.size, 0);
        await writer.stop();
    });

    test('flushes never overlap', async () => {
        const { sink, writer } = setup();
        let open!: () => void;
        sink.gate = new Promise((r) => (open = r));
        writer.push(switchRow());
        const a = writer.flush();
        const b = writer.flush();
        assert.equal(a, b);
        open();
        assert.equal(await a, true);
        assert.equal(sink.calls.length, 1);
    });

    test('rows for several tables in one batch go to their own tables', async () => {
        const { sink, writer } = setup();
        writer.push(switchRow());
        writer.push(restRow(0, [1]));
        writer.push(switchRow());
        await writer.flush();
        assert.equal(sink.count('switch_events'), 2);
        assert.equal(sink.count('rest_minutes'), 1);
    });
});

describe('outage handling', () => {
    test('a Tiger outage keeps the rows, retries with a doubling wait, then writes them all', async () => {
        const { timers, sink, log, writer } = setup();
        sink.failNext = 3;
        for (let i = 0; i < 5; i++) writer.push(switchRow());
        writer.start();
        await timers.advance(1_000); // fail 1, wait 1 s
        assert.equal(writer.stats().consecutiveFailures, 1);
        await timers.advance(1_000); // fail 2, wait 2 s
        assert.equal(writer.stats().consecutiveFailures, 2);
        await timers.advance(1_000);
        assert.equal(sink.calls.length, 2, 'no retry before the 2 s wait is over');
        await timers.advance(1_000); // fail 3, wait 4 s
        assert.equal(writer.stats().consecutiveFailures, 3);
        await timers.advance(4_000); // success
        assert.equal(sink.count('switch_events'), 5);
        const s = writer.stats();
        assert.equal(s.failedFlushes, 3);
        assert.equal(s.consecutiveFailures, 0);
        assert.equal(s.dropped.switch_events, 0);
        assert.equal(s.queued, 0);
        assert.ok(log.lines.some((l) => l.includes('Tiger write failed')));
        assert.ok(log.lines.some((l) => l.includes('Tiger is writable again')));
        await writer.stop();
    });

    test('an outage error never surfaces the password or the connection string', async () => {
        const { sink, log, writer } = setup();
        sink.failAlways = true;
        writer.push(switchRow());
        writer.start();
        await writer.flush();
        const text = [writer.stats().lastError ?? '', ...log.lines].join('\n');
        assert.ok(writer.stats().lastError?.includes('[redacted]'));
        assert.ok(!text.includes('Sup3rSecretPw'));
        assert.ok(!text.includes(LEAKY_ERROR_TEXT));
        await writer.stop(10);
    });

    test('past capacity the oldest rows are dropped and counted, and memory stays bounded', async () => {
        const { sink, writer } = setup({ capacity: 10 });
        sink.failAlways = true;
        for (let i = 1; i <= 25; i++) writer.push(switchRow(1_000 + i));
        assert.equal(writer.size, 10);
        assert.equal(writer.stats().dropped.switch_events, 15);
        writer.start();
        await writer.flush(); // fails, rows go back, still bounded
        assert.equal(writer.size, 10);
        sink.failAlways = false;
        await writer.flush();
        const kept = (sink.rows.get('switch_events') as SwitchEventRow[]).map((r) => Number(r.ledgerId));
        assert.deepEqual(kept, [1016, 1017, 1018, 1019, 1020, 1021, 1022, 1023, 1024, 1025]);
        await writer.stop();
    });

    test('dropped rows release their memory: a burst far past capacity keeps the queue near its cap', () => {
        const { writer } = setup({ capacity: 10 });
        for (let i = 0; i < 10_000; i++) writer.push(switchRow(i));
        assert.equal(writer.size, 10);
        assert.equal(writer.stats().dropped.switch_events, 9_990);
        assert.ok(writer.retained <= 10 + 1_024, `the backing array holds ${writer.retained} slots`);
    });

    test('stop writes what it can and resolves even while Tiger is down, and counts what it lost', async () => {
        const { sink, log, writer } = setup();
        sink.failAlways = true;
        writer.push(switchRow());
        writer.start();
        await writer.stop(50);
        assert.ok(log.lines.some((l) => l.includes('stopped before every row was written')));
        assert.equal(writer.stats().unsentAtStop, 1);
    });

    test('stop waits for a batch already out instead of returning under it', async () => {
        const { timers, sink, writer } = setup();
        let open!: () => void;
        sink.gate = new Promise((r) => (open = r));
        writer.push(switchRow());
        writer.start();
        const inflight = writer.flush(); // the row has left the queue
        assert.equal(writer.size, 0);
        let stopped = false;
        const stopping = writer.stop(5_000).then(() => {
            stopped = true;
        });
        await settle();
        assert.equal(stopped, false, 'stop is waiting for the insert');
        open();
        await inflight;
        await stopping;
        assert.equal(sink.count('switch_events'), 1);
        assert.equal(writer.stats().unsentAtStop, 0);
        void timers;
    });

    test('stop gives up at its deadline on an insert that hangs, and says the row was not written', async () => {
        const { timers, sink, writer } = setup();
        sink.gate = new Promise(() => {}); // never answers
        writer.push(switchRow());
        writer.start();
        void writer.flush();
        let stopped = false;
        const stopping = writer.stop(100).then(() => {
            stopped = true;
        });
        await timers.advance(99);
        assert.equal(stopped, false);
        await timers.advance(1);
        await stopping;
        assert.equal(writer.stats().unsentAtStop, 1);
        assert.equal(writer.stats().inFlight, 1);
    });

    test('a failing pre-flush hook is logged and the loop keeps going', async () => {
        const { timers, sink, log, writer } = setup({
            beforeFlush: () => {
                throw new Error('hook broke');
            },
        });
        writer.push(switchRow());
        writer.start();
        await timers.advance(1_000);
        assert.equal(sink.count('switch_events'), 1);
        assert.ok(log.lines.some((l) => l.includes('the pre-flush hook failed')));
        await timers.advance(1_000);
        assert.ok(timers.pending > 0, 'the next tick is scheduled');
        writer.push(switchRow());
        await timers.advance(1_000);
        assert.equal(sink.count('switch_events'), 2);
        await writer.stop();
    });
});

describe('back-pressure', () => {
    test('whenWritable waits until the queue drains below the low-water mark', async () => {
        const { timers, writer } = setup({ capacity: 10 }); // high water 8, low water 5
        writer.start();
        for (let i = 0; i < 9; i++) writer.push(switchRow());
        assert.equal(writer.pressure, true);
        let resolved = false;
        const waiting = writer.whenWritable().then(() => {
            resolved = true;
        });
        await settle();
        assert.equal(resolved, false, 'still above the high-water mark');
        await timers.advance(0); // pressure kicks an immediate flush
        await waiting;
        assert.equal(resolved, true);
        assert.equal(writer.size, 0);
        await writer.stop();
    });

    test('below the high-water mark it resolves at once', async () => {
        const { writer } = setup({ capacity: 10 });
        writer.start();
        writer.push(switchRow());
        await writer.whenWritable();
        await writer.stop();
    });
});

describe('rest minute coalescing', () => {
    test('copies of one minute merge in the queue as a union of their seconds', async () => {
        const { sink, writer } = setup();
        writer.push(restRow(60, [0, 1, 2]));
        writer.push(restRow(60, [2, 3]));
        writer.push(restRow(60, [10]));
        writer.push(restRow(120, [5]));
        assert.equal(writer.size, 2);
        await writer.flush();
        const sent = sink.rows.get('rest_minutes') as RestMinuteRow[];
        assert.deepEqual(
            sent.map((r) => [r.restMask, r.idleMs]),
            [
                [0b10000001111n, 5_000],
                [0b100000n, 1_000],
            ],
        );
    });

    test('a failed minute goes back and merges with a copy queued meanwhile, so one row is sent', async () => {
        const { sink, writer } = setup();
        let open!: () => void;
        sink.gate = new Promise((r) => (open = r));
        sink.failNext = 1;
        writer.push(restRow(60, [0, 1]));
        const inflight = writer.flush();
        writer.push(restRow(60, [1, 2])); // the tracker added seconds while the insert was out
        open();
        assert.equal(await inflight, false);
        sink.gate = null;
        assert.equal(writer.size, 1);
        await writer.flush();
        const sent = sink.rows.get('rest_minutes') as RestMinuteRow[];
        assert.deepEqual(
            sent.map((r) => [r.restMask, r.idleMs]),
            [[0b111n, 3_000]],
        );
    });
});
