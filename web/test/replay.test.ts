import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { eventsForQuestion, hitDisplay, latestOptions, optionUnderCursor, spokenReply, timeToFirstOption } from '../lib/data/derive';
import {
  buildLoop,
  CONFIRM_WINDOW_MS,
  createReplaySource,
  HISTORY_LOOPS,
  LOOP_MS,
  nextChangeAt,
  PICK_WAIT_MS,
  replayRowsAt,
} from '../lib/data/replay';
import { COMMANDS, STAGES, type CallStatus, type CommandName, type DataRows, type ErrandStatus, type ScanPhase } from '../lib/data/types';

const START = Date.UTC(2026, 9, 24, 19, 40, 0);

/** Every snapshot during one loop, sampled at each step and just after it. */
function samplesOfLoop(loop: number): DataRows[] {
  const loopStart = START + loop * LOOP_MS;
  const times = new Set<number>();
  for (const step of buildLoop(loop, loopStart)) {
    times.add(loopStart + step.t);
    times.add(loopStart + step.t + 1);
  }
  times.add(loopStart + LOOP_MS - 1);
  return [...times].sort((a, b) => a - b).map((t) => replayRowsAt(START, t));
}

/** The values a field takes over the samples, with repeats in a row collapsed. */
function sequence<T>(samples: readonly DataRows[], read: (rows: DataRows) => T | undefined): T[] {
  const seen: T[] = [];
  for (const rows of samples) {
    const value = read(rows);
    if (value !== undefined && seen[seen.length - 1] !== value) seen.push(value);
  }
  return seen;
}

const optionId = (version: number, rank: number) => `opt-0-v${version}-${rank}`;

