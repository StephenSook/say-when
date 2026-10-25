/**
 * Read-backs (lib/station/readback.ts, docs/station.md 2.11 and 7.3 A7): one per errand and digest, the mode's
 * confirm sentence on the end, stopped when the status leaves Previewed, reported only after playback ended on its
 * own, resent after a disconnect, the digest recorded at the end, the window chime `quiet_hold_ms` after the report
 * resolved, and a read-back too long for the time left never started.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DisconnectedError, SenderError } from 'spacetimedb';
import { readbackKey } from '../lib/station/commands';
import { Channel, type ClipLike } from '../lib/station/earpiece';
import { Readback, readbackCandidate, readbackSegments, windowLength, type WorkLite } from '../lib/station/readback';
import { fakeTimers, flush } from './role-fakes';

const DIGEST = '0123456789abcdef';

function errand(patch: Partial<WorkLite> = {}): WorkLite {
  return {
    kind: 'errand',
    id: 7n,
    status: 'Previewed',
    readBackText: 'Dinner request for two at six.',
    digest: DIGEST,
    confirmOpensAt: null,
    confirmClosesAt: null,
    reasonCode: '',
    reason: '',
    ...patch,
  };
}

function call(patch: Partial<WorkLite> = {}): WorkLite {
  return { ...errand(), kind: 'call', id: 9n, status: 'Prepared', digest: 'callscript', readBackText: 'Calling the caregiver.', ...patch };
}

class FakeOut {
  plays: string[] = [];
  stops = 0;
  private resolve: ((how: 'ended' | 'stopped') => void) | null = null;
  play(c: ClipLike & { name?: string }) {
    this.resolve?.('stopped');
    this.plays.push(c.name ?? 'clip');
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

function harness(options: { report?: (attempt: number) => Promise<void>; clipMs?: number; synthThrows?: boolean } = {}) {
  const clock = fakeTimers(100_000);
  const out = new FakeOut();
  const channel = new Channel<ClipLike & { name?: string }>(out);
  const texts: string[] = [];
  const cancels: string[] = [];
  const reports: Array<{ kind: string; id: bigint; digest: string }> = [];
  const chimes: string[] = [];
  let tooLong = 0;
  let interrupted = 0;
  let attempts = 0;
  const pending: Array<(clip: ClipLike & { name: string }) => void> = [];
  const rb = new Readback<ClipLike & { name?: string }>({
    now: clock.now,
    synth: (text) => {
      texts.push(text);
      if (options.synthThrows) throw new Error('The voice is not ready.');
      const done = new Promise<ClipLike & { name: string }>((resolve, reject) => {
        pending.push(resolve);
        cancels.push('');
        void reject;
      });
      return {
        done,
        cancel: () => cancels.push(text),
      };
    },
    channel,
    report: (args) => {
      attempts++;
      reports.push(args);
      return options.report ? options.report(attempts) : Promise.resolve();
    },
    waitForLive: async () => true,
    chime: (name) => chimes.push(name),
    timing: () => ({ readbackDeadlineMs: 30_000, quietHoldMs: 1_000, confirmWindowMs: 8_000 }),
    sayTooLong: () => tooLong++,
    sayInterrupted: () => interrupted++,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    sleep: async () => {},
  });
  const synthesized = async (durationMs = options.clipMs ?? 4_000) => {
    pending.shift()!({ name: 'read-back', durationMs, totalMs: 300, words: [] });
    await flush();
  };
  return { rb, clock, out, texts, cancels: () => cancels.filter((c) => c !== ''), reports, chimes, synthesized, tooLong: () => tooLong, interrupted: () => interrupted };
}

describe('read-back helpers', () => {
  test('the errand comes before the call; the errand needs a 16-hex digest and text', () => {
    assert.equal(readbackCandidate(errand(), call())?.kind, 'errand');
    assert.equal(readbackCandidate(errand({ status: 'AwaitingConfirm' }), call())?.kind, 'call');
    assert.equal(readbackCandidate(errand({ digest: 'short' }), null), null);
    assert.equal(readbackCandidate(errand({ readBackText: '  ' }), null), null);
    assert.equal(readbackCandidate(null, call({ status: 'Dialing' })), null);
  });

  test('an errand or call read-back ends with the jaw clench confirm (D29); a search read-back is read as is (D18)', () => {
    for (const mode of ['keyboard', 'headset', 'switch'] as const) {
      assert.deepEqual(readbackSegments('Text.', mode), ['Text.', 'Clench your jaw to send it.']);
      assert.deepEqual(readbackSegments('Text.', mode, 'call'), ['Text.', 'Clench your jaw to send it.']);
    }
    // The D28 check-in call's read-back (cartesia/src/call.ts) gets the same ending.
    assert.deepEqual(readbackSegments('Call Leon to check in for you.', 'headset', 'call'), ['Call Leon to check in for you.', 'Clench your jaw to send it.']);
    const search = 'Search the web for ideas? Clench your jaw to search.';
    assert.deepEqual(readbackSegments(search, 'headset', 'search'), [search]);
  });

  test('a web search waits for its read-back after the errand and the call', () => {
    const search: WorkLite = { ...call(), kind: 'search', id: 4n, status: 'Prepared', digest: 'a1b2c3d4e5f60718', readBackText: 'Search the web for ideas? Clench your jaw to search.' };
    assert.equal(readbackCandidate(null, null, search)?.kind, 'search');
    assert.equal(readbackCandidate(errand(), null, search)?.kind, 'errand');
    assert.equal(readbackCandidate(null, null, { ...search, digest: 'not hex' }), null);
    assert.equal(readbackCandidate(null, null, { ...search, status: 'AwaitingConfirm' }), null);
  });

  test('the window length comes from the row, else the config', () => {
    assert.equal(windowLength({ confirmOpensAt: 1_000_000n, confirmClosesAt: 9_000_000n }, 5_000), 8_000);
    assert.equal(windowLength({ confirmOpensAt: null, confirmClosesAt: null }, 5_000), 5_000);
  });
});

describe('the read-back', () => {
  test('plays once per errand and digest, records the digest at the end, then reports', async () => {
    const h = harness();
    h.rb.update(errand(), null, 100_000);
    h.rb.update(errand(), null, 100_100);
    assert.equal(h.texts.length, 1, 'one read-back per errand');
    await h.synthesized();
    assert.deepEqual(h.out.plays, ['read-back']);
    assert.equal(h.rb.played.get(readbackKey('errand', 7n)), undefined, 'no digest before the end');
    assert.equal(h.reports.length, 0, 'no report before the end');
    h.out.end();
    await flush();
    assert.equal(h.rb.played.get(readbackKey('errand', 7n)), DIGEST);
    assert.deepEqual(h.reports, [{ kind: 'errand', id: 7n, digest: DIGEST }]);
    h.rb.update(errand(), null, 106_000);
    assert.equal(h.texts.length, 1, 'never read back again once finished');
  });

  test('stops at once and reports nothing when the errand leaves Previewed', async () => {
    const h = harness();
    h.rb.update(errand(), null, 100_000);
    await h.synthesized();
    h.rb.update(errand({ status: 'Stopped', reasonCode: 'no' }), null, 101_000);
    assert.equal(h.out.stops, 1);
    await flush();
    assert.equal(h.reports.length, 0);
    assert.equal(h.rb.played.size, 0, 'a cut-off read-back records no digest');
  });

  test('a pause stops the synthesis or the playback', async () => {
    const h = harness();
    h.rb.update(errand(), null, 100_000);
    h.rb.stop();
    assert.deepEqual(h.cancels(), ['Dinner request for two at six.']);
    assert.equal(h.rb.getState().phase, 'idle');
  });

  test('a new digest for the same errand starts a new read-back and drops the old digest', async () => {
    const h = harness();
    h.rb.update(errand(), null, 100_000);
    await h.synthesized();
    h.out.end();
    await flush();
    h.rb.update(errand({ status: 'AwaitingConfirm' }), null, 105_000);
    h.rb.update(errand({ digest: 'fedcba9876543210', readBackText: 'New text.' }), null, 106_000);
    assert.equal(h.texts.length, 2);
    assert.equal(h.rb.played.get(readbackKey('errand', 7n)), undefined);
  });

  test('the window chime comes quiet_hold_ms after the report resolved, never before', async () => {
    let release: () => void = () => {};
    const h = harness({ report: () => new Promise<void>((resolve) => (release = resolve)) });
    h.rb.update(errand(), null, 100_000);
    await h.synthesized();
    h.out.end();
    await flush();
    h.clock.advance(2_000);
    assert.deepEqual(h.chimes, [], 'nothing while the report is on its way');
    release();
    await flush();
    h.clock.advance(999);
    assert.deepEqual(h.chimes, []);
    h.clock.advance(1);
    assert.deepEqual(h.chimes, ['windowOpen']);
    assert.equal(h.rb.getState().phase, 'window');
    assert.equal(h.rb.getState().windowMs, 8_000);
  });

  test('an early CONFIRM that moves confirm_opens_at restarts the chime from that update', async () => {
    const h = harness();
    h.rb.update(errand(), null, 100_000);
    await h.synthesized();
    h.out.end();
    await flush();
    h.rb.update(errand({ status: 'AwaitingConfirm', confirmOpensAt: 101_000_000n, confirmClosesAt: 109_000_000n }), null, h.clock.now());
    h.clock.advance(1_000);
    assert.deepEqual(h.chimes, ['windowOpen']);
    h.rb.update(errand({ status: 'AwaitingConfirm', confirmOpensAt: 102_500_000n, confirmClosesAt: 110_500_000n }), null, h.clock.now());
    assert.equal(h.rb.getState().phase, 'hold');
    h.clock.advance(1_000);
    assert.deepEqual(h.chimes, ['windowOpen', 'windowOpen']);
  });

  test('the report is resent after a disconnect', async () => {
    const h = harness({ report: (attempt) => (attempt === 1 ? Promise.reject(new DisconnectedError()) : Promise.resolve()) });
    h.rb.update(errand(), null, 100_000);
    await h.synthesized();
    h.out.end();
    await flush();
    await flush();
    assert.equal(h.reports.length, 2);
    assert.equal(h.rb.getState().phase, 'hold');
  });

  test('a late report says the read-back took too long', async () => {
    const h = harness({ report: () => Promise.reject(new SenderError('read-back deadline passed')) });
    h.rb.update(errand(), null, 100_000);
    await h.synthesized();
    h.out.end();
    await flush();
    assert.equal(h.rb.getState().phase, 'late');
    assert.equal(h.rb.getState().message, 'The read-back took too long.');
  });

  test('a read-back longer than the time left is not started', async () => {
    const h = harness({ clipMs: 25_000 });
    h.rb.update(errand(), null, 100_000);
    h.clock.advance(10_000);
    await h.synthesized();
    assert.deepEqual(h.out.plays, []);
    assert.equal(h.tooLong(), 1);
    assert.equal(h.rb.getState().phase, 'too_long');
  });

  test('a read-back that could not be voiced stays on screen while its errand waits, then clears once it moved on', async () => {
    // L1 live run, Oct 24: with no voice the station said "Could not voice the read-back" for the rest of the
    // session, hiding the scan's own status, after the module had already stopped the errand.
    const h = harness({ synthThrows: true });
    h.rb.update(errand(), null, 100_000);
    assert.equal(h.rb.getState().phase, 'failed');
    h.rb.update(errand(), null, 101_000);
    assert.equal(h.rb.getState().phase, 'failed', 'still shown while the errand waits for its read-back');
    assert.equal(h.texts.length, 1, 'not tried again');
    h.rb.update(errand({ status: 'Stopped', reasonCode: 'readback_not_finished' }), null, 130_000);
    assert.equal(h.rb.getState().phase, 'idle');
    assert.equal(h.rb.getState().message, null);
    assert.equal(h.rb.getState().id, null);
    h.rb.update(null, null, 140_000);
    assert.equal(h.rb.getState().phase, 'idle');
  });

  test('a too long or late read-back clears once its errand left Previewed', async () => {
    const long = harness({ clipMs: 25_000 });
    long.rb.update(errand(), null, 100_000);
    long.clock.advance(10_000);
    await long.synthesized();
    assert.equal(long.rb.getState().phase, 'too_long');
    long.rb.update(errand({ status: 'Stopped', reasonCode: 'readback_not_finished' }), null, 130_000);
    assert.equal(long.rb.getState().phase, 'idle');

    const late = harness({ report: () => Promise.reject(new SenderError('read-back deadline passed')) });
    late.rb.update(errand(), null, 100_000);
    await late.synthesized();
    late.out.end();
    await flush();
    assert.equal(late.rb.getState().phase, 'late');
    late.rb.update(null, null, 131_000);
    assert.equal(late.rb.getState().phase, 'idle');
  });

  test('after a failed read-back, the next errand is read back as usual', async () => {
    const h = harness({ synthThrows: true });
    h.rb.update(errand(), null, 100_000);
    assert.equal(h.rb.getState().phase, 'failed');
    h.rb.update(errand({ id: 8n }), null, 101_000);
    assert.equal(h.texts.length, 2, 'the new errand is tried');
  });

  test('a call is read back when no errand waits; an interrupted errand is said once', async () => {
    const h = harness();
    h.rb.update(errand({ status: 'Stopped', reasonCode: 'interrupted' }), call(), 100_000);
    h.rb.update(errand({ status: 'Stopped', reasonCode: 'interrupted' }), call(), 100_100);
    assert.deepEqual(h.texts, ['Calling the caregiver.']);
    assert.equal(h.interrupted(), 1);
  });
});
