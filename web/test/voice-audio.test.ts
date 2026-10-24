/**
 * The audio tap, the chimes and the device watch (lib/voice/audio.ts, docs/station.md 2.9, 5.3, 5.5 and Appendix A),
 * against a fake AudioContext and navigator. No sound plays here.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CHIME_GAIN, CHIMES, contextLatencyMs, createAudioUnlock, playChime, type UnlockContextLike } from '../lib/voice/audio';

class FakeContext implements UnlockContextLike {
  state = 'suspended';
  currentTime = 10;
  destination = { name: 'destination' };
  baseLatency = 0.01;
  outputLatency = 0.03;
  onstatechange: (() => void) | null = null;
  resumes = 0;
  suspends = 0;
  closed = false;
  failResume: Error | null = null;
  oscillators: Array<{ hz: number[]; start: number; stop: number; connectedTo: unknown }> = [];
  gains: Array<{ events: Array<[string, number, number]>; connectedTo: unknown }> = [];
  async resume() {
    this.resumes++;
    if (this.failResume) throw this.failResume;
    this.state = 'running';
    this.onstatechange?.();
  }
  async suspend() {
    this.suspends++;
    this.state = 'suspended';
    this.onstatechange?.();
  }
  async close() {
    this.closed = true;
    this.state = 'closed';
  }
  createOscillator() {
    const record = { hz: [] as number[], start: -1, stop: -1, connectedTo: null as unknown };
    this.oscillators.push(record);
    return {
      type: 'sine',
      frequency: { setValueAtTime: (value: number) => record.hz.push(value) },
      connect: (to: unknown) => {
        record.connectedTo = to;
        return to;
      },
      start: (when?: number) => {
        record.start = when ?? 0;
      },
      stop: (when?: number) => {
        record.stop = when ?? 0;
      },
    };
  }
  createGain() {
    const record = { events: [] as Array<[string, number, number]>, connectedTo: null as unknown };
    this.gains.push(record);
    return {
      gain: {
        setValueAtTime: (value: number, time: number) => record.events.push(['set', value, time]),
        linearRampToValueAtTime: (value: number, time: number) => record.events.push(['ramp', value, time]),
      },
      connect: (to: unknown) => {
        record.connectedTo = to;
        return to;
      },
    };
  }
}

function fakeNavigator(options: { wakeLock?: boolean; refuseWakeLock?: boolean } = {}) {
  const deviceListeners = new Set<() => void>();
  let wakeRequests = 0;
  let released = 0;
  return {
    nav: {
      mediaDevices: {
        addEventListener: (_type: 'devicechange', listener: () => void) => void deviceListeners.add(listener),
        removeEventListener: (_type: 'devicechange', listener: () => void) => void deviceListeners.delete(listener),
      },
      wakeLock:
        options.wakeLock === false
          ? undefined
          : {
              request: async () => {
                wakeRequests++;
                if (options.refuseWakeLock) throw new Error('NotAllowedError');
                return {
                  release: async () => {
                    released++;
                  },
                };
              },
            },
    },
    fireDeviceChange: () => [...deviceListeners].forEach((listener) => listener()),
    deviceListeners,
    wakeRequests: () => wakeRequests,
    released: () => released,
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('the audio tap', () => {
  test('nothing starts before the tap; the tap makes one context, resumes it and plays one tick', async () => {
    let made = 0;
    const ctx = new FakeContext();
    const n = fakeNavigator();
    const audio = createAudioUnlock({ createContext: () => (made++, ctx), navigator: n.nav, now: () => 5 });
    assert.equal(audio.getState().state, 'locked');
    assert.equal(audio.context(), null);
    assert.equal(audio.running(), false);
    assert.equal(made, 0, 'no AudioContext before a user gesture');

    const state = await audio.start();
    await flush();
    assert.equal(state, 'running');
    assert.equal(made, 1);
    assert.equal(ctx.resumes, 1);
    assert.equal(audio.running(), true);
    assert.equal(audio.getState().startedAt, 5);
    assert.equal(audio.getState().latencyMs, 40);
    assert.equal(ctx.oscillators.length, 1, 'one tick so the operator hears the output');
    assert.deepEqual(ctx.oscillators[0]!.hz, [1200]);
    assert.equal(n.wakeRequests(), 1);
    assert.equal(audio.getState().wakeLock, 'held');

    // A second tap reuses the same context.
    await audio.start();
    assert.equal(made, 1);
    audio.close();
    assert.equal(ctx.closed, true);
    assert.equal(n.released(), 1);
    assert.equal(n.deviceListeners.size, 0);
  });

  test('the browser suspending the context needs the tap again', async () => {
    const ctx = new FakeContext();
    const audio = createAudioUnlock({ createContext: () => ctx, navigator: null, tick: false });
    await audio.start();
    await ctx.suspend();
    assert.equal(audio.getState().state, 'suspended');
    assert.equal(audio.running(), false);
    assert.equal(audio.chime('yes'), false, 'no chime while suspended');
    await audio.start();
    assert.equal(audio.getState().state, 'running');
  });

  test('an audio device change suspends and asks for the tap (the earpiece may have come out)', async () => {
    const ctx = new FakeContext();
    const n = fakeNavigator();
    const audio = createAudioUnlock({ createContext: () => ctx, navigator: n.nav, tick: false, now: () => 77 });
    // Before the first tap a device change does nothing.
    n.fireDeviceChange();
    assert.equal(audio.getState().state, 'locked');
    await audio.start();
    n.fireDeviceChange();
    await flush();
    assert.equal(audio.getState().state, 'device_changed');
    assert.equal(audio.getState().deviceChangedAt, 77);
    assert.equal(ctx.suspends, 1);
    assert.equal(audio.running(), false);
    await audio.start();
    assert.equal(audio.getState().state, 'running');
  });

  test('report mode only notes a device change', async () => {
    const ctx = new FakeContext();
    const n = fakeNavigator();
    const audio = createAudioUnlock({ createContext: () => ctx, navigator: n.nav, tick: false, onDeviceChange: 'report', now: () => 9 });
    await audio.start();
    n.fireDeviceChange();
    assert.equal(audio.getState().state, 'running');
    assert.equal(audio.getState().deviceChangedAt, 9);
    assert.equal(ctx.suspends, 0);
  });

  test('a resume that fails, no Web Audio, and a refused wake lock each say so', async () => {
    const ctx = new FakeContext();
    ctx.failResume = new Error('NotAllowedError');
    const failing = createAudioUnlock({ createContext: () => ctx, navigator: fakeNavigator({ refuseWakeLock: true }).nav });
    assert.equal(await failing.start(), 'failed');
    await flush();
    assert.equal(failing.getState().errorText, 'NotAllowedError');
    assert.equal(failing.getState().wakeLock, 'refused');

    const none = createAudioUnlock({
      createContext: () => {
        throw new Error('This browser has no Web Audio.');
      },
      navigator: null,
    });
    assert.equal(await none.start(), 'unsupported');

    const noWake = createAudioUnlock({ createContext: () => new FakeContext(), navigator: fakeNavigator({ wakeLock: false }).nav, tick: false });
    await noWake.start();
    assert.equal(noWake.getState().wakeLock, 'unsupported');
  });

  test('the server render has no window: the helper waits for a tap and never throws', () => {
    const audio = createAudioUnlock({ navigator: null });
    assert.equal(audio.getState().state, 'locked');
    audio.close();
  });
});

describe('the chimes (Appendix A)', () => {
  test('each chime has the documented tones', () => {
    assert.deepEqual(CHIMES.yes, [{ hz: 1200, ms: 40 }]);
    assert.deepEqual(CHIMES.no, [{ hz: 500, ms: 40 }]);
    assert.deepEqual(
      CHIMES.confirm.map((t) => [t.hz, t.ms]),
      [
        [900, 40],
        [900, 40],
      ],
    );
    assert.equal(CHIMES.confirm[0]!.gapMs, 80);
    assert.deepEqual(CHIMES.stop, [{ hz: 300, ms: 250 }]);
    assert.deepEqual(CHIMES.counted, [{ hz: 1500, ms: 60 }]);
    assert.deepEqual(
      CHIMES.notCounted.map((t) => t.hz),
      [250, 250],
    );
    assert.deepEqual(
      CHIMES.on.map((t) => t.hz),
      [700, 1000],
    );
    assert.deepEqual(
      CHIMES.off.map((t) => t.hz),
      [1000, 600],
    );
    assert.deepEqual(CHIMES.windowOpen, [{ hz: 1100, ms: 80 }]);
  });

  test('playChime schedules each tone in order, at a low gain, straight into the destination', () => {
    const ctx = new FakeContext();
    const ms = playChime(ctx, 'confirm');
    assert.equal(ms, 160, '40 ms, an 80 ms gap, 40 ms');
    assert.equal(ctx.oscillators.length, 2);
    const [first, second] = ctx.oscillators;
    assert.ok(Math.abs(first!.start - 10.01) < 1e-9);
    assert.ok(Math.abs(first!.stop - 10.05) < 1e-9);
    assert.ok(Math.abs(second!.start - 10.13) < 1e-9);
    for (const gain of ctx.gains) {
      assert.equal(gain.connectedTo, ctx.destination);
      assert.ok(gain.events.some(([kind, value]) => kind === 'ramp' && value === CHIME_GAIN));
      assert.equal(gain.events[0]![1], 0, 'starts silent, so the beep does not click');
    }
  });

  test('latency is base plus output latency in ms, 0 when the browser does not say', () => {
    assert.equal(contextLatencyMs({ baseLatency: 0.005, outputLatency: 0.02 }), 25);
    assert.equal(contextLatencyMs({}), 0);
    assert.equal(contextLatencyMs(null), 0);
    assert.equal(contextLatencyMs({ baseLatency: Number.NaN, outputLatency: 0.01 }), 10);
  });
});
