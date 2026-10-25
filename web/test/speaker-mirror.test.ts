/**
 * Mirror the earpiece on the room voice (lib/speaker/mirror.ts, mirror-rows.ts, voice.ts): with the toggle on, the
 * room hears the partner's question, then the numbered options as they are read, then any read-back, one line at a
 * time; off, only the picked reply; a newer question drops stale lines; the reply always has priority. Also the audio
 * fixes that make the room voice play every time: a line the audio cut is said again after the tap, a failed line is
 * retried on a fresh socket, a chunk the output refused is a failure, an unused socket is replaced, the browser's own
 * suspension is undone without a tap, and a reply cut by the audio stopping waits for the tap instead of failing.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildMirrorView, MIRROR_TEXT } from '../components/speaker/model';
import { createSpeakerEngine, type SayJob, type SayResult, type SpeakerReply } from '../lib/speaker/engine';
import { createSpeakerMirror, MIRROR_STALE_MS, roomSafeText, type MirrorItem, type SpeakerMirror } from '../lib/speaker/mirror';
import { attachMirrorRows, mirrorReadbackText, type MirrorConnLike } from '../lib/speaker/mirror-rows';
import { createSpeakerVoice, lineUtterance, SOCKET_FRESH_AFTER_MS, type OutLike, type PlayerLike } from '../lib/speaker/voice';
import { createAudioUnlock, type UnlockContextLike } from '../lib/voice/audio';
import { FakeSubscription, FakeTable, fakeTimers, flush, memoryStorage } from './role-fakes';

const T0 = 1_761_400_000_000;

// ---------- A fake voice that records every line and reply in order ----------

interface Spoken {
  what: 'line' | 'reply';
  text: string;
  attempt: number;
  resolve(result: SayResult): void;
  cancelled: boolean;
}

function job(log: Spoken[], what: 'line' | 'reply', text: string, attempt: number): SayJob {
  let resolve: (result: SayResult) => void = () => {};
  const done = new Promise<SayResult>((res) => {
    resolve = res;
  });
  const entry: Spoken = { what, text, attempt, resolve, cancelled: false };
  log.push(entry);
  return {
    done,
    cancel() {
      entry.cancelled = true;
      resolve({ ok: false, reason: 'stopped', message: 'Stopped.' });
    },
  };
}

/** The room voice as useSpeaker wires it: the reply engine, the mirror, and the reply's priority over the mirror. */
function room(options: { on?: boolean; sharing?: boolean; audio?: boolean } = {}) {
  let now = T0;
  let audio = options.audio ?? true;
  const spoken: Spoken[] = [];
  const engine = createSpeakerEngine({
    db: 'say-when-test',
    storage: memoryStorage(),
    now: () => now,
    sleep: async () => {},
    audioReady: () => audio,
    say: (reply, attempt) => job(spoken, 'reply', reply.text, attempt),
    reportSpoken: async () => {},
    waitForLive: async () => true,
  });
  const mirror = createSpeakerMirror({
    say: (item, attempt) => job(spoken, 'line', item.text, attempt),
    audioReady: () => audio,
    replyIdle: () => engine.getState().phase !== 'speaking',
    on: options.on ?? true,
    now: () => now,
  });
  engine.subscribe(() => {
    const state = engine.getState();
    if (state.phase === 'speaking' && state.reply) mirror.replyStarted(state.reply.questionId);
    else mirror.kick();
  });
  mirror.setSharing(options.sharing ?? true);
  /** Plays the newest unfinished speech to its end. */
  const finish = async (clipMs = 900) => {
    const playing = [...spoken].reverse().find((s) => !s.cancelled && !(s as { ended?: boolean }).ended);
    assert.ok(playing, 'something is playing');
    (playing as { ended?: boolean }).ended = true;
    playing.resolve({ ok: true, clipMs });
    await flush();
  };
  return {
    engine,
    mirror,
    spoken,
    finish,
    texts: () => spoken.map((s) => `${s.what}:${s.text}`),
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    setAudio: (on: boolean) => {
      audio = on;
    },
  };
}

let seq = 0;
function line(kind: MirrorItem['kind'], questionId: number, text: string, at = T0): MirrorItem {
  seq++;
  return { key: `${kind}:${questionId}:${seq}`, kind, questionId: BigInt(questionId), text, voice: kind === 'option' ? 'reply' : 'assistant', tone: '', at };
}

