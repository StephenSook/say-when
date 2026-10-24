/**
 * The room voice's engine (lib/speaker/engine.ts, docs/station.md 3 and 7.4 B1): each released reply is said once,
 * never an older id; a reply from a snapshot released more than 20 s ago is missed while a live one is said;
 * reply_spoken goes after playback with the clip length and is resent for 60 s; a reload during speech says it again
 * only if it is under 20 s old; a failed speech is tried once more and never reported.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DisconnectedError, SenderError, UnknownCallResultError } from 'spacetimedb';
import { readSpeakerProgress, saveSpeakerProgress, writeItem } from '../lib/role/storage';
import { createServerClock } from '../lib/speaker/clock';
import {
  createSpeakerEngine,
  speakerReportKey,
  SPEAKER_MISSED_AFTER_MS,
  type SayJob,
  type SayResult,
  type SpeakerReply,
} from '../lib/speaker/engine';
import { flush, memoryStorage } from './role-fakes';

const DB = 'say-when-dev';
const T0 = 1_761_300_000_000;

function reply(id: number, releasedAtMs: number, text = 'Tea, please.'): SpeakerReply {
  return { questionId: BigInt(id), text, tone: 'warm', laugh: false, releasedAtMs };
}

interface FakeSay {
  reply: SpeakerReply;
  attempt: number;
  resolve(result: SayResult): void;
  cancelled: boolean;
}

function harness(options: { audio?: boolean; storage?: ReturnType<typeof memoryStorage> } = {}) {
  let now = T0;
  let audio = options.audio ?? true;
  const storage = options.storage ?? memoryStorage();
  const says: FakeSay[] = [];
  const reports: Array<{ questionId: bigint; ms: number }> = [];
  const noted: unknown[] = [];
  let reportAnswer: (attempt: number) => Promise<void> = async () => {};
  const clock = createServerClock();
  const engine = createSpeakerEngine({
    db: DB,
    storage,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    clock,
    audioReady: () => audio,
    say: (r, attempt): SayJob => {
      let resolve: (result: SayResult) => void = () => {};
      const done = new Promise<SayResult>((res) => {
        resolve = res;
      });
      const entry: FakeSay = { reply: r, attempt, resolve, cancelled: false };
      says.push(entry);
      return {
        done,
        cancel() {
          entry.cancelled = true;
          resolve({ ok: false, reason: 'stopped', message: 'Stopped.' });
        },
      };
    },
    reportSpoken: (questionId, ms) => {
      reports.push({ questionId, ms });
      return reportAnswer(reports.length);
    },
    waitForLive: async (timeoutMs) => {
      now += Math.min(timeoutMs, 20_000);
      return true;
    },
    noteCallError: (error) => noted.push(error),
  });
  return {
    engine,
    storage,
    says,
    reports,
    noted,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    setAudio: (on: boolean) => {
      audio = on;
    },
    answerReports: (fn: (attempt: number) => Promise<void>) => {
      reportAnswer = fn;
    },
  };
}

describe('the speaker engine', () => {
  test('a live reply is said once, then reply_spoken carries the clip length', async () => {
    const h = harness();
    h.engine.offer(reply(7, T0 - 300_000), 'live');
    assert.equal(h.says.length, 1, 'a live reply is said at once, whatever its timestamp');
    assert.equal(h.says[0]!.attempt, 1);
    assert.equal(h.engine.getState().phase, 'speaking');
    assert.deepEqual(readSpeakerProgress(DB, h.storage), { questionId: '7', state: 'started' });
    assert.equal(h.reports.length, 0, 'nothing is reported while it plays');

    h.says[0]!.resolve({ ok: true, clipMs: 1234.4 });
    await flush();
    assert.deepEqual(h.reports, [{ questionId: 7n, ms: 1234 }]);
    const state = h.engine.getState();
    assert.equal(state.phase, 'said');
    assert.equal(state.saidAt, h.now());
    assert.equal(state.report, 'done');
    assert.deepEqual(readSpeakerProgress(DB, h.storage), { questionId: '7', state: 'done' });
    assert.equal(h.storage.items.get(speakerReportKey(DB)), undefined, 'the in-flight report record is cleared');

    h.engine.offer(reply(7, T0 - 300_000), 'live');
    h.engine.offer(reply(7, T0 - 300_000), 'snapshot');
    assert.equal(h.says.length, 1, 'the same question is never said twice');
  });

  test('never an older question id', async () => {
    const h = harness();
    h.engine.offer(reply(7, T0), 'live');
    h.says[0]!.resolve({ ok: true, clipMs: 900 });
    await flush();
    h.engine.offer(reply(6, T0), 'live');
    assert.equal(h.says.length, 1);
    h.engine.offer(reply(8, T0), 'live');
    assert.equal(h.says.length, 2);
    assert.equal(h.says[1]!.reply.questionId, 8n);
  });

  test('a snapshot reply released more than 20 s ago is missed; one under 20 s is said', () => {
    const old = harness();
    old.engine.offer(reply(7, T0 - SPEAKER_MISSED_AFTER_MS - 1), 'snapshot');
    assert.equal(old.says.length, 0);
    assert.equal(old.engine.getState().phase, 'missed');
    assert.equal(old.engine.getState().stillReleased, true);

    const fresh = harness();
    fresh.engine.offer(reply(7, T0 - 10_000), 'snapshot');
    assert.equal(fresh.says.length, 1);
  });

  test('the server clock estimate decides the age of a snapshot reply', () => {
    const h = harness();
    // A live scan_state row written 8 s ahead of this laptop's clock: the server runs 8 s ahead.
    h.engine.noteServerTime(T0 + 8_000, T0);
    assert.equal(h.engine.clockOffset(), 8_000);
    // Released 15 s ago by this laptop's clock is 23 s ago by the server's.
    h.engine.offer(reply(7, T0 - 15_000), 'snapshot');
    assert.equal(h.says.length, 0);
    assert.equal(h.engine.getState().phase, 'missed');
  });

  test('with no clock sample the clocks are assumed to agree, and samples older than a minute drop out', () => {
    const clock = createServerClock();
    assert.equal(clock.offset(T0), 0);
    clock.sample(T0 + 3_000, T0);
    clock.sample(T0 + 1_000, T0 + 100);
    assert.equal(clock.offset(T0 + 200), 3_000, 'the largest bound wins');
    assert.equal(clock.offset(T0 + 61_000), 0, 'a sample older than a minute no longer counts');
    clock.sample(T0 + 60_000, T0);
    assert.equal(clock.offset(T0), 3_000, 'a bound further off than 15 s is an old row, not skew');
  });

  test('without the room voice started, a fresh reply waits for the tap, and goes missed after 20 s', () => {
    const h = harness({ audio: false });
    h.engine.offer(reply(7, T0), 'live');
    assert.equal(h.engine.getState().phase, 'waiting_audio');
    assert.equal(h.says.length, 0, 'never spoken into a context that is not running');
    h.advance(5_000);
    h.setAudio(true);
    h.engine.audioChanged();
    assert.equal(h.says.length, 1);

    const late = harness({ audio: false });
    late.engine.offer(reply(9, T0), 'live');
    late.advance(25_000);
    late.setAudio(true);
    late.engine.audioChanged();
    assert.equal(late.says.length, 0);
    assert.equal(late.engine.getState().phase, 'missed');
  });

  test('a waiting reply that leaves my_session is dropped', () => {
    const h = harness({ audio: false });
    h.engine.offer(reply(7, T0), 'live');
    h.engine.offer(null, 'live');
    assert.equal(h.engine.getState().phase, 'idle');
    h.setAudio(true);
    h.engine.audioChanged();
    assert.equal(h.says.length, 0);
  });

  test('reply_spoken is sent again after DisconnectedError and UnknownCallResultError', async () => {
    const h = harness();
    h.answerReports(async (attempt) => {
      if (attempt === 1) throw new DisconnectedError();
      if (attempt === 2) throw new UnknownCallResultError('dropped');
    });
    h.engine.offer(reply(7, T0), 'live');
    h.says[0]!.resolve({ ok: true, clipMs: 800 });
    for (let i = 0; i < 8; i++) await flush();
    assert.equal(h.reports.length, 3);
    assert.ok(h.reports.every((r) => r.questionId === 7n && r.ms === 800), 'the same arguments each time');
    assert.equal(h.engine.getState().report, 'done');
  });

  test('reply_spoken gives up after 60 s without a connection', async () => {
    const h = harness();
    h.answerReports(async () => {
      throw new DisconnectedError();
    });
    h.engine.offer(reply(7, T0), 'live');
    h.says[0]!.resolve({ ok: true, clipMs: 800 });
    for (let i = 0; i < 20; i++) await flush();
    assert.equal(h.engine.getState().report, 'gave_up');
    assert.ok(h.reports.length >= 2 && h.reports.length <= 5, `tried ${h.reports.length} times within 60 s`);
    assert.ok(h.now() - T0 <= 60_000 + 20_000);
  });

  test('reply is not released stops the report without a retry; another refusal reaches the device', async () => {
    const h = harness();
    h.answerReports(async () => {
      throw new SenderError('reply is not released');
    });
    h.engine.offer(reply(7, T0), 'live');
    h.says[0]!.resolve({ ok: true, clipMs: 800 });
    await flush();
    await flush();
    assert.equal(h.reports.length, 1);
    assert.equal(h.engine.getState().report, 'stopped');
    assert.equal(h.noted.length, 0);

    const g = harness();
    g.answerReports(async () => {
      throw new SenderError('not allowed');
    });
    g.engine.offer(reply(7, T0), 'live');
    g.says[0]!.resolve({ ok: true, clipMs: 800 });
    await flush();
    await flush();
    assert.equal(g.reports.length, 1);
    assert.equal(g.engine.getState().report, 'refused');
    assert.equal(g.noted.length, 1, 'not allowed shows the pairing card through the device');
  });

  test('a failed speech is tried once more with attempt 2, and two failures are never reported', async () => {
    const h = harness();
    h.engine.offer(reply(7, T0), 'live');
    h.says[0]!.resolve({ ok: false, reason: 'failed', message: 'socket closed' });
    await flush();
    assert.equal(h.says.length, 2);
    assert.equal(h.says[1]!.attempt, 2);
    h.says[1]!.resolve({ ok: false, reason: 'failed', message: 'socket closed' });
    await flush();
    assert.equal(h.says.length, 2, 'no third try');
    assert.equal(h.engine.getState().phase, 'failed');
    assert.equal(h.engine.getState().errorText, 'socket closed');
    assert.equal(h.reports.length, 0, 'words nobody heard are never reported');

    assert.equal(h.engine.sayNow(), true, 'Say it now starts it again');
    assert.equal(h.says.length, 3);
    h.says[2]!.resolve({ ok: true, clipMs: 700 });
    await flush();
    assert.deepEqual(h.reports, [{ questionId: 7n, ms: 700 }]);
  });

  test('a clip with no sound counts as a failure, not as said', async () => {
    const h = harness();
    h.engine.offer(reply(7, T0), 'live');
    h.says[0]!.resolve({ ok: true, clipMs: 0 });
    await flush();
    h.says[1]!.resolve({ ok: true, clipMs: 0 });
    await flush();
    assert.equal(h.engine.getState().phase, 'failed');
    assert.equal(h.reports.length, 0);
  });

  test('a reload during speech says it again only if it is under 20 s old', () => {
    const storage = memoryStorage();
    saveSpeakerProgress(DB, { questionId: '7', state: 'started' }, storage);
    const fresh = harness({ storage });
    fresh.engine.offer(reply(7, T0 - 12_000), 'snapshot');
    assert.equal(fresh.says.length, 1, 'started and still fresh: said again from the start');

    const storage2 = memoryStorage();
    saveSpeakerProgress(DB, { questionId: '7', state: 'started' }, storage2);
    const stale = harness({ storage: storage2 });
    stale.engine.offer(reply(7, T0 - 25_000), 'snapshot');
    assert.equal(stale.says.length, 0);
    assert.equal(stale.engine.getState().phase, 'missed');
  });

  test('a reply marked done before a reload is not said again, and its report is finished', async () => {
    const storage = memoryStorage();
    saveSpeakerProgress(DB, { questionId: '7', state: 'done' }, storage);
    writeItem(speakerReportKey(DB), JSON.stringify({ questionId: '7', ms: 1500 }), storage);
    const h = harness({ storage });
    h.engine.offer(reply(7, T0 - 2_000), 'snapshot');
    assert.equal(h.says.length, 0);
    assert.equal(h.engine.getState().phase, 'said');
    assert.equal(h.engine.getState().saidAt, null);
    await flush();
    assert.deepEqual(h.reports, [{ questionId: 7n, ms: 1500 }]);
  });

  test('a newer reply that arrives while one is said waits for it, then is said', async () => {
    const h = harness();
    h.engine.offer(reply(7, T0), 'live');
    h.engine.offer(reply(8, T0), 'live');
    assert.equal(h.says.length, 1, 'one at a time');
    h.says[0]!.resolve({ ok: true, clipMs: 600 });
    await flush();
    assert.equal(h.says.length, 2);
    assert.equal(h.says[1]!.reply.questionId, 8n);
  });

  test('Say it now on a missed reply says it, but not once my_session no longer shows it', () => {
    const h = harness();
    h.engine.offer(reply(7, T0 - 60_000), 'snapshot');
    assert.equal(h.engine.getState().phase, 'missed');
    assert.equal(h.engine.sayNow(), true);
    assert.equal(h.says.length, 1);

    const gone = harness();
    gone.engine.offer(reply(7, T0 - 60_000), 'snapshot');
    gone.engine.offer(null, 'live');
    assert.equal(gone.engine.getState().stillReleased, false);
    assert.equal(gone.engine.sayNow(), false);
    assert.equal(gone.says.length, 0);
  });

  test('stop cancels the speech in progress', () => {
    const h = harness();
    h.engine.offer(reply(7, T0), 'live');
    h.engine.stop();
    assert.equal(h.says[0]!.cancelled, true);
  });
});
