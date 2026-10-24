/**
 * The room voice page without a browser (docs/station.md 3, 7.4 B2): the screen's words for idle, waiting for the tap,
 * speaking, said, missed, failed and paused; the reply's words only with sharing on; the rows it reads (a snapshot is
 * told apart from a live change); and the Cartesia voice adapter, which reports a reply as said only once it played
 * to the end in a running AudioContext.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildSpeakerView, missedSentence, SPEAKER_TEXT } from '../components/speaker/model';
import { SPEAKER_IDLE, type SpeakerReply, type SpeakerState } from '../lib/speaker/engine';
import {
  attachSpeakerRows,
  isSnapshotEvent,
  offerSnapshot,
  readRoom,
  readSpeakerSnapshot,
  replyFromSession,
  SPEAKER_ROOM_UNKNOWN,
  type SpeakerConnLike,
  type SpeakerRoom,
} from '../lib/speaker/rows';
import { createSpeakerVoice, replyUtterance, type OutLike, type PlayerLike } from '../lib/speaker/voice';
import { FakeTable, fakeTimers, flush } from './role-fakes';

const T0 = 1_761_300_000_000;
const REPLY: SpeakerReply = { questionId: 7n, text: 'Tea, please.', tone: 'warm', laugh: false, releasedAtMs: T0 - 180_000 };
const SHARING: SpeakerRoom = { sharing: true, paused: null, speakersOnline: 1 };
const PRIVATE: SpeakerRoom = { sharing: false, paused: null, speakersOnline: 1 };

function view(state: Partial<SpeakerState>, room: SpeakerRoom = SHARING, audioRunning = true) {
  return buildSpeakerView({ state: { ...SPEAKER_IDLE, ...state }, room, now: T0, offsetMs: 0, audioRunning });
}

describe('the room voice screen', () => {
  test('idle says it is waiting; paused says nothing will be said', () => {
    assert.equal(view({}).status.text, SPEAKER_TEXT.waiting);
    assert.equal(view({}).status.mark, 'ring');
    const paused = view({}, { ...SHARING, paused: 'paused' });
    assert.equal(paused.status.text, 'Paused. Nothing will be said.');
    assert.equal(paused.status.mark, 'pause');
    assert.equal(paused.status.tone, 'stopped', 'paused is muted, never red');
  });

  test('speaking and said show the words only while sharing is on', () => {
    const speaking = view({ phase: 'speaking', reply: REPLY });
    assert.equal(speaking.status.text, 'Saying it out loud');
    assert.equal(speaking.status.mark, 'spinner');
    assert.equal(speaking.words, '"Tea, please."');
    assert.equal(speaking.replyLabel, null);

    const hidden = view({ phase: 'speaking', reply: REPLY }, PRIVATE);
    assert.equal(hidden.words, null);
    assert.equal(hidden.replyLabel, 'Reply to question 7');

    const said = view({ phase: 'said', reply: REPLY, saidAt: Date.UTC(2026, 9, 24, 19, 41, 8) });
    assert.equal(said.status.text, 'Said out loud');
    assert.equal(said.status.mark, 'check');
    assert.equal(said.meta, 'Said at 12:41:08');

    const saidHidden = view({ phase: 'said', reply: REPLY, saidAt: T0 }, PRIVATE);
    assert.equal(saidHidden.words, null);
    assert.ok(!JSON.stringify(saidHidden).includes('Tea'), 'no reply words anywhere on the screen with sharing off');
  });

  test('a missed reply says how long ago it was released and offers Say it now while it is still released', () => {
    const missed = view({ phase: 'missed', reply: REPLY, stillReleased: true });
    assert.equal(missed.status.text, 'Missed reply to question 7, released 3 min ago.');
    assert.equal(missed.status.tone, 'stopped');
    assert.equal(missed.sayNow, true);
    assert.equal(view({ phase: 'missed', reply: REPLY, stillReleased: false }).sayNow, false);
    assert.equal(view({ phase: 'missed', reply: REPLY, stillReleased: true }, SHARING, false).sayNow, false, 'only once the room voice runs');
    assert.equal(missedSentence(REPLY, T0, 120_000), 'Missed reply to question 7, released 5 min ago.', 'ages use the server clock estimate');
  });

  test('waiting for the tap, failed, the report line and two speakers', () => {
    const waiting = view({ phase: 'waiting_audio', reply: REPLY, stillReleased: true }, SHARING, false);
    assert.equal(waiting.status.text, SPEAKER_TEXT.needsAudio);
    assert.equal(waiting.status.mark, 'hourglass');

    const failed = view({ phase: 'failed', reply: REPLY, stillReleased: true, errorText: 'socket closed' });
    assert.equal(failed.status.text, 'Could not say the reply.');
    assert.equal(failed.status.tone, 'failed');
    assert.equal(failed.status.title, 'socket closed', 'the raw error is a tooltip only');
    assert.equal(failed.sayNow, true);

    assert.equal(view({ phase: 'said', reply: REPLY, report: 'sending' }).report?.text, 'Recording that it was said');
    assert.equal(view({ phase: 'said', reply: REPLY, report: 'retrying' }).report?.text, 'Not connected. Trying again.');
    assert.equal(view({ phase: 'said', reply: REPLY, report: 'done' }).report?.mark, 'check');
    assert.equal(view({ phase: 'said', reply: REPLY, report: 'stopped' }).report?.tone, 'stopped');
    assert.equal(view({ phase: 'said', reply: REPLY, report: 'gave_up' }).report?.tone, 'failed');

    assert.equal(view({}, { ...SHARING, speakersOnline: 2 }).warning, SPEAKER_TEXT.twoSpeakers);
    assert.equal(view({}, SHARING).warning, null);
  });
});

function speakerConn() {
  const t = {
    mySession: new FakeTable<any>(),
    scanState: new FakeTable<any>(),
    config: new FakeTable<any>(),
    deviceStatus: new FakeTable<any>(),
  };
  return { conn: { db: t } as unknown as SpeakerConnLike, t };
}

/** Calls a fake table's row callbacks with the SDK's arguments (an event context, then the rows). */
function fire(table: FakeTable<any>, kind: 'insert' | 'update', ...args: unknown[]) {
  for (const cb of [...table.listeners[kind]]) (cb as (...a: unknown[]) => void)(...args);
}

