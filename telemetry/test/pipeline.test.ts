import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { memoryLogger } from '../src/log.js';
import { createPipeline } from '../src/pipeline.js';
import { FakeSource } from '../src/sources/fake.js';
import { popcount, type PickRow, type RestMinuteRow, type SwitchEventRow } from '../src/types.js';
import { Scenario, sec } from './fixtures.js';
import { ManualTimers, MemorySink } from './helpers.js';

/** A short real-looking session: rest with one misfire, one question answered, then rest again. */
function session(): Scenario {
    const s = new Scenario(4n).start(sec(0)).ready().beat(2, 24);
    s.gesture(sec(25), 'NO', 'ignored:idle');
    s.beat(26, 44);
    s.ledger(sec(45), 'question', { questionId: 9n, outcome: 'asked', reason: 'voice' });
    s.preparing(sec(45), 9n).tick(sec(46)).read(sec(47), 9n, 1).tick(sec(48)).window(sec(49));
    s.beat(50, 52);
    s.read(sec(52.5), 9n, 2);
    s.pick(sec(53), 9n, 2, 'reply');
    s.gesture(sec(53), 'YES', 'accepted:pick', { questionId: 9n, optionId: 102n, cursor: 2 });
    s.veto(sec(53));
    s.idle(sec(53.7), 'picked');
    s.beat(54, 130);
    return s;
}

describe('source to tracker to writer to sink', () => {
    test('a replayed session lands as content-free rows in every table', async () => {
        const timers = new ManualTimers();
        const sink = new MemorySink();
        const pipeline = createPipeline({ source: new FakeSource('test-pipe', session().events), sink, log: memoryLogger(), timers });
        await pipeline.start();
        await timers.advance(1_000);
        await pipeline.stop();
        const events = sink.rows.get('switch_events') as SwitchEventRow[];
        assert.deepEqual(
            events.map((e) => [e.command, e.code, e.resting, e.falseActivation, e.latencyMs]),
            [
                ['NO', 'idle', true, true, null],
                ['YES', 'pick', false, false, 500],
            ],
        );
        assert.equal((sink.rows.get('picks') as PickRow[])[0]?.timeToPickMs, 500);
        assert.ok(sink.count('scan_steps') >= 6);
        const minutes = (sink.rows.get('rest_minutes') as RestMinuteRow[]).reduce((m, r) => m.set(String(r.time), (m.get(String(r.time)) ?? 0n) | r.restMask), new Map<string, bigint>());
        // Rest from 0 to 45 (the question arrives): seconds 0 to 44. Then from 53.7 to the station's last tick at 130:
        // seconds 54 to 129 (a second counts when its midpoint is at rest).
        assert.equal([...minutes.values()].reduce((a, m) => a + popcount(m), 0), 45 + 76);
        for (const e of events) assert.equal(e.sessionId, 'test-pipe:4');
    });

    test('a replay waits on the writer when the queue is under pressure', async () => {
        const timers = new ManualTimers();
        const sink = new MemorySink();
        sink.failAlways = true;
        const s = new Scenario(1n).start(sec(0)).ready();
        for (let i = 0; i < 30; i++) s.gesture(sec(1 + i), 'NO', 'ignored:idle');
        let pipeline: ReturnType<typeof createPipeline> | null = null;
        const source = new FakeSource('test-pressure', s.events, { beforeEach: () => pipeline!.writer.whenWritable() });
        pipeline = createPipeline({ source, sink, log: memoryLogger(), timers, capacity: 10 });
        const replay = pipeline.start();
        await timers.advance(100);
        assert.equal(pipeline.writer.stats().dropped.switch_events, 0, 'back-pressure, not drops');
        assert.ok(pipeline.writer.size >= 8, 'the replay paused at the high-water mark');
        sink.failAlways = false;
        await timers.advance(60_000);
        await replay;
        await pipeline.stop();
        assert.equal(sink.count('switch_events'), 30);
        assert.equal(pipeline.writer.stats().dropped.switch_events, 0);
    });

    test('a queue overflow during an outage, then a reconnect: the commands that survive and the session input both land', async () => {
        const timers = new ManualTimers();
        const sink = new MemorySink();
        sink.failAlways = true;
        const s = new Scenario(3n).start(sec(0), true, 'headset-demo').ready();
        for (let i = 0; i < 30; i++) s.gesture(sec(1 + i), 'NO', 'ignored:idle');
        // The connection drops and the snapshot replays: the same session_start row, which the tracker has seen.
        const start = s.events.find((e) => e.type === 'ledger' && e.row.kind === 'session_start')!;
        s.lost();
        s.events.push(start);
        s.ready();
        const pipeline = createPipeline({ source: new FakeSource('test-overflow', s.events), sink, log: memoryLogger(), timers, capacity: 10 });
        await pipeline.start(); // a live source cannot pause the server: past capacity the oldest rows go
        assert.ok(pipeline.writer.stats().dropped.switch_events > 0, 'the queue overflowed');
        await timers.advance(1_000); // attempt 1 fails
        await timers.advance(1_000); // attempt 2, after the 1 s wait, fails
        assert.equal(pipeline.writer.stats().failedFlushes, 2);
        // Each failed flush tried the session's input first and sent nothing after it.
        assert.deepEqual(sink.calls.map((c) => c.table), ['session_inputs', 'session_inputs']);
        sink.failAlways = false;
        await timers.advance(60_000);
        await pipeline.stop();
        const landed = sink.calls.slice(2).map((c) => c.table);
        assert.equal(landed[0], 'session_inputs', 'the input goes first in the flush that lands');
        assert.ok(landed.includes('switch_events'));
        assert.ok(sink.count('switch_events') > 0);
        assert.deepEqual(sink.rows.get('session_inputs'), [{ time: sec(0), sessionId: 'test-overflow:3', input: 'headset' }]);
        assert.equal(pipeline.writer.stats().written.session_inputs, 1);
        assert.equal(pipeline.writer.stats().dropped.session_inputs, 0);
        assert.equal(pipeline.writer.stats().failedFlushes, 2);
    });

    test('a fake source refuses a real-looking database name', () => {
        assert.throws(() => new FakeSource('say-when-demo', []), /test-/);
    });
});
