// The judge try sandbox (sandbox.ts, docs/spacetime.md 15): off by default and then nothing changes; on, only a
// station pairs without the owner, a try is its own station's alone (it asks and says the reply itself, and no other
// device reads or acts on it), one try runs at a time and gives way when it goes quiet or runs too long, nothing a
// judge says is saved to memory, and every cap refuses with a "try limit:" sentence.
import { expect, test } from 'vitest';
import * as m from '../index';
import { SANDBOX_DEFAULTS } from '../sandbox';
import {
  advance,
  AGENT,
  as,
  auth,
  beat,
  clips,
  emptyDb,
  failure,
  gesture,
  grantConsent,
  idOf,
  newDb,
  OWNER,
  pair,
  PARTNER,
  publish,
  question,
  reply,
  SPEAKER,
  STATION,
  tick,
  type Test,
} from './harness';

const STATION_B = 'station-b';
let nextCode = 300000;
let nextRequest = 1;

function sandbox(test: Test, json: object = { on: true }): void {
  as(test, OWNER, (ctx) => m.setSandbox(ctx, { json: JSON.stringify(json) }));
}

function requestPairing(test: Test, subject: string, role: 'station' | 'partner' | 'speaker' | 'agent'): void {
  const code = nextCode++;
  as(test, subject, (ctx) => m.requestPairing(ctx, { code, role, label: `${role} 1` }));
}

function deviceOf(test: Test, subject: string) {
  return test.db.device.identity.find(idOf(test, subject));
}

function activeId(test: Test): bigint {
  return test.db.config.id.find(0)!.activeSessionId;
}

function sessionRow(test: Test, id: bigint) {
  return test.db.session.id.find(id)!;
}

function beatAs(test: Test, subject: string, seq: bigint): void {
  as(test, subject, (ctx) => m.heartbeat(ctx, { beatSeq: seq, decoderHealthy: true }));
}

function sessionEndReason(test: Test, id: bigint): string | undefined {
  return [...test.db.ledger.ledgerBySession.filter(id)].find((l) => l.kind === 'session_end')?.reason;
}

function askAs(test: Test, subject: string, text = 'What should we eat?'): bigint | undefined {
  const requestId = `t-${nextRequest++}`;
  as(test, subject, (ctx) => m.askQuestion(ctx, { requestId, text, via: 'typed', listenMs: 0 }));
  return test.db.question.requestId.find(requestId)?.id;
}

/** A sandbox database with two stations paired by the sandbox, and no session yet. */
function tryDb(json: object = { on: true }): Test {
  const test = emptyDb();
  sandbox(test, json);
  requestPairing(test, STATION, 'station');
  requestPairing(test, STATION_B, 'station');
  return test;
}

function mint(test: Test, subject: string, purpose: 'tts' | 'stt'): string {
  const ctx = test.procedureContextBuilder(auth(subject)).http(() => {
    throw new Error('the procedure must not call out');
  }).build();
  return m.mintVoiceToken(ctx, { purpose }).error;
}

test('off by default: pairing waits for the owner and a second session is refused, exactly as before', () => {
  const test = emptyDb();
  requestPairing(test, STATION, 'station');
  expect(deviceOf(test, STATION)).toBeFalsy();
  expect(test.db.sandboxSettings.id.find(0)).toBeFalsy();

  const live = newDb();
  requestPairing(live, STATION_B, 'station');
  expect(deviceOf(live, STATION_B)).toBeFalsy();
  // Off, a station cannot ask or say a reply: those stay the partner's and the speaker's.
  expect(failure(() => askAs(live, STATION))).toBe('not allowed');
  // Turned off again, the rules are the old ones too.
  sandbox(live, { on: false });
  requestPairing(live, 'station-c', 'station');
  expect(deviceOf(live, 'station-c')).toBeFalsy();
});

