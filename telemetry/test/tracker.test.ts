import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { FakeEvent } from '../src/sources/fake.js';
import { restMasks, Tracker } from '../src/tracker.js';
import { popcount, type TelemetryRow } from '../src/types.js';
import { BASE, restSeconds, restTotalMs, rowsOf, Scenario, sec, STATION } from './fixtures.js';

function feed(tracker: Tracker, events: readonly FakeEvent[]): void {
    for (const e of events) {
        if (e.type === 'ledger') tracker.ledger(e.row);
        else if (e.type === 'scan') tracker.scan(e.row);
        else if (e.type === 'action') tracker.action(e.row);
        else if (e.type === 'device') tracker.device(e.row);
        else if (e.type === 'ready') tracker.markReady();
        else tracker.markLost();
    }
}

function play(events: readonly FakeEvent[]) {
    const rows: TelemetryRow[] = [];
    const tracker = new Tracker({ database: 'test-unit', emit: (r) => rows.push(r) });
    feed(tracker, events);
    tracker.checkpoint();
    return { rows, tracker };
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

describe('mapping events to rows', () => {
    test('a pick gesture becomes a switch event timed from the heard option', () => {
        const s = new Scenario().start(sec(0)).ready();
        s.preparing(sec(1), 7n).read(sec(2), 7n, 1).window(sec(4));
        const heard = s.step;
        s.pick(sec(4.8), 7n, 1, 'reply');
        s.gesture(sec(4.8), 'YES', 'accepted:pick', { heard, questionId: 7n, optionId: 101n, cursor: 1 });
        s.veto(sec(4.8));
        const { rows } = play(s.events);
        const [e] = rowsOf(rows, 'switch_events');
        assert.ok(e);
        assert.equal(e.command, 'YES');
        assert.equal(e.outcome, 'accepted');
        assert.equal(e.code, 'pick');
        assert.equal(e.latencyMs, 2800);
        assert.equal(e.heardIn, 'window');
        assert.equal(e.optionRank, 1);
        assert.equal(e.lateByMs, 0);
        assert.equal(e.resting, false);
        assert.equal(e.falseActivation, false);
        assert.equal(e.sessionId, 'test-unit:1');
        const [p] = rowsOf(rows, 'picks');
        assert.ok(p);
        assert.equal(p.timeToPickMs, 2800);
        assert.equal(p.pickKind, 'reply');
        assert.equal(p.optionRank, 1);
    });

    test('a command during the reading itself is marked as heard in reading', () => {
        const s = new Scenario().start(sec(0)).ready();
        s.read(sec(2), 7n, 2);
        s.gesture(sec(3.1), 'NO', 'accepted:skip', { questionId: 7n, optionId: 102n, cursor: 2 });
        const [e] = rowsOf(play(s.events).rows, 'switch_events');
        assert.equal(e?.heardIn, 'reading');
        assert.equal(e?.latencyMs, 1100);
    });

    test('a late pick in the grace window is timed from the option before', () => {
        const s = new Scenario().start(sec(0)).ready();
        s.read(sec(2), 7n, 1).window(sec(4));
        const heard = s.step;
        s.read(sec(7.5), 7n, 2);
        s.pick(sec(8), 7n, 1, 'errand', 500);
        s.gesture(sec(8), 'YES', 'accepted:pick_errand', { heard, questionId: 7n, optionId: 101n, cursor: 1, ms: 500 });
        const { rows } = play(s.events);
        assert.equal(rowsOf(rows, 'picks')[0]?.timeToPickMs, 6000);
        assert.equal(rowsOf(rows, 'picks')[0]?.lateByMs, 500);
        const e = rowsOf(rows, 'switch_events')[0];
        assert.equal(e?.latencyMs, 6000);
        assert.equal(e?.lateByMs, 500);
        assert.equal(e?.heardIn, 'window');
    });

    test('a yes or no answer is timed from the prompt', () => {
        const s = new Scenario().start(sec(0)).ready();
        s.read(sec(2), 8n, 0, { answerMode: 'yes_no', optionCount: 2 }).window(sec(2.9));
        const heard = s.step;
        s.pick(sec(4), 8n, 1, 'yes');
        s.gesture(sec(4), 'YES', 'accepted:answer_yes', { heard, questionId: 8n, optionId: 201n, cursor: 1 });
        const { rows } = play(s.events);
        assert.equal(rowsOf(rows, 'picks')[0]?.timeToPickMs, 2000);
        assert.equal(rowsOf(rows, 'picks')[0]?.pickKind, 'yes');
        assert.equal(rowsOf(rows, 'switch_events')[0]?.latencyMs, 2000);
    });

    test('a late pick whose gesture row never comes is timed from the reading before the current one', () => {
        const s = new Scenario().start(sec(0)).ready();
        s.read(sec(2), 9n, 1, { optionCount: 1 }).window(sec(4)).read(sec(7.5), 9n, 1, { optionCount: 1 });
        s.pick(sec(7.8), 9n, 1, 'reply', 300);
        s.tick(sec(20)); // past the pairing wait
        const { rows, tracker } = play(s.events);
        assert.equal(rowsOf(rows, 'picks')[0]?.timeToPickMs, 5800);
        assert.equal(tracker.counters.unpairedPicks, 1);
    });

    test('a pick is timed from its own gesture, even when the grace pick lands in the first millisecond of the next pass', () => {
        // The module records late_by_ms in whole milliseconds, so a sub-millisecond late pick reads as 0 there.
        for (const gestureFirst of [false, true]) {
            const s = new Scenario().start(sec(0)).ready();
            s.read(sec(2), 8n, 0, { answerMode: 'yes_no', optionCount: 2 }).window(sec(2.9));
            const heard = s.step; // the window of the first pass
            s.read(sec(6.4), 8n, 0, { answerMode: 'yes_no', optionCount: 2 }); // the prompt again, second pass
            const id = 'late-yes';
            if (gestureFirst) s.gesture(sec(6.4005), 'YES', 'accepted:answer_yes', { heard, questionId: 8n, optionId: 201n, cursor: 1, gestureId: id });
            s.pick(sec(6.4005), 8n, 1, 'yes', 0, id);
            if (!gestureFirst) s.gesture(sec(6.4005), 'YES', 'accepted:answer_yes', { heard, questionId: 8n, optionId: 201n, cursor: 1, gestureId: id });
            const { rows, tracker } = play(s.events);
            assert.equal(rowsOf(rows, 'picks')[0]?.timeToPickMs, 4400, `gesture first: ${gestureFirst}`);
            assert.equal(rowsOf(rows, 'switch_events')[0]?.latencyMs, 4400);
            assert.equal(tracker.counters.unpairedPicks, 0);
        }
    });

    test('a pick whose reading was never seen has no time, and is counted', () => {
        const s = new Scenario().start(sec(0)).ready();
        s.pick(sec(5), 3n, 2, 'reply');
        s.tick(sec(20));
        const { rows, tracker } = play(s.events);
        assert.equal(rowsOf(rows, 'picks')[0]?.timeToPickMs, null);
        assert.equal(tracker.counters.untimedPicks, 1);
    });

    test('scan rows become scan steps once each, with the planned length', () => {
        const s = new Scenario().start(sec(0)).ready();
        s.read(sec(2), 7n, 1, { dwellS: 2.15 });
        const again = s.events.at(-1)!;
        s.events.push(again);
        const steps = rowsOf(play(s.events).rows, 'scan_steps');
        assert.equal(steps.length, 2); // the start row and one reading
        assert.equal(steps[1]?.phase, 'reading');
        assert.equal(steps[1]?.plannedMs, 2150);
        assert.equal(steps[1]?.cursor, 1);
    });

    test('errand and call statuses become outcome rows once per status, at the status time', () => {
        const s = new Scenario().start(sec(0)).ready();
        s.errand(sec(10), 1n, 'drafted');
        s.errand(sec(11), 1n, 'drafted');
        s.errand(sec(13), 1n, 'previewed', sec(12));
        s.call(sec(20), 2n, 'ended', 'answered');
        s.call(sec(21), 3n, 'ended', 'hung up by a robot');
        const out = rowsOf(play(s.events).rows, 'action_outcomes');
        assert.deepEqual(
            out.map((o) => [o.kind, o.actionId, o.status, o.time, o.result]),
            [
                ['errand', 1n, 'drafted', sec(10), null],
                ['errand', 1n, 'previewed', sec(12), null],
                ['call', 2n, 'ended', sec(20), 'answered'],
                ['call', 3n, 'ended', sec(21), 'other'],
            ],
        );
    });

    test('an unknown command or a malformed gesture id is dropped, never stored', () => {
        const s = new Scenario().start(sec(0)).ready();
        s.gesture(sec(1), 'SELECT', 'accepted:pick');
        s.gesture(sec(2), 'YES', 'accepted:pick', { gestureId: 'not a valid id' });
        s.gesture(sec(3), 'YES', 'maybe');
        const { rows, tracker } = play(s.events);
        assert.equal(rowsOf(rows, 'switch_events').length, 0);
        assert.equal(tracker.counters.contractSkips, 3);
    });

    test('an odd code becomes other', () => {
        const s = new Scenario().start(sec(0)).ready();
        s.gesture(sec(1), 'NO', 'ignored:Some Words Here');
        assert.equal(rowsOf(play(s.events).rows, 'switch_events')[0]?.code, 'other');
    });
});

describe('false activations', () => {
    test('a NO at rest is a false activation, and the rest is counted', () => {
        const s = new Scenario().start(sec(0)).ready().beat(2, 40);
        s.gesture(sec(40), 'NO', 'ignored:idle');
        s.beat(42, 90);
        const { rows } = play(s.events);
        const e = rowsOf(rows, 'switch_events')[0];
        assert.equal(e?.resting, true);
        assert.equal(e?.falseActivation, true);
        assert.equal(restTotalMs(rows), 90_000);
    });

    test('a station that drops ends rest, even inside a deliberate pause the module keeps', () => {
        const s = new Scenario().start(sec(0)).ready().beat(2, 10);
        s.pause(sec(10), 'idle').beat(12, 20);
        s.station(sec(20), false); // liveness_expired: offline, last seen at 20; the pause itself does not change
        s.gesture(sec(35), 'NO', 'ignored:paused');
        s.partnerTick(sec(40));
        const { rows } = play(s.events);
        assert.equal(rowsOf(rows, 'switch_events')[0]?.resting, false);
        assert.equal(rowsOf(rows, 'switch_events')[0]?.falseActivation, false);
        assert.equal(restTotalMs(rows), 20_000);
    });

    test('an unhealthy decoder ends rest until it is healthy again', () => {
        const s = new Scenario().start(sec(0)).ready().beat(2, 4);
        s.pause(sec(5), 'stop').beat(6, 14);
        s.station(sec(15), true, false).station(sec(17), true, false).station(sec(19), true, false);
        s.gesture(sec(20), 'NO', 'ignored:paused');
        s.station(sec(21), true, false).station(sec(23), true, false);
        s.station(sec(25), true, true).beat(27, 40);
        const { rows } = play(s.events);
        assert.equal(rowsOf(rows, 'switch_events')[0]?.resting, false);
        assert.deepEqual(restSeconds(rows), [...range(0, 15), ...range(25, 40)]);
    });

    test('rest runs at most 8 s past the last sighting of the station, whatever other clocks say', () => {
        // No offline row comes: the last sighting at 10 vouches for 8 s (for rest and commands alike), then nothing.
        const s = new Scenario().start(sec(0)).ready().beat(2, 10);
        s.partnerTick(sec(50));
        assert.equal(restTotalMs(play(s.events).rows), 18_000);
    });

    test('until the clock passes that window, rest is not written past the last sighting', () => {
        // The clock is only 5 s past the sighting: the next row could still be the offline row that ends rest at 10.
        const s = new Scenario().start(sec(0)).ready().beat(2, 10);
        s.partnerTick(sec(15));
        assert.equal(restTotalMs(play(s.events).rows), 10_000);
    });

    test('sightings that resume after an unobserved stretch never count the stretch as rest', () => {
        // No offline row ever arrives (the station went unseen for 30 s). The sighting at 10 vouches for 8 s, as it
        // would for a command (next test); from 18 until the next sighting at 40 nothing was observed.
        const s = new Scenario().start(sec(0)).ready().beat(2, 10);
        s.partnerTick(sec(25));
        s.beat(40, 50);
        assert.deepEqual(restSeconds(play(s.events).rows), [...range(0, 18), ...range(40, 50)]);
    });

    test('a command in an unobserved stretch is never a false activation, matching the rest it is set against', () => {
        const s = new Scenario().start(sec(0)).ready().beat(2, 10);
        s.pause(sec(10), 'stop');
        s.gesture(sec(16), 'NO', 'ignored:paused'); // 6 s after the last sighting: observed
        s.gesture(sec(30), 'NO', 'ignored:paused'); // 20 s after it: nothing was reading the person
        s.beat(40, 42);
        const { rows } = play(s.events);
        assert.deepEqual(
            rowsOf(rows, 'switch_events').map((e) => [e.resting, e.falseActivation]),
            [
                [true, true],
                [false, false],
            ],
        );
        assert.deepEqual(restSeconds(rows), [...range(0, 18), ...range(40, 42)]);
    });

    test('a reconnect never brings back rest the writer saw go unobserved before it disconnected', () => {
        // A deliberate pause, sightings through 10, then only an unrelated clock tick at 50: unobserved from 18. The
        // connection drops; the snapshot replays a command at 30 and shows the station healthy at 80.
        const s = new Scenario().start(sec(0)).ready().beat(2, 4);
        s.pause(sec(5), 'stop').beat(6, 10);
        s.partnerTick(sec(50));
        s.lost();
        s.gesture(sec(30), 'NO', 'ignored:paused');
        s.tick(sec(80));
        s.ready().beat(82, 84);
        const { rows } = play(s.events);
        const e = rowsOf(rows, 'switch_events')[0];
        assert.equal(e?.falseActivation, false);
        assert.notEqual(e?.resting, true);
        assert.deepEqual(restSeconds(rows), [...range(0, 18), ...range(80, 84)]);
    });

    test("a decoder going unhealthy ends rest even while an ended session's station still looks fresh", () => {
        // Station A ends its session at 20 and stays online. Station B starts at 21, pauses on purpose, and reports an
        // unhealthy decoder at 23, while A's last sighting is still within 8 s. A was not seen during B's session.
        const a = new Scenario(1n, 'a0a0a0').start(sec(0)).ready().beat(2, 20);
        a.end(sec(20));
        const b = new Scenario(2n, 'b0b0b0', 1_000n).start(sec(21));
        b.pause(sec(22), 'stop');
        b.station(sec(23), true, false).station(sec(25), true, false);
        b.gesture(sec(26), 'NO', 'ignored:paused');
        b.station(sec(27), true, false).station(sec(29), true, false);
        b.partnerTick(sec(30));
        const { rows } = play([...a.events, ...b.events]);
        const misfire = rowsOf(rows, 'switch_events').find((e) => e.sessionId === 'test-unit:2');
        assert.equal(misfire?.resting, false);
        assert.equal(misfire?.falseActivation, false);
        const sessionTwo = rows.filter((r) => r.table !== 'rest_minutes' || r.row.sessionId === 'test-unit:2');
        assert.deepEqual(restSeconds(sessionTwo), range(21, 23));
    });

    test('a station lost while the writer was disconnected still ends rest at its last sighting', () => {
        // Rest in a deliberate pause up to the last sighting at 10; a partner tick moves the clock to 12; the writer
        // loses its connection, and the snapshot on reconnect shows the station offline, last seen at 10.
        const s = new Scenario().start(sec(0)).ready().beat(2, 4);
        s.pause(sec(5), 'stop').beat(6, 10);
        s.partnerTick(sec(12));
        s.lost();
        s.station(sec(10), false);
        s.partnerTick(sec(30));
        s.ready();
        // The station comes back: the settled time moves past the gap, so only the cut keeps 10 to 12 out of rest.
        s.station(sec(30), true, true).beat(32, 34);
        assert.deepEqual(restSeconds(play(s.events).rows), [...range(0, 10), ...range(30, 34)]);
    });

    test('a station re-paired with another role while the writer was away stops vouching at once', () => {
        // Healthy through 10 in an operator pause; the writer disconnects; the owner revokes the station at 11 and
        // pairs the same identity again as a partner. The snapshot shows that identity with the partner role.
        const s = new Scenario().start(sec(0)).ready().beat(2, 4);
        s.pause(sec(5), 'operator').beat(6, 10);
        s.partnerTick(sec(11)); // the clock had moved past the last sighting before the connection dropped
        s.lost();
        s.events.push({ type: 'device', row: { id: STATION, role: 'partner', online: true, decoderHealthy: null, lastSeenAt: sec(12) } });
        s.partnerTick(sec(13));
        s.ready();
        s.partnerTick(sec(30));
        assert.deepEqual(restSeconds(play(s.events).rows), range(0, 10));
    });

    test('rest up to a decoder health loss is written even if the decoder never recovers', () => {
        // The clock stays within 8 s of the last healthy sighting (14), so only the loss itself settles 14 to 15.
        const s = new Scenario().start(sec(0)).ready().beat(2, 14);
        s.station(sec(15), true, false).station(sec(17), true, false).station(sec(19), true, false);
        assert.deepEqual(restSeconds(play(s.events).rows), range(0, 15));
    });

    test('a state change while the station is silent does not start rest', () => {
        // Sightings stop at 10; at 35 the scan changes to a deliberate pause; the station is seen again at 50.
        const s = new Scenario().start(sec(0)).ready().beat(2, 10);
        s.partnerTick(sec(30));
        s.pause(sec(35), 'stop');
        s.beat(50, 52);
        assert.deepEqual(restSeconds(play(s.events).rows), [...range(0, 18), ...range(50, 52)]);
    });

    test('rest up to a loss is written even when the only station still online is a stale one', () => {
        const a = new Scenario(1n, 'a0a0a0').start(sec(0)).ready().beat(2, 20);
        a.end(sec(20));
        const b = new Scenario(2n, 'b0b0b0', 1_000n).start(sec(100)).beat(102, 110);
        b.pause(sec(110), 'stop').beat(112, 120);
        b.station(sec(120), false);
        b.partnerTick(sec(150)); // B never comes back
        const { rows } = play([...a.events, ...b.events]);
        const sessionTwo = rows.filter((r) => r.table !== 'rest_minutes' || r.row.sessionId === 'test-unit:2');
        assert.deepEqual(restSeconds(sessionTwo), range(100, 120));
    });

    test("a station left online by an ended session never vouches for another session's outage", () => {
        // end_session leaves station A online and healthy with a frozen last_seen_at. Session 2 runs on station B,
        // pauses on purpose, and B drops for 80 s. Only B's own sightings count as rest.
        const a = new Scenario(1n, 'a0a0a0').start(sec(0)).ready().beat(2, 20);
        a.end(sec(20));
        const b = new Scenario(2n, 'b0b0b0', 1_000n).start(sec(100)).beat(102, 110);
        b.pause(sec(110), 'stop').beat(112, 120);
        b.station(sec(120), false); // liveness_expired: offline, last seen at 120
        b.gesture(sec(130), 'NO', 'ignored:paused'); // B is not reading the person here, so this is no false activation
        b.partnerTick(sec(150));
        b.station(sec(200), true, true).beat(202, 220);
        const { rows } = play([...a.events, ...b.events]);
        const misfire = rowsOf(rows, 'switch_events').find((e) => e.sessionId === 'test-unit:2');
        assert.equal(misfire?.resting, false);
        assert.equal(misfire?.falseActivation, false);
        const sessionTwo = rows.filter((r) => r.table !== 'rest_minutes' || r.row.sessionId === 'test-unit:2');
        assert.deepEqual(restSeconds(sessionTwo), [...range(100, 120), ...range(200, 220)]);
        const sessionOne = rows.filter((r) => r.table !== 'rest_minutes' || r.row.sessionId === 'test-unit:1');
        assert.deepEqual(restSeconds(sessionOne), range(0, 20));
    });

    for (const order of ['scan pause first', 'offline row first'] as const) {
        test(`a station lost at its last sighting ends rest there, whichever row arrives first (${order})`, () => {
            const s = new Scenario().start(sec(0)).ready().beat(2, 60);
            if (order === 'scan pause first') s.pause(sec(62), 'headset_lost').station(sec(60), false);
            else s.station(sec(60), false).pause(sec(62), 'headset_lost');
            const { rows } = play(s.events);
            assert.deepEqual(restSeconds(rows), range(0, 60));
        });
    }

    test('a station that has not reported decoder health yet does not make the session rest', () => {
        const s = new Scenario().start(sec(0), null).ready();
        s.gesture(sec(0.5), 'NO', 'ignored:idle');
        s.station(sec(1), true, true).beat(3, 10);
        const { rows, tracker } = play(s.events);
        const e = rowsOf(rows, 'switch_events')[0];
        assert.equal(e?.resting, false);
        assert.equal(e?.falseActivation, false);
        assert.equal(tracker.counters.restDisagreements, 1, 'the module saw an idle scan; the timeline had no healthy station');
        assert.deepEqual(restSeconds(rows), range(1, 10));
    });

    test('rows more than six days behind the latest server time are dropped and counted', () => {
        const s = new Scenario().start(sec(0)).ready();
        s.partnerTick(sec(7 * 86_400));
        s.gesture(sec(5), 'NO', 'ignored:idle');
        const { rows, tracker } = play(s.events);
        assert.equal(rowsOf(rows, 'switch_events').length, 0);
        assert.equal(rowsOf(rows, 'rest_minutes').length, 0);
        assert.equal(tracker.counters.tooOld, 2, 'the command, and the rest minute its session sat in');
    });

    test('commands during a scan are never false activations', () => {
        const s = new Scenario().start(sec(0)).ready();
        s.read(sec(2), 7n, 1);
        s.gesture(sec(3), 'CONFIRM', 'ignored:nothing_to_confirm');
        const e = rowsOf(play(s.events).rows, 'switch_events')[0];
        assert.equal(e?.resting, false);
        assert.equal(e?.falseActivation, false);
    });

    test('an open errand is not rest; rest resumes when it ends', () => {
        const s = new Scenario().start(sec(0)).ready().beat(2, 10);
        s.errand(sec(10), 1n, 'drafted').beat(12, 14);
        s.gesture(sec(15), 'CONFIRM', 'ignored:nothing_to_confirm');
        s.beat(16, 20);
        s.errand(sec(20), 1n, 'stopped');
        s.beat(22, 30);
        const { rows } = play(s.events);
        assert.equal(rowsOf(rows, 'switch_events')[0]?.falseActivation, false);
        assert.equal(restTotalMs(rows), 20_000); // 0 to 10, then 20 to 30
    });

    test('a deliberate pause is rest; a lost or removed headset is not', () => {
        const s = new Scenario().start(sec(0)).ready().beat(2, 10);
        s.pause(sec(10), 'idle').beat(12, 20);
        s.gesture(sec(20), 'NO', 'ignored:paused');
        s.beat(22, 24);
        s.gesture(sec(25), 'STOP', 'ignored:already_paused');
        s.beat(26, 30);
        s.pause(sec(30), 'headset_off').beat(32, 40);
        s.gesture(sec(40), 'NO', 'ignored:paused');
        s.beat(42, 50);
        const { rows } = play(s.events);
        const events = rowsOf(rows, 'switch_events');
        assert.deepEqual(
            events.map((e) => [e.command, e.resting, e.falseActivation]),
            [
                ['NO', true, true],
                ['STOP', true, true],
                ['NO', false, false],
            ],
        );
        assert.equal(restTotalMs(rows), 30_000);
    });

    test('a YES that opened the menu is judged by the state before it, and is not a false activation', () => {
        const s = new Scenario().start(sec(0)).ready().beat(2, 10);
        s.gesture(sec(10), 'YES', 'accepted:menu_open', { questionId: 5n });
        s.preparing(sec(10), 5n);
        s.gesture(sec(11), 'NO', 'ignored:not_ready', { questionId: 5n });
        const events = rowsOf(play(s.events).rows, 'switch_events');
        assert.deepEqual(
            events.map((e) => [e.code, e.resting, e.falseActivation]),
            [
                ['menu_open', true, false],
                ['not_ready', false, false],
            ],
        );
    });

    test('the state a command changed is never used to judge it, whichever row of the transaction arrives first', () => {
        // The SDK does not promise an order among one transaction's rows: here the scan update lands first.
        const s = new Scenario().start(sec(0)).ready().beat(2, 10);
        s.preparing(sec(10), 5n); // rest to busy, caused by the YES below
        s.gesture(sec(10), 'YES', 'accepted:menu_open', { questionId: 5n });
        s.read(sec(12), 5n, 1);
        s.idle(sec(14), 'none'); // busy to rest, caused by the STOP below
        s.gesture(sec(14), 'STOP', 'accepted:none', { questionId: 5n, cursor: 1 });
        const events = rowsOf(play(s.events).rows, 'switch_events');
        assert.deepEqual(
            events.map((e) => [e.code, e.resting, e.falseActivation]),
            [
                ['menu_open', true, false],
                ['none', false, false],
            ],
        );
    });

    test('HEADSET_OFF and refractory repeats never count', () => {
        const s = new Scenario().start(sec(0)).ready().beat(2, 4);
        s.gesture(sec(5), 'NO', 'ignored:refractory');
        s.beat(6, 10);
        s.gesture(sec(10), 'HEADSET_OFF', 'accepted:pause');
        const events = rowsOf(play(s.events).rows, 'switch_events');
        assert.deepEqual(
            events.map((e) => e.falseActivation),
            [false, false],
        );
        assert.deepEqual(
            events.map((e) => e.resting),
            [true, true],
        );
    });

    test('a module ignored:idle the timeline calls busy is counted as a disagreement', () => {
        const s = new Scenario().start(sec(0)).ready();
        s.read(sec(2), 7n, 1);
        s.gesture(sec(3), 'NO', 'ignored:idle');
        assert.equal(play(s.events).tracker.counters.restDisagreements, 1);
    });

    test('a command with no session is recorded under session 0 and never classified', () => {
        const s = new Scenario(0n);
        s.events.push({ type: 'ready' });
        s.gesture(sec(1), 'YES', 'ignored:no_session');
        const e = rowsOf(play(s.events).rows, 'switch_events')[0];
        assert.equal(e?.sessionId, 'test-unit:0');
        assert.equal(e?.resting, null);
        assert.equal(e?.falseActivation, false);
    });
});

describe('rest minutes', () => {
    test('one row per minute, a bit per second, up to the last sighting of the station', () => {
        const s = new Scenario().start(sec(50)).ready().beat(52, 130);
        const { rows } = play(s.events);
        const minutes = rowsOf(rows, 'rest_minutes');
        const merged = new Map<number, bigint>();
        for (const m of minutes) merged.set(Number((m.time - BASE) / 1_000_000n), (merged.get(Number((m.time - BASE) / 1_000_000n)) ?? 0n) | m.restMask);
        assert.deepEqual(
            [...merged.entries()].map(([minute, mask]) => [minute, popcount(mask)]),
            [
                [0, 10],
                [60, 60],
                [120, 10],
            ],
        );
        for (const m of minutes) {
            assert.equal(m.time % 60_000_000n, 0n, 'on the minute');
            assert.equal(m.idleMs, popcount(m.restMask) * 1000);
        }
    });

    test('the minute still filling gains seconds under one key; nothing new sends nothing', () => {
        const rows: TelemetryRow[] = [];
        const t = new Tracker({ database: 'test-unit', emit: (r) => rows.push(r) });
        feed(t, new Scenario().start(sec(50)).ready().events);
        const tick = (s: number) => t.device({ id: STATION, role: 'station', online: true, decoderHealthy: true, lastSeenAt: sec(s) });
        for (let k = 52; k <= 70; k += 2) tick(k);
        t.checkpoint();
        for (let k = 72; k <= 80; k += 2) tick(k);
        t.checkpoint();
        const before = rows.length;
        t.checkpoint();
        assert.equal(rows.length, before);
        const at60 = rowsOf(rows, 'rest_minutes').filter((x) => x.time === sec(60));
        assert.deepEqual(
            at60.map((x) => popcount(x.restMask)),
            [10, 20],
        );
        assert.equal(restTotalMs(rows), 30_000);
    });

    test('rest ends at the change, and a session end stops it for good', () => {
        const s = new Scenario().start(sec(0)).ready().beat(2, 30);
        s.read(sec(30), 7n, 1).beat(32, 40);
        s.idle(sec(40)).beat(42, 50);
        s.end(sec(50)).beat(52, 100);
        assert.equal(restTotalMs(play(s.events).rows), 40_000);
    });

    test('a second counts when its midpoint is at rest', () => {
        const masks = restMasks([{ start: sec(59), state: 'rest' }], sec(0), sec(121.5));
        assert.deepEqual(
            [...masks.entries()].map(([m, mask]) => [Number((m - BASE) / 1_000_000n), popcount(mask)]),
            [
                [0, 1],
                [60, 60],
                [120, 1],
            ],
        );
        const edges = restMasks([{ start: sec(53.7), state: 'rest' }], sec(0), sec(64.4));
        assert.deepEqual(
            [...edges.entries()].map(([m, mask]) => [Number((m - BASE) / 1_000_000n), mask]),
            [
                [0, 0b111111n << 54n], // 54 to 59: the midpoint of 53 (53.5) is before 53.7
                [60, 0b1111n], // 60 to 63: the midpoint of 64 (64.5) is after 64.4
            ],
        );
    });

    test('a writer restart can never double count: minutes merge as a union', () => {
        // Run 1 sees rest from 0 and writes up to 30. Run 2 starts later and, from its snapshot, can only place the
        // start of rest at the session's last change (10). The overlap must count once.
        const first: TelemetryRow[] = [];
        const run1 = new Tracker({ database: 'test-unit', emit: (r) => first.push(r) });
        const s1 = new Scenario().start(sec(0)).ready().beat(2, 30);
        feed(run1, s1.events);
        run1.checkpoint();

        const second: TelemetryRow[] = [];
        const run2 = new Tracker({ database: 'test-unit', emit: (r) => second.push(r) });
        const s2 = new Scenario().start(sec(0));
        s2.idle(sec(10)); // an idle-to-idle change the second run sees as the last change
        s2.tick(sec(60)).ready().tick(sec(60));
        feed(run2, s2.events);
        run2.checkpoint();

        assert.equal(restTotalMs(first), 30_000);
        assert.equal(restTotalMs(second), 50_000);
        assert.equal(restTotalMs([...first, ...second]), 60_000);
    });
});

describe('snapshots and reconnects', () => {
    test('before the first ready nothing is classified, and rest starts at the last change', () => {
        const s = new Scenario().start(sec(0));
        s.gesture(sec(10), 'NO', 'ignored:idle');
        s.read(sec(20), 1n, 1).window(sec(22)).idle(sec(30));
        s.gesture(sec(40), 'NO', 'ignored:idle');
        s.tick(sec(50)).ready().beat(52, 60); // the snapshot holds the station's current row; live rows follow
        const { rows } = play(s.events);
        assert.deepEqual(
            rowsOf(rows, 'switch_events').map((e) => [e.resting, e.falseActivation]),
            [
                [null, false],
                [true, true],
            ],
        );
        assert.equal(restTotalMs(rows), 30_000);
    });

    test('rest in a deliberate pause is not taken back further than this writer saw', () => {
        // The pause began at 10, but a station drop and return during it would leave no trace, so the snapshot
        // proves rest only from the moment the writer is connected.
        const s = new Scenario().start(sec(0));
        s.pause(sec(10), 'idle');
        s.gesture(sec(30), 'NO', 'ignored:paused');
        s.tick(sec(60)).ready().beat(62, 90);
        const { rows } = play(s.events);
        assert.equal(rowsOf(rows, 'switch_events')[0]?.resting, null);
        assert.deepEqual(restSeconds(rows), range(60, 90));
    });

    test('a gap in which nothing changed is covered: rest continues through it', () => {
        const s = new Scenario().start(sec(0)).ready().beat(2, 20).lost();
        s.gesture(sec(35), 'NO', 'ignored:idle');
        s.tick(sec(40)).ready().beat(42, 60);
        const { rows } = play(s.events);
        assert.equal(rowsOf(rows, 'switch_events')[0]?.falseActivation, true);
        assert.equal(restTotalMs(rows), 60_000);
    });

    test('a gap in which something changed stays unknown', () => {
        const s = new Scenario().start(sec(0)).ready().beat(2, 20).lost();
        s.gesture(sec(35), 'NO', 'ignored:idle');
        s.idle(sec(40)); // the snapshot shows a scan row written during the gap
        s.tick(sec(40)).ready().beat(42, 60);
        const { rows } = play(s.events);
        const e = rowsOf(rows, 'switch_events')[0];
        assert.equal(e?.resting, null);
        assert.equal(e?.falseActivation, false);
        assert.equal(restTotalMs(rows), 40_000); // 0 to 20, then 40 to 60
    });

    test('a replayed ledger row is processed once', () => {
        const s = new Scenario().start(sec(0)).ready();
        const g = s.gesture(sec(5), 'NO', 'ignored:idle');
        s.events.push({ type: 'ledger', row: g });
        assert.equal(rowsOf(play(s.events).rows, 'switch_events').length, 1);
    });
});

describe('the input a session ran with (T1)', () => {
    test('is the word from the label prefix, never the label, one row per session', () => {
        const cases: Array<[string, string]> = [
            ['keyboard-test', 'keyboard'],
            ['switch-demo', 'switch'],
            ['switch-test', 'switch'],
            ['headset-demo', 'headset'],
            ['headset-test', 'headset'],
            ['smoke', 'unknown'],
            ['demo', 'unknown'],
            ['', 'unknown'],
            ['keyboardtest', 'unknown'],
            ['test-headset-', 'unknown'],
        ];
        for (const [label, want] of cases) {
            const s = new Scenario().start(sec(0), true, label).ready();
            const start = s.events.find((e) => e.type === 'ledger' && e.row.kind === 'session_start');
            assert.ok(start);
            s.events.push(start); // a replayed session_start lands once
            assert.deepEqual(rowsOf(play(s.events).rows, 'session_inputs'), [{ time: sec(0), sessionId: 'test-unit:1', input: want }], label);
        }
    });

    test('is written for a session that started more than six days before its current commands', () => {
        const week = 7 * 86_400;
        const s = new Scenario(5n).start(sec(0), true, 'headset-demo');
        s.tick(sec(week));
        s.gesture(sec(week + 1), 'NO', 'ignored:idle');
        s.ready(); // first seen in a snapshot taken a week after the session started
        const { rows, tracker } = play(s.events);
        assert.equal(rowsOf(rows, 'switch_events').length, 1, 'the current command lands');
        assert.ok(tracker.counters.tooOld > 0, 'old raw rows are still dropped');
        assert.deepEqual(rowsOf(rows, 'session_inputs'), [{ time: sec(0), sessionId: 'test-unit:5', input: 'headset' }]);
    });

    test('is written for a session that starts after the snapshot too', () => {
        const s = new Scenario(2n).ready();
        s.start(sec(1), true, 'switch-test');
        assert.deepEqual(rowsOf(play(s.events).rows, 'session_inputs'), [{ time: sec(1), sessionId: 'test-unit:2', input: 'switch' }]);
    });

    test('an ended keyboard session read from a snapshot: commands and timed picks, no rest, so no false activation', () => {
        const s = new Scenario(13n).start(sec(0), true, 'keyboard-test');
        s.preparing(sec(1), 7n).read(sec(2), 7n, 1).window(sec(4));
        const heard = s.step;
        s.pick(sec(4.8), 7n, 1, 'reply');
        s.gesture(sec(4.8), 'YES', 'accepted:pick', { heard, questionId: 7n, optionId: 101n, cursor: 1 });
        s.veto(sec(4.8)).idle(sec(6));
        s.gesture(sec(20), 'NO', 'ignored:idle');
        s.end(sec(30)).tick(sec(40)).ready();
        const { rows } = play(s.events);
        assert.deepEqual(rowsOf(rows, 'session_inputs'), [{ time: sec(0), sessionId: 'test-unit:13', input: 'keyboard' }]);
        const events = rowsOf(rows, 'switch_events');
        assert.equal(events.length, 2);
        // The snapshot cannot prove rest before the writer connected (device_status keeps only the latest sighting).
        for (const e of events) {
            assert.equal(e.resting, null);
            assert.equal(e.falseActivation, false);
        }
        assert.equal(rowsOf(rows, 'picks')[0]?.timeToPickMs, 2800);
        assert.equal(restTotalMs(rows), 0);
    });

    test('onlySessions writes the chosen sessions only, and still follows the others', () => {
        const a = new Scenario(13n, STATION, 0n).start(sec(0), true, 'keyboard-test');
        a.gesture(sec(5), 'NO', 'ignored:idle');
        a.end(sec(10));
        const b = new Scenario(14n, STATION, 1_000n).start(sec(20), true, 'smoke');
        b.gesture(sec(25), 'NO', 'ignored:idle');
        b.end(sec(30));
        const rows: TelemetryRow[] = [];
        const tracker = new Tracker({ database: 'test-unit', emit: (r) => rows.push(r), onlySessions: new Set([13n]) });
        feed(tracker, [...a.events, ...b.events, { type: 'ready' }]);
        tracker.checkpoint();
        assert.deepEqual([...new Set(rows.map((r) => r.row.sessionId))], ['test-unit:13']);
        assert.deepEqual(rowsOf(rows, 'session_inputs').map((r) => r.input), ['keyboard']);
        assert.equal(rowsOf(rows, 'switch_events').length, 1);
        assert.ok(tracker.counters.otherSessions >= 3, `${tracker.counters.otherSessions} rows of session 14 left out`);
        // Session 14 was still followed: its start and end are known.
        assert.equal(tracker.stateAt(14n, sec(31)), 'off');
    });
});