function reply(id: number, text: string): SpeakerReply {
  return { questionId: BigInt(id), text, tone: 'warm', laugh: false, releasedAtMs: T0 };
}

describe('mirror the earpiece', () => {
  test('on: the question, then each option, then the read-back, one at a time and in order', async () => {
    const r = room();
    r.mirror.offer(line('question', 7, 'Question: Want some tea?'));
    r.mirror.offer(line('option', 7, 'One: yes please.'));
    r.mirror.offer(line('option', 7, 'Two: no thanks.'));
    assert.deepEqual(r.texts(), ['line:Question: Want some tea?'], 'never talks over itself');
    assert.equal(r.mirror.getState().phase, 'speaking');
    assert.equal(r.mirror.getState().queued, 2);
    await r.finish();
    await r.finish();
    r.mirror.offer(line('readback', 7, 'Send a request for tea. One: send it. Two: cancel.'));
    await r.finish();
    await r.finish();
    assert.deepEqual(r.texts(), [
      'line:Question: Want some tea?',
      'line:One: yes please.',
      'line:Two: no thanks.',
      'line:Send a request for tea. One: send it. Two: cancel.',
    ]);
    assert.equal(r.mirror.getState().phase, 'idle');
  });

  test('off: only the picked reply is said', async () => {
    const r = room({ on: false });
    r.mirror.offer(line('question', 7, 'Question: Want some tea?'));
    r.mirror.offer(line('option', 7, 'One: yes please.'));
    r.mirror.offer(line('readback', 7, 'Send it?'));
    r.engine.offer(reply(7, 'Yes please, with milk.'), 'live');
    assert.deepEqual(r.texts(), ['reply:Yes please, with milk.']);
    assert.equal(r.mirror.getState().phase, 'off');
    await r.finish();
    assert.deepEqual(r.texts(), ['reply:Yes please, with milk.']);

    // Turned on later: what was offered while off is past and never said.
    r.mirror.setOn(true);
    assert.deepEqual(r.texts(), ['reply:Yes please, with milk.']);
  });

  test('sharing off: nothing is queued, so only the reply is said', () => {
    const r = room({ sharing: false });
    r.mirror.offer(line('question', 7, 'Question: Want some tea?'));
    assert.equal(r.spoken.length, 0);
    assert.equal(r.mirror.getState().phase, 'no_sharing');
  });

  test('a newer question drops the queued lines of older ones and cuts the line being said', async () => {
    const r = room();
    r.mirror.offer(line('question', 7, 'Question: Want some tea?'));
    r.mirror.offer(line('option', 7, 'One: yes.'));
    r.mirror.offer(line('option', 7, 'Two: no.'));
    r.mirror.offer(line('question', 8, 'Question: Ready to go?'));
    await flush();
    assert.equal(r.spoken[0]!.cancelled, true, 'the old question was cut');
    assert.deepEqual(r.texts(), ['line:Question: Want some tea?', 'line:Question: Ready to go?']);
    r.mirror.offer(line('option', 7, 'Three: later.'));
    assert.equal(r.mirror.getState().queued, 0, 'a line for an older question is never queued');
    r.mirror.advance(9n);
    assert.equal(r.spoken[1]!.cancelled, true, 'a newer scanned question cuts it too');
  });

  test('the reply has priority: it cuts the line, drops the lines of its question, then newer lines go on', async () => {
    const r = room();
    r.mirror.offer(line('question', 7, 'Question: Want some tea?'));
    r.mirror.offer(line('option', 7, 'One: yes.'));
    r.engine.offer(reply(7, 'Yes please.'), 'live');
    await flush();
    assert.equal(r.spoken[0]!.cancelled, true, 'the line was cut at once');
    assert.deepEqual(r.texts(), ['line:Question: Want some tea?', 'reply:Yes please.']);
    assert.equal(r.mirror.getState().queued, 0, 'the options of the answered question are dropped');

    // A line for the next question waits for the reply to finish, then is said.
    r.mirror.offer(line('question', 8, 'Question: Ready?'));
    assert.equal(r.spoken.length, 2, 'no line while the reply plays');
    await r.finish();
    assert.deepEqual(r.texts(), ['line:Question: Want some tea?', 'reply:Yes please.', 'line:Question: Ready?']);
  });

  test('a newer line the voice stopped for a late reply is said again after it', async () => {
    const r = room();
    r.mirror.offer(line('question', 8, 'Question: Ready?'));
    r.engine.offer(reply(7, 'Yes please.'), 'live');
    assert.equal(r.spoken[0]!.cancelled, false, 'the mirror keeps a line of a newer question');
    // The voice gives way to the reply: the line ends as stopped.
    r.spoken[0]!.resolve({ ok: false, reason: 'stopped', message: 'Stopped.' });
    await flush();
    assert.deepEqual(r.texts(), ['line:Question: Ready?', 'reply:Yes please.']);
    await r.finish();
    assert.deepEqual(r.texts(), ['line:Question: Ready?', 'reply:Yes please.', 'line:Question: Ready?']);
  });

  test('a line is said at most once', async () => {
    const r = room();
    const q = line('question', 7, 'Question: Tea?');
    r.mirror.offer(q);
    await r.finish();
    r.mirror.offer(q);
    assert.equal(r.spoken.length, 1);
  });

  test('without the room voice, lines wait; a stale line is dropped when the tap comes', async () => {
    const r = room({ audio: false });
    r.mirror.offer(line('question', 7, 'Question: Old?', T0));
    assert.equal(r.spoken.length, 0);
    assert.equal(r.mirror.getState().phase, 'waiting_audio');
    r.advance(MIRROR_STALE_MS + 1);
    r.mirror.offer(line('option', 7, 'One: fresh.', r.now()));
    r.setAudio(true);
    r.mirror.kick();
    assert.deepEqual(r.texts(), ['line:One: fresh.'], 'a judge never hears a stale question');
  });

  test('a line cut by the audio stopping is said again from the start once the room voice runs', async () => {
    const r = room();
    r.mirror.offer(line('question', 7, 'Question: Tea?', r.now()));
    r.setAudio(false);
    r.spoken[0]!.resolve({ ok: false, reason: 'failed', message: 'The audio stopped before the end.' });
    await flush();
    assert.equal(r.mirror.getState().phase, 'waiting_audio');
    r.setAudio(true);
    r.mirror.kick();
    assert.deepEqual(r.texts(), ['line:Question: Tea?', 'line:Question: Tea?']);
    assert.equal(r.spoken[1]!.attempt, 1);
  });

  test('a failed line is tried once more on a fresh socket; a second failure shows and the next line goes on', async () => {
    const r = room();
    r.mirror.offer(line('question', 7, 'Question: Tea?'));
    r.mirror.offer(line('option', 7, 'One: yes.'));
    r.spoken[0]!.resolve({ ok: false, reason: 'failed', message: 'No audio arrived in time.' });
    await flush();
    assert.equal(r.spoken[1]!.attempt, 2);
    assert.equal(r.spoken[1]!.text, 'Question: Tea?');
    r.spoken[1]!.resolve({ ok: false, reason: 'failed', message: 'socket closed' });
    await flush();
    assert.equal(r.spoken[2]!.text, 'One: yes.', 'the queue does not stall');
    await r.finish();
    // The failure stays on screen until a line plays to the end; this one did.
    assert.equal(r.mirror.getState().phase, 'idle');

    const f = room();
    f.mirror.offer(line('question', 7, 'Question: Tea?'));
    f.spoken[0]!.resolve({ ok: false, reason: 'failed', message: 'x' });
    await flush();
    f.spoken[1]!.resolve({ ok: false, reason: 'failed', message: 'socket closed' });
    await flush();
    assert.equal(f.mirror.getState().phase, 'failed');
    assert.equal(f.mirror.getState().errorText, 'socket closed');
    assert.equal(buildMirrorView(f.mirror.getState(), true).line.text, MIRROR_TEXT.failed);
  });

  test('a pause drops everything; drop removes only what matches', async () => {
    const r = room();
    r.mirror.offer(line('question', 7, 'Question: Tea?'));
    r.mirror.offer(line('option', 7, 'One: yes.'));
    r.mirror.offer(line('readback', 7, 'Send it?'));
    r.mirror.drop((item) => item.kind === 'option');
    assert.equal(r.mirror.getState().queued, 1);
    r.mirror.clear();
    await flush();
    assert.equal(r.spoken[0]!.cancelled, true);
    assert.equal(r.mirror.getState().queued, 0);
    assert.equal(r.spoken.length, 1);
  });

  test('the page line says what the mirror needs or does', () => {
    const r = room({ audio: false });
    assert.equal(buildMirrorView(r.mirror.getState(), false).line.text, MIRROR_TEXT.needsAudio, 'Tap Start room voice');
    r.mirror.offer(line('question', 7, 'Question: Tea?'));
    assert.equal(buildMirrorView(r.mirror.getState(), false).line.text, MIRROR_TEXT.waitingAudio);
    const s = room();
    s.mirror.offer(line('readback', 7, 'Send a request. One: send it. Two: cancel.'));
    const speaking = buildMirrorView(s.mirror.getState(), true);
    assert.equal(speaking.line.text, MIRROR_TEXT.readback);
    assert.equal(speaking.words, '"Send a request. One: send it. Two: cancel."');
    assert.equal(buildMirrorView(room({ on: false }).mirror.getState(), true).line.text, MIRROR_TEXT.off);
    assert.equal(buildMirrorView(room({ sharing: false }).mirror.getState(), true).line.text, MIRROR_TEXT.noSharing);
  });

  test('phone numbers and keys are never said in the room', () => {
    assert.equal(roomSafeText('Call me at 415-555-0123 please'), 'Call me at a number please');
    assert.equal(roomSafeText('use sk_car_abcdef123456 now'), 'use a code now');
    assert.equal(
      mirrorReadbackText('errand', 'Text the care team at (510) 555 0100 for a ride.'),
      'Text the care team at a number for a ride. One: send it. Two: cancel.',
    );
    assert.equal(mirrorReadbackText('search', 'Search the web for ideas? One: yes. Two: cancel.'), 'Search the web for ideas? One: yes. Two: cancel.');
  });
});

