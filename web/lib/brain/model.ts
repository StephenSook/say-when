/**
 * Screen 1, the live brain: every rule and every word on the screen, with no React and no three.js, so a test can
 * check them. The brain glows only from measured numbers (the 8-12 Hz mu change at C3 and C4 against the wearer's
 * rest baseline). The decoder's guess is a separate event, and the jaw clench is a muscle signal that never touches
 * the brain. The brain has no yes area: we chose right fist = YES.
 */
import { glowErd, type BaselineState, type DecoderCommand, type VizMarker, type VizMeta, type VizMi } from './protocol';

/* ---------- Colors: hue says which hand, brightness says how much ---------- */

/** C3 patch: right-fist imagery, which Eleven maps to YES. */
export const CYAN = '#38e1ff';
/** C4 patch: left-fist imagery, mapped to NO. */
export const AMBER = '#ffb020';

/* ---------- Timing ---------- */

/** No viz.mi for this long means NO SIGNAL: patches go neutral and old values are cleared. */
export const STALE_MS = 500;
/** 40% suppression is full brightness. A starting value; tune it at calibration. */
export const FULL_SCALE_PCT = 40;
/** How long a decoder guess stays on the card and how long its ring pulse plays. */
export const GUESS_SHOW_MS = 4000;
export const PULSE_MS = 900;
/** When the brain test failed today, the rhythm still shows, dimmed, as an experiment only. */
export const FAILED_TEST_DIM = 0.35;

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Patch brightness from one ERD% value: only quieting (negative ERD) glows, on the same scale for both sides. */
export function patchIntensity(muErdPct: number, fullScalePct = FULL_SCALE_PCT): number {
  if (!Number.isFinite(muErdPct) || fullScalePct <= 0) return 0;
  return clamp01(-muErdPct / fullScalePct);
}

/* ---------- Geometry: the one place the left and right convention lives ---------- */

export type Vec3 = [number, number, number];

/**
 * Standard 10-20 positions on a unit sphere, from MNE's spherical_1020.tsv (x toward the subject's right, y anterior,
 * z up). 10-10 sites are the normalized midpoint of their two 10-20 neighbours, close enough for a template drawing.
 */
const SITES_1020: Record<string, Vec3> = {
  Fp1: [-0.2939, 0.9045, 0.309],
  Fp2: [0.2939, 0.9045, 0.309],
  F3: [-0.4591, 0.58, 0.673],
  F4: [0.4591, 0.58, 0.673],
  Fz: [0, 0.5878, 0.809],
  T7: [-0.9511, 0, 0.309],
  C3: [-0.5878, 0, 0.809],
  Cz: [0, 0, 1],
  C4: [0.5878, 0, 0.809],
  T8: [0.9511, 0, 0.309],
  P3: [-0.4591, -0.58, 0.673],
  Pz: [0, -0.5878, 0.809],
  P4: [0.4591, -0.58, 0.673],
  O1: [-0.2939, -0.9045, 0.309],
  Oz: [0, -0.9511, 0.309],
  O2: [0.2939, -0.9045, 0.309],
};

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function midpoint(a: string, b: string): Vec3 {
  const p = SITES_1020[a];
  const q = SITES_1020[b];
  return normalize([p[0] + q[0], p[1] + q[1], p[2] + q[2]]);
}

export const ELECTRODES: Record<string, Vec3> = {
  ...SITES_1020,
  FC3: midpoint('F3', 'C3'),
  FC4: midpoint('F4', 'C4'),
  FCz: midpoint('Fz', 'Cz'),
  CP3: midpoint('C3', 'P3'),
  CP4: midpoint('C4', 'P4'),
  CPz: midpoint('Cz', 'Pz'),
  C1: midpoint('C3', 'Cz'),
  C2: midpoint('Cz', 'C4'),
};

/**
 * Head coordinates (x right, y anterior, z up) to the scene: the subject's right is +X, up is +Y, anterior is -Z.
 * A proper rotation (no mirror), so the subject's left, where C3 sits, is always negative x. The brain model is baked
 * into the same frame (tools/brain-asset).
 */
export function toScene([x, y, z]: Vec3): Vec3 {
  return [x, z, -y];
}

/** Unit direction from the brain center toward an electrode, after stretching the sphere onto the brain's ellipsoid. */
export function electrodeDirection(name: string, halfExtents: Vec3): Vec3 | null {
  const head = ELECTRODES[name];
  if (!head) return null;
  const [x, y, z] = toScene(head);
  return normalize([x * halfExtents[0], y * halfExtents[1], z * halfExtents[2]]);
}

/**
 * The standard EEG top view: from above and slightly behind the head, so the nose points to the top of the screen,
 * C3 (the subject's left) is on the screen's left and C4 on its right, as in every 10-20 diagram. Anterior is -Z.
 * No auto-rotate during trials.
 */
export const CAMERA_POSITION: Vec3 = [0, 3.2, 1.35];