describe('replay script (direct select, D18)', () => {
  const loopEnd = replayRowsAt(START, START + LOOP_MS - 1);
  const events = eventsForQuestion(loopEnd.pipelineEvents, 'q-0');
  const commands = loopEnd.commands.filter((c) => c.questionId === 'q-0');
  const samples = samplesOfLoop(0);

  test('the first loop reaches every pipeline stage, and each one finishes', () => {
    for (const stage of STAGES) {
      assert.ok(events.some((e) => e.stage === stage && e.status === 'started'), `${stage} started`);
      assert.ok(events.some((e) => e.stage === stage && e.status === 'ok'), `${stage} ok`);
    }
  });

  test('every finished stage carries its number, and started ones have none yet', () => {
    for (const event of loopEnd.pipelineEvents) {
      if (event.status === 'ok') assert.equal(typeof event.ms, 'number', `${event.id} ${event.stage} has ms`);
      if (event.status === 'started') assert.equal(event.ms, null, `${event.id} ${event.stage} has no ms yet`);
    }
  });

  test('the question is heard, then searched, recalled and drafted, in that order', () => {
    const order = events
      .filter((e) => e.status === 'ok')
      .map((e) => e.stage)
      .filter((stage, i, all) => all.indexOf(stage) === i);
    assert.deepEqual(order.slice(0, 4), ['listen', 'search', 'retrieve', 'plan']);
    assert.equal(loopEnd.questions[0]?.text, 'Where can we get dinner near the hospital tonight?');
    assert.equal(loopEnd.questions[0]?.origin, 'partner');
  });

  test('2.9 s from Heard to the first option in the earpiece', () => {
    assert.equal(timeToFirstOption(events), 2_900);
  });

  test('an open question gets three reply options in three different tones', () => {
    const first = loopEnd.options.filter((o) => o.questionId === 'q-0' && o.version === 1).sort((a, b) => a.rank - b.rank);
    assert.equal(first.length, 3, 'at most 3: one per pick gesture (D21)');
    assert.deepEqual(
      first.map((o) => o.kind),
      ['reply', 'reply', 'reply'],
    );
    const tones = first.map((o) => o.tone);
    assert.ok(tones.every((tone) => typeof tone === 'string' && tone !== ''));
    assert.equal(new Set(tones).size, 3, 'three different tones');
  });

  test('the scan clock passes through every direct select phase (no veto, D18)', () => {
    const phases = new Set<ScanPhase>(samples.map((rows) => rows.scan?.phase).filter((p): p is ScanPhase => p !== undefined));
    for (const phase of ['idle', 'preparing', 'reading', 'window', 'paused'] as ScanPhase[]) assert.ok(phases.has(phase), phase);
    assert.ok(!phases.has('veto'), 'a reply pick is said at once: no veto in direct select');
    for (const rows of samples) {
      const scan = rows.scan;
      if (!scan) continue;
      assert.equal(scan.mode, 'answer');
      assert.equal(scan.answerMode, 'pick');
      assert.ok(scan.stepEndsAt >= scan.stepStartedAt, 'a phase ends after it starts');
      if (scan.phase === 'reading') assert.ok(scan.cursor !== null, 'a read is on an option');
    }
  });

  test('the earpiece reads the list once, numbered, back to back, then waits up to 2 minutes for a pick', () => {
    const reads = events.filter((e) => e.stage === 'speak' && e.status === 'started' && e.detail.channel === 'earpiece' && e.at < START + 11_000);
    assert.deepEqual(
      reads.map((e) => (e.stage === 'speak' ? e.detail.text : null)),
      ['One: Cafeteria.', 'Two: Thai place.', 'Three: Cafe on Bay.'],
    );
    const v1 = samples.map((rows) => rows.scan).filter((scan) => scan?.version === 1);
    const readings = v1.filter((scan) => scan?.phase === 'reading');
    for (let rank = 2; rank <= 3; rank++) {
      const before = readings.find((scan) => scan?.cursor === rank - 1)!;
      const next = readings.find((scan) => scan?.cursor === rank)!;
      assert.equal(next.stepStartedAt, before.stepEndsAt, `option ${rank} starts as soon as option ${rank - 1} ends: no window between`);
    }
    assert.equal(readings.some((scan) => scan?.cursor === 4), false, 'no fourth option is read');
    const wait = v1.find((scan) => scan?.phase === 'window')!;
    assert.equal(wait.stepStartedAt, readings.find((scan) => scan?.cursor === 3)!.stepEndsAt);
    assert.equal(wait.stepEndsAt - wait.stepStartedAt, PICK_WAIT_MS);
    assert.equal(PICK_WAIT_MS, 120_000);
    assert.equal(wait.pass, 1);
    assert.equal(wait.maxPasses, 1, 'read once');
  });

  test('silence picks nothing: no command lands while the list is read', () => {
    const listEnds = samples.map((rows) => rows.scan).find((scan) => scan?.version === 1 && scan.phase === 'window')!.stepStartedAt;
    assert.ok(!commands.some((c) => c.at < listEnds), 'nothing is picked while the options are read');
  });

  test('PICK_3, a single jaw clench, picks option 3 during the wait; it is said out loud at once', () => {
    const pick = commands.find((c) => c.command === 'PICK_3' && c.accepted)!;
    assert.equal(pick.optionId, optionId(1, 3));
    const before = replayRowsAt(START, pick.at - 1);
    assert.equal(before.scan?.phase, 'window', 'picked from the wait after the list');
    const at = replayRowsAt(START, pick.at);
    assert.equal(at.scan?.phase, 'idle');
    assert.equal(at.scan?.outcome, 'picked');
    assert.equal(at.scan?.pickedOptionId, optionId(1, 3));
    assert.equal(optionUnderCursor(at.scan, at.options), null, 'nothing else plays');

    const released = replayRowsAt(START, pick.at + 50);
    const option = loopEnd.options.find((o) => o.id === optionId(1, 3));
    assert.equal(option?.label, 'Cafe on Bay');
    assert.deepEqual(spokenReply(released.questions[0] ?? null), { text: option?.text, spokenAt: null });

    const spoken = spokenReply(loopEnd.questions[0] ?? null);
    assert.equal(spoken?.text, option?.text, 'the room hears the full text, not the label');
    const aloud = events.filter((e) => e.stage === 'speak' && e.detail.channel === 'aloud');
    assert.deepEqual(
      aloud.map((e) => e.status),
      ['started', 'ok'],
    );
    assert.ok(aloud[0]!.at - pick.at <= 200, 'said out loud right after the pick');
    assert.equal(spoken?.spokenAt, aloud[1]!.at);
  });

  test('the story runs in direct select order, and the tail pauses and resumes', () => {
    const accepted = commands.filter((c) => c.accepted).map((c) => c.command);
    assert.deepEqual(accepted, ['PICK_3', 'PICK_1', 'PICK_1', 'PICK_1', 'PICK_1', 'STOP', 'STOP', 'PICK_1', 'HEADSET_OFF', 'PICK_1']);
  });

  test('only direct select command names appear: no scan word and no retired name anywhere', () => {
    const names = new Set<CommandName>(commands.map((c) => c.command));
    for (const name of names) assert.ok(COMMANDS.includes(name), name);
    for (const name of ['PICK_1', 'PICK_3', 'STOP', 'HEADSET_OFF'] as const) assert.ok(names.has(name), name);
    // A headset sample: no gesture gives 4 (a double jaw clench means nothing, PLAN D21), so no PICK_4 appears.
    assert.equal(names.has('PICK_4'), false);
    assert.doesNotMatch(JSON.stringify(loopEnd), /"(SELECT|ERRAND|CALL|PAUSE|YES|NO|CONFIRM)"/);
  });

  test('a repeat inside the refractory time and a number with no option are ignored', () => {
    const ignored = commands.filter((c) => !c.accepted);
    assert.deepEqual(
      ignored.map((c) => [c.command, c.ignoredReason]),
      [
        ['PICK_3', 'Repeat inside the refractory time'],
        ['PICK_3', 'There is no option with that number'],
      ],
    );
  });

  test('errands and calls are follow-up options, each picked by its number', () => {
    const kinds = (version: number) =>
      loopEnd.options
        .filter((o) => o.questionId === 'q-0' && o.version === version)
        .sort((a, b) => a.rank - b.rank)
        .map((o) => o.kind);
    assert.deepEqual(kinds(2), ['errand', 'call', 'reply']);
    assert.deepEqual(kinds(3), ['call', 'reply']);
    assert.deepEqual(
      latestOptions(loopEnd.options, 'q-0').map((o) => o.version),
      [3, 3],
    );
    const picks = commands.filter((c) => c.command.startsWith('PICK_') && c.accepted && c.optionId !== null).map((c) => c.optionId);
    assert.deepEqual(picks, [optionId(1, 3), optionId(2, 1), optionId(3, 1)]);
    assert.equal(loopEnd.errands[0]?.optionId, optionId(2, 1));
    assert.equal(loopEnd.calls[0]?.optionId, optionId(3, 1));
    for (const pick of [optionId(2, 1), optionId(3, 1)]) {
      const one = commands.find((c) => c.optionId === pick && c.command === 'PICK_1')!;
      assert.equal(replayRowsAt(START, one.at).scan?.phase, 'idle', 'an errand or call is guarded by its own read-back and confirm');
    }
    for (const option of loopEnd.options) assert.ok((option.label ?? '').split(/\s+/).length <= 3, `${option.id}: a 1 to 3 word label`);
  });

  test('the errand waits for a fresh PICK_1 after its read-back, then is sent with the confirmation text', () => {
    const statuses = sequence<ErrandStatus>(samples, (rows) => rows.errands.find((e) => e.id === 'err-0')?.status);
    assert.deepEqual(statuses, ['preparing', 'previewed', 'reading_back', 'awaiting_confirm', 'confirmed', 'submitting', 'sent']);
    for (const rows of samples) {
      const errand = rows.errands.find((e) => e.id === 'err-0');
      if (errand?.status !== 'awaiting_confirm') continue;
      assert.ok(errand.previewDigest && /^[0-9a-f]{16}$/.test(errand.previewDigest), 'a 16 hex digest');
      assert.ok(errand.readBackText?.endsWith('One: send it. Two: cancel.'), 'read back, ending with the two-option confirm');
      assert.ok(errand.screenshotUrl?.startsWith('data:image/svg+xml'), 'a preview picture');
      assert.equal(errand.confirmClosesAt, (errand.readAloudAt ?? 0) + CONFIRM_WINDOW_MS);
      assert.equal(errand.sentAt, null, 'nothing sent while waiting');
    }
    const sent = loopEnd.errands.find((e) => e.id === 'err-0');
    assert.equal(sent?.confirmationText, 'Your response has been recorded.');
    const confirm = commands.find((c) => c.id === sent?.confirmCommandId);
    assert.equal(confirm?.command, 'PICK_1', 'One: send it');
    assert.ok((confirm?.at ?? 0) > (sent?.readAloudAt ?? Infinity), 'the confirm comes after the read-back');
    assert.ok((sent?.confirmedAt ?? Infinity) <= (sent?.confirmClosesAt ?? 0), 'confirmed inside the window');
    assert.equal(sent?.stopCommandId, null);
  });

  test('the call reads back, waits for a fresh PICK_1, rings, connects, shows a transcript, and STOP hangs it up', () => {
    const statuses = sequence<CallStatus>(samples, (rows) => rows.calls.find((c) => c.id === 'call-0')?.status);
    assert.deepEqual(statuses, ['prepared', 'awaiting_confirm', 'confirmed', 'dialing', 'ringing', 'connected', 'ended']);
    const call = loopEnd.calls.find((c) => c.id === 'call-0')!;
    assert.equal(commands.find((c) => c.id === call.confirmCommandId)?.command, 'PICK_1');
    assert.equal(commands.find((c) => c.id === call.stopCommandId)?.command, 'STOP');
    assert.ok((call.dialedAt ?? 0) > (call.confirmedAt ?? Infinity), 'dialed only after the confirm');
    assert.ok((call.confirmedAt ?? Infinity) <= (call.confirmClosesAt ?? 0), 'confirmed inside the window');
    assert.equal(call.result, 'cancelled');
    assert.equal(call.endReason, 'The person hung up with STOP.');
    assert.ok(call.consentOnFile);
    assert.ok(call.transcript.length >= 2);
    assert.ok(call.transcript.every((line) => line.at < (call.endedAt ?? 0)));
    assert.match(call.transcript[0]?.text ?? '', /Eleven/, 'the AI disclosure names Eleven');
  });

  test('STOP during the call asks the call agent to hang up, and the call ends a moment later', () => {
    const call = loopEnd.calls.find((c) => c.id === 'call-0')!;
    const stop = commands.find((c) => c.id === call.stopCommandId)!;
    const asked = replayRowsAt(START, stop.at).calls.find((c) => c.id === 'call-0')!;
    assert.equal(asked.status, 'connected', 'still on the line while the hang-up is asked for');
    assert.equal(asked.cancelRequested, true);
    assert.ok((call.endedAt ?? 0) > stop.at, 'the line drops after the STOP');
    assert.equal(replayRowsAt(START, stop.at - 1).calls.find((c) => c.id === 'call-0')?.cancelRequested, false);
  });

  test('each earpiece clip carries its length and word timings from the moment it starts (PLAN D10)', () => {
    const starts = events.filter((e) => e.stage === 'speak' && e.status === 'started' && e.detail.channel === 'earpiece');
    assert.ok(starts.length >= 5);
    for (const event of starts) {
      if (event.stage !== 'speak') continue;
      const words = event.detail.words ?? [];
      assert.equal(words.length, (event.detail.text ?? '').trim().split(/\s+/).length, `${event.id} has a timing per word`);
      assert.ok((event.detail.durationMs ?? 0) >= (words[words.length - 1]?.endMs ?? Infinity), `${event.id} words end inside the clip`);
    }
  });

  test('no phone number anywhere in the replay', () => {
    const json = JSON.stringify(replayRowsAt(START, START + 3 * LOOP_MS - 1));
    assert.doesNotMatch(json, /"(phone|phoneNumber|toNumber|callbackNumber)"/, 'no phone fields');
    assert.doesNotMatch(json, /\+?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/, 'no phone number in any text');
    for (const call of loopEnd.calls) assert.doesNotMatch(call.contactName, /\d/, 'a name, not a number');
  });

  test('STOP during the call does not pause; STOP while idle pauses; headset off shows; PICK_1 resumes each time', () => {
    assert.deepEqual(
      sequence(samples, (rows) => rows.safety.state),
      ['ok', 'paused', 'ok', 'headset_off', 'ok'],
    );
    const stops = commands.filter((c) => c.command === 'STOP');
    assert.equal(stops.length, 2);
    assert.equal(replayRowsAt(START, stops[0]!.at).safety.state, 'ok', 'the hang-up STOP does not pause');
    assert.equal(replayRowsAt(START, stops[1]!.at).safety.state, 'paused');
    assert.equal(replayRowsAt(START, stops[1]!.at).scan?.phase, 'paused');
    const headsetOff = commands.find((c) => c.command === 'HEADSET_OFF')!;
    assert.equal(headsetOff.confidence, null, 'a system event, not a decoded command');
    assert.equal(replayRowsAt(START, headsetOff.at).safety.state, 'headset_off');
    assert.equal(loopEnd.safety.state, 'ok');
    assert.equal(loopEnd.scan?.phase, 'idle');
  });

  test('memory privacy: one shared memory with sample text, one private memory with no text', () => {
    const retrieve = events.find((e) => e.stage === 'retrieve' && e.status === 'ok');
    assert.ok(retrieve && retrieve.stage === 'retrieve');
    const hits = retrieve.detail.hits ?? [];
    const memories = hits.filter((hit) => hit.origin === 'memory');
    assert.equal(memories.length, 2);
    for (const hit of memories) assert.equal(hit.text, undefined, 'memory text never rides in `text`');
    const shared = memories.filter((hit) => hit.sharedText !== undefined);
    const privateOnes = memories.filter((hit) => hit.sharedText === undefined);
    assert.equal(shared.length, 1);
    assert.equal(privateOnes.length, 1);
    assert.match(shared[0]!.sharedText!, /^Sample shared memory: /);
    assert.deepEqual(hitDisplay(shared[0]!), { text: shared[0]!.sharedText, isPrivate: false, origin: 'memory', category: 'Preference' });
    assert.deepEqual(hitDisplay(privateOnes[0]!), { text: 'Private memory', isPrivate: true, origin: 'memory', category: 'Past reply' });
    for (const hit of hits.filter((h) => h.origin === 'web')) assert.ok(hit.text, 'web hits show their text');
  });
});