// ---------- The rows: where each mirrored line comes from ----------

const SNAPSHOT = { event: { tag: 'SubscribeApplied' } };
const LIVE = { event: { tag: 'Reducer' } };

function fire(table: FakeTable<any>, kind: 'insert' | 'update', ...args: unknown[]) {
  for (const cb of [...table.listeners[kind]]) (cb as (...a: unknown[]) => void)(...args);
}

function scanRow(patch: Partial<{ questionId: bigint; version: number; phase: string; answerMode: string; cursor: number; stepSeq: bigint; optionStartSeq: bigint }>) {
  return {
    sessionId: 3n,
    questionId: patch.questionId ?? 7n,
    version: patch.version ?? 1,
    answerMode: { tag: patch.answerMode ?? 'Pick' },
    phase: { tag: patch.phase ?? 'Reading' },
    cursor: patch.cursor ?? 1,
    stepSeq: patch.stepSeq ?? 1n,
    optionStartSeq: patch.optionStartSeq ?? patch.stepSeq ?? 1n,
  };
}

const QUESTION_7 = {
  questionId: 7n,
  sessionId: 3n,
  origin: { tag: 'Partner' },
  textShared: true,
  text: 'Want some tea? Call 415-555-0123.',
  version: 1,
  parentQuestionId: 0n,
  options: [
    { rank: 1, label: 'Yes please, with milk.', shortLabel: 'Yes please', tone: 'warm' },
    { rank: 2, label: 'No thanks, I am fine.', shortLabel: 'No thanks', tone: 'calm' },
    { rank: 3, label: 'Search the web', shortLabel: 'Search the web', tone: '' },
  ],
};

