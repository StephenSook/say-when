/**
 * Asking from the partner phone (docs/station.md 4 and 7.4 B3): the same words reuse their request id; resend only
 * after DisconnectedError or UnknownCallResultError, at most 3 tries within 30 s; no speech and a speech to text
 * error map to their sentences; partial words are hidden with sharing off; listen_ms is the time from the release to
 * the transcript; a text over 500 characters is refused before sending.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DisconnectedError, SenderError, UnknownCallResultError } from 'spacetimedb';
import type { Listening, ListenOptions, ListenResult } from '../lib/cartesia/browser';
import { ASK_TEXT, askFailure, createAskSender, MAX_QUESTION_CHARS, prepareQuestion, requestIdFor, type AskRequest } from '../lib/partner/ask';
import { createPushToTalk, HOLD_TEXT, LISTEN_MAX_MS, PARTNER_KEYTERMS, PUSH_TO_TALK_READY, type PushToTalkState } from '../lib/partner/push-to-talk';
import { readSharing } from '../lib/partner/rows';
import { ASK_VIEW_TEXT, buildAskView, heardText } from '../lib/partner/view';
import { FakeTable, flush } from './role-fakes';

const CTRL = String.fromCharCode(7);

describe('the question text', () => {
  test('is trimmed, loses control characters but keeps tab and newline, and must be 1 to 500 characters', () => {
    assert.deepEqual(prepareQuestion(`  What${CTRL} should\twe\neat?  `), { ok: true, text: 'What should\twe\neat?' });
    assert.equal(prepareQuestion('   ').ok, false);
    const long = prepareQuestion('a'.repeat(MAX_QUESTION_CHARS + 1));
    assert.deepEqual(long, { ok: false, reason: 'too_long', sentence: 'Too long. Keep it under 500 characters.' });
    assert.equal(prepareQuestion('a'.repeat(MAX_QUESTION_CHARS)).ok, true);
  });

  test('the same words keep their request id; new words get a new one', () => {
    let n = 0;
    const make = () => `id-${++n}`;
    const first = requestIdFor(null, 'Which drink?', make);
    assert.equal(first.requestId, 'id-1');
    assert.equal(requestIdFor(first, 'Which drink?', make).requestId, 'id-1', 'a retry is the same question');
    assert.equal(requestIdFor(first, 'Which snack?', make).requestId, 'id-2');
  });
});

function sender(answers: Array<Error | null>, options: { live?: boolean } = {}) {
  let now = 0;
  const calls: AskRequest[] = [];
  const noted: unknown[] = [];
  const retrying: boolean[] = [];
  const send = createAskSender({
    call: async (request) => {
      calls.push(request);
      const answer = answers.shift() ?? null;
      if (answer) throw answer;
    },
    waitForLive: async (timeoutMs) => {
      now += Math.min(timeoutMs, 5_000);
      return options.live ?? true;
    },
    noteCallError: (error) => noted.push(error),
    onRetrying: (on) => retrying.push(on),
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  return { send, calls, noted, retrying, now: () => now };
}

const REQUEST: AskRequest = { requestId: '0b6f2a4e-3c1d-4f7a-9e2b-1a2b3c4d5e6f', text: ' Which drink? ', via: 'typed', listenMs: 0 };

describe('ask_question', () => {
  test('sends the prepared words with the request id', async () => {
    const s = sender([]);
    assert.deepEqual(await s.send({ ...REQUEST, via: 'voice', listenMs: 412.6 }), { ok: true });
    assert.deepEqual(s.calls, [{ requestId: REQUEST.requestId, text: 'Which drink?', via: 'voice', listenMs: 413 }]);
  });

  test('a text over 500 characters is refused before sending', async () => {
    const s = sender([]);
    const outcome = await s.send({ ...REQUEST, text: 'b'.repeat(501) });
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.sentence, ASK_TEXT.tooLong);
    assert.equal(s.calls.length, 0);
  });

  test('DisconnectedError and UnknownCallResultError are sent again with the same request id, at most 3 tries', async () => {
    const ok = sender([new DisconnectedError(), new UnknownCallResultError('dropped')]);
    assert.deepEqual(await ok.send(REQUEST), { ok: true });
    assert.equal(ok.calls.length, 3);
    assert.ok(ok.calls.every((c) => c.requestId === REQUEST.requestId));
    assert.deepEqual(ok.retrying, [true, false], '"Not connected. Trying again." shows while it waits, then goes');

    const fail = sender([new DisconnectedError(), new DisconnectedError(), new DisconnectedError(), new DisconnectedError()]);
    const outcome = await fail.send(REQUEST);
    assert.equal(fail.calls.length, 3, 'never a fourth try');
    assert.equal(!outcome.ok && outcome.kind, 'not_sent');
    assert.equal(!outcome.ok && outcome.sentence, 'Could not send. Try again.');
  });

  test('no live connection within the 30 s window: no second try', async () => {
    const s = sender([new DisconnectedError(), new DisconnectedError(), new DisconnectedError()], { live: false });
    const outcome = await s.send(REQUEST);
    assert.equal(outcome.ok, false);
    assert.equal(s.calls.length, 1, 'no live connection within the window: no second try');
  });

  test('a SenderError is never retried: no session, not allowed, anything else', async () => {
    const none = sender([new SenderError('no active session')]);
    const outcome = await none.send(REQUEST);
    assert.equal(none.calls.length, 1);
    assert.equal(!outcome.ok && outcome.kind, 'no_session');
    assert.equal(!outcome.ok && outcome.sentence, 'The station is not running. Nothing was sent.');

    const revoked = sender([new SenderError('not allowed')]);
    const r = await revoked.send(REQUEST);
    assert.equal(!r.ok && r.kind, 'not_paired');
    assert.equal(revoked.noted.length, 1, 'not allowed reaches the device, which shows the pairing card');

    const other = sender([new SenderError('text has control characters')]);
    const o = await other.send(REQUEST);
    assert.equal(other.calls.length, 1);
    assert.equal(!o.ok && o.sentence, 'Could not send. Try again.');
    assert.equal(!o.ok && o.title, 'text has control characters', 'the raw words go to a tooltip only');
  });

  test('askFailure keeps the words plain', () => {
    assert.equal(askFailure(new DisconnectedError()).sentence, ASK_TEXT.couldNotSend);
  });
});

interface FakeSession {
  options: ListenOptions;
  released: number;
  aborted: number;
  finish(result: ListenResult): void;
}

function pushHarness(sendAnswers: Array<Error | null> = []) {
  let now = 10_000;
  let ids = 0;
  const sessions: FakeSession[] = [];
  const listening: Array<{ requestId: string; on: boolean }> = [];
  const s = sender(sendAnswers);
  const push = createPushToTalk({
    listen: (options): Listening => {
      let resolve: (result: ListenResult) => void = () => {};
      const done = new Promise<ListenResult>((res) => {
        resolve = res;
      });
      const session: FakeSession = { options, released: 0, aborted: 0, finish: (r) => resolve(r) };
      sessions.push(session);
      return {
        done,
        release() {
          session.released++;
        },
        abort() {
          session.aborted++;
          resolve({ ok: false, reason: 'aborted', message: 'Stopped.', ms: 0 });
        },
      };
    },
    getToken: async () => 'stt-token',
    setListening: async (requestId, on) => {
      listening.push({ requestId, on });
    },
    send: s.send,
    newRequestId: () => `req-${++ids}`,
    now: () => now,
  });
  return { push, sessions, listening, sends: s.calls, advance: (ms: number) => (now += ms) };
}

describe('Hold to ask', () => {
  test('streams to Ink-2 only while held, then asks with listen_ms from the release to the transcript', async () => {
    const h = pushHarness();
    h.push.press();
    assert.equal(h.push.getState().phase, 'holding');
    assert.deepEqual(h.listening, [{ requestId: 'req-1', on: true }], 'partner_listening on, without waiting');
    const options = h.sessions[0]!.options;
    assert.equal(options.endOn, 'release', 'push to talk: the partner decides when it is over');
    assert.equal(options.maxMs, LISTEN_MAX_MS);
    assert.ok(PARTNER_KEYTERMS.includes('Eleven'));
    assert.equal(await options.getToken(), 'stt-token');

    options.onPartial?.('what should');
    assert.equal(h.push.getState().heard, 'what should');
    options.onTurn?.('What should we eat?');
    options.onPartial?.('tonight');
    assert.equal(h.push.getState().heard, 'What should we eat? tonight');
    assert.equal(h.push.getState().words, 5);

    h.advance(2_000);
    h.push.release();
    assert.equal(h.sessions[0]!.released, 1);
    assert.deepEqual(h.listening[1], { requestId: 'req-1', on: false });
    assert.equal(h.push.getState().phase, 'hearing');
    h.push.release();
    assert.equal(h.sessions[0]!.released, 1, 'a second release does nothing');

    h.advance(400);
    h.sessions[0]!.finish({ ok: true, text: 'What should we eat tonight?', turns: 1, complete: false, reason: 'release', ms: 2_400 });
    await flush();
    await flush();
    assert.deepEqual(h.sends, [{ requestId: 'req-1', text: 'What should we eat tonight?', via: 'voice', listenMs: 400 }]);
    assert.equal(h.push.getState().phase, 'sent');
  });

  test('no speech and a speech to text error get their sentences, and nothing is asked', async () => {
    const h = pushHarness();
    h.push.press();
    h.push.release();
    h.sessions[0]!.finish({ ok: false, reason: 'no_speech', message: 'No speech was heard.', ms: 900 });
    await flush();
    assert.equal(h.push.getState().problem?.sentence, 'Did not catch that. Hold and ask again.');
    assert.equal(h.push.getState().problem?.sentence, HOLD_TEXT.noSpeech);

    h.push.press();
    h.push.release();
    h.sessions[1]!.finish({ ok: false, reason: 'error', message: 'Could not connect to speech to text.', ms: 900 });
    await flush();
    const problem = h.push.getState().problem;
    assert.equal(problem?.sentence, 'Speech to text is not working. Type your question.');
    assert.equal(problem?.title, 'Could not connect to speech to text.', 'the error code goes to a tooltip only');
    assert.equal(h.sends.length, 0);
  });

  test('the 30 s limit sends what was heard and ends the hold', async () => {
    const h = pushHarness();
    h.push.press();
    h.sessions[0]!.finish({ ok: true, text: 'A very long question', turns: 0, complete: false, reason: 'timeout', ms: 30_000 });
    await flush();
    await flush();
    assert.equal(h.sends.length, 1);
    assert.equal(h.sends[0]!.text, 'A very long question');
    assert.deepEqual(h.listening[h.listening.length - 1], { requestId: 'req-1', on: false }, 'the board stops showing Listening');
    h.push.release();
    assert.equal(h.sessions[0]!.released, 0, 'the release after the limit does nothing');
  });

  test('a question that could not be sent keeps its request id for Send again', async () => {
    const h = pushHarness([new DisconnectedError(), new DisconnectedError(), new DisconnectedError(), null]);
    h.push.press();
    h.push.release();
    h.sessions[0]!.finish({ ok: true, text: 'Which drink?', turns: 1, complete: true, reason: 'release', ms: 1_000 });
    for (let i = 0; i < 10; i++) await flush();
    const state = h.push.getState();
    assert.equal(state.phase, 'problem');
    assert.equal(state.problem?.sentence, 'Could not send. Try again.');
    assert.equal(state.unsent?.requestId, 'req-1');
    h.push.sendAgain();
    for (let i = 0; i < 4; i++) await flush();
    assert.equal(h.sends[h.sends.length - 1]!.requestId, 'req-1', 'Send again is the same question, never a second one');
    assert.equal(h.push.getState().phase, 'sent');
  });

  test('abort throws a hold away without asking', async () => {
    const h = pushHarness();
    h.push.press();
    h.push.abort();
    await flush();
    assert.equal(h.sessions[0]!.aborted, 1);
    assert.equal(h.push.getState().phase, 'ready');
    assert.equal(h.sends.length, 0);
  });
});

const READY_VOICE = { status: 'ready', at: 0 } as const;
const PAIRED = { phase: 'paired', revokedBefore: false } as const;

function askView(hold: Partial<PushToTalkState>, extra: Partial<Parameters<typeof buildAskView>[0]> = {}) {
  return buildAskView({ pairing: PAIRED, voice: READY_VOICE, hold: { ...PUSH_TO_TALK_READY, ...hold }, sharing: true, scanReading: false, retrying: false, ...extra });
}

describe('what the phone shows at each step', () => {
  test('not paired: read-only, with the pairing link under the button', () => {
    const view = buildAskView({ pairing: { phase: 'unpaired', revokedBefore: false }, voice: { status: 'unknown' }, hold: PUSH_TO_TALK_READY, sharing: true, scanReading: false, retrying: false });
    assert.equal(view.canHold, false);
    assert.equal(view.holdDisabled, true);
    assert.equal(view.note, 'Only a paired phone can ask.');
    // The note must not repeat the pairing link's own words right under it.
    assert.notEqual(view.note.replace(/\.$/, ''), 'Pair this phone to ask');
    assert.equal(view.showPairLink, true);
    assert.equal(view.canType, false);
    const revoked = buildAskView({ pairing: { phase: 'revoked', revokedBefore: true }, voice: { status: 'unknown' }, hold: PUSH_TO_TALK_READY, sharing: true, scanReading: false, retrying: false });
    assert.equal(revoked.note, ASK_VIEW_TEXT.notPairedAnymore);
  });

  test('ready: Hold to ask with "Listening only while you hold." and the typed box', () => {
    const view = askView({});
    assert.equal(view.canHold, true);
    assert.equal(view.holdDisabled, false);
    assert.equal(view.note, 'Listening only while you hold.');
    assert.equal(view.canType, true);
    assert.equal(askView({}, { scanReading: true }).note, 'Asking now replaces the question they are answering.');
  });

  test('holding: the words as Ink-2 hears them with sharing on, only a count with sharing off', () => {
    const hold = { phase: 'holding' as const, heard: 'What should we eat', words: 4 };
    assert.equal(askView(hold).heard, '"What should we eat"');
    const hidden = askView({ ...hold, words: 12 }, { sharing: false });
    assert.equal(hidden.heard, '12 words so far');
    assert.ok(!JSON.stringify(hidden).includes('eat'), 'no words anywhere with sharing off');
    assert.equal(heardText({ ...PUSH_TO_TALK_READY, phase: 'holding', heard: '', words: 0 }, false), null);
    assert.equal(heardText({ ...PUSH_TO_TALK_READY, phase: 'sending', heard: 'x', words: 1 }, true), null, 'only while holding');
  });

  test('released and sending: "Sending" with the button off; retrying: "Not connected. Trying again."', () => {
    const sending = askView({ phase: 'sending' });
    assert.equal(sending.busy, 'Sending');
    assert.equal(sending.holdDisabled, true);
    assert.equal(askView({ phase: 'hearing' }).busy, 'Sending');
    const retry = askView({ phase: 'sending' }, { retrying: true });
    assert.equal(retry.busy, 'Not connected. Trying again.');
  });

  test('problems: no speech and no session are muted; could not send is an error with Send again', () => {
    const noSpeech = askView({ phase: 'problem', problem: { kind: 'no_speech', sentence: HOLD_TEXT.noSpeech, title: null } });
    assert.equal(noSpeech.problem?.tone, 'stopped');
    assert.equal(noSpeech.problem?.sendAgain, false);
    const noSession = askView({ phase: 'problem', problem: { kind: 'no_session', sentence: ASK_TEXT.noSession, title: 'no active session' } });
    assert.equal(noSession.problem?.sentence, 'The station is not running. Nothing was sent.');
    assert.equal(noSession.problem?.tone, 'stopped');
    const unsent: AskRequest = { requestId: 'req-1', text: 'Which drink?', via: 'voice', listenMs: 300 };
    const notSent = askView({ phase: 'problem', problem: { kind: 'not_sent', sentence: ASK_TEXT.couldNotSend, title: null }, unsent });
    assert.equal(notSent.problem?.tone, 'failed');
    assert.equal(notSent.problem?.sendAgain, true);
    const stt = askView({ phase: 'problem', problem: { kind: 'stt', sentence: HOLD_TEXT.sttBroken, title: 'voice_offline' } });
    assert.equal(stt.problem?.sentence, 'Speech to text is not working. Type your question.');
    assert.equal(stt.canType, true, 'the typed box still works');
  });

  test('no Cartesia key: Hold to ask is off and the typed box stays', () => {
    const view = askView({}, { voice: { status: 'problem', problem: 'key_missing', code: 'voice_key_missing', words: 'Voice off: the database has no Cartesia key.', at: 0 } });
    assert.equal(view.canHold, false);
    assert.equal(view.holdDisabled, true);
    assert.equal(view.note, ASK_VIEW_TEXT.sttOff);
    assert.equal(view.canType, true);
  });

  test('the room toggle is off until config has been read', () => {
    const config = new FakeTable<{ shareTextOnBoard: boolean }>();
    const conn = { db: { config } };
    assert.equal(readSharing(conn), false);
    config.rows = [{ shareTextOnBoard: true }];
    assert.equal(readSharing(conn), true);
  });
});