describe('replay loops', () => {
  test('every step lands inside its loop', () => {
    const steps = buildLoop(0, START);
    assert.ok(steps.length > 60);
    for (const step of steps) assert.ok(step.t >= 0 && step.t < LOOP_MS, `${step.label} at ${step.t}`);
  });

  test('a new loop starts a new question and keeps the last one', () => {
    const rows = replayRowsAt(START, START + LOOP_MS + 10);
    assert.deepEqual(
      rows.questions.map((q) => [q.id, q.number]),
      [
        ['q-0', 1],
        ['q-1', 2],
      ],
    );
    assert.equal(rows.questions[1]?.text, null, 'the new question is still being heard');
    assert.equal(rows.scan?.questionId, 'q-1');
    assert.equal(rows.scan?.phase, 'idle');
    assert.equal(rows.scan?.version, 0);
    assert.equal(rows.safety.state, 'ok');
  });

  test('every loop runs the same script at the same offsets', () => {
    const shape = (loop: number) => buildLoop(loop, START + loop * LOOP_MS).map((s) => `${s.t} ${s.label}`);
    assert.deepEqual(shape(3), shape(0));
  });

  test('history is capped, so a tab left open does not grow', () => {
    const rows = replayRowsAt(START, START + 9 * LOOP_MS + 30_000);
    assert.equal(rows.questions.length, HISTORY_LOOPS + 1);
    assert.equal(rows.questions[rows.questions.length - 1]?.number, 10);
  });

  test('ids are unique in every table and across tables, with history', () => {
    const rows = replayRowsAt(START, START + 4 * LOOP_MS + LOOP_MS - 1);
    const lists: Array<readonly { id: string }[]> = [rows.questions, rows.pipelineEvents, rows.options, rows.errands, rows.calls, rows.commands];
    const all: string[] = [];
    for (const list of lists) {
      const ids = list.map((row) => row.id);
      assert.equal(new Set(ids).size, ids.length);
      all.push(...ids);
    }
    for (const call of rows.calls) all.push(...call.transcript.map((line) => line.id));
    for (const event of rows.pipelineEvents) {
      if (event.stage === 'retrieve') all.push(...(event.detail.hits ?? []).map((hit) => hit.id));
    }
    assert.equal(new Set(all).size, all.length);
  });

  test('lists stay sorted oldest first', () => {
    const rows = replayRowsAt(START, START + 2 * LOOP_MS + 40_000);
    const sorted = (times: number[]) => times.every((t, i) => i === 0 || t >= (times[i - 1] ?? t));
    assert.ok(sorted(rows.pipelineEvents.map((e) => e.at)));
    assert.ok(sorted(rows.commands.map((c) => c.at)));
    assert.ok(sorted(rows.questions.map((q) => q.askedAt)));
  });

  test('the same moment always gives the same rows', () => {
    const t = START + LOOP_MS + 33_333;
    assert.deepEqual(replayRowsAt(START, t), replayRowsAt(START, t));
  });

  test('the next change is always later, and wraps to the next loop', () => {
    for (const t of [START, START + 1, START + 30_000, START + LOOP_MS - 1, START + 5 * LOOP_MS + 12_345]) {
      assert.ok(nextChangeAt(START, t) > t);
    }
    assert.equal(nextChangeAt(START, START + LOOP_MS - 1), START + LOOP_MS);
  });
});

