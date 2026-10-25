/**
 * Screen 1 against the scripted scenarios in tools/mock-viz (made by make_scenarios.py, played to the browser by
 * tools/viz_replay.py). Every line of every file goes through the page's own applyFrame in time order with a fake
 * clock, and at chosen moments the test asks buildBrainView and patchTargets what the screen would say and how bright
 * each patch would be. No browser, no socket, no real waiting.
 *
 * Each file line is {"at": seconds, "frame": {...}} (or "raw" text, or "bytes" for a binary frame, in 12-malformed),
 * with "expect": "reject" on a line the page must ignore and "expect": "fb_ignored" on one it uses without its fb.
 * Times are rewritten the way viz_replay.py rewrites them at speed 1: t becomes T0 + at, and viz.meta
 * baseline.recordedAt (seconds from the start of the file) becomes T0 + recordedAt.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  FAILED_TEST_DIM,
  LABELS,
  STALE_MS,
  baselineText,
  buildBrainView,
  eventPillText,
  guessText,
  isJawCommand,
  minuteText,
  patchIntensity,
  patchTargets,
  pulseSide,
  type BrainInput,
  type BrainView,
} from '../lib/brain/model';
import { glowErd, type VizMarker, type VizMeta, type VizMi } from '../lib/brain/protocol';
import { VizStream, applyFrame, emptyState, type StreamDeps, type VizState } from '../lib/brain/stream';

const DIR = join(process.cwd(), '..', 'tools', 'mock-viz');
/** Unix seconds when the fake replay starts, and the fake browser clock (ms) at that same moment. */
const T0 = 1_792_867_000;
const NOW0 = 100_000;
/** The page renders this long after a tick's frames arrive, before the next tick. */
const RENDER_MS = 50;
const LIVE_LABEL = /"source"\s*:\s*"live"/;

const EXPECTED = [
  '01-rest',
  '02-right-fist-yes',
  '03-left-fist-no',
  '04-held-clench-stop',
  '05-single-clench-confirm',
  '06-headset-off',
  '07-baseline-flow',
  '08-brain-test-failed',
  '09-replay-label',
  '10-bad-contact',
  '11-legacy-bridge',
  '12-malformed',
  '13-key-press',
  '20-demo-run',
  '90-live-label-test',
];

/** The six bands the synthetic bridge sends, in its order. */
const FILTER_BANK = [
  { id: 'mrcp', lo: 0.05, hi: 5, label: 'Slow potential 0.05-5 Hz' },
  { id: 'b8_12', lo: 8, hi: 12, label: 'Mu 8-12 Hz' },
  { id: 'b12_16', lo: 12, hi: 16, label: 'Low beta 12-16 Hz' },
  { id: 'b16_20', lo: 16, hi: 20, label: 'Beta 16-20 Hz' },
  { id: 'b20_26', lo: 20, hi: 26, label: 'Beta 20-26 Hz' },
  { id: 'b26_30', lo: 26, hi: 30, label: 'High beta 26-30 Hz' },
];
const BAND = Object.fromEntries(FILTER_BANK.map((b, i) => [b.id, i])) as Record<string, number>;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Obj = Record<string, unknown>;

interface Info {
  scenario: string;
  description: string;
  screen: string;
  seconds: number;
  seed: number;
}

interface Line {
  at: number;
  info?: Info;
  frame?: Obj;
  raw?: string;
  bytes?: string;
  expect?: 'reject' | 'fb_ignored';
  why?: string;
  baseline?: boolean;
}

interface Snap {
  at: number;
  now: number;
  view: BrainView;
  targets: { c3: number; c4: number };
  meta: VizMeta | null;
  mi: VizMi | null;
  contact: Record<string, string>;
  markers: VizMarker[];
}