test('set_sandbox: owner only; defaults first; a key left out keeps its value; bad keys and values change nothing', () => {
  const test = emptyDb();
  expect(failure(() => as(test, STATION, (ctx) => m.setSandbox(ctx, { json: '{"on":true}' })))).toBe('owner only');
  sandbox(test);
  const row = test.db.sandboxSettings.id.find(0)!;
  expect(row.on).toBe(true);
  expect(row.questionsPerTry).toBe(SANDBOX_DEFAULTS.questionsPerTry);
  expect(row.maxTryMs).toBe(SANDBOX_DEFAULTS.maxTryMs);
  sandbox(test, { questions_per_try: 3 });
  expect(test.db.sandboxSettings.id.find(0)!.questionsPerTry).toBe(3);
  expect(test.db.sandboxSettings.id.find(0)!.on).toBe(true);
  expect(failure(() => sandbox(test, { questions_per_tryy: 3 }))).toBe('unknown sandbox setting: questions_per_tryy');
  expect(failure(() => sandbox(test, { questions_per_try: 0 }))).toBe('questions_per_try must be a whole number from 1 to 20');
  expect(failure(() => sandbox(test, { on: 'yes' }))).toBe('on must be true or false');
  expect(failure(() => as(test, OWNER, (ctx) => m.setSandbox(ctx, { json: '[1]' })))).toBe('set_sandbox takes a JSON object');
  expect(test.db.sandboxSettings.id.find(0)!.questionsPerTry).toBe(3);
});

test('on: only a station pairs at once, never as a caregiver; a partner, speaker or agent waits for the owner', () => {
  const test = emptyDb();
  sandbox(test);
  requestPairing(test, STATION, 'station');
  requestPairing(test, PARTNER, 'partner');
  requestPairing(test, SPEAKER, 'speaker');
  requestPairing(test, 'agent-x', 'agent');
  const station = deviceOf(test, STATION)!;
  expect(station.role.tag).toBe('Station');
  expect(station.caregiver).toBe(false);
  expect(test.db.deviceStatus.identity.find(idOf(test, STATION))).toBeTruthy();
  for (const subject of [PARTNER, SPEAKER, 'agent-x']) {
    expect(deviceOf(test, subject)).toBeFalsy();
    expect(test.db.pairingRequest.requester.find(idOf(test, subject))).toBeTruthy();
  }
});

test('pairings per hour: the cap refuses, and the window opens again after an hour', () => {
  const test = emptyDb();
  sandbox(test, { on: true, pairings_per_hour: 3 });
  requestPairing(test, 'a', 'station');
  requestPairing(test, 'b', 'station');
  requestPairing(test, 'c', 'station');
  expect(failure(() => requestPairing(test, 'd', 'station'))).toBe('try limit: too many new devices this hour');
  expect(deviceOf(test, 'd')).toBeFalsy();
  advance(test, 60 * 60 * 1000);
  requestPairing(test, 'd', 'station');
  expect(deviceOf(test, 'd')).toBeTruthy();
});

test('a try is its own station\'s: it asks and says the reply; another station cannot ask, say it or read it', () => {
  const test = tryDb();
  pair(test, AGENT, 'agent'); // the owner approves the agent, as always
  grantConsent(test, 'memory');
  as(test, STATION, (ctx) => m.startSession(ctx, { label: 'try' }));
  beat(test);
  // Before any question, the other station already reads nothing of this try.
  expect(m.mySession(test.viewContext(auth(STATION_B)))).toBeUndefined();
  expect(failure(() => askAs(test, STATION_B))).toBe('not allowed');

  const qid = askAs(test, STATION)!;
  expect(question(test, qid).askedBy.isEqual(idOf(test, STATION))).toBe(true);
  const v = publish(test, qid, [reply('Thai noodles'), reply('Pizza'), reply('Soup')]);
  clips(test, qid, v);
  expect(m.myOptions(test.viewContext(auth(STATION))).length).toBe(3);
  expect(m.myOptions(test.viewContext(auth(STATION_B)))).toEqual([]);
  expect(m.mySession(test.viewContext(auth(STATION))!)?.questionId).toBe(qid);
  expect(m.mySession(test.viewContext(auth(STATION_B)))).toBeUndefined();

  gesture(test, 'YES');
  beat(test);
  tick(test); // the veto ends: Released
  expect(question(test, qid).status.tag).toBe('Released');
  expect(failure(() => as(test, STATION_B, (ctx) => m.replySpoken(ctx, { questionId: qid, ms: 900 })))).toBe('not allowed');
  as(test, STATION, (ctx) => m.replySpoken(ctx, { questionId: qid, ms: 900 }));
  expect(question(test, qid).status.tag).toBe('Spoken');
  // Nothing a judge says is saved to memory, even with memory consent.
  expect([...test.db.agentJob.jobByQuestion.filter(qid)].some((j) => j.kind.tag === 'Remember')).toBe(false);
});

