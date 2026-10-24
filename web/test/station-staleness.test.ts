/**
 * Staleness (lib/station/staleness.ts, docs/station.md 2.15 and 7.3 A9): a Reading step with no newer update within
 * its length plus 1.5 s is stale; Preparing never is.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { staleAfterMs, StalenessWatch } from '../lib/station/staleness';
import { fakeTimers } from './role-fakes';

const S = 1_700_000_000_000_000n;

describe('staleness', () => {
  test('Reading, Window and Veto are timed by their planned length plus 1.5 s; the rest never', () => {
    assert.equal(staleAfterMs({ phase: 'reading', stepStartedAt: S, stepEndsAt: S + 2_400_000n }), 3_900);
    assert.equal(staleAfterMs({ phase: 'window', stepStartedAt: S, stepEndsAt: S + 3_500_000n }), 5_000);
    assert.equal(staleAfterMs({ phase: 'veto', stepStartedAt: S, stepEndsAt: S + 700_000n }), 2_200);
    assert.equal(staleAfterMs({ phase: 'preparing', stepStartedAt: S, stepEndsAt: S + 4_000_000n }), null);
    assert.equal(staleAfterMs({ phase: 'idle', stepStartedAt: S, stepEndsAt: S }), null);
    assert.equal(staleAfterMs({ phase: 'paused', stepStartedAt: S, stepEndsAt: S }), null);
  });

  test('a Reading step with no newer update in its length plus 1.5 s is stale, once', () => {
    const clock = fakeTimers(0);
    let fired = 0;
    const watch = new StalenessWatch({ onStale: () => fired++, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    watch.update({ phase: 'reading', stepStartedAt: S, stepEndsAt: S + 2_000_000n });
    clock.advance(3_499);
    assert.equal(fired, 0);
    clock.advance(1);
    assert.equal(fired, 1);
    assert.equal(watch.isStale(), true);
    clock.advance(10_000);
    assert.equal(fired, 1);
    assert.equal(watch.update({ phase: 'window', stepStartedAt: S, stepEndsAt: S + 3_500_000n }), true, 'a new update clears it');
    assert.equal(watch.isStale(), false);
  });

  test('a newer update in time re-arms the timer', () => {
    const clock = fakeTimers(0);
    let fired = 0;
    const watch = new StalenessWatch({ onStale: () => fired++, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    watch.update({ phase: 'reading', stepStartedAt: S, stepEndsAt: S + 2_000_000n });
    clock.advance(2_000);
    watch.update({ phase: 'window', stepStartedAt: S, stepEndsAt: S + 3_500_000n });
    clock.advance(4_999);
    assert.equal(fired, 0);
    clock.advance(1);
    assert.equal(fired, 1);
  });

  test('Preparing never goes stale, however long it waits', () => {
    const clock = fakeTimers(0);
    let fired = 0;
    const watch = new StalenessWatch({ onStale: () => fired++, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    watch.update({ phase: 'reading', stepStartedAt: S, stepEndsAt: S + 2_000_000n });
    watch.update({ phase: 'preparing', stepStartedAt: S, stepEndsAt: S + 4_000_000n });
    clock.advance(600_000);
    assert.equal(fired, 0);
  });
});
