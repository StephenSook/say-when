/**
 * The Screen 1 stream: message validation (unknown types ignored, bad numbers rejected), the optional filter bank, the
 * client state, and the reconnect rule, with a fake socket and fake timers.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_VIZ_URL, MAX_FILTER_BANDS, glowErd, parseVizMessage, type VizMeta, type VizMi } from '../lib/brain/protocol';
import { HISTORY, MAX_MARKERS, VizStream, applyFrame, emptyState, resetState, type StreamDeps } from '../lib/brain/stream';

const META = {
  type: 'viz.meta',
  v: 1,
  source: 'synthetic',
  board: 'SYNTHETIC_BOARD',
  srate: 250,
  channels: ['C3', 'C4'],
  units: 'uV',
  traceFilter: 'none (synthetic)',
  bands: { alpha_mu: [8, 13], beta: [13, 30] },
  baseline: { state: 'set', recordedAt: 1700000000.5 },
  recordedAt: null,
  brainTest: { state: 'not_run', summary: null },
  note: 'Scripted imagery cycle for UI testing. Not a measurement.',
};
const MI = { type: 'viz.mi', t: 1700000001, c3: { mu: -23.1, beta: -12 }, c4: { mu: -4.2, beta: -3 }, laterality: 18.9, emgGate: false, baselineAgeS: 42, emg: 3.1, emgThreshold: 40 };
const s = (o: unknown) => JSON.stringify(o);

/** The six bands the synthetic bridge sends, in its order. */
const FILTER_BANK = [
  { id: 'mrcp', lo: 0.05, hi: 5, label: 'Slow potential 0.05-5 Hz' },
  { id: 'b8_12', lo: 8, hi: 12, label: 'Mu 8-12 Hz' },
  { id: 'b12_16', lo: 12, hi: 16, label: 'Low beta 12-16 Hz' },
  { id: 'b16_20', lo: 16, hi: 20, label: 'Beta 16-20 Hz' },
  { id: 'b20_26', lo: 20, hi: 26, label: 'Beta 20-26 Hz' },
  { id: 'b26_30', lo: 26, hi: 30, label: 'High beta 26-30 Hz' },
];
const META_FB = { ...META, bands: { alpha_mu: [8, 12], beta: [12, 30] }, filterBank: FILTER_BANK };
const FB = { c3: [24.1, -29.7, -23, -15.2, -10.9, -6.8], c4: [0.4, -0.3, -1.1, null, 0.2, 0.9] };
const MI_FB = { ...MI, c3: { mu: -29.7, beta: -14 }, c4: { mu: -0.3, beta: 0 }, laterality: 29.4, fb: FB };
const B8_12 = FILTER_BANK.findIndex((b) => b.id === 'b8_12');
const nan = (n: number) => new Array<number>(n).fill(Number.NaN);

function asMeta(o: unknown): VizMeta {
  const msg = parseVizMessage(s(o));
  if (msg?.type !== 'viz.meta') throw new Error('expected a valid viz.meta');
  return msg;
}

function asMi(o: unknown): VizMi {
  const msg = parseVizMessage(s(o));
  if (msg?.type !== 'viz.mi') throw new Error('expected a valid viz.mi');
  return msg;
}

