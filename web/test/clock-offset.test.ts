/**
 * The server clock against the laptop clock (lib/data/clock-offset.ts). Pure, no timers.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createClockOffset, MAX_OFFSET_MS, newestEventTime, OFFSET_WINDOW_MS, shiftRows } from '../lib/data/clock-offset';
import { replayRowsAt } from '../lib/data/replay';
import { EMPTY_ROWS, type CommandEvent, type DataRows } from '../lib/data/types';

const command = (id: string, at: number): CommandEvent => ({
  id,
  command: 'YES',
  at,
  accepted: true,
  ignoredReason: null,
  confidence: 0.9,
  questionId: null,
  optionId: null,
});

const withCommands = (...times: number[]): DataRows => ({ ...EMPTY_ROWS, commands: times.map((at, i) => command(`c${i}`, at)) });

describe('clock offset', () => {
  test('starts at 0, and the first read after connecting never moves it', () => {
    const clock = createClockOffset();
    assert.equal(clock.current(), 0);
    // An old row: 40 s before it arrived. A snapshot, so it only marks the newest time seen.
    assert.equal(clock.update(withCommands(100_000), 140_000, true), 0);
  });

  test('a new event that arrives soon after the server wrote it sets the offset, server minus laptop', () => {
    const clock = createClockOffset();
    clock.update(withCommands(100_000), 100_500, true);
    // The server clock runs 3 s ahead; the event took 40 ms to arrive.
    const laptop = 200_000;
    const offset = clock.update(withCommands(100_000, laptop + 3_000 - 40), laptop, false);
    assert.equal(offset, 2_960);
  });

  test('the closest bound in the last minute wins, and slow arrivals do not pull it down', () => {
    const clock = createClockOffset();
    clock.update(withCommands(0), 0, true);
    clock.update(withCommands(0, 10_000 - 900), 10_000, false); // a slow trip: -900
    assert.equal(clock.current(), -900);
    clock.update(withCommands(0, 10_000 - 900, 20_000 - 30), 20_000, false); // a fast trip: -30
    assert.equal(clock.current(), -30);
    clock.update(withCommands(0, 10_000 - 900, 20_000 - 30, 30_000 - 500), 30_000, false);
    assert.equal(clock.current(), -30, 'a slower trip later does not lower it');
  });

  test('old samples drop out after a minute, so a clock that is set right is followed', () => {
    const clock = createClockOffset();
    clock.update(withCommands(0), 0, true);
    clock.update(withCommands(0, 1_000 + 2_000), 1_000, false);
    assert.equal(clock.current(), 2_000);
    const later = 1_000 + OFFSET_WINDOW_MS + 1;
    clock.update(withCommands(0, 3_000, later - 20), later, false);
    assert.equal(clock.current(), -20);
  });

  test('a bound further off than 15 s is an old row, not skew, and is ignored', () => {
    const clock = createClockOffset();
    clock.update(withCommands(0), 0, true);
    clock.update(withCommands(0, 100_000 - MAX_OFFSET_MS - 1), 100_000, false);
    assert.equal(clock.current(), 0);
  });

  test('re-reading the same rows takes no new sample', () => {
    const clock = createClockOffset();
    const rows = withCommands(10_000);
    clock.update(rows, 10_050, true);
    clock.update(rows, 30_000, false);
    assert.equal(clock.current(), 0, 'nothing new arrived');
  });

  test('planned times are not events: a scan step that ends later never counts as the newest', () => {
    const rows = replayRowsAt(1_000_000, 1_000_000 + 15_000);
    const newest = newestEventTime(rows);
    assert.ok(newest !== null && newest <= 1_000_000 + 15_000);
    assert.ok(rows.scan && rows.scan.stepEndsAt > 1_000_000 + 15_000, 'the scan step ends in the future');
  });
});

describe('shifting row times', () => {
  test('every row time moves by the delta, payload clock times stay, and a 0 delta is a no-op', () => {
    const start = 1_000_000;
    const rows = replayRowsAt(start, start + 62_000);
    assert.equal(shiftRows(rows, 0), rows);
    const moved = shiftRows(rows, -500);
    assert.equal(moved.questions[0]?.askedAt, (rows.questions[0]?.askedAt ?? 0) - 500);
    assert.equal(moved.pipelineEvents[3]?.at, (rows.pipelineEvents[3]?.at ?? 0) - 500);
    assert.equal(moved.commands[0]?.at, (rows.commands[0]?.at ?? 0) - 500);
    const call = rows.calls[0]!;
    const movedCall = moved.calls[0]!;
    assert.equal(movedCall.startedAt, (call.startedAt ?? 0) - 500);
    assert.equal(movedCall.transcript[0]?.at, (call.transcript[0]?.at ?? 0) - 500);
    assert.equal(movedCall.confirmClosesAt, (call.confirmClosesAt ?? 0) - 500);
    assert.equal(moved.errands[0]?.sentAt, (rows.errands[0]?.sentAt ?? 0) - 500);
    assert.equal(moved.scan?.stepEndsAt, (rows.scan?.stepEndsAt ?? 0) - 500);
    assert.equal(moved.safety.since, (rows.safety.since ?? 0) - 500);
    assert.equal(moved.options, rows.options, 'options carry no row times');
    const search = moved.pipelineEvents.find((e) => e.stage === 'search' && e.status === 'ok');
    const original = rows.pipelineEvents.find((e) => e.stage === 'search' && e.status === 'ok');
    assert.ok(search?.stage === 'search' && original?.stage === 'search');
    assert.equal(search.detail.rows?.[0]?.fetchedAt, original.detail.rows?.[0]?.fetchedAt, 'producer fetch times are shown, not counted');
  });

  test('null times stay null', () => {
    const rows = replayRowsAt(1_000_000, 1_000_000 + 1_000);
    const moved = shiftRows(rows, 250);
    assert.equal(moved.questions[0]?.spokenAt, null);
  });
});