/** The screen's rightward direction for a camera looking at the origin with +Y up. */
export function screenRight(camera: Vec3, target: Vec3 = [0, 0, 0]): Vec3 {
  const f = normalize([target[0] - camera[0], target[1] - camera[1], target[2] - camera[2]]);
  // forward x up, with up = (0, 1, 0)
  return normalize([-f[2], 0, f[0]]);
}

export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/* ---------- Words: few and short (docs/ui.md rule zero); the long version lives in the info dialog ---------- */

export const LABELS = {
  title: 'Live brain',
  subtitle: 'Template brain, not a scan. Glow = 8-12 Hz rhythm quieting vs rest.',
  legendC3: 'C3 right-fist imagery (YES)',
  legendC4: 'C4 left-fist imagery (NO)',
  /** The full honest legend, in the info dialog. */
  explain:
    'Cyan: right-fist imagery (YES). Amber: left-fist imagery (NO). Glow = 8-12 Hz rhythm quieting vs rest. No yes area in the brain. Jaw lane = muscle, not brain.',
  jawLane: 'Jaw muscle, not brain',
  muscle: 'Muscle detected. Brain readings paused.',
  testFailed: 'Brain test failed. YES is a jaw clench today.',
  sceneFailed: '3D view unavailable. Readings below are live.',
} as const;

