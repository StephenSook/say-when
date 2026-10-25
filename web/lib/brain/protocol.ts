/**
 * The Screen 1 stream on ws://127.0.0.1:8766 (tools/VIZ_PROTOCOL.md). It is separate from the station's gesture and
 * health channel on 8765, which Screen 1 never opens, and it never reaches SpacetimeDB or the cloud.
 *
 * Pure: parse and validate one text frame. Anything malformed or of an unknown type comes back as null and is ignored,
 * so a newer bridge can add message types without breaking this page. ERD% is the change in band power against the
 * wearer's own rest baseline, (A - R) / R x 100: negative means the rhythm quieted.
 *
 * The filter bank (viz.meta filterBank, viz.mi fb) is optional: a bridge that leaves it out still works, and the glow
 * then reads mu. When it is there, the glow reads the decoder's own 8 to 12 Hz band (glowErd).
 */

export type VizSource = 'live' | 'replay' | 'synthetic';
export type BaselineState = 'none' | 'recording' | 'set';
export type BrainTestState = 'not_run' | 'passed' | 'failed';
export type Contact = 'good' | 'fair' | 'poor' | 'off';
/**
 * The 8765 words the decoder republishes as markers (tools/VIZ_PROTOCOL.md 3.5): direct select (D18, `live.py --mode
 * direct`) sends PICK_1 to PICK_4, STOP and HEADSET_OFF; the scan map (`--mode scan`) sends YES, NO, CONFIRM, STOP.
 */
export type DecoderCommand = 'PICK_1' | 'PICK_2' | 'PICK_3' | 'PICK_4' | 'YES' | 'NO' | 'CONFIRM' | 'STOP' | 'HEADSET_OFF';
export type Side = 'c3' | 'c4';

/** One band of the decoder's filter bank, in display order. */
export interface FilterBand {
  /** Short key, unique in the bank, for example "b8_12". */
  id: string;
  /** Band edges in Hz. */
  lo: number;
  hi: number;
  /** Plain words for the chart, for example "Mu 8-12 Hz". */
  label: string;
}

/** ERD% per filter-bank band, same order as meta.filterBank. null where the decoder did not compute that band. */
export interface FilterBankErd {
  c3: (number | null)[];
  c4: (number | null)[];
}

export interface VizMeta {
  type: 'viz.meta';
  v: 1;
  source: VizSource;
  board: string;
  srate: number;
  channels: string[];
  units: string;
  /** What filter the bridge really runs, shown as is on the frequency strip. */
  traceFilter: string;
  bands: { alphaMu: [number, number]; beta: [number, number] };
  /** The decoder's filter bank, 1 to 12 bands in display order; null when the bridge does not send one. */
  filterBank: FilterBand[] | null;
  baseline: { state: BaselineState; recordedAt: number | null };
  /** Replay only: when the recording was made (unix seconds). */
  recordedAt: number | null;
  brainTest: { state: BrainTestState; summary: string | null };
  note: string | null;
}

export interface BandErd {
  mu: number;
  beta: number;
}

export interface VizMi {
  type: 'viz.mi';
  /** Decoder time, unix seconds. */
  t: number;
  c3: BandErd;
  c4: BandErd;
  /** ERD%(C4 mu) minus ERD%(C3 mu). A feature, never the decoder's verdict. */
  laterality: number;
  emgGate: boolean;
  baselineAgeS: number | null;
  /** Jaw muscle level, microvolts RMS, when the bridge sends it. */
  emg: number | null;
  emgThreshold: number | null;
  /**
   * ERD% per filter-bank band at each side, or null when the bridge does not send it. The parser checks that c3 and
   * c4 have the same length; the client (stream.ts) sets it to null when that length does not match meta.filterBank.
   */
  fb: FilterBankErd | null;
}

export interface VizSpec {
  type: 'viz.spec';
  t: number;
  /** Bin centers in Hz. */
  freqs: number[];
  /** log10 power per bin, uV^2/Hz. */
  c3: number[];
  c4: number[];
}

export interface VizQuality {
  type: 'viz.quality';
  t: number;
  contact: Record<string, Contact>;
}

export interface VizMarker {
  type: 'viz.marker';
  t: number;
  id: string;
  command: DecoderCommand;
  confidence: number | null;
  /** imagery, jaw, key or switch; any other string is shown as is. */
  source: string;
}

export type VizMessage = VizMeta | VizMi | VizSpec | VizQuality | VizMarker;