function rowsHarness(options: { sharing?: boolean; inputMode?: string; paired?: boolean } = {}) {
  const t = {
    scanState: new FakeTable<any>(),
    config: new FakeTable<any>(),
    publicBoard: new FakeTable<any>(),
    boardErrands: new FakeTable<any>(),
    boardCalls: new FakeTable<any>(),
    boardSearches: new FakeTable<any>(),
  };
  t.config.rows = [{ activeSessionId: 3n, shareTextOnBoard: options.sharing ?? true, inputMode: { tag: options.inputMode ?? 'Direct' } }];
  const subs: FakeSubscription[] = [];
  const conn = {
    db: t,
    subscriptionBuilder() {
      const sub = new FakeSubscription();
      subs.push(sub);
      return sub;
    },
  } as unknown as MirrorConnLike;
  const offered: MirrorItem[] = [];
  const calls: string[] = [];
  let sharing: boolean | null = null;
  let problem: string | null = null;
  const mirror: Pick<SpeakerMirror, 'offer' | 'advance' | 'drop' | 'clear' | 'setSharing' | 'setProblem'> & { queue: MirrorItem[] } = {
    queue: offered,
    offer: (item) => void offered.push(item),
    advance: (id) => void calls.push(`advance:${id}`),
    drop: (match) => {
      calls.push('drop');
      for (let i = offered.length - 1; i >= 0; i--) if (match(offered[i]!)) offered.splice(i, 1);
    },
    clear: () => {
      calls.push('clear');
      offered.length = 0;
    },
    setSharing: (on) => {
      sharing = on;
    },
    setProblem: (text) => {
      problem = text;
    },
  };
  const detach = attachMirrorRows(conn, { mirror, now: () => T0, paired: () => options.paired ?? true }, ['public_board', 'board_errands']);
  return {
    t,
    subs,
    offered,
    calls,
    detach,
    texts: () => offered.map((o) => o.text),
    sharing: () => sharing,
    problem: () => problem,
    applyBoard: () => subs[0]!.applied?.(),
  };
}