test('the next try\'s station cannot say a reply left over from the try it replaced', () => {
  const test = tryDb();
  pair(test, AGENT, 'agent');
  as(test, STATION, (ctx) => m.startSession(ctx, { label: 'try' }));
  beat(test);
  const qid = askAs(test, STATION)!;
  clips(test, qid, publish(test, qid, [reply('Thai noodles'), reply('Pizza')]));
  gesture(test, 'YES');
  beat(test);
  tick(test);
  expect(question(test, qid).status.tag).toBe('Released');
  advance(test, SANDBOX_DEFAULTS.staleTryMs + 1_000);
  as(test, STATION_B, (ctx) => m.startSession(ctx, { label: 'try' }));
  expect(failure(() => as(test, STATION_B, (ctx) => m.replySpoken(ctx, { questionId: qid, ms: 900 })))).toBe('not allowed');
  expect(question(test, qid).status.tag).toBe('Released');
});

test('control, sandbox off: the same station cannot say the reply, and any station reads the active session', () => {
  const test = newDb();
  pair(test, STATION_B, 'station');
  grantConsent(test, 'memory');
  const qid = askAs(test, PARTNER)!;
  const v = publish(test, qid, [reply('Thai noodles'), reply('Pizza')]);
  clips(test, qid, v);
  expect(m.myOptions(test.viewContext(auth(STATION_B))).length).toBe(2);
  gesture(test, 'YES');
  beat(test);
  tick(test);
  expect(failure(() => as(test, STATION, (ctx) => m.replySpoken(ctx, { questionId: qid, ms: 900 })))).toBe('not allowed');
  as(test, SPEAKER, (ctx) => m.replySpoken(ctx, { questionId: qid, ms: 900 }));
  expect([...test.db.agentJob.jobByQuestion.filter(qid)].some((j) => j.kind.tag === 'Remember')).toBe(true);
});

test('one try at a time: a live try is not replaced; a quiet one gives way and ends as replaced', () => {
  const test = tryDb();
  as(test, STATION, (ctx) => m.startSession(ctx, { label: 'try' }));
  const first = activeId(test);
  beatAs(test, STATION, 1n);
  advance(test, 5_000);
  beatAs(test, STATION, 2n);
  expect(failure(() => as(test, STATION_B, (ctx) => m.startSession(ctx, { label: 'try' })))).toBe('busy: someone else is trying Eleven right now');
  expect(activeId(test)).toBe(first);

  advance(test, SANDBOX_DEFAULTS.staleTryMs);
  as(test, STATION_B, (ctx) => m.startSession(ctx, { label: 'try' }));
  const second = activeId(test);
  expect(second).not.toBe(first);
  expect(sessionRow(test, first).endedAt).toBeTruthy();
  expect(sessionEndReason(test, first)).toBe('replaced');
  expect(sessionRow(test, second).station.isEqual(idOf(test, STATION_B))).toBe(true);
  // The replaced station cannot beat, ask or read the new try.
  expect(failure(() => beatAs(test, STATION, 3n))).toBe('not the session station');
  expect(failure(() => askAs(test, STATION))).toBe('not allowed');
  expect(m.mySession(test.viewContext(auth(STATION)))).toBeUndefined();
});

