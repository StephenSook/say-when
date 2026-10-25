/**
 * The judge try page (PLAN 5.11): the pure view model (lib/try/model.ts) over board rows, and the two station engine
 * additions it relies on: an on-screen button is relayed with source `button` (never as a headset signal), and a try
 * may start while another one is visible, keeping the new session as this page's own.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DataRows, PipelineEvent, Question } from '../lib/data/types';
import { EMPTY_ROWS } from '../lib/data/types';
import { StationEngine } from '../lib/station/engine';
import type { Ticker } from '../lib/station/heartbeat';
import { isRolePageRoute } from '../lib/routes';
import { limitSentence, TRY_DB_DEFAULT, TRY_WORDS, trySettings, tryView, type TryInput } from '../lib/try/model';
import { deviceStatusRow, FakeBuilder, FakeSubscription, FakeTable, flush, memoryStorage } from './role-fakes';

const SID = '9';

function q(patch: Partial<Question> = {}): Question {
  return { id: '21', sessionId: SID, number: 1, text: 'Where can we get dinner?', via: 'typed', origin: 'partner', askedAt: 1, replyText: null, spokenAt: null, ...patch };
}

function ev(stage: PipelineEvent['stage'], status: PipelineEvent['status'], detail: Record<string, unknown>, id = `${stage}-${status}`): PipelineEvent {
  return { id, sessionId: SID, questionId: '21', stage, status, detail, ms: status === 'started' ? null : 10, at: 1 } as PipelineEvent;
}

function rows(patch: Partial<DataRows> = {}): DataRows {
  return { ...EMPTY_ROWS, ...patch };
}

function input(patch: Partial<TryInput> = {}): TryInput {
  return {
    connected: true,
    paired: true,
    voice: 'ready',
    ownership: 'mine',
    mySessionId: SID,
    activeSessionId: SID,
    everStarted: true,
    sessionError: null,
    askError: null,
    agentOnline: true,
    questionsPerTry: 5,
    rows: rows(),
    ...patch,
  };
}

describe('the try view model', () => {
  test('phases: loading, ready, running, and ended once another try holds the database', () => {
    assert.equal(tryView(input({ connected: false })).phase, 'loading');
    assert.equal(tryView(input({ ownership: 'none', mySessionId: null, activeSessionId: null, everStarted: false })).phase, 'ready');
    assert.equal(tryView(input()).phase, 'running');
    assert.equal(tryView(input({ ownership: 'none', activeSessionId: '10' })).phase, 'ended');
    assert.equal(tryView(input({ ownership: 'starting' })).phase, 'starting');
  });

  test('a module refusal reads as its own sentence: busy, and each try limit', () => {
    assert.equal(limitSentence('busy: someone else is trying Eleven right now'), TRY_WORDS.busy);
    assert.equal(limitSentence('try limit: 5 questions per try. Start a new try.'), 'Try limit: 5 questions per try. Start a new try.');
    assert.equal(limitSentence('not allowed'), null);
    const ready = input({ ownership: 'none', everStarted: false, mySessionId: null, sessionError: 'Could not start the session: busy: someone else is trying Eleven right now' });
    assert.equal(tryView(ready).error, TRY_WORDS.busy);
    assert.equal(tryView(input({ askError: 'try limit: the questions for today are used up' })).error, 'Try limit: the questions for today are used up.');
  });

  test('the steps follow the board: heard, sample notes, the web rows, then the draft', () => {
    const v = tryView(
      input({
        rows: rows({
          questions: [q()],
          pipelineEvents: [
            ev('listen', 'ok', { words: 'Where can we get dinner?' }),
            ev('retrieve', 'ok', { hits: [{ id: 'm1', origin: 'memory', memoryType: 'pref', sharedText: 'Sample note: prefers tea to coffee.', score: 0.8 }, { id: 'm2', origin: 'memory', memoryType: 'reply', score: 0.6 }] }),
            ev('search', 'ok', { needsWeb: true, rowCount: 2, rows: [{ id: 'r1', source: 'web', title: 'Thai House', fetchedAt: 'x' }, { id: 'r2', source: 'web', title: 'Noodle Bar', fetchedAt: 'x' }] }),
            ev('plan', 'ok', { optionCount: 4 }),
          ],
        }),
      }),
    );
    assert.deepEqual(
      v.steps.map((s) => [s.key, s.status]),
      [
        ['heard', 'done'],
        ['notes', 'done'],
        ['web', 'done'],
        ['draft', 'done'],
      ],
    );
    assert.deepEqual(v.steps[1]!.items, ['Sample note: prefers tea to coffee.', 'Private memory']);
    assert.deepEqual(v.steps[2]!.items, ['Thai House', 'Noodle Bar']);
    assert.equal(v.steps[3]!.detail, '4 options.');
    assert.equal(v.questionsLeft, 4);
  });

  test('a skipped search, a draft refused by the try caps, and no questions left', () => {
    const v = tryView(
      input({
        questionsPerTry: 1,
        rows: rows({ questions: [q()], pipelineEvents: [ev('search', 'ok', { needsWeb: false }), ev('plan', 'error', { label: 'failed: try_limit' })] }),
      }),
    );
    assert.equal(v.steps[2]!.status, 'skipped');
    assert.equal(v.steps[3]!.status, 'failed');
    assert.match(v.steps[3]!.detail ?? '', /Try limit reached/);
    assert.equal(v.canAsk, false);
    assert.equal(v.questionsLeft, 0);
  });

  test('options, the one being read, the pick, and the reply said out loud', () => {
    const opts = [
      { id: 'o1', questionId: '21', version: 1, rank: 1, text: 'Thai House, two blocks away.', kind: 'reply' as const, tone: 'warm', sources: [] },
      { id: 'o2', questionId: '21', version: 1, rank: 2, text: 'Noodle Bar is open late.', kind: 'reply' as const, tone: 'calm', sources: [] },
    ];
    const scan = { questionId: '21', version: 1, mode: 'answer' as const, answerMode: 'pick' as const, phase: 'window' as const, cursor: 2, stepStartedAt: 0, stepEndsAt: 1, pass: 1, maxPasses: 2, outcome: null, pickedOptionId: null };
    // Direct select (D18): the Window after the list is the wait for any number; no single option is "now".
    const waiting = tryView(input({ rows: rows({ questions: [q()], options: opts, scan }) }));
    assert.deepEqual(waiting.options.map((o) => o.now), [false, false]);
    assert.equal(waiting.turn, 'Pick 1 to 2. Silence picks nothing.');
    const reading = tryView(input({ rows: rows({ questions: [q()], options: opts, scan: { ...scan, phase: 'reading' as const } }) }));
    assert.deepEqual(reading.options.map((o) => o.now), [false, true]);
    assert.equal(reading.turn, 'Reading option 2 of 2. Tap its number any time.');
    assert.equal(reading.reply, null);

    const picked = { ...scan, phase: 'idle' as const, cursor: null, outcome: 'picked' as const, pickedOptionId: 'o2' };
    const spoken = tryView(input({ rows: rows({ questions: [q({ replyText: 'Noodle Bar is open late.', spokenAt: 5 })], options: opts, scan: picked }) }));
    assert.deepEqual(spoken.options.map((o) => o.picked), [false, true]);
    assert.deepEqual(spoken.reply, { heading: 'Said out loud', text: 'Noodle Bar is open late.' });

    // Released but not spoken: with the voice off it says so and never claims it was said; with the voice on it waits
    // for the room voice's report.
    const released = rows({ questions: [q({ replyText: 'Noodle Bar is open late.' })], options: opts, scan: picked });
    const off = tryView(input({ voice: 'off', rows: released })).reply;
    assert.match(off?.heading ?? '', /Voice is off, so it was not said out loud/);
    assert.notEqual(off?.heading, 'Said out loud');
    assert.equal(tryView(input({ rows: released })).reply, null);
  });

  test('once the draft is done, a step that never ran reads as not used, never as waiting', () => {
    const v = tryView(input({ rows: rows({ questions: [q()], pipelineEvents: [ev('listen', 'ok', {}), ev('plan', 'ok', { optionCount: 4 })] }) }));
    assert.deepEqual(v.steps.map((s) => s.status), ['done', 'skipped', 'skipped', 'done']);
    const drafting = tryView(input({ rows: rows({ questions: [q()], pipelineEvents: [ev('plan', 'started', {})] }) }));
    assert.equal(drafting.steps[1]!.status, 'waiting');
  });

  test('questions from another session are never shown as this try', () => {
    const v = tryView(input({ rows: rows({ questions: [q({ sessionId: '3' })] }) }));
    assert.equal(v.question, null);
    assert.equal(v.questionsLeft, 5);
  });

  test('the notices say when the agent is offline and when voice is off, in plain words', () => {
    const v = tryView(input({ agentOnline: false, voice: 'off' }));
    assert.deepEqual(v.notices, [TRY_WORDS.agentOff, TRY_WORDS.voiceOff]);
    assert.match(TRY_WORDS.honesty, /On-screen buttons stand in for the headset's four picks \(1 to 4\) and STOP/);
  });

  test('settings default to the try database, never the demo, and /try is a role page with no demo board source', () => {
    assert.deepEqual(trySettings(undefined, undefined), { host: 'https://maincloud.spacetimedb.com', db: TRY_DB_DEFAULT });
    assert.equal(TRY_DB_DEFAULT, 'say-when-try');
    assert.equal(trySettings('https://maincloud.spacetimedb.com', 'say-when-try-dev').db, 'say-when-try-dev');
    assert.equal(isRolePageRoute('/try'), true);
  });
});

// ---------- The station engine additions ----------

const SETTINGS = { host: 'https://maincloud.spacetimedb.com', db: 'say-when-try-dev' };
const ME = 'c200bbbb11112222';

class StationConn {
  readonly db = {
    deviceStatus: new FakeTable<unknown>(),
    config: new FakeTable<unknown>(),
    scanState: new FakeTable<unknown>(),
    cueEvent: new FakeTable<unknown>(),
    mySession: new FakeTable<unknown>(),
    myOptions: new FakeTable<unknown>(),
    sandboxSettings: new FakeTable<unknown>(),
  };
  readonly calls: Array<{ name: string; args: any }> = [];
  answer: (name: string, args: unknown) => Promise<void> = async () => {};
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
  subscriptions: FakeSubscription[] = [];
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

const ticker: Ticker = { start() {}, stop() {} };

function session(id: bigint) {
  return { sessionId: id, role: 'station', questionId: 0n, questionText: '', origin: { tag: 'Partner' }, answerMode: { tag: 'Pick' }, errand: undefined, call: undefined, lastGestureId: '', lastGestureOutcome: '', reply: undefined };
}

async function pairedEngine() {
  const conn = new StationConn();
  conn.db.config.rows = [{ id: 0, activeSessionId: 0n, heartbeatMs: 500, confirmWindowMs: 8_000, quietHoldMs: 1_000, readbackDeadlineMs: 30_000, pairingTtlMs: 300_000 }];
  conn.db.deviceStatus.rows = [deviceStatusRow(ME, 'Station', 1n)];
  const builder = new FakeBuilder(() => conn as any);
  const engine = new StationEngine({ settings: SETTINGS, storage: memoryStorage(), builder: () => builder as any, mint: async () => ({ token: '', expiresAtMs: 0n, error: 'voice_key_missing' }), ticker });
  engine.start();
  builder.connect(ME, 'token-1');
  await flush();
  await flush();
  return { engine, conn };
}

describe('the station engine for the try page', () => {
  test('an on-screen button is relayed with source button in keyboard mode, and ignored in headset mode', async () => {
    const { engine, conn } = await pairedEngine();
    engine.chooseMode('headset');
    engine.press('PICK_1');
    assert.equal(conn.named('gesture').length, 0, 'headset mode takes no buttons');
    engine.chooseMode('keyboard');
    engine.setSilent(true);
    engine.startSession({ label: 'try' });
    assert.deepEqual(conn.named('startSession')[0]?.args, { label: 'try' });
    await flush();
    conn.db.mySession.set([session(9n)]);
    await flush();
    engine.press('PICK_3');
    const g = conn.named('gesture')[0]?.args;
    assert.ok(g, 'the button was relayed');
    assert.equal(g.command, 'PICK_3');
    assert.equal(g.source, 'button');
    assert.equal(g.confidence, 1);
    engine.stop();
  });

  test('a try may start while another session is visible, and the new session stays this page\'s own', async () => {
    const { engine, conn } = await pairedEngine();
    conn.db.mySession.set([session(4n)]);
    await flush();
    engine.chooseMode('keyboard');
    engine.setSilent(true);
    engine.startSession({ label: 'try' });
    assert.equal(conn.named('startSession').length, 0, 'without replaceActive nothing is sent while a session is visible');
    engine.startSession({ label: 'try', replaceActive: true });
    assert.equal(conn.named('startSession').length, 1, 'the module decides whether the old try gives way');
    await flush();
    conn.db.mySession.set([session(5n)]); // the module replaced session 4 with ours
    await flush();
    const s = engine.getState();
    assert.equal(s.session.id, 5n);
    assert.equal(s.session.ownership, 'mine', 'our own new session is not read as a replacement of ours');
    // A later replacement by someone else ends ours.
    conn.db.mySession.set([]);
    await flush();
    assert.equal(engine.getState().session.ownership, 'none');
    engine.stop();
  });
});
