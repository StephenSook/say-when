/**
 * The partner's question in the earpiece (lib/station/question.ts, Stephen Oct 25: "when Deem is speaking, Shashank
 * should be able to hear the question"): the words said ("Question: ...", no phone numbers, keys or tokens, about 200
 * characters), which questions are said (a new partner question; not the menu, not a follow-up turn, not the question
 * current when the page took the session), and the reader's hand-off to the earpiece with a fake voice and fake timers.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ClipLike } from '../lib/station/earpiece';
import {
  isFollowUp,
  QUESTION_MAX_CHARS,
  QUESTION_MAX_WAIT_MS,
  QUESTION_POLL_MS,
  questionEarText,
  QuestionReader,
  spokenQuestionText,
  type QuestionPlay,
  type SessionQuestion,
} from '../lib/station/question';
import { flush } from './role-fakes';

interface FakeClip extends ClipLike {
  name: string;
}

function q(questionId: bigint, text: string, patch: Partial<SessionQuestion> = {}): SessionQuestion {
  return { questionId, text, origin: 'partner', lastGestureOutcome: '', ...patch };
}

describe('the words the earpiece says', () => {
  test('"Question:" and then the partner words; nothing for no words', () => {
    assert.equal(questionEarText('Want some tea?'), 'Question: Want some tea?');
    assert.equal(questionEarText('   '), '');
    assert.equal(questionEarText('[laughs]'), '', 'markup alone is no words');
  });

  test('a phone number, a key or a token is never said; times and small numbers stay', () => {
    assert.equal(spokenQuestionText('Should I call (510) 555-0100 now?'), 'Should I call a number now?');
    assert.equal(spokenQuestionText('Is sk_car_abc123XYZ the key?'), 'Is a code the key?');
    assert.equal(spokenQuestionText('Open https://x.test/?access_token=abc123 please'), 'Open a code please');
    assert.equal(spokenQuestionText('Meet at 3 or at 4:30 pm?'), 'Meet at 3 or at 4:30 pm?');
  });

  test('speech markup in the words is dropped, so a partner cannot add pauses or spelled codes', () => {
    assert.equal(spokenQuestionText('Say <break time="1s"/> hi [laughs]'), 'Say hi');
  });

  test('long words are cut at a word to about 200 characters', () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    const said = spokenQuestionText(long);
    assert.ok(said.length <= QUESTION_MAX_CHARS && said.length > QUESTION_MAX_CHARS - 10, `${said.length} characters`);
    assert.ok(long.startsWith(`${said} `), 'ends on a whole word');
  });

  test('a follow-up turn has the words of the question before it and follows a search confirm or a category pick', () => {
    const text = 'Anything you want to do today?';
    assert.equal(isFollowUp({ text, lastGestureOutcome: 'accepted:confirm_search' }, text), true);
    assert.equal(isFollowUp({ text, lastGestureOutcome: 'accepted:pick_category' }, text), true);
    assert.equal(isFollowUp({ text, lastGestureOutcome: 'accepted:pick_reply' }, text), false, 'the partner asked it again');
    assert.equal(isFollowUp({ text: 'Something else?', lastGestureOutcome: 'accepted:confirm_search' }, text), false);
  });
});

function reader(options: { enabled?: () => boolean; ready?: () => boolean } = {}) {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map<number, () => void>();
  const spoken: string[] = [];
  const jobs: Array<{ text: string; resolve: (c: FakeClip) => void; reject: (e: Error) => void; cancelled: boolean }> = [];
  const plays: Array<{ questionId: bigint; clip: string }> = [];
  const errors: unknown[] = [];
  let answer: QuestionPlay = 'played';
  const r = new QuestionReader<FakeClip>({
    now: () => now,
    enabled: options.enabled ?? (() => true),
    ...(options.ready ? { ready: options.ready } : {}),
    synth: (text) => {
      spoken.push(text);
      const job = { text, resolve: (_c: FakeClip) => {}, reject: (_e: Error) => {}, cancelled: false };
      const done = new Promise<FakeClip>((resolve, reject) => {
        job.resolve = resolve;
        job.reject = reject;
      });
      jobs.push(job);
      return {
        done,
        cancel: () => {
          job.cancelled = true;
          const error = new Error('Cancelled.');
          error.name = 'TtsCancelled';
          job.reject(error);
        },
      };
    },
    play: (questionId, clip) => {
      plays.push({ questionId, clip: clip.name });
      return answer;
    },
    onVoiceError: (error) => errors.push(error),
    setTimer: (callback) => {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (handle) => void timers.delete(handle as number),
  });
  const voiced = async (index: number) => {
    const job = jobs[index]!;
    job.resolve({ name: job.text, durationMs: 2_000, totalMs: 300, words: [] });
    await flush();
  };
  const tick = (ms: number) => {
    now += ms;
    const due = [...timers.entries()];
    timers.clear();
    for (const [, callback] of due) callback();
  };
  return { r, spoken, jobs, plays, errors, voiced, tick, timers, setAnswer: (a: QuestionPlay) => (answer = a) };
}

describe('which questions are said', () => {
  test('a new partner question is voiced once and handed to the earpiece', async () => {
    const h = reader();
    h.r.begin(null);
    h.r.update(q(7n, 'Want some tea?'));
    assert.deepEqual(h.spoken, ['Question: Want some tea?']);
    assert.equal(h.r.busyWith(), 7n);
    await h.voiced(0);
    assert.deepEqual(h.plays, [{ questionId: 7n, clip: 'Question: Want some tea?' }]);
    assert.equal(h.r.busyWith(), null);
    h.r.update(q(7n, 'Want some tea?'));
    assert.equal(h.spoken.length, 1, 'the same question is said once');
  });

  test('not the menu, not a follow-up turn, and not the question current when this page took the session', () => {
    const h = reader();
    h.r.begin(q(5n, 'Asked before the reload'));
    h.r.update(q(5n, 'Asked before the reload'));
    h.r.update(q(6n, 'I need something', { origin: 'menu' }));
    assert.deepEqual(h.spoken, []);
    h.r.update(q(7n, 'Anything to do today?'));
    h.r.update(q(8n, 'Anything to do today?', { lastGestureOutcome: 'accepted:confirm_search' }));
    h.r.update(q(9n, 'Anything to do today?', { lastGestureOutcome: 'accepted:pick_category' }));
    assert.deepEqual(h.spoken, ['Question: Anything to do today?'], 'the categories and search turns are not the partner asking');
    h.r.update(q(10n, 'Anything to do today?', { lastGestureOutcome: 'accepted:pick_reply' }));
    assert.equal(h.spoken.length, 2, 'the partner asking the same words again is said again');
    h.r.update(q(0n, ''));
    assert.equal(h.spoken.length, 2, 'no question: nothing');
  });

  test('a newer question replaces one still being voiced, with no voice error', async () => {
    const h = reader();
    h.r.update(q(7n, 'First?'));
    h.r.update(q(8n, 'Second?'));
    assert.equal(h.jobs[0]!.cancelled, true);
    await flush();
    await h.voiced(1);
    assert.deepEqual(h.plays, [{ questionId: 8n, clip: 'Question: Second?' }]);
    assert.deepEqual(h.errors, []);
  });

  test('off, without a voice, or with a failed synthesis: nothing plays, and a failure is a voice error', async () => {
    const off = reader({ enabled: () => false });
    off.r.update(q(7n, 'Tea?'));
    assert.deepEqual(off.spoken, []);
    const noVoice = reader({ ready: () => false });
    noVoice.r.update(q(7n, 'Tea?'));
    assert.deepEqual(noVoice.spoken, []);
    const failing = reader();
    failing.r.update(q(7n, 'Tea?'));
    failing.jobs[0]!.reject(new Error('credits'));
    await flush();
    assert.equal(failing.errors.length, 1);
    assert.deepEqual(failing.plays, []);
    assert.equal(failing.r.busyWith(), null);
  });
});

describe('handing the clip to the earpiece', () => {
  test('while the earpiece is busy it asks again every 100 ms, then plays', async () => {
    const h = reader();
    h.setAnswer('wait');
    h.r.update(q(7n, 'Tea?'));
    await h.voiced(0);
    assert.equal(h.plays.length, 1);
    assert.equal(h.timers.size, 1);
    h.tick(QUESTION_POLL_MS);
    assert.equal(h.plays.length, 2);
    h.setAnswer('played');
    h.tick(QUESTION_POLL_MS);
    assert.equal(h.plays.length, 3);
    assert.equal(h.timers.size, 0);
    assert.equal(h.r.busyWith(), null);
  });

  test('it gives up after 4 s of waiting, and when it is too late it is not asked again', async () => {
    const h = reader();
    h.setAnswer('wait');
    h.r.update(q(7n, 'Tea?'));
    await h.voiced(0);
    h.tick(QUESTION_MAX_WAIT_MS);
    assert.equal(h.plays.length, 2);
    assert.equal(h.timers.size, 0, 'waited long enough: dropped');
    assert.equal(h.r.busyWith(), null);

    const late = reader();
    late.setAnswer('late');
    late.r.update(q(7n, 'Tea?'));
    await late.voiced(0);
    assert.equal(late.plays.length, 1);
    assert.equal(late.timers.size, 0);
  });

  test('turned off while it waits: dropped without playing', async () => {
    let on = true;
    const h = reader({ enabled: () => on });
    h.setAnswer('wait');
    h.r.update(q(7n, 'Tea?'));
    await h.voiced(0);
    on = false;
    h.tick(QUESTION_POLL_MS);
    assert.equal(h.plays.length, 1);
    assert.equal(h.r.busyWith(), null);
  });
});