describe('parseVizMessage', () => {
  test('accepts the documented messages', () => {
    const meta = parseVizMessage(s(META));
    assert.equal(meta?.type, 'viz.meta');
    if (meta?.type === 'viz.meta') {
      assert.deepEqual(meta.bands.alphaMu, [8, 13]);
      assert.equal(meta.source, 'synthetic');
    }
    assert.equal(parseVizMessage(s(MI))?.type, 'viz.mi');
    assert.equal(parseVizMessage(s({ type: 'viz.spec', t: 1, freqs: [1, 2, 3], c3: [0.1, 0.2, 0.3], c4: [0.1, 0.2, 0.3] }))?.type, 'viz.spec');
    assert.equal(parseVizMessage(s({ type: 'viz.quality', t: 1, contact: { C3: 'good', C4: 'poor' } }))?.type, 'viz.quality');
    assert.equal(parseVizMessage(s({ type: 'viz.marker', t: 1, id: 'a', command: 'YES', confidence: 0.82, source: 'imagery' }))?.type, 'viz.marker');
  });

  test('older bridges may leave out the optional fields', () => {
    const { brainTest: _b, note: _n, ...metaOld } = META;
    const parsed = parseVizMessage(s(metaOld));
    assert.equal(parsed?.type === 'viz.meta' && parsed.brainTest.state, 'not_run');
    const { emg: _e, emgThreshold: _t, ...miOld } = MI;
    const mi = parseVizMessage(s(miOld));
    assert.equal(mi?.type === 'viz.mi' && mi.emg, null);
  });

  test('ignores unknown types, bad JSON and non-objects', () => {
    for (const raw of ['{"type":"viz.trace"}', 'not json', '[]', '42', 'null', '{"type":"gesture","command":"YES"}']) {
      assert.equal(parseVizMessage(raw), null, raw);
    }
  });

  test('rejects bad numbers and impossible values', () => {
    assert.equal(parseVizMessage(s({ ...MI, c3: { mu: 'x', beta: 0 } })), null);
    assert.equal(parseVizMessage(s({ ...MI, c3: { mu: -150, beta: 0 } })), null, 'ERD below -100% is impossible');
    assert.equal(parseVizMessage(s({ ...MI, emgGate: 'false' })), null);
    assert.equal(parseVizMessage(s({ ...MI, t: null })), null);
    assert.equal(parseVizMessage(s({ ...META, source: 'demo' })), null, 'an unknown source is never shown as live');
    assert.equal(parseVizMessage(s({ ...META, v: 2 })), null);
    assert.equal(parseVizMessage(s({ ...META, bands: { alpha_mu: [13, 8], beta: [13, 30] } })), null);
    assert.equal(parseVizMessage(s({ type: 'viz.spec', t: 1, freqs: [1, 2], c3: [1], c4: [1, 2] })), null);
    assert.equal(parseVizMessage(s({ type: 'viz.quality', t: 1, contact: { C3: 'great' } })), null);
    assert.equal(parseVizMessage(s({ type: 'viz.marker', t: 1, id: 'a', command: 'SELECT', confidence: 0.5, source: 'imagery' })), null);
    assert.equal(parseVizMessage(s({ type: 'viz.marker', t: 1, id: 'a', command: 'YES', confidence: 1.5, source: 'imagery' })), null);
  });

  test('the default address is loopback port 8766, never the station channel', () => {
    assert.equal(DEFAULT_VIZ_URL, 'ws://127.0.0.1:8766');
  });
});

describe('filter bank in the protocol', () => {
  test('viz.meta filterBank and viz.mi fb are accepted in order, and a null band stays null', () => {
    const meta = asMeta(META_FB);
    assert.deepEqual(meta.filterBank, FILTER_BANK);
    assert.deepEqual(meta.bands, { alphaMu: [8, 12], beta: [12, 30] });
    const mi = asMi(MI_FB);
    assert.deepEqual(mi.fb, FB);
    assert.equal(mi.fb?.c4[3], null);
  });

  test('frames from an older bridge without them still parse, with both fields null', () => {
    assert.equal(asMeta(META).filterBank, null);
    assert.equal(asMeta({ ...META, filterBank: null }).filterBank, null);
    assert.equal(asMi(MI).fb, null);
    assert.equal(asMi({ ...MI, fb: null }).fb, null);
  });

  test('a bad filterBank makes the whole viz.meta invalid', () => {
    const band = (over: object) => ({ id: 'x', lo: 1, hi: 2, label: 'X', ...over });
    const many = (n: number) => Array.from({ length: n }, (_, i) => band({ id: `b${i}` }));
    const bad: [string, unknown][] = [
      ['duplicate id', [band({ id: 'b8_12' }), band({ id: 'b8_12' })]],
      ['lo equal to hi', [band({ lo: 12, hi: 12 })]],
      ['lo above hi', [band({ lo: 12, hi: 8 })]],
      ['too many bands', many(MAX_FILTER_BANDS + 1)],
      ['no bands', []],
      ['uppercase id', [band({ id: 'Mu' })]],
      ['id over 16 chars', [band({ id: 'a'.repeat(17) })]],
      ['empty id', [band({ id: '' })]],
      ['hi above 200 Hz', [band({ hi: 201 })]],
      ['negative lo', [band({ lo: -1 })]],
      ['lo not a number', [band({ lo: '8' })]],
      ['label over 24 chars', [band({ label: 'x'.repeat(25) })]],
      ['label not a string', [band({ label: 7 })]],
      ['entry not an object', ['b8_12']],
      ['not an array', { b8_12: [8, 12] }],
    ];
    for (const [why, filterBank] of bad) assert.equal(parseVizMessage(s({ ...META, filterBank })), null, why);
    assert.equal(asMeta({ ...META, filterBank: many(MAX_FILTER_BANDS) }).filterBank?.length, MAX_FILTER_BANDS, '12 bands is the limit');
    assert.equal(asMeta({ ...META, filterBank: [band({ lo: 0, hi: 200, label: 'x'.repeat(24) })] }).filterBank?.length, 1, 'edges inclusive');
  });

  test('a malformed fb makes the whole viz.mi invalid', () => {
    const bad: [string, unknown][] = [
      ['c3 and c4 lengths differ', { c3: [1, 2], c4: [1] }],
      ['below -100', { c3: [-150], c4: [0] }],
      ['above 1000', { c3: [0], c4: [1001] }],
      ['a string entry', { c3: ['1'], c4: [0] }],
      ['missing c4', { c3: [0] }],
      ['empty rows', { c3: [], c4: [] }],
      ['too many entries', { c3: nan(13).map(() => 0), c4: nan(13).map(() => 0) }],
      ['not an object', [0, 0]],
    ];
    for (const [why, fb] of bad) assert.equal(parseVizMessage(s({ ...MI, fb })), null, why);
    assert.ok(asMi({ ...MI, fb: { c3: [-100, 1000], c4: [null, 0] } }).fb, 'the bounds are inclusive');
  });
});