export function caption(wearer: string | null): string {
  return wearer ? `Template brain, not ${wearer}'s brain or a scan.` : 'Template brain, not a scan.';
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Local wall clock, HH:MM:SS. */
export function clockText(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Local wall clock, HH:MM. */
export function minuteText(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Whole percent with a real minus sign: "−23%", "+4%", "0%". */
export function pctText(v: number): string {
  const r = Math.round(v);
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r)}%`;
}

export type ModeKind = 'live' | 'replay' | 'synthetic' | 'none';

/** The one pill on the right of the title row. Never calls a replay or a test signal live. */
export function modeBadge(meta: VizMeta | null): { kind: ModeKind; text: string } {
  if (!meta) return { kind: 'none', text: 'No headset stream' };
  if (meta.source === 'live') return { kind: 'live', text: 'Live headset' };
  if (meta.source === 'replay') return { kind: 'replay', text: meta.recordedAt === null ? 'Replay' : `Replay, recorded ${minuteText(meta.recordedAt)}` };
  return { kind: 'synthetic', text: 'Synthetic test signal' };
}

export function baselineText(state: BaselineState, recordedAt: number | null): string {
  if (state === 'set') return recordedAt === null ? 'Rest baseline recorded' : `Rest baseline recorded ${minuteText(recordedAt)}`;
  if (state === 'recording') return 'Recording rest baseline';
  return 'No rest baseline';
}

export function brainTestText(meta: VizMeta | null): string | null {
  if (!meta) return null;
  const { state, summary } = meta.brainTest;
  if (state === 'passed') return summary ? `Brain test passed: ${summary}` : 'Brain test passed';
  if (state === 'failed') return summary ? `Brain test failed: ${summary}` : 'Brain test failed';
  return 'Brain test not run yet';
}

const SOURCE_WORDS: Record<string, string> = {
  imagery: 'imagined squeeze',
  jaw: 'jaw muscle',
  key: 'key press',
  switch: 'USB switch',
};

export function sourceText(source: string): string {
  return SOURCE_WORDS[source] ?? source;
}

/** Only an imagined YES or NO pulses on the brain; jaw, key and switch commands never do. */
export function pulseSide(marker: Pick<VizMarker, 'command' | 'source'>): 'c3' | 'c4' | null {
  if (marker.source !== 'imagery') return null;
  if (marker.command === 'YES') return 'c3';
  if (marker.command === 'NO') return 'c4';
  return null;
}

const JAW_COMMANDS: readonly DecoderCommand[] = ['CONFIRM', 'STOP'];

export function isJawCommand(command: DecoderCommand): boolean {
  return JAW_COMMANDS.includes(command);
}

/** The guess pill: the decoder's guess, never a claim about what the person thinks. */
export function guessText(marker: VizMarker): string {
  if (marker.command === 'HEADSET_OFF') return 'Headset off';
  if (isJawCommand(marker.command)) return `Jaw ${marker.command}`;
  if (marker.source === 'imagery') return marker.confidence === null ? `Guess ${marker.command}` : `Guess ${marker.command} ${marker.confidence.toFixed(2)}`;
  return `${marker.command}, ${sourceText(marker.source)}`;
}

/** The short pill on the strip's timeline. */
export function eventPillText(marker: VizMarker): string {
  if (isJawCommand(marker.command) || marker.confidence === null) return marker.command;
  return `${marker.command} ${marker.confidence.toFixed(2)}`;
}

/* ---------- The screen state ---------- */

export type ScreenState = 'waiting' | 'no_signal' | 'baseline' | 'muscle' | 'measuring';

/** The one line on the stage, shown only when something needs attention. `status` picks the shared StatusMark. */
export interface StateLine {
  status: 'working' | 'failed' | 'stopped' | 'refused';
  text: string;
  /** Raw detail for the tooltip. */
  detail?: string;
}

export interface PatchView {
  /** 0..1, what the shader draws. */
  intensity: number;
  /** The 8-12 Hz change from rest, or null when it must not be shown (no signal, no baseline, muscle). */
  value: number | null;
  valueText: string;
}

export interface BrainView {
  state: ScreenState;
  mode: { kind: ModeKind; text: string };
  stateLine: StateLine | null;
  /** True when there is no rest baseline: the stage offers "Record". */
  needsBaseline: boolean;
  c3: PatchView;
  c4: PatchView;
  /** For the info dialog. */
  details: { baseline: string; brainTest: string | null; laterality: string | null; frameAge: string };
}

export interface BrainInput {
  connected: boolean;
  meta: VizMeta | null;
  mi: VizMi | null;
  /** Browser clock (ms) when the last viz.mi arrived. */
  miAt: number | null;
  /** Browser clock (ms) when any message last arrived. */
  lastAt: number | null;
  now: number;
}

const NO_READING: PatchView = { intensity: 0, value: null, valueText: 'no reading' };

/**
 * Which state the screen is in and how much of the measured glow may show. One rule, used by the words
 * (buildBrainView) and by the 3D scene every frame (patchTargets), so the two can never disagree. A jaw clench lights
 * up the 20 to 30 Hz bands, so while the muscle gate is on nothing shows as brain activity.
 */
export function classify(input: BrainInput): { state: ScreenState; scale: number; ageMs: number | null } {
  const { meta, mi, miAt, now } = input;
  const ageMs = miAt === null ? null : now - miAt;
  if (!input.connected || !meta) return { state: 'waiting', scale: 0, ageMs };
  if (!mi || ageMs === null || ageMs > STALE_MS) return { state: 'no_signal', scale: 0, ageMs };
  if (meta.baseline.state !== 'set') return { state: 'baseline', scale: 0, ageMs };
  if (mi.emgGate) return { state: 'muscle', scale: 0, ageMs };
  return { state: 'measuring', scale: meta.brainTest.state === 'failed' ? FAILED_TEST_DIM : 1, ageMs };
}

/** The two numbers the shader draws, 0..1 each, from the 8-12 Hz change at C3 and C4. */
export function patchTargets(input: BrainInput): { c3: number; c4: number } {
  const { state, scale } = classify(input);
  if (state !== 'measuring' || !input.mi) return { c3: 0, c4: 0 };
  return {
    c3: patchIntensity(glowErd(input.mi, input.meta, 'c3')) * scale,
    c4: patchIntensity(glowErd(input.mi, input.meta, 'c4')) * scale,
  };
}

function patch(value: number, scale: number): PatchView {
  return { intensity: patchIntensity(value) * scale, value, valueText: pctText(value) };
}

export function buildBrainView(input: BrainInput): BrainView {
  const { meta, mi, lastAt, now } = input;
  const { state, scale, ageMs } = classify(input);
  const connectedMeta = input.connected ? meta : null;
  const testFailed = connectedMeta?.brainTest.state === 'failed';
  const details = {
    baseline: meta ? baselineText(meta.baseline.state, meta.baseline.recordedAt) : 'No rest baseline',
    brainTest: brainTestText(connectedMeta),
    laterality: state === 'measuring' && mi ? `Left vs right difference ${mi.laterality >= 0 ? '+' : '−'}${Math.abs(mi.laterality).toFixed(1)}` : null,
    frameAge: lastAt === null ? 'No frames yet' : `Frame age ${Math.round(Math.max(0, now - lastAt))} ms`,
  };
  const base = { state, mode: modeBadge(connectedMeta), needsBaseline: !!connectedMeta && connectedMeta.baseline.state === 'none', details };

  if (state !== 'measuring' || !mi) {
    let stateLine: StateLine;
    if (state === 'waiting') stateLine = { status: 'working', text: 'Waiting for the headset' };
    else if (state === 'no_signal') stateLine = { status: 'failed', text: 'No signal', detail: ageMs === null ? 'No data yet' : `No data for ${Math.round(ageMs)} ms` };
    else if (state === 'baseline')
      stateLine = meta?.baseline.state === 'recording' ? { status: 'working', text: 'Recording rest baseline' } : { status: 'stopped', text: 'No rest baseline' };
    else stateLine = { status: 'stopped', text: LABELS.muscle };
    return { ...base, stateLine, c3: NO_READING, c4: NO_READING };
  }
  return {
    ...base,
    stateLine: testFailed ? { status: 'refused', text: LABELS.testFailed } : null,
    c3: patch(glowErd(mi, meta, 'c3'), scale),
    c4: patch(glowErd(mi, meta, 'c4'), scale),
  };
}

/** Reconnect delay: 250 ms, doubling, capped at 2 s. */
export function nextBackoff(previousMs: number | null): number {
  if (previousMs === null) return 250;
  return Math.min(2000, previousMs * 2);
}
