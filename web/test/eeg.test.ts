/** The headset page's pure parts: decoder frames (eeg-data/eeg/server.py) and the true or false quiz. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { changeColor, parseLiveFrame } from '../lib/eeg/live';
import { QUESTIONS, QUIZ_TIMING, onCommand, pickQuestions, score, secondsLeft, startQuiz, tick } from '../lib/eeg/quiz';

const frame = {
  type: 'eeg',
  t: 1,
  channels: [{ name: 'C3', x: -0.5, y: -0.09, change: -42.5, flat: false, noisy: false }, { name: 'C4', x: 0.5, y: -0.08, change: 3, flat: true, noisy: false }],
  hemispheres: { left: -40, right: 2 },
  activeHand: 'right',
  proba: { left: 0.1, right: 0.8, rest: 0.1 },
  status: 'RIGHT',
  jaw: 1.2,
  jawThreshold: 20,
  samplesPerSecond: 125,
};

describe('decoder frames on /eeg', () => {
  test('an eeg frame is read with its electrodes and bars', () => {
    const parsed = parseLiveFrame(JSON.stringify(frame));
    assert.equal(parsed.kind, 'eeg');
    if (parsed.kind !== 'eeg') return;
    assert.equal(parsed.frame.channels.length, 2);
    assert.equal(parsed.frame.channels[1].flat, true);
    assert.equal(parsed.frame.activeHand, 'right');
    assert.equal(parsed.frame.proba.right, 0.8);
  });

  test('bad values are clamped, an unknown hand is null', () => {
    const parsed = parseLiveFrame(JSON.stringify({ ...frame, activeHand: 'both', proba: { right: 7 }, channels: [{ name: 'C3', x: 9, y: 'a' }] }));
    assert.equal(parsed.kind, 'eeg');
    if (parsed.kind !== 'eeg') return;
    assert.equal(parsed.frame.activeHand, null);
    assert.equal(parsed.frame.proba.right, 1);
    assert.deepEqual([parsed.frame.channels[0].x, parsed.frame.channels[0].y], [1, 0]);
  });

  test('gesture and health still go through the station parser', () => {
    const g = parseLiveFrame(JSON.stringify({ type: 'gesture', id: '6f1c2b7e-9d1a-4c3e-8f00-1a2b3c4d5e6f', command: 'YES', onsetAgeMs: 900, confidence: 0.8, source: 'imagery' }));
    assert.equal(g.kind, 'gesture');
    assert.equal(parseLiveFrame(JSON.stringify({ type: 'health', decoderHealthy: true })).kind, 'health');
    assert.equal(parseLiveFrame('not json').kind, 'bad');
  });

  test('a drop is blue and a rise is red', () => {
    assert.match(changeColor(-40), /^rgba\(96, 160, 255/);
    assert.match(changeColor(40), /^rgba\(240, 120, 110/);
  });
});

describe('true or false quiz', () => {
  const t0 = 1_000_000;

  test('questions are half true and never three alike in a row', () => {
    for (let seed = 1; seed < 30; seed += 1) {
      let x = seed;
      const random = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
      const qs = pickQuestions(10, random);
      assert.equal(qs.length, 10);
      assert.equal(qs.filter((q) => q.answer).length, 5);
      for (let i = 2; i < qs.length; i += 1) assert.ok(!(qs[i].answer === qs[i - 1].answer && qs[i].answer === qs[i - 2].answer));
    }
    assert.ok(QUESTIONS.length >= 20);
  });

  test('YES is TRUE and NO is FALSE, and the first second does not count', () => {
    const q = startQuiz([{ text: 'Fire is hot.', answer: true }, { text: 'Ice is hot.', answer: false }], t0);
    assert.equal(onCommand(q, 'YES', 0.9, t0 + 500).phase, 'asking');
    const a = onCommand(q, 'YES', 0.9, t0 + 1_500);
    assert.equal(a.phase, 'result');
    assert.equal(a.results[0].correct, true);
    const b = tick(a, t0 + 1_500 + QUIZ_TIMING.resultMs);
    assert.equal(b.phase, 'asking');
    assert.equal(b.index, 1);
    const c = onCommand(b, 'YES', 0.7, b.askedAt + 2_000);
    assert.equal(c.results[1].said, true);
    assert.equal(c.results[1].correct, false);
    assert.equal(onCommand(b, 'CONFIRM', 1, b.askedAt + 2_000).phase, 'asking');
  });

  test('no answer in time counts as no answer, and the quiz ends', () => {
    const q = startQuiz([{ text: 'Grass is green.', answer: true }], t0);
    assert.equal(secondsLeft(q, t0), 11);
    const timedOut = tick(q, t0 + QUIZ_TIMING.graceMs + QUIZ_TIMING.answerMs);
    assert.equal(timedOut.results[0].said, null);
    const done = tick(timedOut, timedOut.shownAt + QUIZ_TIMING.resultMs);
    assert.equal(done.phase, 'done');
    assert.deepEqual(score(done), { right: 0, asked: 1, answered: 0 });
  });
});
