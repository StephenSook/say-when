/**
 * Earpiece audio (lib/station/earpiece.ts, docs/station.md 2.9 and 7.3 A6) with a fake player and a fake AudioOut:
 * rank order, one `report_clip_ready` per option, none for a 0 ms clip, no synthesis for a yes or no version, the
 * pending version after the current one, jobs cancelled when options leave, playback only on a new Reading step,
 * stops on Idle and Paused, the play start in the heard log, and `report_word_timings` once per read.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DisconnectedError } from 'spacetimedb';
import type { ReportWordTimingsArgs } from '../lib/role/calls';
import { Channel, cleanWordTimings, Earpiece, reportableClipMs, type ClipLike, type OptionRowLite, type ScanLite } from '../lib/station/earpiece';
import { HeardLog } from '../lib/station/heard';
import { flush } from './role-fakes';

interface FakeClip extends ClipLike {
  name: string;
}

function clip(name: string, durationMs = 1_200, words = [{ word: 'Tea', startMs: 0, endMs: 300 }]): FakeClip {
  return { name, durationMs, totalMs: 400, words };
}

class FakeOut {
  plays: string[] = [];
  stops = 0;
  private resolve: ((how: 'ended' | 'stopped') => void) | null = null;
  play(c: FakeClip) {
    this.resolve?.('stopped');
    this.plays.push(c.name);
    return new Promise<'ended' | 'stopped'>((resolve) => (this.resolve = resolve));
  }
  stop() {
    this.stops++;
    this.resolve?.('stopped');
    this.resolve = null;
  }
  end() {
    this.resolve?.('ended');
    this.resolve = null;
  }
  positionMs() {
    return 0;
  }
}

function row(optionId: bigint, rank: number, patch: Partial<OptionRowLite> = {}): OptionRowLite {
  return { optionId, questionId: 7n, version: 1, rank, kind: 'Reply', text: `Option ${rank}`, tone: 'warm', laugh: false, current: true, ...patch };
}

function scan(patch: Partial<ScanLite>): ScanLite {
  return { sessionId: 3n, questionId: 7n, version: 1, phase: 'preparing', answerMode: 'pick', cursor: 0, optionCount: 2, stepSeq: 1n, optionStartSeq: 0n, ...patch };
}

function harness(options: { silent?: boolean; timings?: boolean; timingsFail?: Error; ready?: () => boolean } = {}) {
  let now = 1_000;
  const out = new FakeOut();
  const channel = new Channel<FakeClip>(out);
  const heard = new HeardLog();
  const asked: bigint[] = [];
  const cancelled: bigint[] = [];
  const jobs = new Map<string, { resolve: (c: FakeClip) => void; reject: (e: Error) => void }>();
  const reports: Array<{ optionId: bigint; clipMs: number; synthMs: number }> = [];
  const timings: ReportWordTimingsArgs[] = [];
  let timingCalls = 0;
  const ear = new Earpiece<FakeClip>({
    now: () => now,
    latencyMs: () => 60,
    heard,
    options: channel,
    speakOption: (r) => {
      asked.push(r.optionId);
      const done = new Promise<FakeClip>((resolve, reject) => jobs.set(r.optionId.toString(), { resolve, reject }));
      return {
        done,
        cancel: () => {
          cancelled.push(r.optionId);
          const error = new Error('Cancelled.');
          error.name = 'TtsCancelled';
          jobs.get(r.optionId.toString())?.reject(error);
        },
      };
    },
    yesNoPrompt: async () => clip('yes or no'),
    silent: () => options.silent ?? false,
    ...(options.ready ? { ready: options.ready } : {}),
    reportClip: async (args) => void reports.push(args),
    wordTimings: () =>
      options.timings === false
        ? null
        : async (args) => {
            timingCalls++;
            if (options.timingsFail) throw options.timingsFail;
            timings.push(args);
          },
    waitForLive: async () => true,
    sleep: async () => {},
  });
  const finish = async (id: bigint, c: FakeClip = clip(`clip ${id}`)) => {
    jobs.get(id.toString())!.resolve(c);
    await flush();
  };
  return {
    ear,
    out,
    heard,
    asked,
    cancelled,
    reports,
    timings,
    finish,
    timingCalls: () => timingCalls,
    advance: (ms: number) => (now += ms),
    now: () => now,
  };
}

describe('earpiece helpers', () => {
  test('word timings are whole ms, sorted, ends at or after starts, capped at 30000, at most 100', () => {
    assert.deepEqual(
      cleanWordTimings([
        { word: 'b', startMs: 400.4, endMs: 380 },
        { word: 'a', startMs: 0, endMs: 199.6 },
        { word: 'c', startMs: 31_000, endMs: 32_000 },
      ]),
      { startsMs: [0, 400, 30_000], endsMs: [200, 400, 30_000] },
    );
    const many = Array.from({ length: 150 }, (_, i) => ({ word: 'w', startMs: i * 10, endMs: i * 10 + 5 }));
    assert.equal(cleanWordTimings(many)!.startsMs.length, 100);
    assert.equal(cleanWordTimings([]), null);
  });

  test('report_clip_ready takes 1 to 30000 ms', () => {
    assert.equal(reportableClipMs(0), null);
    assert.equal(reportableClipMs(0.4), null);
    assert.equal(reportableClipMs(1_234.6), 1_235);
    assert.equal(reportableClipMs(30_001), null);
  });
});

describe('synthesis', () => {
  test('current options in rank order, one at a time, one report each', async () => {
    const h = harness();
    h.ear.setOptions([row(12n, 2), row(11n, 1)]);
    assert.deepEqual(h.asked, [11n], 'one job at a time, rank 1 first');
    await h.finish(11n);
    assert.deepEqual(h.asked, [11n, 12n]);
    await h.finish(12n);
    assert.deepEqual(
      h.reports.map((r) => r.optionId),
      [11n, 12n],
    );
    assert.equal(h.reports[0]!.clipMs, 1_200);
    assert.equal(h.reports[0]!.synthMs, 400);
    h.ear.setOptions([row(12n, 2), row(11n, 1)]);
    await flush();
    assert.equal(h.reports.length, 2, 'never reported twice');
    // The rows leave the view for a moment and come back: the clip is voiced again but not reported again.
    h.ear.setOptions([]);
    h.ear.setOptions([row(11n, 1)]);
    assert.deepEqual(h.asked, [11n, 12n, 11n]);
    await h.finish(11n);
    assert.equal(h.reports.length, 2, 'one report per option id');
  });

  test('a 0 ms clip is not reported', async () => {
    const h = harness();
    h.ear.setOptions([row(11n, 1)]);
    await h.finish(11n, clip('empty', 0));
    assert.equal(h.reports.length, 0);
  });

  test('the pending version comes after the current one', async () => {
    const h = harness();
    h.ear.setOptions([row(21n, 1, { version: 2, current: false }), row(11n, 1), row(12n, 2)]);
    await h.finish(11n);
    await h.finish(12n);
    assert.deepEqual(h.asked, [11n, 12n, 21n]);
  });

  test('a current yes or no version is not synthesized', async () => {
    const h = harness();
    h.ear.onScan(scan({ phase: 'preparing', answerMode: 'yes_no', stepSeq: 1n }), 1_000);
    h.ear.setOptions([row(11n, 1), row(12n, 2)]);
    await flush();
    assert.deepEqual(h.asked, []);
  });

  test('the scanned question answer mode from my_session is used before the scan reaches the version', async () => {
    const h = harness();
    h.ear.setAnswerHint(7n, 'yes_no');
    h.ear.setOptions([row(11n, 1), row(12n, 2)]);
    await flush();
    assert.deepEqual(h.asked, []);
  });

  test('jobs are cancelled and clips dropped when their options leave my_options', async () => {
    const h = harness();
    h.ear.setOptions([row(11n, 1), row(12n, 2)]);
    await h.finish(11n);
    h.ear.setOptions([row(31n, 1, { questionId: 8n })]);
    assert.deepEqual(h.cancelled, [12n]);
    assert.equal(h.ear.clipOf(11n), undefined);
    assert.deepEqual(h.asked, [11n, 12n, 31n]);
  });

  test('while the voice is not ready nothing is asked for or marked failed; it starts once kicked', async () => {
    let ready = false;
    const h = harness({ ready: () => ready });
    h.ear.setOptions([row(11n, 1), row(12n, 2)]);
    assert.deepEqual(h.asked, []);
    ready = true;
    h.ear.kick();
    assert.deepEqual(h.asked, [11n]);
  });

  test('silent test mode synthesizes, plays and reports nothing', async () => {
    const h = harness({ silent: true });
    h.ear.setOptions([row(11n, 1)]);
    h.ear.onScan(scan({ phase: 'reading', cursor: 1, stepSeq: 2n, optionStartSeq: 2n }), 1_000);
    await flush();
    assert.deepEqual(h.asked, []);
    assert.deepEqual(h.out.plays, []);
    assert.deepEqual(h.heard.lookup(1_000), { stepSeq: 2n, optionId: 11n }, 'the heard log uses arrival times');
  });
});

describe('playback driven by scan_state', () => {
  async function ready() {
    const h = harness();
    h.ear.setOptions([row(11n, 1), row(12n, 2)]);
    await h.finish(11n);
    await h.finish(12n);
    return h;
  }

  test('a new Reading step plays its option and logs the play start (plus latency) in the heard log', async () => {
    const h = await ready();
    h.ear.onScan(scan({ phase: 'reading', cursor: 1, stepSeq: 2n, optionStartSeq: 2n }), 1_000);
    assert.deepEqual(h.out.plays, ['clip 11']);
    // Play start = now (1000) + latency (60); heard from 200 ms later.
    assert.deepEqual(h.heard.lookup(1_259), { stepSeq: 0n, optionId: 0n });
    assert.deepEqual(h.heard.lookup(1_260), { stepSeq: 2n, optionId: 11n });
    assert.equal(h.ear.getState().lagMedianMs, 60);
  });

  test('the same step again does not play twice; Window plays nothing new', async () => {
    const h = await ready();
    h.ear.onScan(scan({ phase: 'reading', cursor: 1, stepSeq: 2n, optionStartSeq: 2n }), 1_000);
    h.ear.onScan(scan({ phase: 'reading', cursor: 1, stepSeq: 2n, optionStartSeq: 2n }), 1_100);
    h.ear.onScan(scan({ phase: 'window', cursor: 1, stepSeq: 3n, optionStartSeq: 2n }), 2_300);
    assert.deepEqual(h.out.plays, ['clip 11']);
  });

  test('a late clip plays the moment it is ready while its read or Window is current, else never', async () => {
    const h = harness();
    h.ear.setOptions([row(11n, 1), row(12n, 2)]);
    await h.finish(11n);
    h.ear.onScan(scan({ phase: 'reading', cursor: 2, stepSeq: 4n, optionStartSeq: 4n }), 1_000);
    assert.deepEqual(h.out.plays, []);
    h.ear.onScan(scan({ phase: 'window', cursor: 2, stepSeq: 5n, optionStartSeq: 4n }), 2_000);
    await h.finish(12n);
    assert.deepEqual(h.out.plays, ['clip 12'], 'played late inside its own Window');

    const g = harness();
    g.ear.setOptions([row(11n, 1), row(12n, 2)]);
    await g.finish(11n);
    g.ear.onScan(scan({ phase: 'reading', cursor: 2, stepSeq: 4n, optionStartSeq: 4n }), 1_000);
    g.ear.onScan(scan({ phase: 'idle', cursor: 0, stepSeq: 6n, optionStartSeq: 4n }), 2_000);
    await g.finish(12n);
    assert.deepEqual(g.out.plays, [], 'dropped once the read is over');
  });

  test('a yes or no read plays the prompt as option 0', async () => {
    const h = harness();
    h.ear.onScan(scan({ phase: 'reading', answerMode: 'yes_no', cursor: 0, stepSeq: 2n, optionStartSeq: 2n }), 1_000);
    await flush();
    assert.deepEqual(h.out.plays, ['yes or no']);
    assert.deepEqual(h.heard.lookup(5_000), { stepSeq: 2n, optionId: 0n });
    assert.equal(h.timings[0]!.optionId, 0n);
  });

  test('Idle stops option audio but not a read-back; Paused stops everything', async () => {
    const h = await ready();
    const channel = (h.ear as unknown as { deps: { options: Channel<FakeClip> } }).deps.options;
    h.ear.onScan(scan({ phase: 'reading', cursor: 1, stepSeq: 2n, optionStartSeq: 2n }), 1_000);
    h.ear.onScan(scan({ phase: 'idle', stepSeq: 3n }), 1_500);
    assert.equal(h.out.stops, 1);
    void channel.play(clip('read-back'), 'readback');
    h.ear.onScan(scan({ phase: 'idle', stepSeq: 4n }), 2_000);
    assert.equal(h.out.stops, 1, 'a read-back is not cut by Idle');
    h.ear.onScan(scan({ phase: 'paused', stepSeq: 5n }), 2_500);
    assert.equal(h.out.stops, 2);
  });

  test('one report_word_timings per read, keyed by the session and read step, with cleaned timings', async () => {
    const h = await ready();
    h.ear.onScan(scan({ phase: 'reading', cursor: 1, stepSeq: 2n, optionStartSeq: 2n }), 1_000);
    h.ear.onScan(scan({ phase: 'window', cursor: 1, stepSeq: 3n, optionStartSeq: 2n }), 2_000);
    h.ear.onScan(scan({ phase: 'reading', cursor: 2, stepSeq: 4n, optionStartSeq: 4n }), 3_000);
    await flush();
    // The module accepts only the active session's reads, so every report names the session the read belongs to.
    assert.deepEqual(h.timings, [
      { sessionId: 3n, stepSeq: 2n, optionId: 11n, startsMs: [0], endsMs: [300] },
      { sessionId: 3n, stepSeq: 4n, optionId: 12n, startsMs: [0], endsMs: [300] },
    ]);
  });

  test('a clip with no words is not reported', async () => {
    const h = harness();
    h.ear.setOptions([row(11n, 1)]);
    await h.finish(11n, clip('quiet', 900, []));
    h.ear.onScan(scan({ phase: 'reading', cursor: 1, stepSeq: 2n, optionStartSeq: 2n }), 1_000);
    await flush();
    assert.deepEqual(h.out.plays, ['quiet']);
    assert.equal(h.timingCalls(), 0);
  });

  test('without the v2 reducer nothing is reported and playback goes on', async () => {
    const h = harness({ timings: false });
    h.ear.setOptions([row(11n, 1)]);
    await h.finish(11n);
    h.ear.onScan(scan({ phase: 'reading', cursor: 1, stepSeq: 2n, optionStartSeq: 2n }), 1_000);
    await flush();
    assert.deepEqual(h.out.plays, ['clip 11']);
    assert.equal(h.timingCalls(), 0);
  });

  test('a module that fails the v2 call stops the calls for the session; a disconnect is resent', async () => {
    const internal = new Error('No such reducer report_word_timings');
    internal.name = 'InternalError';
    const h = harness({ timingsFail: internal });
    h.ear.setOptions([row(11n, 1), row(12n, 2)]);
    await h.finish(11n);
    await h.finish(12n);
    h.ear.onScan(scan({ phase: 'reading', cursor: 1, stepSeq: 2n, optionStartSeq: 2n }), 1_000);
    await flush();
    h.ear.onScan(scan({ phase: 'reading', cursor: 2, stepSeq: 4n, optionStartSeq: 4n }), 3_000);
    await flush();
    assert.equal(h.timingCalls(), 1);
    assert.equal(h.ear.getState().wordTimingsOff, true);
    assert.deepEqual(h.out.plays, ['clip 11', 'clip 12']);

    let tries = 0;
    const d = harness();
    (d.ear as unknown as { deps: { wordTimings: () => unknown } }).deps.wordTimings = () => async () => {
      tries++;
      if (tries === 1) throw new DisconnectedError();
    };
    d.ear.setOptions([row(11n, 1)]);
    await d.finish(11n);
    d.ear.onScan(scan({ phase: 'reading', cursor: 1, stepSeq: 2n, optionStartSeq: 2n }), 1_000);
    await flush();
    assert.equal(tries, 2);
  });
});
