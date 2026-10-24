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

/** One session's input row (session metadata). */
const inputRow = (n: number) => ({ table: 'session_inputs' as const, row: { time: 1_000_000n, sessionId: `test-unit:${n}`, input: 'headset' as const } });
/** A command of session `n`, with ledger id `id`. */
const cmd = (id: number, n: number) => ({ table: 'switch_events' as const, row: { ...(switchRow(id).row as SwitchEventRow), sessionId: `test-unit:${n}` } });

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

    test("a full queue never drops a session's input: it is not queued, every failed attempt tries it first, and it lands with the surviving commands", async () => {
        const { timers, sink, writer } = setup({ capacity: 5 });
        sink.failAlways = true;
        writer.push(inputRow(1));
        writer.push(inputRow(1)); // the same session's input again: kept once
        for (let i = 1; i <= 20; i++) writer.push(cmd(2_000 + i, 1));
        assert.equal(writer.stats().dropped.session_inputs, 0);
        assert.equal(writer.stats().dropped.switch_events, 15);
        assert.equal(writer.stats().queued, 5, 'the input is not in the queue');
        writer.start();
        await timers.advance(1_000); // attempt 1 at 1 s fails; the wait is 1 s
        await timers.advance(2_000); // attempt 2 at 2 s fails; the wait is 2 s, so nothing at 3 s
        assert.equal(writer.stats().failedFlushes, 2, 'each failed flush counts once');
        // Each failed attempt tried the input first and sent nothing of the batch after it failed.
        assert.deepEqual(sink.calls.map((c) => [c.table, c.count]), [['session_inputs', 1], ['session_inputs', 1]]);
        sink.failAlways = false;
        await timers.advance(1_000); // attempt 3 at 4 s lands: the input, then the batch, in one flush
        assert.deepEqual(sink.calls.slice(2).map((c) => [c.table, c.count]), [['session_inputs', 1], ['switch_events', 5]]);
        assert.deepEqual(sink.rows.get('session_inputs'), [inputRow(1).row]);
        writer.push(cmd(3_000, 1));
        await timers.advance(1_000);
        assert.deepEqual(sink.calls.slice(4).map((c) => c.table), ['switch_events'], 'a written input is not sent again');
        assert.equal(writer.stats().written.session_inputs, 1);
        assert.equal(writer.stats().failedFlushes, 2);
        await writer.stop();
        assert.equal(writer.stats().unsentAtStop, 0);
    });

    test('a flush that fails then succeeds: rows and their input are retried together, and a written input is not resent', async () => {
        // The input's insert fails: nothing of the batch is sent, and the next flush sends both.
        const a = setup();
        a.writer.push(inputRow(1));
        a.writer.push(cmd(1, 1));
        a.writer.push(cmd(2, 1));
        a.sink.failNext = 1;
        assert.equal(await a.writer.flush(), false);
        assert.deepEqual(a.sink.calls.map((c) => c.table), ['session_inputs']);
        assert.equal(a.writer.size, 2, 'the batch went back to the queue');
        assert.equal(await a.writer.flush(), true);
        assert.deepEqual(a.sink.calls.slice(1).map((c) => [c.table, c.count]), [['session_inputs', 1], ['switch_events', 2]]);
        assert.equal(a.writer.stats().failedFlushes, 1);
        // The input lands and the batch's insert fails: the batch is retried alone, the input is not sent twice.
        const b = setup();
        b.writer.push(inputRow(1));
        b.writer.push(cmd(1, 1));
        b.sink.failTable = 'switch_events';
        assert.equal(await b.writer.flush(), false);
        assert.deepEqual(b.sink.calls.map((c) => c.table), ['session_inputs', 'switch_events']);
        b.sink.failTable = null;
        assert.equal(await b.writer.flush(), true);
        assert.deepEqual(b.sink.calls.slice(2).map((c) => c.table), ['switch_events']);
        assert.equal(b.sink.count('session_inputs'), 1);
        assert.equal(b.writer.stats().failedFlushes, 1);
    });

    test('stop() sends the pending rows with their input, and with Tiger down counts the rows it could not write', async () => {
        const a = setup();
        a.writer.push(inputRow(1));
        a.writer.push(cmd(1, 1));
        a.writer.push(cmd(2, 1));
        await a.writer.stop();
        assert.deepEqual(a.sink.calls.map((c) => [c.table, c.count]), [['session_inputs', 1], ['switch_events', 2]]);
        assert.equal(a.writer.stats().unsentAtStop, 0);
        const b = setup();
        b.sink.failAlways = true;
        b.writer.push(inputRow(1));
        b.writer.push(cmd(1, 1));
        await b.writer.stop(1_000);
        assert.deepEqual(b.sink.calls.map((c) => c.table), ['session_inputs'], 'one attempt, input first');
        assert.equal(b.writer.stats().unsentAtStop, 2, 'the command and its input');
        assert.equal(b.writer.stats().inputsUnsentAtStop, 1);
        assert.ok(b.log.lines.some((l) => l.includes('"inputsNotWritten":1')));
        // Three inputs, maxBatch 2, one command: stop sends the input left over after the batch on its own.
        const c = setup({ maxBatch: 2 });
        for (let i = 1; i <= 3; i++) c.writer.push(inputRow(i));
        c.writer.push(cmd(1, 3));
        await c.writer.stop();
        assert.deepEqual(c.sink.calls.map((x) => [x.table, x.count]), [['session_inputs', 2], ['switch_events', 1], ['session_inputs', 1]]);
        assert.equal(c.sink.count('session_inputs'), 3);
        assert.equal(c.writer.stats().unsentAtStop, 0);
        assert.equal(c.writer.stats().inputsUnsentAtStop, 0);
        // The same, with Tiger gone before the last input: stop reports it, though no command row is left.
        const d = setup({ maxBatch: 2 });
        for (let i = 1; i <= 3; i++) d.writer.push(inputRow(i));
        d.writer.push(cmd(1, 3));
        assert.equal(await d.writer.flush(), true);
        d.sink.failAlways = true;
        await d.writer.stop(1_000);
        assert.equal(d.writer.size, 0);
        assert.equal(d.writer.stats().unsentAtStop, 1);
        assert.equal(d.writer.stats().inputsUnsentAtStop, 1);
        assert.ok(d.log.lines.some((l) => l.includes('stopped before every row was written') && l.includes('"inputsNotWritten":1')));
    });

    test('an input that becomes known after its session\'s command was written is sent on the next tick, once', async () => {
        const { timers, sink, writer } = setup();
        writer.push(cmd(1, 7));
        writer.start();
        await timers.advance(1_000); // the command is written; its session's input is not known yet
        assert.deepEqual(sink.calls.map((c) => c.table), ['switch_events']);
        writer.push({ table: 'session_inputs', row: { time: 1_000_000n, sessionId: 'test-unit:7', input: 'headset' } });
        await timers.advance(10_000);
        assert.deepEqual(sink.calls.slice(1).map((c) => [c.table, c.count]), [['session_inputs', 1]], 'one attempt with an empty queue');
        assert.deepEqual(sink.rows.get('session_inputs'), [{ time: 1_000_000n, sessionId: 'test-unit:7', input: 'headset' }]);
        await writer.stop();
        assert.equal(writer.stats().unsentAtStop, 0);
        // The same with the input's first insert failing: retried on the normal wait, counted once, then it lands.
        const f = setup();
        f.writer.push(cmd(1, 8));
        f.writer.start();
        await f.timers.advance(1_000);
        f.sink.failNext = 1;
        f.writer.push({ table: 'session_inputs', row: { time: 1_000_000n, sessionId: 'test-unit:8', input: 'headset' } });
        await f.timers.advance(1_000); // tick at 2 s: the inputs-only flush fails; the wait is 1 s
        assert.equal(f.writer.stats().failedFlushes, 1);
        assert.equal(f.writer.stats().consecutiveFailures, 1);
        assert.deepEqual(f.sink.calls.map((c) => c.table), ['switch_events', 'session_inputs']);
        assert.equal(f.sink.count('session_inputs'), 0);
        await f.timers.advance(1_000); // tick at 3 s: the retry lands
        await f.timers.advance(5_000); // and nothing more is sent
        assert.deepEqual(f.sink.calls.map((c) => c.table), ['switch_events', 'session_inputs', 'session_inputs']);
        assert.equal(f.sink.count('session_inputs'), 1);
        assert.equal(f.writer.stats().failedFlushes, 1);
        assert.equal(f.writer.stats().consecutiveFailures, 0);
        await f.writer.stop();
    });

    test("the inputs sent with a batch are its sessions' first, at most maxBatch, and never take the batch's room", async () => {
        const { sink, writer } = setup({ maxBatch: 2 });
        for (let i = 1; i <= 3; i++) writer.push(inputRow(i));
        writer.push(cmd(1, 3));
        assert.equal(await writer.flush(), true);
        assert.deepEqual(sink.calls.map((c) => [c.table, c.count]), [['session_inputs', 2], ['switch_events', 1]]);
        assert.deepEqual((sink.rows.get('session_inputs') as Array<{ sessionId: string }>).map((r) => r.sessionId), ['test-unit:3', 'test-unit:1']);
        writer.push(cmd(2, 2));
        assert.equal(await writer.flush(), true);
        assert.deepEqual((sink.rows.get('session_inputs') as Array<{ sessionId: string }>).map((r) => r.sessionId), ['test-unit:3', 'test-unit:1', 'test-unit:2']);
        assert.equal(sink.count('switch_events'), 2);
    });

    test('back-pressure is the queue alone, and a replay waiting for room is released once a retried flush lands', async () => {
        const { timers, sink, writer } = setup({ capacity: 5 });
        for (let i = 1; i <= 50; i++) writer.push(inputRow(i)); // inputs are not queued, so they add no pressure
        assert.equal(writer.pressure, false);
        for (let i = 1; i <= 4; i++) writer.push(cmd(4_000 + i, 1));
        assert.equal(writer.pressure, true);
        writer.start();
        let writable = false;
        void writer.whenWritable().then(() => (writable = true));
        sink.failNext = 1;
        await timers.advance(1_000); // the flush fails on the inputs: the commands stay queued, the replay waits
        assert.equal(writer.stats().failedFlushes, 1);
        assert.equal(writable, false);
        await timers.advance(1_000); // the retry lands
        assert.equal(sink.count('switch_events'), 4);
        assert.equal(writable, true);
        await writer.stop();
    });

    test('many sessions during an outage: inputs stay out of the queue, and each insert of them is at most maxBatch rows', async () => {
        const { timers, sink, writer } = setup({ capacity: 5, maxBatch: 50 });
        sink.failAlways = true;
        for (let i = 1; i <= 1_000; i++) {
            writer.push(inputRow(i));
            writer.push(cmd(i, i));
        }
        assert.equal(writer.stats().queued, 5);
        writer.start();
        await timers.advance(1_000);
        assert.deepEqual(sink.calls.map((c) => [c.table, c.count]), [['session_inputs', 50]]);
        sink.failAlways = false;
        await timers.advance(1_000);
        const ok = sink.calls.slice(1);
        assert.deepEqual(ok.slice(0, 2).map((c) => [c.table, c.count]), [['session_inputs', 50], ['switch_events', 5]]);
        // The five surviving commands' sessions come first in the inputs that went with them.
        const sent = (sink.rows.get('session_inputs') as Array<{ sessionId: string }>).map((r) => r.sessionId);
        assert.deepEqual(sent.slice(0, 5), ['test-unit:996', 'test-unit:997', 'test-unit:998', 'test-unit:999', 'test-unit:1000']);
        // The other sessions' inputs follow on their own, 50 per insert, in the same tick.
        assert.deepEqual(ok.slice(2).map((c) => [c.table, c.count]), Array.from({ length: 19 }, () => ['session_inputs', 50]));
        assert.equal(sink.count('session_inputs'), 1_000);
        for (const c of sink.calls) assert.ok(c.count <= 50);
        await writer.stop();
        assert.equal(writer.stats().unsentAtStop, 0);
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