const SOURCES: readonly VizSource[] = ['live', 'replay', 'synthetic'];
const BASELINE_STATES: readonly BaselineState[] = ['none', 'recording', 'set'];
const BRAIN_TEST_STATES: readonly BrainTestState[] = ['not_run', 'passed', 'failed'];
const CONTACTS: readonly Contact[] = ['good', 'fair', 'poor', 'off'];
const COMMANDS: readonly DecoderCommand[] = ['PICK_1', 'PICK_2', 'PICK_3', 'PICK_4', 'YES', 'NO', 'CONFIRM', 'STOP', 'HEADSET_OFF'];

/** Bounds that keep a broken bridge from drawing nonsense. ERD% below -100 is impossible; a huge rise is clipped. */
const ERD_MIN = -100;
const ERD_MAX = 1000;
const MAX_BINS = 256;
const MAX_CHANNELS = 64;
const MAX_TEXT = 200;
export const MAX_FILTER_BANDS = 12;
const BAND_ID = /^[a-z0-9_]{1,16}$/;
const MAX_BAND_HZ = 200;
const MAX_BAND_LABEL = 24;
/** The band the brain glow reads when the bridge sends a filter bank: mu, 8 to 12 Hz. */
export const GLOW_BAND_ID = 'b8_12';

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown, max = MAX_TEXT): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function erd(value: unknown): number | null {
  const n = num(value);
  return n === null || n < ERD_MIN || n > ERD_MAX ? null : n;
}

function bandErd(value: unknown): BandErd | null {
  if (!isObj(value)) return null;
  const mu = erd(value.mu);
  const beta = erd(value.beta);
  return mu === null || beta === null ? null : { mu, beta };
}

function range(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const lo = num(value[0]);
  const hi = num(value[1]);
  return lo === null || hi === null || lo < 0 || hi <= lo ? null : [lo, hi];
}

function numbers(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BINS) return null;
  const out: number[] = [];
  for (const item of value) {
    const n = num(item);
    if (n === null) return null;
    out.push(n);
  }
  return out;
}

function nullableNum(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  const n = num(value);
  return n === null ? undefined : n;
}

/** meta.filterBank: null when absent, undefined when present but invalid (which makes the whole meta invalid). */
function filterBank(value: unknown): FilterBand[] | null | undefined {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILTER_BANDS) return undefined;
  const out: FilterBand[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!isObj(item)) return undefined;
    const id = typeof item.id === 'string' && BAND_ID.test(item.id) ? item.id : null;
    const lo = num(item.lo);
    const hi = num(item.hi);
    const label = text(item.label, MAX_BAND_LABEL);
    if (id === null || ids.has(id) || lo === null || hi === null || lo < 0 || hi <= lo || hi > MAX_BAND_HZ || label === null) {
      return undefined;
    }
    ids.add(id);
    out.push({ id, lo, hi, label });
  }
  return out;
}

function bandValues(value: unknown): (number | null)[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILTER_BANDS) return null;
  const out: (number | null)[] = [];
  for (const item of value) {
    if (item === null) {
      out.push(null);
      continue;
    }
    const n = erd(item);
    if (n === null) return null;
    out.push(n);
  }
  return out;
}

/** viz.mi fb: null when absent, undefined when present but invalid (which makes the whole frame invalid). */
function filterBankErd(value: unknown): FilterBankErd | null | undefined {
  if (value === undefined || value === null) return null;
  if (!isObj(value)) return undefined;
  const c3 = bandValues(value.c3);
  const c4 = bandValues(value.c4);
  if (!c3 || !c4 || c3.length !== c4.length) return undefined;
  return { c3, c4 };
}

function parseMeta(o: Obj): VizMeta | null {
  if (o.v !== 1) return null;
  const source = oneOf(o.source, SOURCES);
  const srate = num(o.srate);
  if (!source || srate === null || srate <= 0) return null;
  if (!Array.isArray(o.channels) || o.channels.length > MAX_CHANNELS) return null;
  const channels: string[] = [];
  for (const ch of o.channels) {
    const name = text(ch, 16);
    if (!name) return null;
    channels.push(name);
  }
  if (!isObj(o.bands) || !isObj(o.baseline)) return null;
  const alphaMu = range(o.bands.alpha_mu);
  const beta = range(o.bands.beta);
  const baselineState = oneOf(o.baseline.state, BASELINE_STATES);
  const baselineAt = nullableNum(o.baseline.recordedAt);
  const recordedAt = nullableNum(o.recordedAt);
  if (!alphaMu || !beta || !baselineState || baselineAt === undefined || recordedAt === undefined) return null;
  const bank = filterBank(o.filterBank);
  if (bank === undefined) return null;
  let brainTest: VizMeta['brainTest'] = { state: 'not_run', summary: null };
  if (o.brainTest !== undefined && o.brainTest !== null) {
    if (!isObj(o.brainTest)) return null;
    const state = oneOf(o.brainTest.state, BRAIN_TEST_STATES);
    if (!state) return null;
    brainTest = { state, summary: text(o.brainTest.summary) };
  }
  return {
    type: 'viz.meta',
    v: 1,
    source,
    board: text(o.board, 64) ?? 'unknown board',
    srate,
    channels,
    units: text(o.units, 16) ?? 'uV',
    traceFilter: text(o.traceFilter) ?? 'not stated',
    bands: { alphaMu, beta },
    filterBank: bank,
    baseline: { state: baselineState, recordedAt: baselineAt },
    recordedAt,
    brainTest,
    note: text(o.note),
  };
}

