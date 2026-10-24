/**
 * The heartbeat (lib/station/heartbeat.ts, docs/station.md 2.3, 2.8 and 7.3 A5): `decoder_healthy` per mode, no
 * beats without ownership or a running earpiece, one extra beat on a healthy-to-unhealthy change, beats stop on the
 * three session refusals, `beat_seq` keeps rising, and the round trip is the median of the last 20 beats.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DisconnectedError, SenderError } from 'spacetimedb';
import { firstBeatSeq, Heartbeat, heartbeatInterval, inputHealthy, median, type Ticker } from '../lib/station/heartbeat';
import { fakeTimers, flush } from './role-fakes';

describe('decoder_healthy per input mode', () => {
  const base = { decoderHealthy: false, visible: true, focused: true, blurredAt: null, now: 10_000 };

  test('headset: the decoder bridge decides', () => {
    assert.equal(inputHealthy({ ...base, mode: 'headset', decoderHealthy: true }), true);
    assert.equal(inputHealthy({ ...base, mode: 'headset', decoderHealthy: false }), false);
  });

  test('keyboard: the page is visible', () => {
    assert.equal(inputHealthy({ ...base, mode: 'keyboard', decoderHealthy: false }), true);
    assert.equal(inputHealthy({ ...base, mode: 'keyboard', visible: false }), false);
  });

  test('switch: visible and focused, with 2 s of grace after a focus loss', () => {
    assert.equal(inputHealthy({ ...base, mode: 'switch' }), true);
    assert.equal(inputHealthy({ ...base, mode: 'switch', focused: false, blurredAt: 8_500 }), true);
    assert.equal(inputHealthy({ ...base, mode: 'switch', focused: false, blurredAt: 8_000 }), false);
    assert.equal(inputHealthy({ ...base, mode: 'switch', visible: false }), false);
  });

  test('the interval stays inside 200 to 2000 ms; beat_seq starts at the wall clock', () => {
    assert.equal(heartbeatInterval(500), 500);
    assert.equal(heartbeatInterval(50), 200);
    assert.equal(heartbeatInterval(9_000), 2_000);
    assert.equal(heartbeatInterval(undefined), 500);
    assert.equal(firstBeatSeq(1_700_000_000_123), 1_700_000_000_123n);
    assert.equal(median([5, 1, 3]), 3);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([]), null);
  });
});

class FakeTicker implements Ticker {
  interval: number | null = null;
  private onTick: (() => void) | null = null;
  start(intervalMs: number, onTick: () => void) {
    this.interval = intervalMs;
    this.onTick = onTick;
  }
  stop() {
    this.interval = null;
    this.onTick = null;
  }
  tick() {
    this.onTick?.();
  }
}

function harness(options: { answer?: (seq: bigint) => Promise<void> } = {}) {
  const clock = fakeTimers(1_000);
  const ticker = new FakeTicker();
  const beats: Array<{ seq: bigint; healthy: boolean }> = [];
  let healthy = true;
  let canBeat = true;
  let ok = 0;
  const refused: unknown[] = [];
  const hb = new Heartbeat({
    send: (seq, h) => {
      beats.push({ seq, healthy: h });
      return options.answer ? options.answer(seq) : Promise.resolve();
    },
    healthy: () => healthy,
    canBeat: () => canBeat,
    ticker,
    now: clock.now,
    firstSeq: 1_700_000_000_000n,
    onBeatOk: () => ok++,
    onRefused: (e) => refused.push(e),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return {
    hb,
    clock,
    ticker,
    beats,
    refused,
    ok: () => ok,
    setHealthy: (v: boolean) => (healthy = v),
    setCanBeat: (v: boolean) => (canBeat = v),
  };
}

describe('the heartbeat', () => {
  test('one beat per tick with a rising beat_seq', async () => {
    const h = harness();
    h.hb.arm(500);
    assert.equal(h.ticker.interval, 500);
    h.ticker.tick();
    h.ticker.tick();
    h.ticker.tick();
    assert.deepEqual(
      h.beats.map((b) => b.seq),
      [1_700_000_000_000n, 1_700_000_000_001n, 1_700_000_000_002n],
    );
    await flush();
    assert.equal(h.ok(), 3);
  });

  test('no beats without ownership, a live connection or a running earpiece', () => {
    const h = harness();
    h.hb.arm(500);
    h.setCanBeat(false);
    h.ticker.tick();
    assert.equal(h.hb.beat(), false);
    assert.equal(h.beats.length, 0);
  });

  test('a healthy-to-unhealthy change sends one extra beat at once with false', () => {
    const h = harness();
    h.hb.arm(500);
    h.ticker.tick();
    h.setHealthy(false);
    assert.equal(h.hb.inputChanged(), true);
    assert.deepEqual(
      h.beats.map((b) => b.healthy),
      [true, false],
    );
    assert.equal(h.hb.inputChanged(), false, 'no second extra beat while still unhealthy');
    h.setHealthy(true);
    assert.equal(h.hb.inputChanged(), false, 'unhealthy to healthy waits for the next tick');
  });

  test('beats stop on not the session station, no active session and not allowed', async () => {
    for (const message of ['not the session station', 'no active session', 'not allowed']) {
      const h = harness({ answer: () => Promise.reject(new SenderError(message)) });
      h.hb.arm(500);
      h.ticker.tick();
      await flush();
      assert.equal(h.refused.length, 1, message);
      assert.equal(h.hb.getState().armed, false);
      assert.equal(h.ticker.interval, null);
      assert.equal(h.hb.getState().refusedText, message);
    }
  });

  test('a beat lost to the connection is skipped and beating goes on', async () => {
    const h = harness({ answer: () => Promise.reject(new DisconnectedError()) });
    h.hb.arm(500);
    h.ticker.tick();
    await flush();
    assert.equal(h.hb.getState().armed, true);
    assert.equal(h.refused.length, 0);
  });

  test('the round trip is the median of answered beats; a beat unanswered for 3 s is a problem', async () => {
    const pending: Array<() => void> = [];
    const h = harness({ answer: () => new Promise<void>((resolve) => pending.push(resolve)) });
    h.hb.arm(500);
    for (const wait of [100, 80, 120]) {
      h.ticker.tick();
      h.clock.advance(wait);
      pending.shift()!();
      await flush();
    }
    assert.equal(h.hb.getState().rttMedianMs, 100);
    assert.equal(h.hb.oneWayMs(), 50);
    h.ticker.tick();
    h.clock.advance(3_000);
    assert.equal(h.hb.getState().problem, true);
    pending.shift()!();
    await flush();
    assert.equal(h.hb.getState().problem, false);
  });

  test('re-arming with a new interval restarts the tick', () => {
    const h = harness();
    h.hb.arm(500);
    h.hb.arm(800);
    assert.equal(h.ticker.interval, 800);
    h.hb.disarm();
    assert.equal(h.ticker.interval, null);
  });
});