describe('the rows the mirror reads', () => {
  test('the board views are their own subscription; an error there leaves the reply alone and shows on the page', () => {
    const h = rowsHarness();
    assert.equal(h.subs.length, 1);
    assert.deepEqual(h.subs[0]!.queries, ['public_board', 'board_errands']);
    h.subs[0]!.error?.({ event: new Error('no such view') });
    assert.equal(h.problem(), 'no such view');
    h.applyBoard();
    assert.equal(h.problem(), null);
    assert.equal(h.sharing(), true, 'sharing comes from config.share_text_on_board');
  });

  test('a snapshot never speaks; a new scanned question is said, then each option as it is read', () => {
    const h = rowsHarness();
    h.t.publicBoard.rows = [QUESTION_7];
    // The question that was current at connect is the starting point, never said.
    h.t.scanState.rows = [scanRow({ questionId: 6n, phase: 'Window', stepSeq: 40n })];
    fire(h.t.scanState, 'insert', SNAPSHOT, h.t.scanState.rows[0]);
    h.applyBoard();
    assert.equal(h.offered.length, 0);

    const preparing = scanRow({ questionId: 7n, phase: 'Preparing', stepSeq: 41n });
    fire(h.t.scanState, 'update', LIVE, h.t.scanState.rows[0], preparing);
    assert.deepEqual(h.texts(), ['Question: Want some tea? Call a number.']);
    assert.equal(h.offered[0]!.kind, 'question');
    assert.equal(h.offered[0]!.voice, 'assistant');
    assert.ok(h.calls.includes('advance:7'));

    fire(h.t.scanState, 'update', LIVE, preparing, scanRow({ cursor: 1, stepSeq: 42n }));
    fire(h.t.scanState, 'update', LIVE, preparing, scanRow({ cursor: 1, stepSeq: 42n }));
    fire(h.t.scanState, 'update', LIVE, preparing, scanRow({ cursor: 2, stepSeq: 43n }));
    fire(h.t.scanState, 'update', LIVE, preparing, scanRow({ cursor: 3, stepSeq: 44n }));
    assert.deepEqual(h.texts(), ['Question: Want some tea? Call a number.', 'One: Yes please.', 'Two: No thanks.', 'Three: Search the web.']);
    assert.equal(h.offered[1]!.voice, 'reply', 'options in the reply voice, as in the earpiece');
    assert.equal(h.offered[1]!.tone, 'warm');
    assert.equal(h.offered[1]!.key, 'read:3:42');
  });

  test('a yes or no read is "Yes or no?"; a version the board does not show yet is not guessed', () => {
    const h = rowsHarness();
    h.applyBoard();
    h.t.publicBoard.rows = [QUESTION_7];
    fire(h.t.scanState, 'update', LIVE, null, scanRow({ answerMode: 'YesNo', stepSeq: 5n }));
    fire(h.t.scanState, 'update', LIVE, null, scanRow({ version: 2, cursor: 1, stepSeq: 6n }));
    assert.deepEqual(h.texts(), ['Question: Want some tea? Call a number.', 'Yes or no?']);
  });

  test('no question under the scan fallback, for a follow-up turn, or for the person\'s own menu; options still are', () => {
    const scan = rowsHarness({ inputMode: 'Scan' });
    scan.applyBoard();
    scan.t.publicBoard.rows = [QUESTION_7];
    fire(scan.t.scanState, 'update', LIVE, null, scanRow({ stepSeq: 2n }));
    assert.deepEqual(scan.texts(), ['One: Yes please.']);

    const follow = rowsHarness();
    follow.applyBoard();
    follow.t.publicBoard.rows = [{ ...QUESTION_7, parentQuestionId: 6n }];
    fire(follow.t.scanState, 'update', LIVE, null, scanRow({ stepSeq: 2n }));
    assert.deepEqual(follow.texts(), ['One: Yes please.']);

    const menu = rowsHarness();
    menu.applyBoard();
    menu.t.publicBoard.rows = [{ ...QUESTION_7, origin: { tag: 'Menu' } }];
    fire(menu.t.scanState, 'update', LIVE, null, scanRow({ stepSeq: 2n }));
    assert.deepEqual(menu.texts(), ['One: Yes please.']);
  });

  test('with sharing off the board hides the words, so nothing is offered', () => {
    const h = rowsHarness({ sharing: false });
    h.applyBoard();
    h.t.publicBoard.rows = [{ ...QUESTION_7, textShared: false, text: 'Question 7' }];
    fire(h.t.scanState, 'update', LIVE, null, scanRow({ stepSeq: 2n }));
    assert.equal(h.offered.length, 0);
    assert.equal(h.sharing(), false);
  });

  test('nothing is offered before the board applies or before pairing', () => {
    const h = rowsHarness();
    h.t.publicBoard.rows = [QUESTION_7];
    fire(h.t.scanState, 'update', LIVE, null, scanRow({ stepSeq: 2n }));
    assert.equal(h.offered.length, 0, 'before the board applied');

    const p = rowsHarness({ paired: false });
    p.applyBoard();
    p.t.publicBoard.rows = [QUESTION_7];
    fire(p.t.scanState, 'update', LIVE, null, scanRow({ stepSeq: 2n }));
    assert.equal(p.offered.length, 0, 'before pairing');
  });

  test('Idle drops the queued options; a pause clears everything', () => {
    const h = rowsHarness();
    h.applyBoard();
    h.t.publicBoard.rows = [QUESTION_7];
    fire(h.t.scanState, 'update', LIVE, null, scanRow({ cursor: 1, stepSeq: 2n }));
    fire(h.t.scanState, 'update', LIVE, null, scanRow({ cursor: 2, stepSeq: 3n }));
    fire(h.t.scanState, 'update', LIVE, null, scanRow({ phase: 'Idle', stepSeq: 4n }));
    assert.deepEqual(h.texts(), ['Question: Want some tea? Call a number.']);
    fire(h.t.scanState, 'update', LIVE, null, scanRow({ phase: 'Paused', stepSeq: 5n }));
    assert.ok(h.calls.includes('clear'));
  });

  test('read-backs: an errand, a call and a search, each once, as the earpiece says them', () => {
    const h = rowsHarness();
    h.t.boardErrands.rows = [{ errandId: 1n, questionId: 5n, status: { tag: 'Previewed' }, textShared: true, readBackText: 'An old one.', previewDigest: 'aaaaaaaaaaaaaaaa' }];
    h.applyBoard();
    assert.equal(h.offered.length, 0, 'a read-back waiting at connect is never said');

    const errand = { errandId: 2n, questionId: 8n, status: { tag: 'Previewed' }, textShared: true, readBackText: 'Ask the care team for a ride at 1 PM.', previewDigest: '0123456789abcdef' };
    fire(h.t.boardErrands, 'insert', LIVE, errand);
    fire(h.t.boardErrands, 'update', LIVE, errand, errand);
    const call = { callId: 4n, questionId: 9n, status: { tag: 'Prepared' }, textShared: true, readBackText: 'Call Stephen to say the request was sent.', scriptDigest: 'd1' };
    fire(h.t.boardCalls, 'insert', LIVE, call);
    const search = { searchId: 6n, questionId: 10n, status: { tag: 'Prepared' }, readBackText: 'Search the web for ideas? One: yes. Two: cancel.', digest: 'fedcba9876543210' };
    fire(h.t.boardSearches, 'insert', LIVE, search);
    assert.deepEqual(h.texts(), [
      'Ask the care team for a ride at 1 PM. One: send it. Two: cancel.',
      'Call Stephen to say the request was sent. One: send it. Two: cancel.',
      'Search the web for ideas? One: yes. Two: cancel.',
    ]);
    assert.ok(h.offered.every((o) => o.kind === 'readback' && o.voice === 'assistant'));
    assert.equal(h.offered[0]!.questionId, 8n);

    // Moving on to the confirm keeps it; stopping drops a read-back not said yet.
    fire(h.t.boardErrands, 'update', LIVE, errand, { ...errand, status: { tag: 'AwaitingConfirm' } });
    assert.equal(h.offered.length, 3);
    fire(h.t.boardCalls, 'update', LIVE, call, { ...call, status: { tag: 'Stopped' } });
    assert.deepEqual(
      h.offered.map((o) => o.key),
      ['rb:errand:2:0123456789abcdef', 'rb:search:6:fedcba9876543210'],
    );
  });

  test('a read-back whose words are hidden (sharing off) is not offered', () => {
    const h = rowsHarness();
    h.applyBoard();
    fire(h.t.boardErrands, 'insert', LIVE, { errandId: 2n, questionId: 8n, status: { tag: 'Previewed' }, textShared: false, readBackText: '', previewDigest: '0123456789abcdef' });
    assert.equal(h.offered.length, 0);
  });

  test('every callback is removed on detach', () => {
    const h = rowsHarness();
    h.detach();
    for (const table of Object.values(h.t)) assert.equal(table.callbackCount(), 0);
  });
});