const ts = (ms: number) => ({ microsSinceUnixEpoch: BigInt(ms) * 1000n });

describe('the rows the room voice reads', () => {
  test('my_session.reply becomes plain values', () => {
    assert.equal(replyFromSession({ sessionId: 1n, reply: undefined }), null);
    assert.deepEqual(replyFromSession({ sessionId: 1n, reply: { questionId: 7n, text: 'Tea.', tone: 'warm', laugh: true, releasedAt: ts(T0) } }), {
      questionId: 7n,
      text: 'Tea.',
      tone: 'warm',
      laugh: true,
      releasedAtMs: T0,
    });
  });

  test('sharing, the active session pause and the speakers online come from config, scan_state and device_status', () => {
    const { conn, t } = speakerConn();
    assert.deepEqual(readRoom(conn), SPEAKER_ROOM_UNKNOWN);
    t.config.rows = [{ activeSessionId: 3n, shareTextOnBoard: true }];
    t.scanState.rows = [
      { sessionId: 2n, phase: { tag: 'Paused' }, pauseReason: { tag: 'Stop' }, updatedAt: ts(T0) },
      { sessionId: 3n, phase: { tag: 'Paused' }, pauseReason: { tag: 'HeadsetOff' }, updatedAt: ts(T0) },
    ];
    t.deviceStatus.rows = [
      { role: { tag: 'Speaker' }, online: true },
      { role: { tag: 'Speaker' }, online: false },
      { role: { tag: 'Station' }, online: true },
    ];
    assert.deepEqual(readRoom(conn), { sharing: true, paused: 'headset_off', speakersOnline: 1 });
  });

  test('a SubscribeApplied row event is a snapshot; a reducer event is live; only live scan rows feed the clock', () => {
    assert.equal(isSnapshotEvent({ event: { tag: 'SubscribeApplied' } }), true);
    assert.equal(isSnapshotEvent({ event: { tag: 'Reducer' } }), false);
    assert.equal(isSnapshotEvent(undefined), false);

    const { conn, t } = speakerConn();
    const offers: Array<{ id: bigint | null; source: string }> = [];
    const samples: number[] = [];
    const rooms: SpeakerRoom[] = [];
    const target = {
      engine: {
        offer: (r: SpeakerReply | null, source: 'snapshot' | 'live') => offers.push({ id: r?.questionId ?? null, source }),
        noteServerTime: (serverMs: number) => samples.push(serverMs),
      },
      room: (next: SpeakerRoom) => rooms.push(next),
      now: () => T0,
    };
    const detach = attachSpeakerRows(conn, target);
    t.mySession.rows = [{ sessionId: 1n, reply: { questionId: 7n, text: 'Tea.', tone: 'warm', laugh: false, releasedAt: ts(T0) } }];
    fire(t.mySession, 'insert', { event: { tag: 'SubscribeApplied' } }, t.mySession.rows[0]);
    fire(t.mySession, 'insert', { event: { tag: 'Reducer' } }, t.mySession.rows[0]);
    assert.deepEqual(offers, [
      { id: 7n, source: 'snapshot' },
      { id: 7n, source: 'live' },
    ]);
    const row = { sessionId: 1n, phase: { tag: 'Reading' }, updatedAt: ts(T0 + 500) };
    fire(t.scanState, 'insert', { event: { tag: 'SubscribeApplied' } }, row);
    assert.deepEqual(samples, [], 'snapshot rows never count for the clock');
    fire(t.scanState, 'update', { event: { tag: 'Reducer' } }, row, row);
    assert.deepEqual(samples, [T0 + 500]);
    assert.ok(rooms.length >= 2);

    readSpeakerSnapshot(conn, target);
    assert.deepEqual(offers[offers.length - 1], { id: 7n, source: 'snapshot' }, 'the cache read at subscription apply is a snapshot');

    detach();
    for (const table of Object.values(t)) assert.equal(table.callbackCount(), 0, 'every callback is removed');
  });

  test('no reply is offered before pairing completes; then the cache is offered as a snapshot', () => {
    const { conn, t } = speakerConn();
    let paired = false;
    const offers: Array<{ id: bigint | null; source: string }> = [];
    const target = {
      engine: {
        offer: (r: SpeakerReply | null, source: 'snapshot' | 'live') => offers.push({ id: r?.questionId ?? null, source }),
        noteServerTime: () => {},
      },
      room: () => {},
      paired: () => paired,
    };
    attachSpeakerRows(conn, target);
    t.mySession.rows = [{ sessionId: 1n, reply: { questionId: 7n, text: 'Tea.', tone: 'warm', laugh: false, releasedAt: ts(T0 - 600_000) } }];
    // The owner approves: the view starts returning the reply in a live transaction, before the voice check says paired.
    fire(t.mySession, 'insert', { event: { tag: 'Reducer' } }, t.mySession.rows[0]);
    readSpeakerSnapshot(conn, target);
    assert.deepEqual(offers, [], 'an old reply that appears with the pairing is never taken as live');
    paired = true;
    offerSnapshot(conn, target);
    assert.deepEqual(offers, [{ id: 7n, source: 'snapshot' }]);
  });
});

