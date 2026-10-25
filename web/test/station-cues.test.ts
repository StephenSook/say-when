/**
 * Cues (lib/station/cues.ts, docs/station.md 2.13, 2.14 and 7.3 A8): every cue kind maps to its sentence or chime,
 * the mode's variants, mid-scan cues are chimes, `say_confirm` is dropped during a read-back, a safety cue cuts an
 * option and a read-back, and an info sentence waits for the earpiece and is dropped after 3 s.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { cueAction, CueSpeaker, type CueContext } from '../lib/station/cues';
import { Channel, type ClipLike } from '../lib/station/earpiece';
import { NUMBER_WORDS, optionEarText, PHRASES, phraseText, warmPhraseKeys, type PhraseKey } from '../lib/station/phrases';
import { fakeTimers, flush } from './role-fakes';

const ctx = (patch: Partial<CueContext> = {}): CueContext => ({ mode: 'headset', phase: 'idle', readbackActive: false, errandReason: '', callReason: '', ...patch });
const cue = (kind: string, reason = '', callId = 0n) => ({ kind, reason, callId });

describe('what each cue says', () => {
  test('pauses are safety sentences, by reason and input mode', () => {
    assert.deepEqual(cueAction(cue('paused', 'stop'), ctx()), { type: 'safety', phrase: 'paused' });
    assert.deepEqual(cueAction(cue('paused', 'idle'), ctx()), { type: 'safety', phrase: 'pausedIdle' });
    assert.deepEqual(cueAction(cue('paused', 'operator'), ctx()), { type: 'safety', phrase: 'pausedHelper' });
    assert.deepEqual(cueAction(cue('paused', 'headset_lost'), ctx()), { type: 'safety', phrase: 'signalLost' });
    assert.deepEqual(cueAction(cue('paused', 'headset_off'), ctx({ mode: 'headset' })), { type: 'safety', phrase: 'headsetOff' });
    assert.deepEqual(cueAction(cue('paused', 'headset_off'), ctx({ mode: 'keyboard' })), { type: 'safety', phrase: 'inputOff' });
    assert.deepEqual(cueAction(cue('paused', 'headset_off'), ctx({ mode: 'switch' })), { type: 'safety', phrase: 'inputOff' });
    assert.deepEqual(cueAction(cue('call_cancelling'), ctx()), { type: 'safety', phrase: 'hangingUp' });
    assert.deepEqual(cueAction(cue('too_late'), ctx()), { type: 'safety', phrase: 'tooLate' });
  });

  test('mid-scan cues are chimes; the same cue while idle is a sentence', () => {
    assert.deepEqual(cueAction(cue('resumed'), ctx({ phase: 'reading' })), { type: 'chime', chime: 'on' });
    assert.deepEqual(cueAction(cue('resumed'), ctx({ phase: 'idle' })), { type: 'info', phrase: 'resumed' });
    assert.deepEqual(cueAction(cue('veto_cancelled'), ctx({ phase: 'reading' })), { type: 'chime', chime: 'off' });
    assert.deepEqual(cueAction(cue('veto_cancelled'), ctx({ phase: 'idle' })), { type: 'info', phrase: 'cancelled' });
    for (const kind of ['again', 'more_options', 'menu_open']) assert.deepEqual(cueAction(cue(kind), ctx({ phase: 'reading' })), { type: 'chime', chime: 'on' });
    assert.deepEqual(cueAction(cue('picked'), ctx({ phase: 'veto' })), { type: 'chime', chime: 'counted' });
    assert.deepEqual(cueAction(cue('reply_released'), ctx()), { type: 'none' });
  });

  test('scan endings, errands and calls', () => {
    const expect: Array<[string, string, bigint, PhraseKey]> = [
      ['none', '', 0n, 'noneOfThese'],
      ['no_pick', '', 0n, 'noPick'],
      ['not_ready', '', 0n, 'oneMoment'],
      ['confirmed', '', 0n, 'confirmed'],
      ['errand_preparing', '', 0n, 'preparing'],
      ['errand_sent', '', 0n, 'sent'],
      ['errand_unknown', 'lease_lapsed', 0n, 'unknownOutcome'],
      ['not_sent', 'window_closed', 0n, 'windowClosed'],
      ['not_sent', 'readback_not_finished', 0n, 'readbackLate'],
      ['not_sent', 'no', 0n, 'notSent'],
      ['not_sent', 'no', 4n, 'noCall'],
      ['call_ended', 'hung_up', 4n, 'callEnded'],
      ['question_waiting', '', 0n, 'questionWaiting'],
      ['failed', 'planner_error', 0n, 'noOptions'],
    ];
    for (const [kind, reason, callId, phrase] of expect) assert.deepEqual(cueAction(cue(kind, reason, callId), ctx()), { type: 'info', phrase }, kind);
  });

  test('say_confirm is dropped during a read-back, whose own last sentence says how to confirm', () => {
    assert.deepEqual(cueAction(cue('say_confirm'), ctx({ readbackActive: true })), { type: 'none' });
    assert.deepEqual(cueAction(cue('say_confirm'), ctx()), { type: 'info', phrase: 'sayConfirm' });
  });

  test('refusals say the row reason when it has one', () => {
    assert.deepEqual(cueAction(cue('errand_refused'), ctx({ errandReason: 'That form needs a login. Nothing was sent.' })), {
      type: 'info_text',
      text: 'That form needs a login. Nothing was sent.',
      fallback: 'notSent',
    });
    assert.deepEqual(cueAction(cue('errand_failed'), ctx()), { type: 'info', phrase: 'notSent' });
    assert.deepEqual(cueAction(cue('call_refused'), ctx()), { type: 'info', phrase: 'noCall' });
  });

  test('an unknown cue kind says nothing', () => {
    assert.deepEqual(cueAction(cue('something_new'), ctx()), { type: 'none' });
  });

  test('the two-option confirm in every mode (D18), and the 34 clips cached at start', () => {
    for (const mode of ['headset', 'keyboard', 'switch'] as const) {
      assert.equal(phraseText('confirmTail', mode), 'One: send it. Two: cancel.');
      assert.equal(phraseText('sayConfirm', mode), 'That needs a confirm. One: send it. Two: cancel.');
      assert.equal(phraseText('tooSoon', mode), 'Too soon. Wait a moment. One: send it. Two: cancel.');
    }
    for (const words of Object.values(PHRASES)) assert.ok(!/\{act\}|clench once|press C|YES|CONFIRM/.test(words), words);
    for (const mode of ['headset', 'keyboard', 'switch'] as const) {
      const keys = warmPhraseKeys(mode);
      assert.equal(keys.length + 4, 34, mode);
      assert.ok(!keys.includes('confirmTail'));
      assert.equal(keys.includes('headsetOff'), mode === 'headset');
      assert.equal(keys.includes('inputOff'), mode !== 'headset');
    }
    for (const words of Object.values(PHRASES)) assert.ok(!/thought|mind/i.test(words));
  });
});

class FakeOut {
  plays: string[] = [];
  stops = 0;
  private resolve: ((how: 'ended' | 'stopped') => void) | null = null;
  play(c: ClipLike & { name: string }) {
    this.resolve?.('stopped');
    this.plays.push(c.name);
    return new Promise<'ended' | 'stopped'>((resolve) => (this.resolve = resolve));
  }
  stop() {
    this.stops++;
    this.resolve?.('stopped');
    this.resolve = null;
  }
  end() {
    this.resolve?.('ended');
    this.resolve = null;
  }
  positionMs() {
    return 0;
  }
}

type Named = ClipLike & { name: string };
const named = (name: string): Named => ({ name, durationMs: 800, totalMs: 100, words: [] });

function harness() {
  const clock = fakeTimers(0);
  const optionsOut = new FakeOut();
  const promptsOut = new FakeOut();
  const options = new Channel<Named>(optionsOut);
  const prompts = new Channel<Named>(promptsOut);
  let readbackStops = 0;
  let optionStops = 0;
  const chimes: string[] = [];
  const speaker = new CueSpeaker<Named>({
    now: clock.now,
    phrase: async (key) => named(key),
    text: async (text) => named(text),
    options,
    prompts,
    chime: (c) => chimes.push(c),
    stopReadback: () => readbackStops++,
    stopOptions: () => optionStops++,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, optionsOut, promptsOut, options, prompts, speaker, chimes, readbackStops: () => readbackStops, optionStops: () => optionStops };
}

describe('web search cues (D18)', () => {
  const ctx: CueContext = { mode: 'headset', phase: 'idle', readbackActive: false, errandReason: '', callReason: '' };
  test('the search read-back cue adds nothing (the station reads it); a refused search says Not sent', () => {
    assert.deepEqual(cueAction({ kind: 'search_readback', reason: '', callId: 0n }, ctx), { type: 'none' });
    assert.deepEqual(cueAction({ kind: 'search_refused', reason: 'no_consent', callId: 0n }, ctx), { type: 'info', phrase: 'notSent' });
  });
});

describe('the numbered earpiece list (D18)', () => {
  test('each option is its number, then its short label: "One: good."', () => {
    assert.deepEqual(NUMBER_WORDS, ['One', 'Two', 'Three', 'Four']);
    assert.equal(optionEarText(1, 'good', "I'm doing awesome, how about you?"), 'One: good.');
    assert.equal(optionEarText(2, 'Not great', 'Honestly, not great today.'), 'Two: Not great.');
    assert.equal(optionEarText(3, 'Search the web', 'Search the web for ideas'), 'Three: Search the web.');
    assert.equal(optionEarText(4, 'Something else.', 'Something else'), 'Four: Something else.', 'one period, never two');
  });

  test('an empty label reads the text; an odd rank reads the words alone', () => {
    assert.equal(optionEarText(1, '', 'Tea please!'), 'One: Tea please.');
    assert.equal(optionEarText(2, '   ', 'Coffee'), 'Two: Coffee.');
    assert.equal(optionEarText(5, 'Later', 'Later'), 'Later.');
    assert.equal(optionEarText(1, '', ''), 'One.');
  });

  test('the four options read in order make the list the person hears', () => {
    const list = [
      ['good', 'Doing awesome, how about you?'],
      ['not great', 'Not great today.'],
      ['tired', "I'm a bit tired."],
      ['busy', 'Busy, talk later?'],
    ].map(([label, text], i) => optionEarText(i + 1, label!, text!));
    assert.equal(list.join(' '), 'One: good. Two: not great. Three: tired. Four: busy.');
  });
});

describe('cue priorities', () => {
  test('a safety cue cuts an option and a read-back, then speaks', async () => {
    const h = harness();
    void h.options.play(named('option 2'), 'option');
    h.speaker.handle({ type: 'safety', phrase: 'paused' });
    assert.equal(h.optionsOut.stops, 1);
    assert.equal(h.readbackStops(), 1);
    assert.equal(h.optionStops(), 1);
    await flush();
    assert.deepEqual(h.promptsOut.plays, ['paused']);

    const r = harness();
    void r.options.play(named('read-back'), 'readback');
    r.speaker.handle({ type: 'safety', phrase: 'signalLost' });
    assert.equal(r.optionsOut.stops, 1);
    await flush();
    assert.deepEqual(r.promptsOut.plays, ['signalLost']);
  });

  test('an info sentence waits for the options channel, then plays', async () => {
    const h = harness();
    void h.options.play(named('read-back'), 'readback');
    h.speaker.handle({ type: 'info', phrase: 'preparing' });
    await flush();
    assert.deepEqual(h.promptsOut.plays, []);
    h.optionsOut.end();
    await flush();
    h.clock.advance(100);
    await flush();
    assert.deepEqual(h.promptsOut.plays, ['preparing']);
  });

  test('an info sentence older than 3 s when the earpiece frees up is dropped', async () => {
    const h = harness();
    void h.options.play(named('option 1'), 'option');
    h.speaker.handle({ type: 'info', phrase: 'questionWaiting' });
    h.clock.advance(3_100);
    h.optionsOut.end();
    await flush();
    h.clock.advance(100);
    await flush();
    assert.deepEqual(h.promptsOut.plays, []);
    assert.equal(h.speaker.waiting(), 0);
  });

  test('two info sentences play one after the other, never cutting each other', async () => {
    const h = harness();
    h.speaker.handle({ type: 'info', phrase: 'confirmed' });
    h.speaker.handle({ type: 'info', phrase: 'sent' });
    await flush();
    assert.deepEqual(h.promptsOut.plays, ['confirmed']);
    h.promptsOut.end();
    await flush();
    await flush();
    assert.deepEqual(h.promptsOut.plays, ['confirmed', 'sent']);
  });

  test('chimes play at once, even over speech', () => {
    const h = harness();
    void h.options.play(named('option 1'), 'option');
    h.speaker.handle({ type: 'chime', chime: 'counted' });
    assert.deepEqual(h.chimes, ['counted']);
    assert.equal(h.optionsOut.stops, 0);
  });

  test('a safety cue clears waiting info sentences', async () => {
    const h = harness();
    void h.options.play(named('option 1'), 'option');
    h.speaker.handle({ type: 'info', phrase: 'questionWaiting' });
    h.speaker.handle({ type: 'safety', phrase: 'paused' });
    await flush();
    h.clock.advance(500);
    await flush();
    assert.deepEqual(h.promptsOut.plays, ['paused']);
  });
});
