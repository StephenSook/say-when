/**
 * The station engine end to end against a fake SpacetimeDB connection (lib/station/engine.ts): the silent keyboard
 * test runs with no Cartesia key (docs/station.md 2.9 "Silent test mode", live run L1), the session label says
 * `keyboard-test`, the first heartbeat follows `start_session`, a key press is relayed with the heard step and option
 * and `source` `key`, its outcome comes back from `my_session`, a session owned by another station is reported, and
 * the switch key is learned and its press pattern relayed with `source` `switch`.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SenderError } from 'spacetimedb';
import { StationEngine } from '../lib/station/engine';
import type { Ticker } from '../lib/station/heartbeat';
import { bigStatus, inputBanner, startBlocker } from '../lib/station/model';
import { deviceStatusRow, FakeBuilder, FakeSubscription, FakeTable, flush, memoryStorage } from './role-fakes';

const SETTINGS = { host: 'https://maincloud.spacetimedb.com', db: 'say-when-dev' };
const ME = 'c200aaaa11112222';
const T0 = 1_700_000_000_000_000n;

class StationConn {
  readonly db = {
    deviceStatus: new FakeTable<unknown>(),
    config: new FakeTable<unknown>(),
    scanState: new FakeTable<unknown>(),
    cueEvent: new FakeTable<unknown>(),
    mySession: new FakeTable<unknown>(),
    myOptions: new FakeTable<unknown>(),
  };
  readonly calls: Array<{ name: string; args: any }> = [];
  answer: (name: string, args: unknown) => Promise<void> = async () => {};
  subscriptions: FakeSubscription[] = [];
  readonly reducers: Record<string, (args: unknown) => Promise<void>> = new Proxy(
    {},
    {
      get: (_target, name) => (args: unknown) => {
        this.calls.push({ name: String(name), args });
        return this.answer(String(name), args);
      },
    },
  );
  readonly procedures = { mintVoiceToken: async () => ({ token: '', expiresAtMs: 0n, error: 'voice_key_missing' }) };
  subscriptionBuilder() {
    const sub = new FakeSubscription();
    this.subscriptions.push(sub);
    return sub;
  }
  disconnect() {}
  named(name: string) {
    return this.calls.filter((c) => c.name === name);
  }
}

class ManualTicker implements Ticker {
  on: (() => void) | null = null;
  start(_ms: number, onTick: () => void) {
    this.on = onTick;
  }
  stop() {
    this.on = null;
  }
}

function configRow() {
  return {
    id: 0,
    activeSessionId: 0n,
    shareTextOnBoard: false,
    menuEnabled: true,
    heartbeatMs: 500,
    idlePauseMs: 120_000,
    yesNoCueMs: 900,
    replyVetoMs: 700,
    quietHoldMs: 1_000,
    confirmWindowMs: 8_000,
    readbackDeadlineMs: 30_000,
    pairingTtlMs: 300_000,
  };
}

function sessionRow(patch: Record<string, unknown> = {}) {
  return {
    sessionId: 5n,
    role: 'station',
    questionId: 7n,
    questionText: 'Smoke test: which drink?',
    origin: { tag: 'Partner' },
    answerMode: { tag: 'Pick' },
    errand: undefined,
    call: undefined,
    lastGestureId: '',
    lastGestureOutcome: '',
    reply: undefined,
    ...patch,
  };
}

function option(optionId: bigint, rank: number, text: string) {
  return { optionId, questionId: 7n, version: 1, rank, kind: { tag: 'Reply' }, menuItem: { tag: 'None' }, text, tone: 'warm', laugh: false, clipMs: undefined, current: true };
}

function scanRow(patch: Record<string, unknown> = {}) {
  return {
    sessionId: 5n,
    questionId: 7n,
    version: 1,
    mode: { tag: 'Answer' },
    answerMode: { tag: 'Pick' },
    phase: { tag: 'Reading' },
    cursor: 1,
    optionCount: 2,
    pass: 1,
    maxPasses: 2,
    stepSeq: 10n,
    stepStartedAt: { microsSinceUnixEpoch: T0 },
    stepEndsAt: { microsSinceUnixEpoch: T0 + 4_000_000n },
    optionStartSeq: 10n,
    optionStartedAt: { microsSinceUnixEpoch: T0 },
    prevCursor: 0,
    prevOptionStartSeq: 0n,
    outcome: undefined,
    pickedRank: undefined,
    pickedOptionId: undefined,
    pauseReason: undefined,
    pausedAt: undefined,
    resumeCursor: 0,
    updatedAt: { microsSinceUnixEpoch: T0 },
    ...patch,
  };
}

function key(k: string, code: string, timeStamp = performance.now()) {
  return { key: k, code, repeat: false, metaKey: false, ctrlKey: false, altKey: false, timeStamp, target: null, preventDefault() {}, stopPropagation() {} };
}

async function pairedEngine() {
  const conn = new StationConn();
  conn.db.config.rows = [configRow()];
  conn.db.deviceStatus.rows = [deviceStatusRow(ME, 'Station', 1n)];
  const builder = new FakeBuilder(() => conn as any);
  const ticker = new ManualTicker();
  const engine = new StationEngine({
    settings: SETTINGS,
    storage: memoryStorage(),
    builder: () => builder as any,
    mint: async () => ({ token: '', expiresAtMs: 0n, error: 'voice_key_missing' }),
    ticker,
  });
  engine.start();
  builder.connect(ME, 'token-1');
  await flush();
  await flush();
  return { engine, conn, ticker, internals: engine as any };
}

describe('the station engine', () => {
  test('a silent keyboard test runs with no Cartesia key: start, beat, relay a key, read the outcome, end', async () => {
    const { engine, conn, ticker, internals } = await pairedEngine();
    assert.equal(engine.getState().pairing.phase, 'paired', 'paired although the voice key is missing');
    assert.equal(engine.getState().voice.status, 'problem');

    engine.chooseMode('keyboard');
    engine.setSilent(true);
    let s = engine.getState();
    assert.equal(s.setup.silent, true);
    assert.equal(startBlocker(s), null, 'nothing blocks a silent keyboard test');
    assert.match(inputBanner(s) ?? '', /key presses, not headset signals/);
    assert.match(inputBanner(s) ?? '', /Silent test: options are not voiced/);

    engine.startSession();
    assert.deepEqual(conn.named('startSession')[0]?.args, { label: 'keyboard-test' });
    await flush();
    assert.equal(engine.getState().session.ownership, 'mine');
    assert.equal(conn.named('heartbeat').length, 1, 'the first beat right after start_session');
    assert.equal(conn.named('heartbeat')[0]?.args.decoderHealthy, true, 'keyboard mode: the page is visible');
    ticker.on?.();
    assert.equal(conn.named('heartbeat').length, 2);
    assert.ok(conn.named('heartbeat')[1]!.args.beatSeq > conn.named('heartbeat')[0]!.args.beatSeq);

    conn.db.mySession.set([sessionRow()]);
    conn.db.myOptions.set([option(11n, 1, 'Tea'), option(12n, 2, 'Coffee')]);
    conn.db.scanState.set([scanRow()]);
    await flush();
    s = engine.getState();
    assert.equal(s.session.id, 5n);
    assert.equal(s.scan?.phase, 'reading');
    assert.equal(bigStatus(s, Date.now()).title, 'Reading option 1 of 2');
    assert.equal(conn.named('reportClipReady').length, 0, 'nothing is synthesized or reported in the silent test');

    internals.onKeyDown(key('y', 'KeyY'));
    const gesture = conn.named('gesture')[0]?.args;
    assert.ok(gesture, 'the key was relayed');
    assert.equal(gesture.command, 'YES');
    assert.equal(gesture.source, 'key');
    assert.equal(gesture.heardStepSeq, 10n);
    assert.equal(gesture.heardOptionId, 11n);
    assert.equal(gesture.heardDigest, '');
    assert.equal(gesture.confidence, 1);

    conn.db.mySession.set([sessionRow({ lastGestureId: gesture.gestureId, lastGestureOutcome: 'accepted:pick' })]);
    await flush();
    await flush();
    const entry = engine.getState().commands[0]!;
    assert.equal(entry.status, 'accepted');
    assert.equal(entry.words, 'Picked option 1');

    internals.onKeyDown(key('x', 'KeyX'));
    assert.equal(conn.named('gesture').length, 1, 'other keys do nothing');

    let prevented = false;
    internals.onKeyDown({ ...key('1', 'Digit1'), preventDefault: () => (prevented = true) });
    assert.equal(prevented, true, 'the dashboard screen keys cannot navigate away while a session runs');

    engine.endSession();
    assert.equal(conn.named('endSession').length, 1);
    await flush();
    assert.equal(engine.getState().session.ownership, 'none');
    ticker.on?.();
    assert.equal(conn.named('heartbeat').length, 2, 'no beats after the session ended');
    engine.stop();
  });

  test('keys do nothing before a session, and are refused in headset mode with a notice', async () => {
    const { engine, conn, internals } = await pairedEngine();
    engine.chooseMode('keyboard');
    internals.onKeyDown(key('y', 'KeyY'));
    assert.equal(conn.named('gesture').length, 0);
    engine.chooseMode('headset');
    assert.equal(engine.getState().setup.silent, false, 'silent is keyboard only');
    engine.stop();
  });

  test('Continue on a session owned by another station says so and stops beating', async () => {
    const { engine, conn, ticker } = await pairedEngine();
    engine.chooseMode('keyboard');
    engine.setSilent(true);
    conn.db.mySession.set([sessionRow()]);
    await flush();
    assert.equal(engine.getState().session.id, 5n);
    assert.equal(engine.getState().session.ownership, 'none');
    conn.answer = async (name) => {
      if (name === 'heartbeat') throw new SenderError('not the session station');
    };
    engine.continueSession();
    await flush();
    await flush();
    const s = engine.getState();
    assert.equal(s.session.ownership, 'other');
    assert.equal(bigStatus(s, Date.now()).title, 'This session belongs to another station.');
    assert.equal(ticker.on, null, 'the tick stopped');
    engine.stop();
  });

  /** A silent keyboard session 5 that this station started and runs. */
  async function runningSession() {
    const paired = await pairedEngine();
    paired.engine.chooseMode('keyboard');
    paired.engine.setSilent(true);
    paired.engine.startSession();
    await flush();
    paired.conn.db.mySession.set([sessionRow()]);
    await flush();
    assert.equal(paired.engine.getState().session.id, 5n);
    assert.equal(paired.engine.getState().session.ownership, 'mine');
    return paired;
  }

  test('a failed End session stops showing once the owner has ended that session (live run, Oct 24)', async () => {
    const { engine, conn } = await runningSession();
    conn.answer = async (name) => {
      if (name === 'endSession') throw new Error('connection lost');
    };
    engine.endSession();
    await flush();
    await flush();
    assert.match(engine.getState().session.error ?? '', /^Could not end the session/, 'shown while its session is still active');

    // The owner ends it from the CLI: my_session empties.
    conn.db.mySession.set([]);
    await flush();
    const s = engine.getState();
    assert.equal(s.session.id, null);
    assert.equal(s.session.error, null, 'the error belonged to a session that is no longer active');
    const big = bigStatus(s, Date.now());
    assert.equal(big.title, 'No session running');
    assert.doesNotMatch(big.sentence ?? '', /Could not end/);
    assert.equal(big.alert, false);
    engine.stop();
  });

  test('an End session that fails after the owner already ended the session leaves no error and no ownership', async () => {
    const { engine, conn } = await runningSession();
    let fail: (error: unknown) => void = () => {};
    conn.answer = (name) => (name === 'endSession' ? new Promise<void>((_resolve, reject) => (fail = reject)) : Promise.resolve());
    engine.endSession();
    // The owner's end_session lands first; the station's own call then comes back refused.
    conn.db.mySession.set([]);
    await flush();
    fail(new SenderError('no active session'));
    await flush();
    await flush();
    const s = engine.getState();
    assert.equal(s.session.id, null);
    assert.equal(s.session.error, null);
    assert.equal(s.session.ownership, 'none');
    assert.equal(bigStatus(s, Date.now()).title, 'No session running');
    engine.stop();
  });

  test('a failed End session still shows while its session is the active one', async () => {
    const { engine, conn } = await runningSession();
    conn.answer = async (name) => {
      if (name === 'endSession') throw new Error('connection lost');
    };
    engine.endSession();
    await flush();
    await flush();
    // Another update of the same session row does not clear it.
    conn.db.mySession.set([sessionRow({ lastGestureId: 'g1', lastGestureOutcome: 'ignored:idle' })]);
    await flush();
    const s = engine.getState();
    assert.equal(s.session.id, 5n);
    assert.equal(s.session.ownership, 'mine');
    assert.match(s.session.error ?? '', /^Could not end the session: connection lost/);
    engine.stop();
  });

  test('the switch key is learned, and its presses are relayed as switch input', async () => {
    const { engine, conn, internals } = await pairedEngine();
    engine.chooseMode('switch');
    engine.learnSwitch(true);
    internals.onKeyDown(key(' ', 'Space'));
    assert.equal(engine.getState().setup.switchKey, 'Space');
    assert.equal(engine.getState().setup.learningSwitch, false);
    assert.match(inputBanner(engine.getState()) ?? '', /switch presses, not headset signals/);

    // A switch session without voice is not allowed; take the session as if audio ran, to check the relay itself.
    internals.ownership = 'mine';
    conn.db.mySession.set([sessionRow()]);
    await flush();
    const t = performance.now();
    internals.onKeyDown(key(' ', 'Space', t));
    internals.onKeyUp(key(' ', 'Space', t + 120));
    await new Promise((resolve) => setTimeout(resolve, 450));
    const gesture = conn.named('gesture')[0]?.args;
    assert.ok(gesture, 'the short press became YES');
    assert.equal(gesture.command, 'YES');
    assert.equal(gesture.source, 'switch');
    engine.stop();
  });
});