function voiceHarness(options: { state?: string; durationMs?: number; fail?: Error } = {}) {
  const timers = fakeTimers();
  const context = { state: options.state ?? 'running' };
  const players: Array<{ closed: boolean; spoken: string[] }> = [];
  const out = {
    playing: false,
    chunks: 0,
    stops: 0,
    enqueue() {
      this.chunks++;
      this.playing = true;
    },
    stop() {
      this.stops++;
      this.playing = false;
    },
    positionMs: () => 0,
  };
  let finishClip: () => void = () => {};
  const makePlayer = (): PlayerLike => {
    const p = { closed: false, spoken: [] as string[] };
    players.push(p);
    return {
      speak(u, opts) {
        p.spoken.push(u.transcript);
        opts.onAudio?.(new Uint8Array(4));
        let resolve: (clip: any) => void = () => {};
        let reject: (error: Error) => void = () => {};
        const done = new Promise<any>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        finishClip = () => {
          if (options.fail) reject(options.fail);
          else resolve({ durationMs: options.durationMs ?? 1200, words: [], pcm: new Uint8Array(4) });
        };
        return { done, cancel() {} };
      },
      close() {
        p.closed = true;
      },
    };
  };
  const voice = createSpeakerVoice({
    getToken: async () => 'unused',
    context: () => context,
    volume: () => 1.5,
    makePlayer,
    makeOut: () => out as unknown as OutLike,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { voice, out, context, players, timers, finish: () => finishClip() };
}

describe('the room voice adapter', () => {
  test('the reply is said in the reply voice with its tone and the room volume', () => {
    const u = replyUtterance({ text: 'Tea, please', tone: 'warm', laugh: true }, 1.5);
    assert.equal(u.kind, 'reply');
    assert.equal(u.generationConfig.volume, 1.5);
    assert.equal(u.generationConfig.emotion, 'content');
    assert.ok(u.transcript.endsWith('[laughter]'));
    assert.equal(replyUtterance({ text: 'x', tone: 'none', laugh: false }, 9).generationConfig.volume, 2, 'the volume is kept within 0.5 to 2');
  });

  test('done waits until the last chunk has played, then reports the clip length', async () => {
    const h = voiceHarness();
    const job = h.voice.say({ text: 'Tea, please.', tone: 'warm', laugh: false }, 1);
    let result: unknown = null;
    void job.done.then((r) => {
      result = r;
    });
    h.finish();
    await flush();
    assert.equal(result, null, 'still playing');
    h.out.playing = false;
    h.timers.advance(100);
    await flush();
    assert.deepEqual(result, { ok: true, clipMs: 1200 });
  });

  test('audio that stopped before the end is a failure, so it is never reported as said', async () => {
    const h = voiceHarness();
    const job = h.voice.say({ text: 'Tea.', tone: 'warm', laugh: false }, 1);
    h.finish();
    await flush();
    h.context.state = 'suspended';
    h.timers.advance(100);
    const result = await job.done;
    assert.equal(result.ok, false);
  });

  test('nothing is said into a context that is not running', async () => {
    const h = voiceHarness({ state: 'suspended' });
    const result = await h.voice.say({ text: 'Tea.', tone: 'warm', laugh: false }, 1).done;
    assert.equal(result.ok, false);
    assert.equal(h.players.length, 0);
  });

  test('a generation error fails the job; the retry opens a fresh player (a new socket and token)', async () => {
    const h = voiceHarness({ fail: new Error('socket closed') });
    const first = h.voice.say({ text: 'Tea.', tone: 'warm', laugh: false }, 1);
    h.finish();
    const result = await first.done;
    assert.deepEqual(result, { ok: false, reason: 'failed', message: 'socket closed' });
    h.voice.say({ text: 'Tea.', tone: 'warm', laugh: false }, 2);
    assert.equal(h.players.length, 2);
    assert.equal(h.players[0]!.closed, true);
  });

  test('an empty reply fails before any audio', async () => {
    const h = voiceHarness();
    const result = await h.voice.say({ text: '   ', tone: 'warm', laugh: false }, 1).done;
    assert.equal(result.ok, false);
    assert.equal(h.players.length, 0);
  });
});