interface Run {
  name: string;
  info: Info;
  lines: Line[];
  state: VizState;
  /** One entry per line after the info line: did applyFrame use it. */
  results: { line: Line; used: boolean; fbAfter: unknown }[];
  snaps: Snap[];
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const close = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;
const round1 = (v: number) => Math.round(v * 10) / 10;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function readLines(name: string): Line[] {
  return readFileSync(join(DIR, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Line);
}

const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith('.jsonl'))
  .map((f) => f.replace(/\.jsonl$/, ''))
  .sort();
const TEXT = new Map(FILES.map((name) => [name, readFileSync(join(DIR, `${name}.jsonl`), 'utf8')]));
const LINES = new Map(FILES.map((name) => [name, readLines(name)]));

/** The text viz_replay.py would send for this line at speed 1, starting at T0. */
function wire(line: Line): string {
  if (line.raw !== undefined) return line.raw;
  const frame = structuredClone(line.frame) as Obj;
  if (typeof frame.t === 'number') frame.t = T0 + line.at;
  if (frame.type === 'viz.meta' && isObj(frame.baseline) && typeof frame.baseline.recordedAt === 'number') {
    frame.baseline.recordedAt = T0 + frame.baseline.recordedAt;
  }
  return JSON.stringify(frame);
}

const clockAt = (at: number) => NOW0 + Math.round(at * 1000);

function inputOf(state: VizState, now: number): BrainInput {
  return { connected: state.connected, meta: state.meta, mi: state.mi, miAt: state.miAt, lastAt: state.lastAt, now };
}

function snapshot(state: VizState, at: number, now: number): Snap {
  const input = inputOf(state, now);
  return {
    at,
    now,
    view: buildBrainView(input),
    targets: patchTargets(input),
    meta: state.meta,
    mi: state.mi,
    contact: { ...(state.quality?.contact ?? {}) },
    markers: [...state.markers],
  };
}

const RUNS = new Map<string, Run>();

/** Plays one file through applyFrame, as the page would get it, and takes a snapshot after each moment's frames. */
function run(name: string): Run {
  const cached = RUNS.get(name);
  if (cached) return cached;
  const lines = LINES.get(name);
  assert.ok(lines, `no scenario ${name}`);
  const info = lines[0].info as Info;
  const state = emptyState();
  state.connected = true; // the socket is open; the replay sends viz.meta first
  const results: Run['results'] = [];
  const snaps: Snap[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // A binary frame never reaches applyFrame: VizStream drops it first (checked through VizStream below).
    const used = line.bytes !== undefined ? false : applyFrame(state, wire(line), clockAt(line.at));
    results.push({ line, used, fbAfter: state.mi?.fb });
    const next = lines[i + 1];
    if (!next || next.at > line.at) snaps.push(snapshot(state, line.at, clockAt(line.at) + RENDER_MS));
  }
  const out = { name, info, lines, state, results, snaps };
  RUNS.set(name, out);
  return out;
}

const between = (r: Run, from: number, to: number) => r.snaps.filter((s) => s.at >= from - 1e-9 && s.at <= to + 1e-9);
const snapAt = (r: Run, at: number) => {
  const s = r.snaps.find((x) => close(x.at, at));
  assert.ok(s, `${r.name}: no snapshot at ${at} s`);
  return s;
};
const validFrames = (r: Run, type: string) =>
  r.lines.filter((l) => l.frame && l.frame.type === type && l.expect !== 'reject').map((l) => ({ at: l.at, frame: l.frame as Obj }));
const markersOf = (r: Run) => r.state.markers;
const fbOf = (mi: VizMi | null, side: 'c3' | 'c4', band: string) => {
  const v = mi?.fb?.[side][BAND[band]];
  assert.equal(typeof v, 'number', `fb ${side} ${band}`);
  return v as number;
};

/** The brain-glow checks for one imagined squeeze: the quiet side glows past 0.6 on its plateau, the other stays dark. */
function checkImagery(r: Run, from: number, to: number, side: 'c3' | 'c4') {
  const other = side === 'c3' ? 'c4' : 'c3';
  const plateau = between(r, from, to);
  assert.ok(plateau.length >= 15, `${r.name}: ${plateau.length} frames on the plateau`);
  for (const s of plateau) {
    assert.equal(s.view.state, 'measuring', `${r.name} at ${s.at}`);
    assert.ok(s.targets[side] > 0.6, `${r.name} at ${s.at}: ${side} target ${s.targets[side]}`);
    assert.ok(s.targets[other] < 0.2, `${r.name} at ${s.at}: ${other} target ${s.targets[other]}`);
    assert.equal(s.view[side].intensity, s.targets[side], 'the words and the 3D scene agree');
  }
}

function checkRestDark(snaps: Snap[], name: string) {
  assert.ok(snaps.length > 0, `${name}: no rest frames`);
  for (const s of snaps) {
    assert.ok(s.targets.c3 < 0.2 && s.targets.c4 < 0.2, `${name} at ${s.at}: targets ${s.targets.c3}, ${s.targets.c4}`);
  }
}

function onlyMarker(r: Run, command: string, source: string): VizMarker {
  const all = markersOf(r);
  assert.equal(all.length, 1, `${r.name}: ${all.map((m) => m.command).join(', ')}`);
  assert.equal(all[0].command, command);
  assert.equal(all[0].source, source);
  return all[0];
}

function checkGate(r: Run, gated: number[]) {
  const gate = r.snaps.filter((s) => s.mi?.emgGate);
  assert.deepEqual(
    gate.map((s) => s.at),
    gated,
    `${r.name}: frames with emgGate true`,
  );
  for (const s of gate) {
    const mi = s.mi as VizMi;
    assert.equal(s.view.state, 'muscle', `${r.name} at ${s.at}`);
    assert.deepEqual(s.view.stateLine, { status: 'stopped', text: LABELS.muscle });
    assert.deepEqual(s.targets, { c3: 0, c4: 0 }, 'no brain glow during a clench');
    assert.equal(s.view.c3.value, null);
    assert.equal(s.view.c4.value, null);
    assert.ok(mi.emg !== null && mi.emgThreshold !== null && mi.emg > mi.emgThreshold, `emg ${mi.emg}`);
    for (const side of ['c3', 'c4'] as const) {
      for (const band of ['b20_26', 'b26_30']) {
        const v = fbOf(mi, side, band);
        assert.ok(v >= 150 && v <= 300, `${r.name} at ${s.at}: ${side} ${band} ${v}`);
      }
      const b16 = fbOf(mi, side, 'b16_20');
      assert.ok(b16 >= 20 && b16 <= 50, `${side} b16_20 ${b16}`);
      assert.ok(mi[side].beta > 80, `${side} beta ${mi[side].beta} spikes, yet nothing glows`);
    }
  }
}

/** One scenario, one set of checks: what the screen must show at the moments that matter. */
const CHECKS: Record<string, (r: Run) => void> = {
  '01-rest': (r) => {
    for (const s of r.snaps) {
      assert.equal(s.view.state, 'measuring');
      assert.equal(s.view.stateLine, null, 'the stage stays quiet at rest');
      assert.deepEqual(s.view.mode, { kind: 'synthetic', text: 'Synthetic test signal' });
    }
    checkRestDark(r.snaps, r.name);
    assert.equal(markersOf(r).length, 0);
    assert.deepEqual(r.state.quality?.contact, { C3: 'good', C4: 'good' });
  },

  '02-right-fist-yes': (r) => {
    checkRestDark(between(r, 0, 2.9), r.name);
    checkImagery(r, 3.5, 5.5, 'c3');
    checkRestDark(between(r, 6.1, 10), r.name);
    // The other bands at C3 move like the synthetic bridge's table: slow potential up, quieting less with frequency.
    const plateau = between(r, 3.5, 5.5);
    const c3 = (band: string) => mean(plateau.map((s) => fbOf(s.mi, 'c3', band)));
    const c4 = (band: string) => mean(plateau.map((s) => fbOf(s.mi, 'c4', band)));
    const want: Record<string, number> = { mrcp: 25, b8_12: -30, b12_16: -24, b16_20: -16, b20_26: -11, b26_30: -7 };
    for (const [band, v] of Object.entries(want)) {
      assert.ok(Math.abs(c3(band) - v) <= 4, `C3 ${band} mean ${c3(band).toFixed(1)}, want about ${v}`);
      assert.ok(Math.abs(c4(band)) <= 6, `C4 ${band} mean ${c4(band).toFixed(1)}, want near 0`);
    }
    assert.ok(plateau.every((s) => (s.mi as VizMi).laterality > 20), 'laterality about +27');
    const yes = onlyMarker(r, 'YES', 'imagery');
    assert.equal(pulseSide(yes), 'c3', 'the YES would pulse the C3 ring');
    // PLAN D21: an at-once YES is 0.90 or more.
    assert.ok(yes.confidence !== null && yes.confidence >= 0.9 && yes.confidence <= 0.97);
    assert.match(guessText(yes), /^Guess YES 0\.\d\d$/);
    assert.ok(snapAt(r, 5.4).markers.includes(yes), 'the YES lands at 5.4 s, during the glow');
  },

  '03-left-fist-no': (r) => {
    checkRestDark(between(r, 0, 2.9), r.name);
    checkImagery(r, 3.5, 5.5, 'c4');
    checkRestDark(between(r, 6.1, 10), r.name);
    assert.ok(between(r, 3.5, 5.5).every((s) => (s.mi as VizMi).laterality < -20), 'laterality about -27');
    const no = onlyMarker(r, 'NO', 'imagery');
    assert.ok(no.confidence !== null && no.confidence >= 0.96, 'an at-once NO is 0.96 or more (PLAN D21)');
    assert.equal(pulseSide(no), 'c4');
    assert.match(guessText(no), /^Guess NO 0\.\d\d$/);
  },

  // PLAN D21: a held clench is STOP (a double clench sends nothing), and a single clench is CONFIRM (D17).
  '04-held-clench-stop': (r) => {
    checkGate(r, [4, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8]);
    for (const at of [3.9, 4.9]) {
      // The frames just before and after the clench: some muscle in the upper bands, under the gate. The glow
      // reads 8-12 Hz, which a clench does not touch, so nothing lights up.
      const s = snapAt(r, at);
      assert.equal(s.view.state, 'measuring', `at ${at}`);
      assert.ok(s.targets.c3 < 0.2 && s.targets.c4 < 0.2);
    }
    for (const s of r.snaps.filter((x) => !x.mi?.emgGate)) assert.equal(s.view.state, 'measuring', `at ${s.at}`);
    const stop = onlyMarker(r, 'STOP', 'jaw');
    assert.equal(stop.confidence, null);
    assert.ok(isJawCommand(stop.command), 'goes on the jaw lane, never on the brain');
    assert.equal(pulseSide(stop), null, 'no ring pulse for a jaw command');
    assert.equal(eventPillText(stop), 'STOP');
    assert.equal(guessText(stop), 'Jaw STOP');
    assert.ok(snapAt(r, 4.8).markers.includes(stop), 'STOP lands at 4.8 s, while the clench is still held');
  },

  '05-single-clench-confirm': (r) => {
    checkGate(r, [4, 4.1, 4.2]);
    const confirm = onlyMarker(r, 'CONFIRM', 'jaw');
    assert.equal(confirm.confidence, null);
    assert.equal(pulseSide(confirm), null);
    assert.equal(eventPillText(confirm), 'CONFIRM');
    assert.equal(guessText(confirm), 'Jaw CONFIRM');
    assert.ok(snapAt(r, 4.8).markers.includes(confirm));
  },

  '06-headset-off': (r) => {
    const mis = validFrames(r, 'viz.mi');
    const lastAt = mis[mis.length - 1].at;
    assert.equal(lastAt, 5);
    assert.ok(r.info.seconds - lastAt >= 4, 'at least 4 s with no frames at all');
    const off = onlyMarker(r, 'HEADSET_OFF', 'contact');
    assert.equal(pulseSide(off), null);
    assert.equal(guessText(off), 'Headset off');
    assert.deepEqual(r.state.quality?.contact, { C3: 'off', C4: 'off' });
    const miAt = r.state.miAt as number;
    assert.equal(miAt, clockAt(lastAt), 'the marker after the last frame does not count as data');
    const at = (ms: number) => buildBrainView(inputOf(r.state, miAt + ms));
    assert.equal(at(STALE_MS).state, 'measuring', '500 ms is still fresh');
    assert.equal(at(STALE_MS + 1).state, 'no_signal');
    const view = at(600);
    assert.deepEqual(view.stateLine, { status: 'failed', text: 'No signal', detail: 'No data for 600 ms' });
    assert.deepEqual([view.c3.value, view.c3.valueText, view.c4.value], [null, 'no reading', null], 'old values cleared');
    assert.deepEqual(patchTargets(inputOf(r.state, miAt + 600)), { c3: 0, c4: 0 });
    const end = buildBrainView(inputOf(r.state, clockAt(r.info.seconds)));
    assert.equal(end.state, 'no_signal', 'still No signal at the end of the file');
    assert.equal(end.mode.kind, 'synthetic', 'the connection is still open, so the pill stays');
  },

  '07-baseline-flow': (r) => {
    for (const s of between(r, 0, 1.95)) {
      assert.equal(s.view.state, 'baseline', `at ${s.at}`);
      assert.deepEqual(s.view.stateLine, { status: 'stopped', text: 'No rest baseline' });
      assert.equal(s.view.needsBaseline, true, 'the stage offers Record');
    }
    for (const s of between(r, 2, 6.95)) {
      assert.equal(s.view.state, 'baseline', `at ${s.at}`);
      assert.deepEqual(s.view.stateLine, { status: 'working', text: 'Recording rest baseline' });
      assert.equal(s.view.needsBaseline, false);
    }
    for (const s of between(r, 0, 6.95)) assert.deepEqual(s.targets, { c3: 0, c4: 0 });
    for (const s of between(r, 7, 16)) {
      assert.ok(s.view.state === 'measuring', `at ${s.at}: ${s.view.state}`);
      assert.equal(s.view.stateLine, null);
      assert.equal(s.view.details.baseline, baselineText('set', T0 + 7));
    }
    for (const { at, frame } of validFrames(r, 'viz.mi')) {
      const mi = frame as unknown as VizMi;
      if (at < 7) {
        const all = [mi.c3.mu, mi.c3.beta, mi.c4.mu, mi.c4.beta, mi.laterality, ...(mi.fb?.c3 ?? []), ...(mi.fb?.c4 ?? [])];
        assert.ok(all.every((v) => v === 0), `at ${at}: every ERD field is 0 until the baseline is set`);
        assert.equal(mi.baselineAgeS, null);
      } else {
        assert.ok(mi.baselineAgeS !== null && close(mi.baselineAgeS, at - 7, 0.051), `baselineAgeS ${mi.baselineAgeS} at ${at}`);
      }
    }
    // The frames viz_replay.py replays when the page asks for a new baseline: from the recording meta to the set meta.
    const tagged = r.lines.map((l, i) => (l.baseline ? i : -1)).filter((i) => i >= 0);
    assert.ok(tagged.length > 40);
    assert.deepEqual(tagged, Array.from({ length: tagged.length }, (_, k) => tagged[0] + k), 'one unbroken run of lines');
    const first = r.lines[tagged[0]].frame as Obj;
    const last = r.lines[tagged[tagged.length - 1]].frame as Obj;
    assert.equal(first.type, 'viz.meta');
    assert.equal((first.baseline as Obj).state, 'recording');
    assert.equal(last.type, 'viz.meta');
    assert.equal((last.baseline as Obj).state, 'set');
    checkImagery(r, 11.5, 13.5, 'c3');
    assert.equal(pulseSide(onlyMarker(r, 'YES', 'imagery')), 'c3');
  },

  '08-brain-test-failed': (r) => {
    const meta = r.state.meta as VizMeta;
    assert.equal(meta.brainTest.state, 'failed');
    assert.ok(meta.brainTest.summary);
    for (const s of r.snaps) {
      assert.equal(s.view.state, 'measuring');
      assert.deepEqual(s.view.stateLine, { status: 'refused', text: LABELS.testFailed }, 'the failed line is shown');
      assert.equal(s.view.details.brainTest, `Brain test failed: ${meta.brainTest.summary}`);
    }
    for (const s of between(r, 3.5, 5.5)) {
      const full = patchIntensity(fbOf(s.mi, 'c3', 'b8_12'));
      assert.ok(full > 0.6, 'undimmed it would glow past 0.6');
      assert.ok(close(s.targets.c3, full * FAILED_TEST_DIM), `dimmed: ${s.targets.c3}`);
      assert.ok(s.targets.c3 > 0.2 && s.targets.c3 <= 0.35);
      assert.equal(s.view.c3.intensity, s.targets.c3);
    }
    assert.equal(markersOf(r).length, 0, 'no imagery YES while the brain test has failed');
  },

  '09-replay-label': (r) => {
    const meta = r.state.meta as VizMeta;
    assert.equal(meta.source, 'replay');
    assert.equal(meta.recordedAt, 1792850400);
    for (const s of r.snaps) {
      assert.equal(s.view.mode.kind, 'replay');
      assert.ok(s.view.mode.text.startsWith('Replay'), s.view.mode.text);
      assert.equal(s.view.mode.text, `Replay, recorded ${minuteText(1792850400)}`);
      assert.doesNotMatch(s.view.mode.text, /live/i);
    }
    checkImagery(r, 3.5, 5.5, 'c4');
    assert.equal(pulseSide(onlyMarker(r, 'NO', 'imagery')), 'c4');
  },

  '10-bad-contact': (r) => {
    const c4 = (from: number, to: number) => new Set(between(r, from, to).map((s) => s.contact.C4));
    assert.deepEqual(c4(0, 1.95), new Set(['good']));
    assert.deepEqual(c4(2, 6.95), new Set(['poor']));
    assert.deepEqual(c4(7, 12), new Set(['off']));
    assert.ok(r.snaps.every((s) => s.contact.C3 === 'good'));
    // What BandStrip lists in its legend: every channel that is poor or off.
    const bad = (s: Snap) => Object.entries(s.contact).filter(([, c]) => c === 'poor' || c === 'off');
    assert.deepEqual(bad(snapAt(r, 4)), [['C4', 'poor']]);
    assert.deepEqual(bad(snapAt(r, 9)), [['C4', 'off']]);
    // The noise on a bad contact raises C4 power; only quieting glows, so the C4 patch stays dark.
    checkRestDark(r.snaps, r.name);
    assert.ok(between(r, 7.5, 12).every((s) => fbOf(s.mi, 'c4', 'b8_12') > 100), 'C4 reads far above rest while off');
  },

  '11-legacy-bridge': (r) => {
    const meta = r.state.meta as VizMeta;
    assert.equal(meta.filterBank, null, 'no filterBank from an older bridge');
    assert.deepEqual(meta.bands.alphaMu, [8, 13]);
    assert.ok(r.snaps.every((s) => s.mi?.fb === null));
    assert.equal(r.state.history.bandCount, 0, 'the strip falls back to the mu and beta rows');
    checkImagery(r, 3.5, 5.5, 'c3');
    for (const s of between(r, 3.5, 5.5)) {
      const mi = s.mi as VizMi;
      assert.equal(glowErd(mi, meta, 'c3'), mi.c3.mu, 'the glow comes from mu');
      assert.equal(s.targets.c3, patchIntensity(mi.c3.mu));
    }
    assert.equal(pulseSide(onlyMarker(r, 'YES', 'imagery')), 'c3');
  },

  '12-malformed': (r) => {
    const junk = r.results.filter((x) => x.line.expect === 'reject');
    assert.equal(junk.length, 40);
    assert.equal(r.results.filter((x) => x.line.expect === 'fb_ignored').length, 1);
    const whys = junk.map((x) => x.line.why ?? '').join('\n');
    for (const kind of [/bad JSON/, /not JSON/, /NaN/, /Infinity/, /does not know/, /8765/, /fb c3 has 6/, /below -100/, /above 1000/, /over the .* limit/, /binary/, /same marker id/, /64000/, /MAYBE/]) {
      assert.match(whys, kind);
    }
    for (const s of r.snaps) assert.notEqual(s.view.state, 'no_signal', `at ${s.at}: the junk never stalls the stream`);
    checkImagery(r, 6.5, 8.5, 'c3');
    // The fb that does not fit is dropped and the glow falls back to mu for that one frame.
    const odd = r.results.find((x) => x.line.expect === 'fb_ignored');
    assert.ok(odd);
    const s = snapAt(r, odd.line.at);
    assert.equal(s.mi?.fb, null);
    assert.equal(s.targets.c3, patchIntensity((s.mi as VizMi).c3.mu));
    // Nothing from the junk is left on the screen.
    const meta = r.state.meta as VizMeta;
    assert.equal(meta.source, 'synthetic');
    assert.deepEqual(meta.filterBank, FILTER_BANK);
    assert.deepEqual(meta.channels, ['C3', 'C4']);
    assert.deepEqual(r.state.quality?.contact, { C3: 'good', C4: 'good' });
    assert.equal(pulseSide(onlyMarker(r, 'YES', 'imagery')), 'c3', 'one YES; no MAYBE, no NO with confidence 1.5, no repeat');
  },

  '13-key-press': (r) => {
    const all = markersOf(r);
    assert.deepEqual(
      all.map((m) => [m.command, m.source, m.confidence]),
      [
        ['YES', 'key', null],
        ['NO', 'key', null],
      ],
    );
    for (const m of all) {
      assert.equal(pulseSide(m), null, 'a key press never pulses the brain');
      assert.equal(guessText(m), `${m.command}, key press`);
      assert.equal(eventPillText(m), m.command);
    }
    checkRestDark(r.snaps, r.name);
  },

  '20-demo-run': (r) => {
    assert.ok(r.info.seconds >= 55 && r.info.seconds <= 65);
    for (const s of r.snaps) {
      assert.deepEqual(s.view.mode, { kind: 'replay', text: 'Replay' });
      assert.ok(s.view.state === 'measuring' || s.view.state === 'muscle', `at ${s.at}: ${s.view.state}`);
    }
    checkImagery(r, 8.5, 10.5, 'c3');
    checkImagery(r, 20.5, 22.5, 'c4');
    checkRestDark([...between(r, 0, 7.9), ...between(r, 11.1, 19.9), ...between(r, 23.1, 60)], r.name);
    checkGate(r, [33, 33.1, 33.2, 33.3, 33.4, 33.5, 33.6, 33.7, 33.8, 45, 45.1, 45.2]);
    const all = markersOf(r);
    assert.deepEqual(
      all.map((m) => [m.command, m.source]),
      [
        ['YES', 'imagery'],
        ['NO', 'imagery'],
        ['STOP', 'jaw'], // the held clench from 33 s (PLAN D21)
        ['CONFIRM', 'jaw'], // the single clench at 45 s
      ],
    );
    assert.deepEqual(
      all.map((m) => pulseSide(m)),
      ['c3', 'c4', null, null],
    );
    const markerAt = r.lines.filter((l) => l.frame?.type === 'viz.marker').map((l) => l.at);
    assert.deepEqual(markerAt, [10.4, 22.4, 33.8, 45.8]);
  },

  '90-live-label-test': (r) => {
    for (const s of r.snaps) assert.deepEqual(s.view.mode, { kind: 'live', text: 'Live headset' });
    checkRestDark(r.snaps, r.name);
  },
};

describe('the mock scenario folder', () => {
  test('holds exactly the expected scenarios, and each has its own checks', () => {
    assert.deepEqual(FILES, EXPECTED);
    assert.deepEqual(Object.keys(CHECKS).sort(), EXPECTED);
  });

  test('only the test fixture 90 is labeled live; every other file says synthetic or replay', () => {
    for (const name of FILES) {
      const text = TEXT.get(name) as string;
      const sources = run(name)
        .lines.filter((l) => l.frame?.type === 'viz.meta' && l.expect !== 'reject')
        .map((l) => (l.frame as Obj).source);
      const raws = run(name).lines.filter((l) => l.raw !== undefined && LIVE_LABEL.test(l.raw));
      if (name === '90-live-label-test') {
        assert.match(text, LIVE_LABEL);
        assert.ok(sources.every((s) => s === 'live'));
      } else {
        assert.doesNotMatch(text, LIVE_LABEL, `${name} must not say source live`);
        assert.equal(raws.length, 0);
        assert.ok(sources.length > 0 && sources.every((s) => s === 'synthetic' || s === 'replay'), `${name}: ${sources.join(', ')}`);
        assert.notEqual(run(name).state.meta?.source, 'live');
      }
    }
  });
});

describe('every scenario through the page logic', () => {
  for (const name of FILES) {
    test(`${name}: well formed, every line used or dropped as marked, at the protocol rates`, () => {
      const r = run(name);
      const [head, ...rest] = r.lines;
      assert.equal(head.at, 0);
      assert.equal(r.info.scenario, name);
      assert.ok(r.info.description.length > 10 && r.info.screen.length > 10);
      const long = name === '20-demo-run';
      assert.ok(long ? r.info.seconds >= 55 : r.info.seconds >= 8 && r.info.seconds <= 20, `${r.info.seconds} s`);
      for (const [i, l] of rest.entries()) {
        const kinds = ['info', 'frame', 'raw', 'bytes'].filter((k) => k in l);
        assert.equal(kinds.length, 1, `line ${i + 2}`);
        assert.ok(kinds[0] !== 'info');
        for (const key of Object.keys(l)) assert.ok(['at', 'frame', 'raw', 'bytes', 'expect', 'why', 'baseline'].includes(key), `line ${i + 2}: ${key}`);
        if (l.expect) assert.ok(l.why, `line ${i + 2} says why it is bad`);
        assert.ok(l.at >= (i === 0 ? 0 : rest[i - 1].at), 'in time order');
        assert.ok(l.at <= r.info.seconds);
      }
      assert.equal(rest[0].frame?.type, 'viz.meta', 'viz.meta comes first');

      for (const { line, used, fbAfter } of r.results) {
        if (line.expect === 'reject') assert.equal(used, false, `${name} at ${line.at}: the page must drop this: ${line.why}`);
        else assert.equal(used, true, `${name} at ${line.at}: the page must use this ${String(line.frame?.type)}`);
        if (line.expect === 'fb_ignored') assert.equal(fbAfter, null, 'fb dropped, frame kept');
      }

      const steps = (type: string, gap: number) => {
        const at = r.lines.filter((l) => l.frame?.type === type && !l.expect).map((l) => l.at);
        assert.ok(at.length >= 2, `${type} frames`);
        for (let i = 1; i < at.length; i++) assert.ok(close(at[i] - at[i - 1], gap), `${name} ${type} at ${at[i]}: gap ${at[i] - at[i - 1]}`);
      };
      steps('viz.mi', 0.1);
      steps('viz.spec', 0.1);
      steps('viz.quality', 0.5);
    });

    test(`${name}: every frame agrees with itself the way the synthetic bridge's frames do`, () => {
      const r = run(name);
      let baseline = 'none';
      const ids = new Set<string>();
      for (const line of r.lines) {
        if (!line.frame || line.expect) continue;
        const f = line.frame;
        if (f.type === 'viz.meta') {
          baseline = String((f.baseline as Obj).state);
          if (f.filterBank !== undefined) assert.deepEqual(f.filterBank, FILTER_BANK, 'the six bands, exactly as the synthetic bridge sends them');
          assert.match(String(f.note), /not a measurement\./i);
        } else if (f.type === 'viz.mi') {
          const mi = f as unknown as VizMi & { fb?: { c3: number[]; c4: number[] } };
          assert.ok(close(mi.laterality, round1(mi.c4.mu - mi.c3.mu), 0.051), `laterality at ${line.at}`);
          assert.equal(mi.emgGate, (mi.emg as number) > (mi.emgThreshold as number), `emgGate at ${line.at}`);
          assert.equal(mi.emgThreshold, 40);
          if (mi.fb) {
            for (const side of ['c3', 'c4'] as const) {
              const row = mi.fb[side];
              assert.equal(row.length, FILTER_BANK.length);
              assert.equal(mi[side].mu, row[BAND.b8_12], 'mu is the 8-12 Hz band');
              const beta = mean(['b12_16', 'b16_20', 'b20_26', 'b26_30'].map((b) => row[BAND[b]]));
              // Compared with the unrounded mean, as check_viz_bridge.py does: Python rounds halves to even.
              assert.ok(close(mi[side].beta, beta, 0.051), `beta at ${line.at}`);
            }
          }
          if (baseline !== 'set') {
            assert.equal(mi.baselineAgeS, null);
            assert.deepEqual([mi.c3.mu, mi.c3.beta, mi.c4.mu, mi.c4.beta, mi.laterality], [0, 0, 0, 0, 0]);
          } else assert.equal(typeof mi.baselineAgeS, 'number');
        } else if (f.type === 'viz.spec') {
          assert.deepEqual(f.freqs, Array.from({ length: 40 }, (_, i) => i + 1));
          assert.equal((f.c3 as number[]).length, 40);
        } else if (f.type === 'viz.marker') {
          const id = String(f.id);
          assert.match(id, UUID4);
          assert.ok(!ids.has(id), 'marker ids are unique');
          ids.add(id);
          // PLAN D21: the lowest an imagery YES or NO can carry is the 10 s fallback's 0.65.
          if (f.source === 'imagery') assert.ok(typeof f.confidence === 'number' && f.confidence >= 0.65 && f.confidence <= 1);
          if (f.source === 'jaw') {
            assert.ok(f.command === 'CONFIRM' || f.command === 'STOP');
            assert.equal(f.confidence, null);
          }
        }
      }
    });

    test(`${name}: the screen shows what the scenario is for`, () => {
      const check = CHECKS[name];
      assert.ok(check, `no checks for ${name}`);
      check(run(name));
    });
  }
});

/* ---------- 12-malformed through the real VizStream, binary frames included ---------- */

class FakeSocket {
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  readyState = 0;
  constructor(readonly url: string) {}
  send() {}
  close() {
    this.readyState = 3;
  }
}

describe('12-malformed through VizStream', () => {
  test('binary frames are dropped before applyFrame, and the screen ends where the applyFrame run ends', () => {
    let clock = 0;
    let socket: FakeSocket | null = null;
    const deps: StreamDeps = {
      createSocket: (url) => (socket = new FakeSocket(url)),
      setTimeout: () => 0,
      clearTimeout: () => {},
      now: () => clock,
    };
    const stream = new VizStream('ws://127.0.0.1:8766', deps);
    stream.start();
    const ws = socket as unknown as FakeSocket;
    ws.readyState = 1;
    ws.onopen?.({});
    const lines = LINES.get('12-malformed') as Line[];
    let binary = 0;
    for (const line of lines.slice(1)) {
      clock = clockAt(line.at);
      const before = stream.state.version;
      if (line.bytes !== undefined) {
        binary++;
        const data = Uint8Array.from(Buffer.from(line.bytes, 'hex')).buffer;
        ws.onmessage?.({ data });
        assert.equal(stream.state.version, before, 'a binary frame changes nothing');
      } else {
        ws.onmessage?.({ data: wire(line) });
        assert.equal(stream.state.version > before, line.expect !== 'reject', `at ${line.at}: ${line.why ?? String(line.frame?.type)}`);
      }
    }
    assert.equal(binary, 2);
    const ref = run('12-malformed').state;
    assert.deepEqual(stream.state.meta, ref.meta);
    assert.deepEqual(stream.state.mi, ref.mi);
    assert.deepEqual(stream.state.markers, ref.markers);
    assert.deepEqual(stream.state.quality, ref.quality);
    const view = buildBrainView(inputOf(stream.state, clock + RENDER_MS));
    assert.equal(view.state, 'measuring');
    stream.stop();
  });
});