// ---------- The voice: lines through the same Cartesia player ----------

function voiceHarness() {
  const timers = fakeTimers();
  let now = T0;
  const context = { state: 'running' };
  const players: Array<{ closed: boolean; spoken: Array<{ transcript: string; kind: string; volume: number | undefined }> }> = [];
  const finishers: Array<(durationMs?: number) => void> = [];
  const out = {
    playing: false,
    refuse: false,
    enqueue() {
      if (this.refuse) throw new Error('InvalidStateError');
      this.playing = true;
    },
    stop() {
      this.playing = false;
    },
    positionMs: () => 0,
  };
  const makePlayer = (): PlayerLike => {
    const p = { closed: false, spoken: [] as Array<{ transcript: string; kind: string; volume: number | undefined }> };
    players.push(p);
    return {
      speak(u, opts) {
        p.spoken.push({ transcript: u.transcript, kind: u.kind, volume: u.generationConfig.volume });
        opts.onAudio?.(new Uint8Array(4));
        let resolve: (clip: any) => void = () => {};
        const done = new Promise<any>((res) => {
          resolve = res;
        });
        finishers.push((durationMs = 800) => resolve({ durationMs, words: [], pcm: new Uint8Array(4) }));
        return {
          done,
          cancel() {
            const error = new Error('Cancelled.');
            error.name = 'TtsCancelled';
            resolve(Promise.reject(error));
          },
        };
      },
      close() {
        p.closed = true;
      },
    };
  };
  const voice = createSpeakerVoice({
    getToken: async () => 'unused',
    context: () => context,
    volume: () => 1.6,
    makePlayer,
    makeOut: () => out as unknown as OutLike,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: () => now,
  });
  return {
    voice,
    out,
    players,
    timers,
    finishers,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('the room voice says the lines', () => {
  test('a line in the earpiece voices at the room volume', () => {
    const question = lineUtterance({ text: 'Question: Tea?', voice: 'assistant', tone: '' }, 1.6);
    assert.equal(question.kind, 'prompt');
    assert.equal(question.generationConfig.volume, 1.6);
    const option = lineUtterance({ text: 'One: yes please.', voice: 'reply', tone: 'warm' }, 9);
    assert.equal(option.kind, 'option');
    assert.equal(option.generationConfig.emotion, 'content');
    assert.equal(option.generationConfig.volume, 2, 'kept within 0.5 to 2');
    assert.equal(option.laugh, false);
    assert.notEqual(question.voiceId, option.voiceId);
  });

  test('a line never cuts the reply; the reply cuts a line', async () => {
    const h = voiceHarness();
    const replyJob = h.voice.say({ text: 'Yes please.', tone: 'warm', laugh: false }, 1);
    const refused = await h.voice.sayLine({ text: 'One: yes.', voice: 'reply', tone: '' }, 1).done;
    assert.deepEqual(refused, { ok: false, reason: 'stopped', message: 'The reply is being said.' });
    assert.equal(h.players[0]!.spoken.length, 1, 'the line never reached Cartesia');
    replyJob.cancel();
    await replyJob.done;
    await flush();

    const lineJob = h.voice.sayLine({ text: 'Question: Tea?', voice: 'assistant', tone: '' }, 1);
    h.voice.say({ text: 'Yes please.', tone: 'warm', laugh: false }, 1);
    const result = await lineJob.done;
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'stopped');
  });

  test('a chunk the output refused is a failure, never "said"', async () => {
    const h = voiceHarness();
    h.out.refuse = true;
    const j = h.voice.sayLine({ text: 'Question: Tea?', voice: 'assistant', tone: '' }, 1);
    h.finishers[0]!();
    const result = await j.done;
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.message : '', /could not play/);
  });

  test('a socket unused for two minutes is replaced before speaking', async () => {
    const h = voiceHarness();
    const first = h.voice.sayLine({ text: 'Question: Tea?', voice: 'assistant', tone: '' }, 1);
    h.finishers[0]!();
    h.out.playing = false;
    h.timers.advance(100);
    assert.equal((await first.done).ok, true);
    h.voice.sayLine({ text: 'One: yes.', voice: 'reply', tone: '' }, 1);
    assert.equal(h.players.length, 1, 'a warm socket is kept');
    h.advance(SOCKET_FRESH_AFTER_MS + 1);
    h.voice.sayLine({ text: 'Two: no.', voice: 'reply', tone: '' }, 1);
    assert.equal(h.players.length, 2);
    assert.equal(h.players[0]!.closed, true);
  });
});

