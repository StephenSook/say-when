/**
 * The heard log (lib/station/heard.ts, docs/station.md 2.6 and 7.3 A2): the step and option sent with a command are
 * the ones the wearer was hearing at its onset, by when the audio played, with a 200 ms margin.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HEARD_MARGIN_MS, HeardLog, NOTHING_HEARD } from '../lib/station/heard';

const OPT1 = 101n;
const OPT2 = 102n;

/** Option 1 read at step 10 (window 11), option 2 read at step 12 (window 13). Audio starts 80 ms after each read arrives. */
function twoOptions(log: HeardLog) {
  log.add({ stepSeq: 10n, optionStartSeq: 10n, phase: 'reading', optionId: OPT1 }, 1_000);
  log.played(10n, 1_080);
  log.add({ stepSeq: 11n, optionStartSeq: 10n, phase: 'window', optionId: OPT1 }, 3_000);
  log.add({ stepSeq: 12n, optionStartSeq: 12n, phase: 'reading', optionId: OPT2 }, 6_000);
  log.played(12n, 6_080);
  log.add({ stepSeq: 13n, optionStartSeq: 12n, phase: 'window', optionId: OPT2 }, 8_000);
}

describe('the heard log', () => {
  test('an onset in option 1 window gives option 1 with the window step', () => {
    const log = new HeardLog();
    twoOptions(log);
    assert.deepEqual(log.lookup(4_000), { stepSeq: 11n, optionId: OPT1 });
  });

  test('an onset while option 1 is read gives option 1 once 200 ms of its audio have played', () => {
    const log = new HeardLog();
    twoOptions(log);
    assert.deepEqual(log.lookup(1_080 + HEARD_MARGIN_MS + 1), { stepSeq: 10n, optionId: OPT1 });
    assert.deepEqual(log.lookup(1_080 + 100), NOTHING_HEARD);
  });

  test('100 ms after option 2 audio starts is still option 1 (margin 200 ms)', () => {
    const log = new HeardLog();
    twoOptions(log);
    assert.deepEqual(log.lookup(6_080 + 100), { stepSeq: 11n, optionId: OPT1 });
  });

  test('300 ms after option 2 audio starts is option 2', () => {
    const log = new HeardLog();
    twoOptions(log);
    assert.deepEqual(log.lookup(6_080 + 300), { stepSeq: 12n, optionId: OPT2 });
  });

  test('the row arriving is not hearing it: before the clip plays, the earlier option is returned', () => {
    const log = new HeardLog();
    log.add({ stepSeq: 10n, optionStartSeq: 10n, phase: 'reading', optionId: OPT1 }, 1_000);
    log.played(10n, 1_050);
    log.add({ stepSeq: 11n, optionStartSeq: 10n, phase: 'window', optionId: OPT1 }, 3_000);
    log.add({ stepSeq: 12n, optionStartSeq: 12n, phase: 'reading', optionId: OPT2 }, 6_000);
    // Option 2 is slow to synthesize: nothing has played for it yet.
    assert.deepEqual(log.lookup(7_000), { stepSeq: 11n, optionId: OPT1 });
    log.played(12n, 7_500);
    assert.deepEqual(log.lookup(7_800), { stepSeq: 12n, optionId: OPT2 });
  });

  test('a clip that never played is skipped for good, and its window too', () => {
    const log = new HeardLog();
    log.add({ stepSeq: 10n, optionStartSeq: 10n, phase: 'reading', optionId: OPT1 }, 1_000);
    log.played(10n, 1_050);
    log.add({ stepSeq: 11n, optionStartSeq: 10n, phase: 'window', optionId: OPT1 }, 3_000);
    log.add({ stepSeq: 12n, optionStartSeq: 12n, phase: 'reading', optionId: OPT2 }, 6_000);
    log.add({ stepSeq: 13n, optionStartSeq: 12n, phase: 'window', optionId: OPT2 }, 8_000);
    // Option 2 never played; its window waits, then option 3 starts and option 2 is over.
    log.add({ stepSeq: 14n, optionStartSeq: 14n, phase: 'reading', optionId: 103n }, 10_000);
    assert.equal(log.played(12n, 10_100), false, 'a late clip for a read that is over is refused');
    assert.deepEqual(log.lookup(9_000), { stepSeq: 11n, optionId: OPT1 });
    const entries = log.list();
    assert.equal(entries.find((e) => e.stepSeq === 12n)?.unheard, true);
    assert.equal(entries.find((e) => e.stepSeq === 13n)?.unheard, true);
  });

  test('a clip played late inside its own window counts from its play start', () => {
    const log = new HeardLog();
    log.add({ stepSeq: 12n, optionStartSeq: 12n, phase: 'reading', optionId: OPT2 }, 6_000);
    log.add({ stepSeq: 13n, optionStartSeq: 12n, phase: 'window', optionId: OPT2 }, 8_000);
    assert.equal(log.played(12n, 8_500), true);
    assert.deepEqual(log.lookup(8_600), NOTHING_HEARD);
    assert.deepEqual(log.lookup(8_800), { stepSeq: 13n, optionId: OPT2 });
  });

  test('yes or no mode gives option 0 from the prompt play start', () => {
    const log = new HeardLog();
    log.add({ stepSeq: 20n, optionStartSeq: 20n, phase: 'reading', optionId: 0n }, 1_000);
    log.played(20n, 1_060);
    log.add({ stepSeq: 21n, optionStartSeq: 20n, phase: 'window', optionId: 0n }, 2_000);
    assert.deepEqual(log.lookup(1_500), { stepSeq: 20n, optionId: 0n });
    assert.deepEqual(log.lookup(2_500), { stepSeq: 21n, optionId: 0n });
  });

  test('nothing logged gives step 0 and option 0', () => {
    assert.deepEqual(new HeardLog().lookup(5_000), NOTHING_HEARD);
  });

  test('silent mode uses arrival times', () => {
    const log = new HeardLog({ silent: true });
    log.add({ stepSeq: 10n, optionStartSeq: 10n, phase: 'reading', optionId: OPT1 }, 1_000);
    log.add({ stepSeq: 11n, optionStartSeq: 10n, phase: 'window', optionId: OPT1 }, 3_000);
    assert.deepEqual(log.lookup(1_000), { stepSeq: 10n, optionId: OPT1 });
    assert.deepEqual(log.lookup(3_100), { stepSeq: 11n, optionId: OPT1 });
  });

  test('Preparing, Veto, Idle and Paused count from their arrival with option 0', () => {
    const log = new HeardLog();
    log.add({ stepSeq: 30n, optionStartSeq: 0n, phase: 'preparing', optionId: 5n }, 1_000);
    log.add({ stepSeq: 31n, optionStartSeq: 0n, phase: 'veto', optionId: 0n }, 2_000);
    assert.deepEqual(log.lookup(1_500), { stepSeq: 30n, optionId: 0n });
    assert.deepEqual(log.lookup(2_000), { stepSeq: 31n, optionId: 0n });
  });

  test('old or repeated steps are not logged again, and entries older than 60 s are dropped', () => {
    const log = new HeardLog();
    assert.equal(log.add({ stepSeq: 5n, optionStartSeq: 0n, phase: 'idle', optionId: 0n }, 1_000), true);
    assert.equal(log.add({ stepSeq: 5n, optionStartSeq: 0n, phase: 'idle', optionId: 0n }, 1_100), false);
    assert.equal(log.add({ stepSeq: 4n, optionStartSeq: 0n, phase: 'idle', optionId: 0n }, 1_200), false);
    log.add({ stepSeq: 6n, optionStartSeq: 0n, phase: 'paused', optionId: 0n }, 70_000);
    assert.deepEqual(
      log.list().map((e) => e.stepSeq),
      [6n],
    );
  });
});