describe('replay source', () => {
  test('reports Live at once, then plays on its own timers, loops, and stops cleanly', () => {
    let now = START;
    const timers = new Map<number, { at: number; run: () => void }>();
    let nextId = 0;
    const source = createReplaySource({
      now: () => now,
      setTimer: (run, ms) => {
        timers.set(++nextId, { at: now + ms, run });
        return nextId;
      },
      clearTimer: (handle) => {
        timers.delete(handle as number);
      },
    });
    const advanceTo = (end: number) => {
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = end;
    };

    assert.equal(source.getState().connection, 'connecting');
    let notified = 0;
    const unsubscribe = source.subscribe(() => notified++);
    source.start();
    const live = source.getState();
    assert.equal(live.mode, 'replay');
    assert.equal(live.connection, 'live');
    assert.equal(live.ready, true);
    assert.equal(live.rows.questions.length, 1);

    advanceTo(START + 5_200);
    assert.ok(notified > 3);
    assert.equal(source.getState().rows.options.length, 3, 'three options drafted by 5.2 s');

    advanceTo(START + LOOP_MS + 100);
    assert.deepEqual(
      source.getState().rows.questions.map((q) => q.id),
      ['q-0', 'q-1'],
      'the second loop started on its own',
    );

    source.stop();
    assert.equal(timers.size, 0, 'no timer left after stop');
    unsubscribe();
  });
});