describe('glowErd', () => {
  test('reads the 8 to 12 Hz band when the filter bank has it and fb has a number there', () => {
    const meta = asMeta(META_FB);
    const mi = asMi({ ...MI_FB, c3: { mu: -5, beta: 0 }, c4: { mu: -6, beta: 0 } });
    assert.equal(glowErd(mi, meta, 'c3'), FB.c3[B8_12]);
    assert.equal(glowErd(mi, meta, 'c4'), FB.c4[B8_12]);
  });

  test('falls back to mu without a filter bank, without b8_12, with a null there, or on a length mismatch', () => {
    const meta = asMeta(META_FB);
    const mi = asMi(MI_FB);
    assert.equal(glowErd(mi, null, 'c3'), MI_FB.c3.mu, 'no meta');
    assert.equal(glowErd(mi, asMeta(META), 'c3'), MI_FB.c3.mu, 'meta without filterBank');
    assert.equal(glowErd(asMi(MI), meta, 'c4'), MI.c4.mu, 'mi without fb');
    const noMu = asMeta({ ...META, filterBank: FILTER_BANK.map((b) => (b.id === 'b8_12' ? { ...b, id: 'b8_13' } : b)) });
    assert.equal(glowErd(mi, noMu, 'c3'), MI_FB.c3.mu, 'filter bank without b8_12');
    const nullMu = asMi({ ...MI_FB, fb: { c3: FB.c3.map((v, i) => (i === B8_12 ? null : v)), c4: FB.c4 } });
    assert.equal(glowErd(nullMu, meta, 'c3'), MI_FB.c3.mu, 'b8_12 not computed');
    assert.equal(glowErd(nullMu, meta, 'c4'), FB.c4[B8_12], 'the other side still has it');
    const short = asMi({ ...MI_FB, fb: { c3: FB.c3.slice(0, 3), c4: FB.c4.slice(0, 3) } });
    assert.equal(glowErd(short, meta, 'c3'), MI_FB.c3.mu, 'fb length does not match meta.filterBank');
  });
});

