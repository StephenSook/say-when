/**
 * Reading a reducer's answer (lib/role/calls.ts, docs/station.md 1.5 and 7.2 C1): classification by error name,
 * the resend helper's age and try limits on a fake clock, and the feature check for a reducer that a module version
 * may not have (report_word_timings, module v2).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DisconnectedError, SenderError, UnknownCallResultError } from 'spacetimedb';
import { DbConnection } from '../lib/data/module_bindings';
import ReportWordTimingsParams from '../lib/data/module_bindings/report_word_timings_reducer';
import {
  type ReportWordTimingsArgs,
  callErrorKind,
  callErrorText,
  isSenderMessage,
  mayResend,
  notConnectedError,
  optionalReducer,
  SENDER_MESSAGES,
  sendWithResend,
  wordTimingsReducer,
} from '../lib/role/calls';

function named(name: string, message = 'x'): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe('classifying a call error', () => {
  test('by name, for the SDK classes and for look-alikes', () => {
    assert.equal(callErrorKind(new SenderError('not allowed')), 'sender');
    assert.equal(callErrorKind(new DisconnectedError()), 'disconnected');
    assert.equal(callErrorKind(new UnknownCallResultError()), 'unknown_result');
    assert.equal(callErrorKind(named('SenderError')), 'sender');
    assert.equal(callErrorKind(named('InternalError')), 'internal');
    assert.equal(callErrorKind(new TypeError('boom')), 'other');
    assert.equal(callErrorKind('a string'), 'other');
    assert.equal(callErrorKind(notConnectedError()), 'disconnected');
  });

  test('only "not sent" and "may have run" are sent again', () => {
    assert.equal(mayResend(new DisconnectedError()), true);
    assert.equal(mayResend(new UnknownCallResultError()), true);
    assert.equal(mayResend(new SenderError('no active session')), false);
    assert.equal(mayResend(named('InternalError')), false);
  });

  test('exact refusal messages', () => {
    assert.equal(isSenderMessage(new SenderError('not allowed'), SENDER_MESSAGES.notAllowed), true);
    assert.equal(isSenderMessage(new SenderError('not the session station'), SENDER_MESSAGES.notAllowed), false);
    assert.equal(isSenderMessage(named('DisconnectedError', 'not allowed'), SENDER_MESSAGES.notAllowed), false);
    assert.equal(callErrorText(new SenderError('code taken: pick a new code')), 'code taken: pick a new code');
  });
});

/** A fake clock and sleep, so waits take no real time. */
function fakeClock() {
  let now = 1_000;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

describe('sendWithResend', () => {
  test('resolves at once when the first call goes through', async () => {
    const clock = fakeClock();
    let calls = 0;
    const value = await sendWithResend(
      async () => {
        calls++;
        return 'ok';
      },
      { maxAgeMs: 3_000, waitForLive: async () => true, now: clock.now, sleep: clock.sleep },
    );
    assert.equal(value, 'ok');
    assert.equal(calls, 1);
  });

  test('never sends a refused call again', async () => {
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(
      sendWithResend(
        async () => {
          calls++;
          throw new SenderError('not allowed');
        },
        { maxAgeMs: 30_000, waitForLive: async () => true, now: clock.now, sleep: clock.sleep },
      ),
      (error: unknown) => callErrorKind(error) === 'sender',
    );
    assert.equal(calls, 1);
  });

  test('sends again after a drop, once live, with the attempt number', async () => {
    const clock = fakeClock();
    const attempts: number[] = [];
    const value = await sendWithResend(
      async (attempt) => {
        attempts.push(attempt);
        if (attempt < 3) throw attempt === 1 ? new DisconnectedError() : new UnknownCallResultError();
        return 'sent';
      },
      {
        maxAgeMs: 30_000,
        waitForLive: async () => {
          clock.advance(500);
          return true;
        },
        now: clock.now,
        sleep: clock.sleep,
      },
    );
    assert.equal(value, 'sent');
    assert.deepEqual(attempts, [1, 2, 3]);
  });

  test('stops at its age limit and throws the last error (3 s for YES and NO)', async () => {
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(
      sendWithResend(
        async () => {
          calls++;
          throw new DisconnectedError();
        },
        {
          maxAgeMs: 3_000,
          waitForLive: async (timeoutMs) => {
            clock.advance(Math.min(timeoutMs, 1_000));
            return true;
          },
          now: clock.now,
          sleep: clock.sleep,
        },
      ),
      (error: unknown) => callErrorKind(error) === 'disconnected',
    );
    assert.ok(calls >= 2 && calls <= 4, `sent ${calls} times inside 3 s`);
    assert.ok(clock.now() - 1_000 <= 3_000 + 1_000, 'gave up near the limit');
  });

  test('gives up when the connection does not come back in time', async () => {
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(
      sendWithResend(
        async () => {
          calls++;
          throw new UnknownCallResultError();
        },
        {
          maxAgeMs: 30_000,
          waitForLive: async (timeoutMs) => {
            clock.advance(timeoutMs);
            return false;
          },
          now: clock.now,
          sleep: clock.sleep,
        },
      ),
    );
    assert.equal(calls, 1);
  });

  test('respects a try limit (ask_question: 3 tries)', async () => {
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(
      sendWithResend(
        async () => {
          calls++;
          throw new DisconnectedError();
        },
        { maxAgeMs: 30_000, maxTries: 3, waitForLive: async () => true, now: clock.now, sleep: clock.sleep },
      ),
    );
    assert.equal(calls, 3);
  });

  test('waits at least the minimum gap between tries', async () => {
    const clock = fakeClock();
    const sleeps: number[] = [];
    await assert.rejects(
      sendWithResend(
        async () => {
          throw new DisconnectedError();
        },
        {
          maxAgeMs: 1_000,
          minGapMs: 300,
          waitForLive: async () => true,
          now: clock.now,
          sleep: async (ms) => {
            sleeps.push(ms);
            clock.advance(ms);
          },
        },
      ),
    );
    assert.ok(sleeps.length >= 1 && sleeps.every((ms) => ms === 300));
  });
});

describe('a reducer the module may not have', () => {
  test('missing from these bindings gives null, so the page keeps working', () => {
    const conn = { reducers: { heartbeat: async () => {} } };
    assert.equal(wordTimingsReducer(conn), null);
    assert.equal(optionalReducer(null, 'heartbeat'), null);
    assert.equal(optionalReducer({}, 'heartbeat'), null);
    assert.equal(optionalReducer({ reducers: { heartbeat: 'not a function' } }, 'heartbeat'), null);
  });

  test('present in newer bindings gives a call bound to its reducers object', async () => {
    const seen: unknown[] = [];
    const reducers = {
      marker: 'v2',
      reportWordTimings(this: { marker: string }, args: unknown) {
        seen.push([this.marker, args]);
        return Promise.resolve();
      },
    };
    const send = wordTimingsReducer({ reducers });
    assert.ok(send);
    await send({ sessionId: 3n, stepSeq: 5n, optionId: 9n, startsMs: [0, 200], endsMs: [180, 400] });
    assert.deepEqual(seen, [['v2', { sessionId: 3n, stepSeq: 5n, optionId: 9n, startsMs: [0, 200], endsMs: [180, 400] }]]);
  });

  test('the page sends exactly the fields the generated report_word_timings takes', () => {
    // The page's call shape must match the generated reducer's parameters, or the SDK serializes a field as undefined.
    const sent: Record<keyof ReportWordTimingsArgs, true> = { sessionId: true, stepSeq: true, optionId: true, startsMs: true, endsMs: true };
    assert.deepEqual(Object.keys(ReportWordTimingsParams).sort(), Object.keys(sent).sort());
  });

  test('the generated bindings in this build: heartbeat is there; report_word_timings may or may not be', () => {
    // The generated reducer accessors, read from the builder's module without opening a socket.
    const builder = DbConnection.builder() as unknown as { remoteModule: { reducers: Array<{ accessorName: string }> } };
    const names = builder.remoteModule.reducers.map((reducer) => reducer.accessorName);
    assert.ok(names.includes('heartbeat'));
    assert.ok(names.includes('requestPairing'));
    // Either binding set works: a connection's reducers object has one function per generated accessor, and the
    // check finds report_word_timings exactly when these bindings have it.
    const generated = Object.fromEntries(names.map((name) => [name, async () => {}]));
    assert.equal(wordTimingsReducer({ reducers: generated }) !== null, names.includes('reportWordTimings'));
  });
});