function parseMi(o: Obj): VizMi | null {
  const t = num(o.t);
  const c3 = bandErd(o.c3);
  const c4 = bandErd(o.c4);
  const laterality = num(o.laterality);
  if (t === null || !c3 || !c4 || laterality === null || typeof o.emgGate !== 'boolean') return null;
  const baselineAgeS = nullableNum(o.baselineAgeS);
  const emg = nullableNum(o.emg);
  const emgThreshold = nullableNum(o.emgThreshold);
  const fb = filterBankErd(o.fb);
  if (baselineAgeS === undefined || emg === undefined || emgThreshold === undefined || fb === undefined) return null;
  return { type: 'viz.mi', t, c3, c4, laterality, emgGate: o.emgGate, baselineAgeS, emg, emgThreshold, fb };
}

function parseSpec(o: Obj): VizSpec | null {
  const t = num(o.t);
  const freqs = numbers(o.freqs);
  const c3 = numbers(o.c3);
  const c4 = numbers(o.c4);
  if (t === null || !freqs || !c3 || !c4) return null;
  if (c3.length !== freqs.length || c4.length !== freqs.length) return null;
  return { type: 'viz.spec', t, freqs, c3, c4 };
}

function parseQuality(o: Obj): VizQuality | null {
  const t = num(o.t);
  if (t === null || !isObj(o.contact)) return null;
  const contact: Record<string, Contact> = {};
  const entries = Object.entries(o.contact);
  if (entries.length > MAX_CHANNELS) return null;
  for (const [name, value] of entries) {
    const state = oneOf(value, CONTACTS);
    if (!state || name.length > 16) return null;
    contact[name] = state;
  }
  return { type: 'viz.quality', t, contact };
}

function parseMarker(o: Obj): VizMarker | null {
  const t = num(o.t);
  const id = text(o.id, 64);
  const command = oneOf(o.command, COMMANDS);
  const confidence = nullableNum(o.confidence);
  const source = text(o.source, 32);
  if (t === null || !id || !command || confidence === undefined || !source) return null;
  if (confidence !== null && (confidence < 0 || confidence > 1)) return null;
  return { type: 'viz.marker', t, id, command, confidence, source };
}

/** One text frame in, one message or null out. Never throws. */
export function parseVizMessage(raw: string): VizMessage | null {
  if (raw.length > 64_000) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(data)) return null;
  switch (data.type) {
    case 'viz.meta':
      return parseMeta(data);
    case 'viz.mi':
      return parseMi(data);
    case 'viz.spec':
      return parseSpec(data);
    case 'viz.quality':
      return parseQuality(data);
    case 'viz.marker':
      return parseMarker(data);
    default:
      return null;
  }
}

/** True when fb has one entry per band of meta.filterBank. Otherwise the client ignores fb. */
export function filterBankFits(meta: VizMeta | null, fb: FilterBankErd | null): boolean {
  const bands = meta?.filterBank;
  return !!bands && !!fb && fb.c3.length === bands.length && fb.c4.length === bands.length;
}

/**
 * The ERD% the brain glow uses for one side: the decoder's own 8 to 12 Hz filter-bank value (GLOW_BAND_ID) when
 * meta.filterBank has that band and mi.fb has a number there, else the older mu field. One rule, so the glow and the
 * band rows can never disagree. It says nothing about the muscle gate: while emgGate is true no band is brain.
 */
export function glowErd(mi: VizMi, meta: VizMeta | null, side: Side): number {
  const bands = meta?.filterBank;
  const values = mi.fb?.[side];
  if (bands && values && filterBankFits(meta, mi.fb)) {
    const i = bands.findIndex((band) => band.id === GLOW_BAND_ID);
    const value = i < 0 ? null : values[i];
    if (typeof value === 'number') return value;
  }
  return mi[side].mu;
}

/** The only message this page sends: start a fresh rest baseline. */
export const BASELINE_COMMAND = JSON.stringify({ type: 'viz.cmd', cmd: 'baseline' });

/** Loopback only. */
export const DEFAULT_VIZ_URL = 'ws://127.0.0.1:8766';