describe('client state', () => {
  test('summaries before viz.meta are dropped; after it they fill the 20 s history', () => {
    const state = emptyState();
    assert.equal(applyFrame(state, s(MI), 1), false);
    assert.equal(applyFrame(state, s(META), 2), true);
    for (let i = 0; i < HISTORY + 5; i++) applyFrame(state, s({ ...MI, t: 1700000001 + i / 10, c3: { mu: -i % 50, beta: 0 } }), 3 + i);
    assert.equal(state.history.count, HISTORY);
    const t = state.history.ordered(state.history.t);
    assert.ok(t.every((v, i) => i === 0 || v > t[i - 1]), 'oldest first');
    assert.equal(state.miAt, 3 + HISTORY + 4);
  });

  test('fb with the wrong length for meta.filterBank is ignored, but the rest of the frame is applied', () => {
    const state = emptyState();
    applyFrame(state, s(META_FB), 0);
    const short = { ...MI_FB, fb: { c3: FB.c3.slice(0, 5), c4: FB.c4.slice(0, 5) } };
    assert.equal(applyFrame(state, s(short), 1), true);
    assert.equal(state.mi?.fb, null);
    assert.equal(state.mi?.c3.mu, MI_FB.c3.mu);
    assert.equal(state.miAt, 1);
    assert.equal(state.history.count, 1);
    assert.equal(state.history.bandCount, 0);
    assert.deepEqual(state.history.bandSeries('c3', B8_12), nan(1));
    const noBank = emptyState();
    applyFrame(noBank, s(META), 0);
    assert.equal(applyFrame(noBank, s(MI_FB), 1), true, 'fb from a bridge whose meta has no filterBank');
    assert.equal(noBank.mi?.fb, null);
    assert.equal(noBank.history.count, 1);
  });

  test('band history: oldest first, aligned with t, NaN for null or missing, and cleared on reset', () => {
    const state = emptyState();
    const h = state.history;
    applyFrame(state, s(META_FB), 0);
    assert.equal(h.bandCount, 0, 'no fb yet');
    applyFrame(state, s({ ...MI_FB, t: 10 }), 1);
    applyFrame(state, s({ ...MI, t: 11 }), 2);
    applyFrame(state, s({ ...MI_FB, t: 12, fb: { c3: FB.c3.map((v) => v + 1), c4: FB.c4 } }), 3);
    assert.equal(h.bandCount, FILTER_BANK.length);
    assert.deepEqual(h.ordered(h.t), [10, 11, 12]);
    assert.deepEqual(h.bandSeries('c3', B8_12), [Math.fround(-29.7), Number.NaN, Math.fround(-28.7)]);
    assert.deepEqual(h.bandSeries('c4', 3), nan(3), 'null and missing values are NaN');
    assert.deepEqual(h.bandSeries('c3', FILTER_BANK.length), nan(3), 'a band index the bank does not have');
    assert.deepEqual(h.bandSeries('c3', -1), nan(3));
    assert.deepEqual(h.bandSeries('c3', MAX_FILTER_BANDS), nan(3));
    for (let i = 0; i < HISTORY + 7; i++) {
      applyFrame(state, s({ ...MI_FB, t: 100 + i, fb: { c3: FB.c3.map(() => -(i % 90)), c4: FB.c4 } }), 10 + i);
    }
    const t = h.ordered(h.t);
    const mu = h.bandSeries('c3', B8_12);
    assert.equal(mu.length, t.length);
    assert.equal(mu.length, HISTORY);
    assert.deepEqual(mu.slice(-3), [-((HISTORY + 4) % 90), -((HISTORY + 5) % 90), -((HISTORY + 6) % 90)], 'the ring wraps in order');
    resetState(state);
    assert.equal(h.count, 0);
    assert.equal(h.bandCount, 0);
    assert.deepEqual(h.bandSeries('c3', B8_12), []);
    assert.ok(h.bandC3.every((ring) => ring.every(Number.isNaN)) && h.bandC4.every((ring) => ring.every(Number.isNaN)));
  });

  test('a different filter bank clears the band rows; the same one sent again keeps them', () => {
    const state = emptyState();
    const h = state.history;
    applyFrame(state, s(META_FB), 0);
    applyFrame(state, s(MI_FB), 1);
    applyFrame(state, s({ ...META_FB, baseline: { state: 'recording', recordedAt: null } }), 2);
    assert.equal(h.bandCount, FILTER_BANK.length, 'a baseline change resends the same bank');
    assert.deepEqual(h.bandSeries('c3', B8_12), [Math.fround(-29.7)]);
    applyFrame(state, s({ ...META_FB, filterBank: FILTER_BANK.slice(1) }), 3);
    assert.equal(h.bandCount, 0);
    assert.deepEqual(h.bandSeries('c3', 0), nan(1), 'old values would sit under the wrong band');
    assert.equal(h.count, 1, 'mu, beta and EMG history stay');
    assert.deepEqual(h.ordered(h.c3mu), [Math.fround(-29.7)]);
  });

  test('markers are deduplicated by id and capped', () => {
    const state = emptyState();
    applyFrame(state, s(META), 0);
    const marker = (id: string) => s({ type: 'viz.marker', t: 1, id, command: 'NO', confidence: 0.7, source: 'imagery' });
    assert.equal(applyFrame(state, marker('a'), 1), true);
    assert.equal(applyFrame(state, marker('a'), 2), false);
    for (let i = 0; i < MAX_MARKERS + 10; i++) applyFrame(state, marker(`m${i}`), 3 + i);
    assert.equal(state.markers.length, MAX_MARKERS);
    assert.equal(state.markerAt.length, MAX_MARKERS);
  });
});

