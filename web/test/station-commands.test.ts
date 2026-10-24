/**
 * From a command to `gesture(...)` (lib/station/commands.ts, docs/station.md 2.7 and 7.3 A3): the arguments per
 * command, the CONFIRM digest (errand before call, '' when no read-back finished), `onset_age_ms` with the one-way
 * estimate, the resend windows (3 s and 30 s), decoder ids relayed once, and the outcome read from `my_session`.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DisconnectedError, SenderError, UnknownCallResultError } from 'spacetimedb';
import {
  buildGestureArgs,
  COMMAND_CHIME,
  CommandSender,
  confirmDigest,
  onsetAge,
  outcomeFeedback,
  outcomeWords,
  readbackKey,
  RecentIds,
  resendWindowMs,
  type CommandInput,
  type GestureArgs,
} from '../lib/station/commands';
import { fakeTimers, flush } from './role-fakes';

function input(patch: Partial<CommandInput> = {}): CommandInput {
  return { command: 'YES', gestureId: null, source: 'key', confidence: 1, onsetLocal: 0, via: 'key', ...patch };
}

describe('gesture arguments', () => {
  test('every command carries the heard step and option, the source and the confidence', () => {
    for (const command of ['YES', 'NO', 'CONFIRM', 'STOP', 'HEADSET_OFF'] as const) {
      const args = buildGestureArgs(input({ command, onsetLocal: 1_000 }), 'g1', { stepSeq: 12n, optionId: 102n }, 'abcd1234abcd1234', 1_300, 40);
      assert.equal(args.gestureId, 'g1');
      assert.equal(args.command, command);
      assert.equal(args.heardStepSeq, 12n);
      assert.equal(args.heardOptionId, 102n);
      assert.equal(args.source, 'key');
      assert.equal(args.confidence, 1);
      assert.equal(args.onsetAgeMs, 340);
      assert.equal(args.heardDigest, command === 'CONFIRM' ? 'abcd1234abcd1234' : '');
    }
  });

  test('a bad source becomes decoder; confidence is clamped to 0 to 1', () => {
    const args = buildGestureArgs(input({ source: 'Imagery!', confidence: 1.7, via: 'decoder' }), 'g', { stepSeq: 1n, optionId: 0n }, '', 0, 0);
    assert.equal(args.source, 'decoder');
    assert.equal(args.confidence, 1);
    assert.equal(buildGestureArgs(input({ confidence: Number.NaN }), 'g', { stepSeq: 1n, optionId: 0n }, '', 0, 0).confidence, 0);
  });

  test('onset age is now minus onset plus the one-way estimate, rounded and clamped', () => {
    assert.equal(onsetAge(1_500.4, 1_000, 47.3), 548);
    assert.equal(onsetAge(1_000, 2_000, 0), 0);
    assert.equal(onsetAge(10_000_000, 0, 0), 600_000);
    assert.equal(onsetAge(1_000, 900, Number.NaN), 100);
  });

  test('resend windows: 3 s for YES, NO and CONFIRM; 30 s for STOP and HEADSET_OFF', () => {
    assert.equal(resendWindowMs('YES'), 3_000);
    assert.equal(resendWindowMs('NO'), 3_000);
    assert.equal(resendWindowMs('CONFIRM'), 3_000);
    assert.equal(resendWindowMs('STOP'), 30_000);
    assert.equal(resendWindowMs('HEADSET_OFF'), 30_000);
  });
});

describe('the CONFIRM digest', () => {
  const played = new Map([
    [readbackKey('errand', 7n), 'e1e1e1e1e1e1e1e1'],
    [readbackKey('call', 9n), 'c9c9c9c9c9c9c9c9'],
  ]);

  test('the errand comes before the call, as in the module', () => {
    assert.equal(confirmDigest({ errand: { errandId: 7n, status: 'AwaitingConfirm' }, call: { callId: 9n, status: 'AwaitingConfirm' } }, played), 'e1e1e1e1e1e1e1e1');
  });

  test('the call is used when the errand is past confirming', () => {
    assert.equal(confirmDigest({ errand: { errandId: 7n, status: 'Submitted' }, call: { callId: 9n, status: 'Prepared' } }, played), 'c9c9c9c9c9c9c9c9');
  });

  test('empty when no read-back finished for the pending work, or nothing is pending', () => {
    assert.equal(confirmDigest({ errand: { errandId: 8n, status: 'AwaitingConfirm' } }, played), '');
    assert.equal(confirmDigest({ errand: { errandId: 7n, status: 'Stopped' }, call: { callId: 9n, status: 'Ended' } }, played), '');
    assert.equal(confirmDigest(null, played), '');
  });
});

describe('outcomes', () => {
  test('words for accepted and ignored outcomes', () => {
    assert.equal(outcomeWords('accepted:pick', 2), 'Picked option 2');
    assert.equal(outcomeWords('accepted:skip', 1), 'Skipped option 1');
    assert.equal(outcomeWords('accepted:answer_no', null), 'Answered no');
    assert.equal(outcomeWords('accepted:stop_errand', null), 'Stopped the request');
    assert.equal(outcomeWords('ignored:refractory', 2), 'Ignored: Repeat inside the refractory time');
  });

  test('earpiece feedback: Too soon for the quiet hold, the not-counted chime for a missed option, nothing else', () => {
    assert.deepEqual(outcomeFeedback('ignored:quiet_hold'), { phrase: 'tooSoon' });
    for (const reason of ['stale_step', 'heard_mismatch', 'no_contact', 'digest_mismatch']) {
      assert.deepEqual(outcomeFeedback(`ignored:${reason}`), { chime: 'notCounted' });
    }
    for (const outcome of ['accepted:pick', 'ignored:refractory', 'ignored:veto', 'ignored:not_ready', 'ignored:too_late']) {
      assert.equal(outcomeFeedback(outcome), null);
    }
  });

  test('the last 500 relayed ids are remembered', () => {
    const ids = new RecentIds(3);
    for (const id of ['a', 'b', 'c', 'd']) ids.add(id);
    assert.equal(ids.has('a'), false);
    assert.equal(ids.has('d'), true);
    assert.equal(ids.size, 3);
  });
});

function harness(options: { send?: (args: GestureArgs, attempt: number) => Promise<void>; live?: boolean } = {}) {
  const clock = fakeTimers(10_000);
  const sent: GestureArgs[] = [];
  const chimes: string[] = [];
  const feedback: unknown[] = [];
  const refused: unknown[] = [];
  let attempts = 0;
  const sender = new CommandSender({
    now: clock.now,
    wallNow: () => 1_700_000_000_000,
    heardAt: (onset) => (onset >= 9_000 ? { stepSeq: 12n, optionId: 102n } : { stepSeq: 0n, optionId: 0n }),
    digest: () => 'e1e1e1e1e1e1e1e1',
    oneWayMs: () => 50,
    send: (args) => {
      sent.push(args);
      attempts++;
      return options.send ? options.send(args, attempts) : Promise.resolve();
    },
    waitForLive: async () => options.live ?? true,
    chime: (name) => chimes.push(name),
    feedback: (fb) => feedback.push(fb),
    rankOf: (id) => (id === 102n ? 2 : null),
    sessionRefused: (error) => refused.push(error),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    // Waiting moves the fake clock, so a resend loop always reaches its age limit.
    sleep: async (ms) => clock.advance(ms),
  });
  return { sender, clock, sent, chimes, feedback, refused };
}

describe('the command sender', () => {
  test('a key press plays its tick at once, sends, and reads its outcome from my_session', async () => {
    const h = harness();
    h.sender.relay(input({ onsetLocal: 9_900 }));
    assert.deepEqual(h.chimes, [COMMAND_CHIME.YES]);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0]!.heardOptionId, 102n);
    assert.equal(h.sent[0]!.onsetAgeMs, 150);
    assert.equal(h.sender.entries()[0]!.status, 'sending');
    await flush();
    h.sender.noteOutcome(h.sent[0]!.gestureId, 'accepted:pick');
    await flush();
    assert.equal(h.sender.entries()[0]!.status, 'accepted');
    assert.equal(h.sender.entries()[0]!.words, 'Picked option 2');
  });

  test('an outcome seen before the call resolved is used', async () => {
    let release: () => void = () => {};
    const h = harness({ send: () => new Promise<void>((resolve) => (release = resolve)) });
    h.sender.relay(input({ onsetLocal: 9_900 }));
    h.sender.noteOutcome(h.sent[0]!.gestureId, 'ignored:quiet_hold');
    release();
    await flush();
    await flush();
    assert.equal(h.sender.entries()[0]!.status, 'ignored');
    assert.deepEqual(h.feedback, [{ phrase: 'tooSoon' }]);
  });

  test('no outcome within 1 s says so', async () => {
    const h = harness();
    h.sender.relay(input({ onsetLocal: 9_900 }));
    await flush();
    h.clock.advance(1_001);
    await flush();
    assert.equal(h.sender.entries()[0]!.status, 'unknown');
  });

  test('a disconnect is resent with the same id and a fresh onset age while the onset is young', async () => {
    const h = harness({
      send: (_args, attempt) => {
        if (attempt === 1) {
          h.clock.advance(400);
          return Promise.reject(new DisconnectedError());
        }
        return Promise.resolve();
      },
    });
    h.sender.relay(input({ onsetLocal: 9_900 }));
    await flush();
    await flush();
    assert.equal(h.sent.length, 2);
    assert.equal(h.sent[0]!.gestureId, h.sent[1]!.gestureId);
    assert.ok(h.sent[1]!.onsetAgeMs > h.sent[0]!.onsetAgeMs);
  });

  test('YES is dropped once its onset is 3 s old; STOP is still resent at 10 s', async () => {
    const yes = harness({ send: () => Promise.reject(new UnknownCallResultError('YES')) });
    yes.sender.relay(input({ onsetLocal: 10_000 - 3_100 }));
    await flush();
    await flush();
    assert.equal(yes.sent.length, 1);
    assert.equal(yes.sender.entries()[0]!.status, 'not_sent');
    assert.equal(yes.sender.entries()[0]!.words, 'Not sent: connection');

    const stop = harness({ send: (_a, attempt) => (attempt === 1 ? Promise.reject(new DisconnectedError()) : Promise.resolve()) });
    stop.sender.relay(input({ command: 'STOP', onsetLocal: 10_000 - 10_000 }));
    await flush();
    await flush();
    assert.equal(stop.sent.length, 2);
  });

  test('a refusal is never retried; the session refusals are reported', async () => {
    const h = harness({ send: () => Promise.reject(new SenderError('not the session station')) });
    h.sender.relay(input({ onsetLocal: 9_900 }));
    await flush();
    await flush();
    assert.equal(h.sent.length, 1);
    assert.equal(h.sender.entries()[0]!.status, 'refused');
    assert.equal(h.refused.length, 1);
  });

  test('a repeated decoder id is relayed once; key presses always get a fresh id', () => {
    const h = harness();
    assert.equal(h.sender.relay(input({ gestureId: 'dec-1', via: 'decoder', source: 'imagery' })), true);
    assert.equal(h.sender.relay(input({ gestureId: 'dec-1', via: 'decoder', source: 'imagery' })), false);
    h.sender.relay(input());
    h.sender.relay(input());
    assert.equal(h.sent.length, 3);
    assert.notEqual(h.sent[1]!.gestureId, h.sent[2]!.gestureId);
    assert.equal(h.sent[0]!.gestureId, 'dec-1');
  });

  test('CONFIRM carries the digest; other commands carry none', () => {
    const h = harness();
    h.sender.relay(input({ command: 'CONFIRM' }));
    h.sender.relay(input({ command: 'NO' }));
    assert.equal(h.sent[0]!.heardDigest, 'e1e1e1e1e1e1e1e1');
    assert.equal(h.sent[1]!.heardDigest, '');
  });
});