// ---------- The audio: playing every time ----------

class SuspendingContext implements UnlockContextLike {
  state = 'suspended';
  currentTime = 0;
  destination = {};
  onstatechange: (() => void) | null = null;
  resumes = 0;
  refuse = false;
  async resume() {
    this.resumes++;
    if (this.refuse) throw new Error('NotAllowedError');
    this.state = 'running';
    this.onstatechange?.();
  }
  async suspend() {
    this.state = 'suspended';
    this.onstatechange?.();
  }
  async close() {
    this.state = 'closed';
  }
  browserSuspends() {
    this.state = 'suspended';
    this.onstatechange?.();
  }
  createOscillator() {
    return { type: 'sine', frequency: { setValueAtTime: () => {} }, connect: (to: unknown) => to, start: () => {}, stop: () => {} };
  }
  createGain() {
    return { gain: { setValueAtTime: () => {}, linearRampToValueAtTime: () => {} }, connect: (to: unknown) => to };
  }
}

describe('the room voice keeps its audio running', () => {
  test('after the first tap, a browser suspension is undone without a tap', async () => {
    let now = 0;
    const ctx = new SuspendingContext();
    const audio = createAudioUnlock({ createContext: () => ctx, navigator: null, tick: false, autoResume: true, now: () => now });
    audio.wake();
    assert.equal(ctx.resumes, 0, 'nothing before the first tap');
    await audio.start();
    assert.equal(audio.running(), true);
    now += 5_000;
    ctx.browserSuspends();
    await flush();
    assert.equal(ctx.resumes, 2, 'resumed by itself');
    assert.equal(audio.getState().state, 'running');
    assert.equal(audio.running(), true);
  });

  test('when the browser refuses, the page still asks for the tap', async () => {
    let now = 0;
    const ctx = new SuspendingContext();
    const audio = createAudioUnlock({ createContext: () => ctx, navigator: null, tick: false, autoResume: true, now: () => now });
    await audio.start();
    ctx.refuse = true;
    now += 5_000;
    ctx.browserSuspends();
    await flush();
    assert.equal(audio.getState().state, 'suspended');
    assert.equal(audio.running(), false);
  });

  test('the earpiece default does not resume by itself', async () => {
    const ctx = new SuspendingContext();
    const audio = createAudioUnlock({ createContext: () => ctx, navigator: null, tick: false });
    await audio.start();
    ctx.browserSuspends();
    await flush();
    assert.equal(ctx.resumes, 1);
    assert.equal(audio.getState().state, 'suspended');
  });

  test('a reply cut by the audio stopping waits for the tap, then is said again', async () => {
    let audio = true;
    const said: number[] = [];
    let resolveSay: (result: SayResult) => void = () => {};
    const engine = createSpeakerEngine({
      db: 'say-when-test',
      storage: memoryStorage(),
      now: () => T0,
      audioReady: () => audio,
      say: (_reply, attempt) => {
        said.push(attempt);
        return {
          done: new Promise<SayResult>((res) => {
            resolveSay = res;
          }),
          cancel() {},
        };
      },
      reportSpoken: async () => {},
      waitForLive: async () => true,
    });
    engine.offer(reply(7, 'Yes please.'), 'live');
    audio = false;
    resolveSay({ ok: false, reason: 'failed', message: 'The audio stopped before the end.' });
    await flush();
    assert.equal(engine.getState().phase, 'waiting_audio', 'not "Could not say the reply"');
    audio = true;
    engine.audioChanged();
    assert.deepEqual(said, [1, 1]);
    assert.equal(engine.getState().phase, 'speaking');
  });
});