test('a try has a time limit: its own heartbeat ends it, and an old try gives way even while it beats', () => {
  const test = tryDb({ on: true, max_try_ms: 120_000 });
  as(test, STATION, (ctx) => m.startSession(ctx, { label: 'try' }));
  const first = activeId(test);
  advance(test, 119_000);
  beatAs(test, STATION, 1n);
  expect(sessionRow(test, first).endedAt).toBeFalsy();
  advance(test, 1_000);
  beatAs(test, STATION, 2n);
  expect(sessionRow(test, first).endedAt).toBeTruthy();
  expect(sessionEndReason(test, first)).toBe('try_time');

  // A fresh try that beats every second but is past its time is replaced by the next one.
  as(test, STATION, (ctx) => m.startSession(ctx, { label: 'try' }));
  const second = activeId(test);
  for (let i = 0; i < 119; i++) {
    advance(test, 1_000);
    beatAs(test, STATION, 10n + BigInt(i));
  }
  expect(failure(() => as(test, STATION_B, (ctx) => m.startSession(ctx, { label: 'try' })))).toBe('busy: someone else is trying Eleven right now');
  advance(test, 1_000);
  as(test, STATION_B, (ctx) => m.startSession(ctx, { label: 'try' }));
  expect(sessionEndReason(test, second)).toBe('replaced');
});

test('tries per hour: the cap refuses a new try and leaves the active one alone', () => {
  const test = tryDb({ on: true, tries_per_hour: 1 });
  as(test, STATION, (ctx) => m.startSession(ctx, { label: 'try' }));
  const first = activeId(test);
  advance(test, SANDBOX_DEFAULTS.staleTryMs + 1_000);
  expect(failure(() => as(test, STATION_B, (ctx) => m.startSession(ctx, { label: 'try' })))).toBe('try limit: the tries for this hour are used up');
  expect(activeId(test)).toBe(first);
  expect(sessionRow(test, first).endedAt).toBeFalsy();
  advance(test, 60 * 60 * 1000);
  as(test, STATION_B, (ctx) => m.startSession(ctx, { label: 'try' }));
  expect(activeId(test)).not.toBe(first);
});

test('questions per try and per day: the cap refuses with the page sentence; a retried request id is still a no-op', () => {
  const test = tryDb({ on: true, questions_per_try: 2, questions_per_day: 3 });
  as(test, STATION, (ctx) => m.startSession(ctx, { label: 'try' }));
  const ask = (subject: string, requestId: string) => as(test, subject, (ctx) => m.askQuestion(ctx, { requestId, text: 'What should we eat?', via: 'typed', listenMs: 0 }));
  ask(STATION, 'q-1');
  ask(STATION, 'q-2');
  ask(STATION, 'q-2'); // a retry of an asked question
  expect(failure(() => ask(STATION, 'q-3'))).toBe('try limit: 2 questions per try. Start a new try.');
  expect(sessionRow(test, activeId(test)).questionCount).toBe(2);

  // The next try asks again until the day's cap.
  advance(test, SANDBOX_DEFAULTS.staleTryMs + 1_000);
  as(test, STATION_B, (ctx) => m.startSession(ctx, { label: 'try' }));
  ask(STATION_B, 'q-4');
  expect(failure(() => ask(STATION_B, 'q-5'))).toBe('try limit: the questions for today are used up');
});

test('voice tokens in the sandbox: a cap per device and one for all devices; off, no cap at all', () => {
  const test = tryDb({ on: true, tokens_per_device_per_hour: 2, tokens_per_hour: 3 });
  // The harness cannot read the key, so a token that passed every check stops at voice_key_missing.
  expect(mint(test, STATION, 'tts')).toBe('voice_key_missing');
  expect(mint(test, STATION, 'tts')).toBe('voice_key_missing');
  expect(mint(test, STATION, 'tts')).toBe('voice_try_limit');
  expect(mint(test, STATION_B, 'tts')).toBe('voice_key_missing');
  expect(mint(test, STATION_B, 'tts')).toBe('voice_try_limit');
  // Roles are still checked first: no partner is paired, and a station never gets speech to text.
  expect(mint(test, PARTNER, 'stt')).toBe('not_paired_for_purpose');
  expect(mint(test, STATION, 'stt')).toBe('not_paired_for_purpose');

  const off = newDb();
  for (let i = 0; i < 5; i++) expect(mint(off, STATION, 'tts')).toBe('voice_key_missing');
});