class FakeSocket {
  static made: FakeSocket[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  readyState = 0;
  sent: string[] = [];
  constructor(readonly url: string) {
    FakeSocket.made.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

function fakeDeps() {
  const timers: { fn: () => void; ms: number }[] = [];
  let clock = 0;
  const deps: StreamDeps = {
    createSocket: (url) => new FakeSocket(url),
    setTimeout: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimeout: (h) => {
      const i = timers.indexOf(h as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
    now: () => clock,
  };
  return { deps, timers, tick: (ms: number) => (clock += ms) };
}

describe('VizStream', () => {
  test('connects to 8766, clears everything on close, and retries 250, 500, 1000, 2000, 2000 ms', () => {
    FakeSocket.made = [];
    const { deps, timers } = fakeDeps();
    const stream = new VizStream(DEFAULT_VIZ_URL, deps);
    let changes = 0;
    stream.subscribe(() => changes++);
    stream.start();
    assert.equal(FakeSocket.made[0].url, 'ws://127.0.0.1:8766');
    FakeSocket.made[0].open();
    FakeSocket.made[0].onmessage?.({ data: s(META) });
    FakeSocket.made[0].onmessage?.({ data: s(MI) });
    assert.equal(stream.state.connected, true);
    assert.ok(stream.state.mi);
    FakeSocket.made[0].drop();
    assert.equal(stream.state.connected, false);
    assert.equal(stream.state.mi, null, 'no frozen number after a drop');
    assert.equal(stream.state.meta, null);
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = timers.shift()!;
      delays.push(t.ms);
      t.fn();
      FakeSocket.made.at(-1)!.drop();
    }
    assert.deepEqual(delays, [250, 500, 1000, 2000, 2000]);
    assert.ok(changes > 0);
    stream.stop();
  });

  test('a successful open resets the backoff', () => {
    FakeSocket.made = [];
    const { deps, timers } = fakeDeps();
    const stream = new VizStream(DEFAULT_VIZ_URL, deps);
    stream.start();
    FakeSocket.made[0].drop();
    timers.shift()!.fn();
    FakeSocket.made[1].drop();
    timers.shift()!.fn();
    FakeSocket.made[2].open();
    FakeSocket.made[2].drop();
    assert.equal(timers[0].ms, 250);
    stream.stop();
  });

  test('stop cancels the retry and the baseline command needs an open socket', () => {
    FakeSocket.made = [];
    const { deps, timers } = fakeDeps();
    const stream = new VizStream(DEFAULT_VIZ_URL, deps);
    stream.start();
    assert.equal(stream.recordBaseline(), false);
    FakeSocket.made[0].open();
    assert.equal(stream.recordBaseline(), true);
    assert.deepEqual(FakeSocket.made[0].sent, ['{"type":"viz.cmd","cmd":"baseline"}']);
    FakeSocket.made[0].drop();
    stream.stop();
    assert.equal(timers.length, 0);
  });

  test('binary frames are ignored', () => {
    FakeSocket.made = [];
    const { deps } = fakeDeps();
    const stream = new VizStream(DEFAULT_VIZ_URL, deps);
    stream.start();
    FakeSocket.made[0].open();
    FakeSocket.made[0].onmessage?.({ data: new ArrayBuffer(16) });
    assert.equal(stream.state.lastAt, null);
    stream.stop();
  });
});
