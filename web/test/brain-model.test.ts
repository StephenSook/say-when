/**
 * Screen 1's rules and words. The glow comes only from measured quieting at 8-12 Hz, a jaw clench pauses every brain
 * reading (it lights up the 20 to 30 Hz bands), a stale stream shows No signal, the stage stays quiet unless
 * something needs attention, and no word names a yes area.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  FAILED_TEST_DIM,
  HEADSET_OFF_HOLD_MS,
  LABELS,
  baselineText,
  buildBrainView,
  caption,
  eventPillText,
  guessText,
  headsetOffNow,
  modeBadge,
  nextBackoff,
  patchIntensity,
  patchTargets,
  pctText,
  sceneFailedText,
  shouldAutoConnect,
  type BrainInput,
} from '../lib/brain/model';
import type { VizMarker, VizMeta, VizMi } from '../lib/brain/protocol';

const MINUS = String.fromCharCode(0x2212);

function meta(over: Partial<VizMeta> = {}): VizMeta {
  return {
    type: 'viz.meta',
    v: 1,
    source: 'live',
    board: 'CYTON_BOARD',
    srate: 250,
    channels: ['C3', 'C4'],
    units: 'uV',
    traceFilter: 'bandpass 1-45 Hz causal + notch 60 Hz',
    bands: { alphaMu: [8, 12], beta: [13, 30] },
    baseline: { state: 'set', recordedAt: 1_000 },
    recordedAt: null,
    brainTest: { state: 'not_run', summary: null },
    note: null,
    filterBank: null,
    ...over,
  } as VizMeta;
}

function mi(over: Partial<VizMi> = {}): VizMi {
  return {
    type: 'viz.mi',
    t: 2_000,
    c3: { mu: -20, beta: -10 },
    c4: { mu: -2, beta: 1 },
    laterality: 18,
    emgGate: false,
    baselineAgeS: 30,
    emg: 3,
    emgThreshold: 40,
    fb: null,
    ...over,
  } as VizMi;
}

function input(over: Partial<BrainInput> = {}): BrainInput {
  return { connected: true, meta: meta(), mi: mi(), miAt: 10_000, lastAt: 10_000, now: 10_100, ...over };
}

describe('patch intensity', () => {
  test('only quieting glows, on one scale: 40% suppression is full brightness', () => {
    assert.equal(patchIntensity(0), 0);
    assert.equal(patchIntensity(25), 0, 'a rise in the rhythm never glows');
    assert.equal(patchIntensity(-20), 0.5);
    assert.equal(patchIntensity(-40), 1);
    assert.equal(patchIntensity(-90), 1);
    assert.equal(patchIntensity(Number.NaN), 0);
  });

  test('the glow reads the 8-12 Hz band when the filter bank is there', () => {
    const bank = [
      { id: 'b8_12', lo: 8, hi: 12, label: 'Mu 8-12 Hz' },
      { id: 'b20_26', lo: 20, hi: 26, label: 'Beta 20-26 Hz' },
    ];
    const targets = patchTargets(input({ meta: meta({ filterBank: bank } as Partial<VizMeta>), mi: mi({ fb: { c3: [-40, -5], c4: [0, 0] } } as Partial<VizMi>) }));
    assert.equal(targets.c3, 1);
    assert.equal(targets.c4, 0);
  });
});

describe('screen states', () => {
  test('measuring: each patch glows from its own number and the stage has no state line', () => {
    const view = buildBrainView(input());
    assert.equal(view.state, 'measuring');
    assert.equal(view.stateLine, null);
    assert.equal(view.c3.intensity, 0.5);
    assert.equal(view.c4.intensity, 0.05);
    assert.equal(view.c3.valueText, `${MINUS}20%`);
    assert.match(view.details.laterality ?? '', /^Left vs right difference \+18\.0$/);
  });

  test('a jaw clench (emgGate) sends both patches neutral and pauses every brain reading', () => {
    const view = buildBrainView(input({ mi: mi({ emgGate: true }) }));
    assert.equal(view.state, 'muscle');
    assert.deepEqual(view.stateLine, { status: 'stopped', text: 'Muscle detected. Brain readings paused.' });
    assert.equal(view.c3.intensity, 0);
    assert.equal(view.c4.intensity, 0);
    assert.equal(view.c3.value, null);
    assert.deepEqual(patchTargets(input({ mi: mi({ emgGate: true }) })), { c3: 0, c4: 0 });
  });

  test('no viz.mi for more than 500 ms is No signal, with the age in the tooltip, and values are cleared', () => {
    const view = buildBrainView(input({ miAt: 10_000, now: 10_800 }));
    assert.equal(view.state, 'no_signal');
    assert.deepEqual(view.stateLine, { status: 'failed', text: 'No signal', detail: 'No data for 800 ms' });
    assert.equal(view.c3.intensity, 0);
    assert.equal(view.c3.value, null);
    assert.equal(view.c3.valueText, 'no reading');
    assert.equal(buildBrainView(input({ mi: null, miAt: null })).stateLine?.detail, 'No data yet');
    assert.equal(buildBrainView(input({ miAt: 10_000, now: 10_500 })).state, 'measuring', '500 ms is still fresh');
  });

  test('without a rest baseline nothing glows and the stage offers to record one', () => {
    const none = buildBrainView(input({ meta: meta({ baseline: { state: 'none', recordedAt: null } }) }));
    assert.equal(none.state, 'baseline');
    assert.equal(none.needsBaseline, true);
    assert.equal(none.stateLine?.text, 'No rest baseline');
    assert.equal(none.c3.intensity, 0);
    const recording = buildBrainView(input({ meta: meta({ baseline: { state: 'recording', recordedAt: null } }) }));
    assert.deepEqual(recording.stateLine, { status: 'working', text: 'Recording rest baseline' });
    assert.equal(recording.needsBaseline, false);
  });

  test('a failed brain test dims the patches and says so in one line', () => {
    const view = buildBrainView(input({ meta: meta({ brainTest: { state: 'failed', summary: '11 of 20' } }) }));
    assert.equal(view.state, 'measuring');
    assert.deepEqual(view.stateLine, { status: 'refused', text: 'Brain test failed. YES is a jaw clench today.' });
    assert.equal(view.c3.intensity, 0.5 * FAILED_TEST_DIM);
    assert.equal(view.details.brainTest, 'Brain test failed: 11 of 20');
  });

  test('not connected waits, and the pill says there is no stream', () => {
    const view = buildBrainView(input({ connected: false }));
    assert.equal(view.state, 'waiting');
    assert.deepEqual(view.mode, { kind: 'none', text: 'No headset stream' });
    assert.equal(view.stateLine?.text, 'Waiting for the headset');
    assert.equal(view.details.brainTest, null);
  });
});

describe('mode pill', () => {
  test('live, replay and synthetic each say what they are; a replay is never called live', () => {
    assert.deepEqual(modeBadge(meta({ source: 'live' })), { kind: 'live', text: 'Live headset' });
    const replay = modeBadge(meta({ source: 'replay', recordedAt: 0 }));
    assert.equal(replay.kind, 'replay');
    assert.match(replay.text, /^Replay, recorded \d\d:\d\d$/);
    assert.doesNotMatch(replay.text, /live/i);
    assert.equal(modeBadge(meta({ source: 'replay', recordedAt: null })).text, 'Replay');
    assert.equal(modeBadge(meta({ source: 'synthetic' })).text, 'Synthetic test signal');
    assert.equal(modeBadge(null).kind, 'none');
  });
});

describe('words', () => {
  const marker = (over: Partial<VizMarker>): VizMarker => ({ type: 'viz.marker', t: 0, id: 'm', command: 'YES', confidence: 0.82, source: 'imagery', ...over });

  test('the guess pill is a guess with a confidence, never a claim about what the person thinks', () => {
    assert.equal(guessText(marker({})), 'Guess YES 0.82');
    assert.equal(guessText(marker({ command: 'NO', confidence: null })), 'Guess NO');
    assert.equal(guessText(marker({ command: 'CONFIRM', source: 'jaw', confidence: null })), 'Jaw CONFIRM');
    assert.equal(guessText(marker({ source: 'key' })), 'YES, key press');
    assert.equal(eventPillText(marker({ confidence: 0.7 })), 'YES 0.70');
    assert.equal(eventPillText(marker({ command: 'STOP', source: 'jaw', confidence: null })), 'STOP');
  });

  test('the words are short, use 8-12 Hz everywhere, and never name a yes area', () => {
    const all = [...Object.values(LABELS), caption(null), caption('Shashank')].join('\n');
    assert.match(LABELS.explain, /No yes area in the brain\./);
    assert.match(LABELS.subtitle, /8-12 Hz/);
    assert.doesNotMatch(all, /8 to 13|8-13/);
    const claims = all.replace('No yes area in the brain.', '');
    assert.doesNotMatch(claims, /yes area|no area|lights up|activated|brain power|\bfocus\b|\bcalm\b|\bmind\b|\bthinks?\b/i);
    assert.equal(caption(null), 'Template brain, not a scan.');
    assert.ok(LABELS.subtitle.length <= 80, 'the subtitle fits one line');
  });

  test('numbers and baseline lines', () => {
    assert.equal(pctText(-23.4), `${MINUS}23%`);
    assert.equal(pctText(4.6), '+5%');
    assert.equal(pctText(0.2), '0%');
    assert.equal(baselineText('none', null), 'No rest baseline');
    assert.match(baselineText('set', 0), /^Rest baseline recorded \d\d:\d\d$/);
  });

  test('reconnect backoff: 250 ms, doubling, capped at 2 s', () => {
    const seq: number[] = [];
    let d: number | null = null;
    for (let i = 0; i < 6; i++) seq.push((d = nextBackoff(d)));
    assert.deepEqual(seq, [250, 500, 1000, 2000, 2000, 2000]);
  });
});

describe('headset and contact', () => {
  test('HEADSET_OFF from the decoder shows even while frames keep coming, and nothing glows', () => {
    const view = buildBrainView(input({ headsetOff: true }));
    assert.equal(view.state, 'headset_off');
    assert.deepEqual(view.stateLine, { status: 'failed', text: 'Headset off. Nothing will be sent.' });
    assert.deepEqual(patchTargets(input({ headsetOff: true })), { c3: 0, c4: 0 });
  });

  test('headsetOffNow: a recent HEADSET_OFF marker, or both C3 and C4 off', () => {
    const off: VizMarker = { type: 'viz.marker', t: 0, id: 'h', command: 'HEADSET_OFF', confidence: null, source: 'jaw' };
    const yes: VizMarker = { ...off, id: 'y', command: 'YES', source: 'imagery', confidence: 0.8 };
    assert.equal(headsetOffNow([off], [1_000], null, 2_000), true);
    assert.equal(headsetOffNow([off], [1_000], null, 1_000 + HEADSET_OFF_HOLD_MS + 1), false);
    assert.equal(headsetOffNow([off, yes], [1_000, 1_500], null, 2_000), false, 'a newer command means it is back');
    assert.equal(headsetOffNow([], [], { C3: 'off', C4: 'off' }, 0), true);
    assert.equal(headsetOffNow([], [], { C3: 'off', C4: 'good' }, 0), false);
  });

  test('an electrode with no contact never glows and says so', () => {
    const view = buildBrainView(input({ contact: { C3: 'off', C4: 'good' } }));
    assert.equal(view.c3.valueText, 'no contact');
    assert.equal(view.c3.intensity, 0);
    assert.equal(view.c4.value, -2);
    assert.equal(patchTargets(input({ contact: { C3: 'off', C4: 'good' } })).c3, 0);
  });
});

describe('connecting and labels by source', () => {
  test('the page connects by itself only on the EEG laptop or with ?bridge=1', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]', 'eeg.localhost', 'LOCALHOST']) assert.equal(shouldAutoConnect(host, ''), true, host);
    for (const host of ['eleven-calhacks.vercel.app', 'neurolingo-web.vercel.app', '192.168.1.5', 'example.com']) assert.equal(shouldAutoConnect(host, ''), false, host);
    assert.equal(shouldAutoConnect('eleven-calhacks.vercel.app', '?bridge=1'), true);
    assert.equal(shouldAutoConnect('eleven-calhacks.vercel.app', '?bridge=0'), false);
  });

  test('before Connect the stage says the decoder is not connected and offers Connect, with nothing glowing', () => {
    const view = buildBrainView(input({ idle: true, connected: false, meta: null, mi: null, miAt: null, lastAt: null }));
    assert.equal(view.state, 'idle');
    assert.equal(view.canConnect, true);
    assert.deepEqual(view.stateLine, { status: 'stopped', text: "Decoder not connected. This view reads the EEG laptop's local decoder." });
    assert.deepEqual(patchTargets(input({ idle: true })), { c3: 0, c4: 0 });
    assert.equal(buildBrainView(input()).canConnect, false);
  });

  test('the title never says live, and the 3D fallback says where the readings come from', () => {
    assert.equal(LABELS.title, 'Brain');
    assert.equal(sceneFailedText('synthetic'), '3D view unavailable. Readings below are a synthetic test signal.');
    assert.equal(sceneFailedText('replay'), '3D view unavailable. Readings below are from a recording.');
    assert.equal(sceneFailedText('live'), '3D view unavailable. Readings below are from the headset.');
    assert.equal(sceneFailedText(null), '3D view unavailable.');
    assert.equal(LABELS.synthetic, 'Synthetic test signal, not a measurement');
    for (const text of [LABELS.title, sceneFailedText('synthetic'), sceneFailedText('replay'), sceneFailedText(null)]) assert.doesNotMatch(text, /live/i);
  });
});
