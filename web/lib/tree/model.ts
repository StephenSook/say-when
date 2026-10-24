/**
 * The Suggested replies tree (Screen 2): a pure function of the rows every other screen reads. No React, no clock.
 *
 * What it draws, for the focused question (the turn the scan is on while it runs, else the newest question):
 * - The question at the root, then three jobs, titled by what they do, since one agent sidecar does all three:
 *   "Looking up saved notes" (Moss, the retrieve steps), "Checking facts on the web" (Apify, the search steps) and
 *   "Drafting options" (the plan steps; "Claude" only when a row says so).
 * - Each region's children come from the rows: saved notes from the recall hits (words only when the person shared
 *   them), web results from the search rows, capped at three slots with "+N more".
 * - Up to four options, each with where it came from. A select row is the pick: that option is picked, its siblings
 *   dim, and what happened next grows beside it only as its rows exist (said out loud, or an errand or a call with
 *   its read-back, confirm window and result). A follow-up drafting round grows to the right of the pick.
 * - Statuses come from rows only: started is Working, ok is Done, error is Failed, no row is Idle. Every status has a
 *   word and an icon on screen, never a color alone.
 *
 * Positions come from lib/tree/layout.ts, a fixed table plus slot functions, so a node that appears never moves
 * another. Motion is derived from rows too: `handoffs` names one dot per real handoff (keyed by the row that caused
 * it), `running` marks an edge whose next step is running now, and `camera` names what to frame, keyed so the
 * screen moves the camera only when a new row asks for it.
 *
 * Live rows carry the options of the scanned version only (lib/data/spacetime-map.ts), so a round whose options were
 * replaced by a follow-up keeps its slots as "Option N" with the pick's own words when the select row has them.
 */
import { signalPhrase, withSignal } from '../commands';
import { hitDisplay, latestOptions, latestQuestion } from '../data/derive';
import type {
  AnswerOption,
  CallRequest,
  DataRows,
  Errand,
  InputKind,
  OptionKind,
  PipelineEvent,
  Question,
  ScanOutcome,
  SourceRef,
} from '../data/types';
import { formatCount, formatSeconds, maskPhoneNumbers } from '../format';
import { callStatusWord } from '../status';
import {
  CHILD_SLOTS,
  draftRect,
  firstRoundRect,
  hubRect,
  lookupRect,
  OPTION_SLOTS,
  optionRect,
  optionsRect,
  questionRect,
  regionRect,
  roundEndRect,
  slot,
  stepRect,
  STEP_SLOTS,
  unionRect,
  type Rect,
  type SlotRegion,
} from './layout';

// ---------------------------------------------------------------------------------------------
// The tree's shape

/** A node's state. Every one is drawn with an icon and a word (TREE_STATUS_WORDS), never a color alone. */
export type TreeStatus = 'idle' | 'working' | 'waiting' | 'done' | 'failed' | 'stopped' | 'refused' | 'picked';

export const TREE_STATUS_WORDS: Readonly<Record<TreeStatus, string>> = {
  idle: 'Idle',
  working: 'Working',
  waiting: 'Waiting for confirm',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  refused: 'Refused',
  picked: 'Picked',
};

export type Job = SlotRegion | 'draft';

/** The three jobs, by what they do. One agent sidecar runs all three, so they are never called three agents. */
export const JOB_TITLES: Readonly<Record<Job, string>> = {
  notes: 'Looking up saved notes',
  web: 'Checking facts on the web',
  draft: 'Drafting options',
};

export const SCREEN_TITLE = 'Suggested replies';
export const SCREEN_SUBTITLE = "Drafted by AI from the person's saved notes and the web. The person decides.";
export const STOP_LINE = 'STOP: none of these';
export const IDLE_LINE = 'Waiting for a question';

interface NodeCommon {
  id: string;
  rect: Rect;
  status: TreeStatus;
  /** The status in words, shown next to its icon. */
  word: string;
  ariaLabel: string;
  /** Where the node grows from when it first appears: its parent's center, relative to its own center. */
  enterFrom: { dx: number; dy: number } | null;
  /** Its place in a burst of siblings, for a short stagger. */
  enterOrder: number;
}

export interface QuestionNode extends NodeCommon {
  kind: 'question';
  /** "Heard", "Typed", "From the person's menu", or the idle line. */
  label: string;
  tool: string | null;
  text: string;
  quoted: boolean;
  /** Counting up from here while the step runs. */
  since: number | null;
}

export interface RegionNode extends NodeCommon {
  kind: 'region';
  region: SlotRegion;
}

export interface HubNode extends NodeCommon {
  kind: 'hub';
  job: Job;
  round: number;
  title: string;
  tool: string | null;
  meta: string | null;
  since: number | null;
}

export interface ChildNode extends NodeCommon {
  kind: 'child';
  region: SlotRegion;
  title: string;
  meta: string | null;
  /** Words withheld or not shared: drawn muted. */
  muted: boolean;
}

export interface MoreNode extends NodeCommon {
  kind: 'more';
  region: SlotRegion;
  title: string;
  meta: string;
}

export type OptionState = 'idle' | 'reading' | 'picked' | 'dimmed';

export interface OptionNode extends NodeCommon {
  kind: 'option';
  round: number;
  rank: number;
  /** "Option 2 of 4". */
  heading: string;
  /** The option's words, or null when they are not on this screen. */
  text: string | null;
  /** Where it came from: "From the person's notes", "From the web: example.org", "Drafted". null for a stand-in. */
  source: string | null;
  /** "Errand" or "Call" when the option is not a reply. */
  tag: string | null;
  state: OptionState;
  /** On the picked option: "Picked by headset (YES). Spoken in the room." */
  pickLine: string | null;
}

export interface StepNode extends NodeCommon {
  kind: 'step';
  round: number;
  /** "Errand: Care team request", "Call: Demo caregiver". */
  eyebrow: string | null;
  title: string;
  meta: string | null;
  /** Words to quote, such as the reply said out loud. */
  text: string | null;
  since: number | null;
  /** A countdown ends here, for an open confirm window. */
  until: number | null;
}

export type TreeNode = QuestionNode | RegionNode | HubNode | ChildNode | MoreNode | OptionNode | StepNode;

export type EdgeTone = 'idle' | 'done' | 'picked' | 'dim';

export interface TreeEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: 'right' | 'bottom' | 'kids';
  targetHandle: 'left' | 'top';
  shape: 'curve' | 'branch' | 'straight';
  tone: EdgeTone;
  /** The step this edge leads to is running now: the only edges drawn with a moving dash. */
  running: boolean;
}

/** One dot along one edge, once, for one real handoff. `key` comes from the row that caused it. */
export interface Handoff {
  key: string;
  edgeId: string;
  tone: 'accent' | 'picked';
}

/**
 * What to frame. `rect` is the preferred view; `tight` is what to frame instead when `rect` would make the labels too
 * small for the screen. `nodeIds` (a pick, a confirmed errand) asks for React Flow's fitView on those nodes.
 */
export interface CameraTarget {
  key: string;
  intent: 'overview' | 'round' | 'pick' | 'confirm' | 'end';
  rect: Rect;
  tight: Rect;
  nodeIds: string[] | null;
}

export interface StopView {
  /** STOP ended this turn with none of these. */
  used: boolean;
  text: string;
  detail: string | null;
}

export interface ReplyTree {
  questionId: string | null;
  /** No question yet: nothing moves. */
  idle: boolean;
  nodes: TreeNode[];
  edges: TreeEdge[];
  handoffs: Handoff[];
  camera: CameraTarget;
  /** One sentence for the polite live region: the newest pick, confirm, end or failure. */
  announcement: string | null;
  stop: StopView;
  /** The picked option of the newest pick, for the screen's focus. */
  pickedId: string | null;
}

// ---------------------------------------------------------------------------------------------
// Reading loose producer values (rows may carry counts where lists are expected)

type Loose = Record<string, unknown>;

function loose(value: unknown): Loose {
  return value !== null && typeof value === 'object' ? (value as Loose) : {};
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function labelOf(event: PipelineEvent): string | null {
  return str(loose(event.detail).label)?.toLowerCase() ?? null;
}

function errorSentence(event: PipelineEvent | null, fallback: string): string {
  if (!event) return fallback;
  const error = loose(event.detail).error;
  if (typeof error === 'string') return str(error) ?? fallback;
  return str(loose(error).sentence) ?? fallback;
}

function quoted(value: string): string {
  return `"${value}"`;
}

function sentence(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

/** Free text as it may appear on a projected screen: trimmed, phone numbers hidden. */
function screenText(value: unknown): string | null {
  const text = str(value);
  return text ? maskPhoneNumbers(text) : null;
}

// ---------------------------------------------------------------------------------------------
// Runs of one job

interface Run {
  status: 'none' | 'working' | 'done' | 'failed';
  /** While working: when the open run started. */
  from: number | null;
  latest: PipelineEvent | null;
  /** The step's time once finished: its own ms, or first row to last for several runs. */
  ms: number | null;
  /** Some run finished ok (a search can fail while another comes back). */
  anyOk: boolean;
}

/**
 * The state of one job from its rows, oldest first. Runs can overlap (a web search and a Maps search side by side),
 * so started rows are counted against finished ones: Working while any run is open.
 */
function runOf(rows: readonly PipelineEvent[]): Run {
  let open = 0;
  let openFrom: number | null = null;
  for (const row of rows) {
    if (row.status === 'started') {
      if (open === 0) openFrom = row.at;
      open += 1;
    } else {
      open = Math.max(0, open - 1);
      if (open === 0) openFrom = null;
    }
  }
  const latest = rows[rows.length - 1] ?? null;
  if (!latest) return { status: 'none', from: null, latest: null, ms: null, anyOk: false };
  const finished = rows.filter((row) => row.status !== 'started');
  const anyOk = finished.some((row) => row.status === 'ok');
  if (open > 0) return { status: 'working', from: openFrom ?? latest.at, latest, ms: null, anyOk };
  const first = rows[0]!;
  const longest = Math.max(0, ...finished.map((row) => num(row.ms) ?? 0));
  const ms = finished.length > 1 ? Math.max(latest.at - first.at, longest) : (num(latest.ms) ?? (latest.at > first.at ? latest.at - first.at : null));
  const failedOnly = finished.length > 0 && !anyOk && finished.some((row) => row.status === 'error');
  return { status: failedOnly ? 'failed' : 'done', from: null, latest, ms, anyOk };
}

function timeWords(ms: number | null): string | null {
  return ms === null ? null : formatSeconds(ms);
}

function joinMeta(...parts: Array<string | null | undefined>): string | null {
  const kept = parts.filter((part): part is string => typeof part === 'string' && part !== '');
  return kept.length > 0 ? kept.join(' · ') : null;
}

// ---------------------------------------------------------------------------------------------
// Picks and rounds

interface Pick {
  optionId: string;
  rank: number | null;
  kind: OptionKind | null;
  text: string | null;
  /** The first select row for this option: the round boundary. */
  at: number;
  firstRowId: string;
  /** started: the veto is open (NO or STOP can still cancel a reply). ok: released. */
  status: 'started' | 'ok';
}

function optionKind(value: unknown): OptionKind | null {
  return value === 'reply' || value === 'errand' || value === 'call' || value === 'menu' ? value : null;
}

/**
 * Picks, oldest first: a select row names its option (module v2 writes select steps only for a pick; an older row
 * that names no option is not a pick). A select row that failed is a cancelled pick and splits nothing.
 */
function picksOf(events: readonly PipelineEvent[]): Pick[] {
  const byOption = new Map<string, Pick & { failed: boolean }>();
  const order: string[] = [];
  for (const event of events) {
    if (event.stage !== 'select') continue;
    const detail = loose(event.detail);
    const optionId = str(detail.optionId);
    if (!optionId) continue;
    const existing = byOption.get(optionId);
    if (!existing) {
      order.push(optionId);
      byOption.set(optionId, {
        optionId,
        rank: num(detail.rank),
        kind: optionKind(detail.kind),
        text: screenText(detail.text),
        at: event.at,
        firstRowId: event.id,
        status: event.status === 'ok' ? 'ok' : 'started',
        failed: event.status === 'error',
      });
      continue;
    }
    existing.rank = existing.rank ?? num(detail.rank);
    existing.kind = existing.kind ?? optionKind(detail.kind);
    existing.text = existing.text ?? screenText(detail.text);
    if (event.status === 'ok') existing.status = 'ok';
    existing.failed = event.status === 'error';
  }
  return order
    .map((id) => byOption.get(id)!)
    .filter((pick) => !pick.failed)
    .map(({ failed: _failed, ...pick }) => pick);
}

/** "Option 3" stands in for the words while the room's sharing is off (lib/data/spacetime-map.ts): no words then. */
function optionWords(option: AnswerOption): string | null {
  const text = screenText(option.text);
  if (text === null || text === `Option ${option.rank}`) return null;
  return text;
}

/** One option slot of a round: a real option row, or a stand-in once a later version replaced it on the board. */
interface Slotted {
  rank: number;
  of: number;
  option: AnswerOption | null;
}

interface Round {
  index: number;
  /** Rows at or after this time belong to this round (or a later one). */
  start: number;
  /** The pick that closed it, or null for the open round. */
  pick: Pick | null;
  /** This round's pick: its drafting rows come before it. +Infinity for the open round. */
  end: number;
  /** The next pick: what grew from this round's pick comes before it. */
  next: number;
  plan: PipelineEvent[];
  slots: Slotted[];
}

function slotsOf(options: readonly AnswerOption[]): Slotted[] {
  const ranked = options.filter((option) => option.rank >= 1 && option.rank <= OPTION_SLOTS);
  return ranked.map((option) => ({ rank: option.rank, of: options.length, option }));
}

// ---------------------------------------------------------------------------------------------
// Words

/**
 * How the person picked, in the session's true input: a key press never reads as a headset signal (docs/station.md
 * 2.3, lib/commands.ts).
 */
export function pickPhrase(input: InputKind): string {
  switch (input) {
    case 'headset':
      return 'Picked by headset (YES)';
    case 'keyboard':
      return 'Picked by key Y (keyboard test)';
    case 'switch':
      return 'Picked by a short switch press (YES)';
    default:
      return 'Picked with YES';
  }
}

function confirmedWords(input: InputKind): string {
  const phrase = signalPhrase('CONFIRM', input);
  return phrase ? `Confirmed with ${phrase}.` : 'Confirmed.';
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

function siteOf(source: SourceRef): string {
  if (source.source === 'maps') return 'Google Maps';
  return hostOf(source.url) ?? 'a web page';
}

/** Where an option came from, from its `sources` (PLAN.md Option row). */
export function sourceLine(option: AnswerOption, hasWords: boolean): string {
  if (option.kind === 'menu') return "From the person's menu";
  const sources = Array.isArray(option.sources) ? option.sources : [];
  const memory = sources.some((source) => source.source === 'memory');
  const sites = [...new Set(sources.filter((source) => source.source !== 'memory').map(siteOf))];
  const web = sites.length === 0 ? null : `the web: ${sites[0]}${sites.length > 1 && !memory ? ` and ${sites.length - 1} more` : ''}`;
  if (memory && web) return `From the person's notes and ${web}`;
  if (memory) return "From the person's notes";
  if (web) return `From ${web}`;
  // With the room's sharing off the board holds back sources along with the words.
  return hasWords ? 'Drafted' : 'Sources not shared on this screen';
}

const KIND_TAGS: Readonly<Record<OptionKind, string | null>> = { reply: null, errand: 'Errand', call: 'Call', menu: 'Menu' };

const ENDINGS: Readonly<Record<Exclude<ScanOutcome, 'picked'>, { title: string; meta: string }>> = {
  none: { title: STOP_LINE, meta: 'Nothing was said or sent.' },
  no_pick: { title: 'No pick', meta: 'Nothing was said or sent.' },
  stopped: { title: 'Stopped', meta: 'Nothing was said or sent.' },
  cancelled: { title: 'Cancelled', meta: 'The partner cancelled the question.' },
};

// ---------------------------------------------------------------------------------------------
// Building

function center(r: Rect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

function from(parent: Rect, own: Rect): { dx: number; dy: number } {
  const a = center(parent);
  const b = center(own);
  return { dx: Math.round(a.x - b.x), dy: Math.round(a.y - b.y) };
}

function aria(...parts: Array<string | null | undefined>): string {
  return parts
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .map((part) => sentence(part))
    .join(' ');
}

interface Context {
  question: Question;
  qid: string;
  events: PipelineEvent[];
  input: InputKind;
  /** Running steps can no longer finish after this moment (a newer question, or the scan ended without a pick). */
  cutAt: number | null;
}

/** Working, unless the run can no longer finish; then Stopped. */
function liveStatus(run: Run, ctx: Context): { status: TreeStatus; word: string } {
  if (run.status === 'working') {
    if (ctx.cutAt !== null && run.from !== null && ctx.cutAt >= run.from) return { status: 'stopped', word: 'Did not finish' };
    return { status: 'working', word: TREE_STATUS_WORDS.working };
  }
  if (run.status === 'failed') return { status: 'failed', word: TREE_STATUS_WORDS.failed };
  if (run.status === 'done') return { status: 'done', word: TREE_STATUS_WORDS.done };
  return { status: 'idle', word: TREE_STATUS_WORDS.idle };
}

function questionNode(ctx: Context | null): QuestionNode {
  const rect = questionRect();
  if (ctx === null) {
    return {
      kind: 'question',
      id: 'idle:question',
      rect,
      status: 'idle',
      word: TREE_STATUS_WORDS.idle,
      label: IDLE_LINE,
      tool: null,
      text: 'Nothing is being drafted.',
      quoted: false,
      since: null,
      ariaLabel: aria(IDLE_LINE, 'Nothing is being drafted'),
      enterFrom: null,
      enterOrder: 0,
    };
  }
  const { question } = ctx;
  const menu = question.origin === 'menu';
  const listen = ctx.events.filter((event) => event.stage === 'listen');
  const run = runOf(listen);
  const heard = run.latest ? screenText(loose(run.latest.detail).words) : null;
  const words = screenText(question.text) ?? heard;
  let { status, word } = liveStatus(run, ctx);
  // No speech step (a typed question with no row, or the person's menu): the question row itself is the start.
  if (run.status === 'none') ({ status, word } = { status: 'done', word: TREE_STATUS_WORDS.done });
  const label = menu ? "From the person's menu" : question.via === 'typed' ? 'Typed' : status === 'working' ? 'Listening' : 'Heard';
  const tool = menu ? "The person's menu" : question.via === 'typed' ? "Typed on the partner's phone" : 'Cartesia Ink-2';
  let text: string;
  let isQuoted = false;
  if (words) {
    text = quoted(words);
    isQuoted = true;
  } else if (status === 'working') {
    text = 'The partner is talking.';
  } else if (status === 'failed') {
    text = errorSentence(run.latest, 'Could not hear the question.');
  } else {
    text = question.number > 0 ? `Question ${question.number}` : 'A new question';
  }
  return {
    kind: 'question',
    id: `${ctx.qid}:question`,
    rect,
    status,
    word,
    label,
    tool,
    text,
    quoted: isQuoted,
    since: status === 'working' ? run.from : null,
    ariaLabel: aria(label, text, word, tool),
    enterFrom: null,
    enterOrder: 0,
  };
}

function regionNode(qid: string, region: SlotRegion): RegionNode {
  return {
    kind: 'region',
    id: `${qid}:${region}:box`,
    rect: regionRect(region),
    region,
    status: 'idle',
    word: '',
    ariaLabel: JOB_TITLES[region],
    enterFrom: null,
    enterOrder: 0,
  };
}

interface ChildItem {
  title: string;
  meta: string | null;
  muted: boolean;
}

interface RegionBuild {
  hub: HubNode;
  items: ChildItem[];
  /** The total the rows report, which can be more than the items listed. */
  total: number;
  firstRow: PipelineEvent | null;
  doneRow: PipelineEvent | null;
}

const WEB_RETRIEVE = /^web /;

function notesRegion(ctx: Context, rows: readonly PipelineEvent[]): RegionBuild {
  const run = runOf(rows);
  const menu = ctx.question.origin === 'menu';
  const items: ChildItem[] = [];
  const seen = new Set<string>();
  let counted: number | null = null;
  let off = false;
  for (const row of rows) {
    if (row.status !== 'ok') continue;
    const detail = loose(row.detail);
    if (labelOf(row) === 'memory off' || detail.memoryAllowed === false) off = true;
    const list = Array.isArray(detail.hits) ? detail.hits : null;
    if (list) {
      const hits = list
        .filter((hit): hit is Loose => hit !== null && typeof hit === 'object')
        // Web passages Moss returns belong to the web job; this region lists saved notes only.
        .filter((hit) => hit.origin !== 'web')
        .sort((a, b) => (num(b.score) ?? 0) - (num(a.score) ?? 0));
      for (const hit of hits) {
        const key = str(hit.id) ?? `hit:${items.length}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // The privacy rule in one place: words only when the person shared the note (hitDisplay).
        const shown = hitDisplay({
          id: key,
          origin: 'memory',
          memoryType: hit.memoryType === 'pref' || hit.memoryType === 'reply' ? hit.memoryType : undefined,
          sharedText: typeof hit.sharedText === 'string' ? hit.sharedText : undefined,
          score: num(hit.score) ?? 0,
        });
        items.push(
          shown.isPrivate
            ? { title: 'Private note', meta: shown.category, muted: true }
            : { title: quoted(maskPhoneNumbers(shown.text)), meta: shown.category, muted: false },
        );
      }
    } else {
      const n = num(detail.hitCount);
      if (n !== null) counted = (counted ?? 0) + n;
    }
  }
  const total = items.length > 0 ? items.length : (counted ?? 0);
  if (items.length === 0 && total > 0) {
    for (let i = 0; i < total; i++) items.push({ title: 'Saved note', meta: 'Words not shared on this screen', muted: true });
  }
  let { status, word } = liveStatus(run, ctx);
  let meta: string | null = null;
  if (run.status === 'none') {
    if (menu) word = 'Not needed';
  } else if (status === 'working') {
    meta = null;
  } else if (status === 'failed') {
    meta = errorSentence(run.latest, 'Could not look up saved notes.');
  } else if (status === 'stopped') {
    meta = 'Did not finish.';
  } else if (off && total === 0) {
    status = 'idle';
    word = 'Off';
    meta = 'Saved notes are off.';
  } else {
    meta = joinMeta(total === 0 ? 'No saved note matched' : formatCount(total, 'saved note'), timeWords(run.ms));
  }
  const tool = 'Moss';
  const hub: HubNode = {
    kind: 'hub',
    id: `${ctx.qid}:notes:hub`,
    rect: hubRect('notes'),
    job: 'notes',
    round: 1,
    title: JOB_TITLES.notes,
    tool,
    meta,
    since: status === 'working' ? run.from : null,
    status,
    word,
    ariaLabel: aria(JOB_TITLES.notes, tool, word, meta),
    enterFrom: null,
    enterOrder: 0,
  };
  return { hub, items, total, firstRow: rows[0] ?? null, doneRow: rows.find((row) => row.status !== 'started') ?? null };
}

function webRegion(ctx: Context, search: readonly PipelineEvent[], index: readonly PipelineEvent[]): RegionBuild {
  const all = [...search, ...index].sort((a, b) => a.at - b.at);
  const run = runOf(all);
  const menu = ctx.question.origin === 'menu';
  const items: ChildItem[] = [];
  const seen = new Set<string>();
  let counted: number | null = null;
  let searches = 0;
  let okCount = 0;
  let webCount = 0;
  let skipReason: string | null = null;
  let switchedOff = false;
  for (const row of search) {
    if (labelOf(row) === 'search off') switchedOff = true;
    if (row.status !== 'ok') continue;
    okCount += 1;
    const detail = loose(row.detail);
    if (detail.needsWeb === false) {
      skipReason = screenText(detail.reason) ?? skipReason;
      continue;
    }
    webCount += 1;
    searches += num(detail.searches) ?? 1;
    const list = Array.isArray(detail.rows) ? detail.rows : null;
    if (list) {
      for (const item of list) {
        if (item === null || typeof item !== 'object') continue;
        const found = item as Loose;
        const key = str(found.id) ?? `${String(found.source)}:${String(found.title)}:${items.length}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const site = found.source === 'maps' ? 'Google Maps' : (hostOf(str(found.url) ?? undefined) ?? 'The web');
        items.push({ title: screenText(found.title) ?? 'Untitled result', meta: site, muted: false });
      }
    } else {
      const n = num(detail.rowCount);
      if (n !== null) counted = (counted ?? 0) + n;
    }
  }
  const total = items.length > 0 ? items.length : (counted ?? 0);
  if (items.length === 0 && total > 0) {
    for (let i = 0; i < total; i++) items.push({ title: 'Web result', meta: 'Not shared on this screen', muted: true });
  }
  let { status, word } = liveStatus(run, ctx);
  let meta: string | null = null;
  if (run.status === 'none') {
    if (menu) word = 'Not needed';
  } else if (switchedOff && okCount === 0 && run.status !== 'working') {
    status = 'idle';
    word = 'Off';
    meta = 'Web search is off.';
  } else if (status === 'working') {
    meta = null;
  } else if (status === 'failed') {
    meta = errorSentence(run.latest, 'The web search failed.');
  } else if (status === 'stopped') {
    meta = 'Did not finish.';
  } else if (okCount > 0 && webCount === 0) {
    // PLAN D8: a question that needs no outside facts never waits on the web.
    status = 'idle';
    word = 'Not needed';
    meta = skipReason ? sentence(skipReason) : 'No outside facts were needed.';
  } else {
    const counts = total === 0 ? 'No results' : formatCount(total, 'result');
    meta = joinMeta(searches > 1 ? `${counts} from ${searches} searches` : counts, timeWords(run.ms));
  }
  const tool = index.length > 0 ? 'Apify and Moss' : 'Apify';
  const hub: HubNode = {
    kind: 'hub',
    id: `${ctx.qid}:web:hub`,
    rect: hubRect('web'),
    job: 'web',
    round: 1,
    title: JOB_TITLES.web,
    tool,
    meta,
    since: status === 'working' ? run.from : null,
    status,
    word,
    ariaLabel: aria(JOB_TITLES.web, tool, word, meta),
    enterFrom: null,
    enterOrder: 0,
  };
  return { hub, items, total, firstRow: all[0] ?? null, doneRow: all.find((row) => row.status !== 'started') ?? null };
}

/** A region's children in its fixed slots: all of them when they fit, else the first ones and "+N more" last. */
function childNodes(qid: string, region: SlotRegion, build: RegionBuild): Array<ChildNode | MoreNode> {
  const { items } = build;
  const fits = items.length <= CHILD_SLOTS;
  const shown = fits ? items : items.slice(0, CHILD_SLOTS - 1);
  const hub = build.hub.rect;
  const nodes: Array<ChildNode | MoreNode> = shown.map((item, i) => {
    const rect = slot(region, i);
    return {
      kind: 'child',
      id: `${qid}:${region}:c${i}`,
      rect,
      region,
      title: item.title,
      meta: item.meta,
      muted: item.muted,
      status: 'done',
      word: '',
      ariaLabel: aria(item.title, item.meta),
      enterFrom: from(hub, rect),
      enterOrder: i,
    };
  });
  if (!fits) {
    const rest = items.length - shown.length;
    const rect = slot(region, CHILD_SLOTS - 1);
    const noun = region === 'notes' ? formatCount(build.total, 'saved note') : formatCount(build.total, 'result');
    nodes.push({
      kind: 'more',
      id: `${qid}:${region}:more`,
      rect,
      region,
      title: `+${rest} more`,
      meta: `${noun} in all`,
      status: 'done',
      word: '',
      ariaLabel: aria(`${rest} more`, `${noun} in all`),
      enterFrom: from(hub, rect),
      enterOrder: CHILD_SLOTS - 1,
    });
  }
  return nodes;
}

function draftHub(ctx: Context, round: Round, optionCount: number, menu: boolean): HubNode {
  const run = runOf(round.plan);
  const claude = round.plan.some((event) => labelOf(event) === 'claude');
  // "Claude" only when a row says so (agent/src/jobs.ts labels its plan step `claude`); a stand-in agent is not Claude.
  const tool = run.status === 'none' ? (menu ? "The person's menu" : null) : claude ? 'Claude' : 'Agent';
  const followUp = round.index > 1;
  const title = followUp ? 'Drafting follow-up options' : JOB_TITLES.draft;
  let { status, word } = liveStatus(run, ctx);
  let meta: string | null = null;
  if (run.status === 'none') {
    if (optionCount > 0) {
      word = menu ? 'Not needed' : TREE_STATUS_WORDS.idle;
      meta = formatCount(optionCount, menu ? 'menu item' : 'option');
    }
  } else if (status === 'working') {
    meta = followUp ? 'Writing follow-up options' : 'Writing up to four options';
  } else if (status === 'failed') {
    meta = errorSentence(run.latest, 'Could not draft options.');
  } else if (status === 'stopped') {
    meta = 'Did not finish.';
  } else {
    const ok = [...round.plan].reverse().find((event) => event.status === 'ok') ?? null;
    const reported = ok ? num(loose(ok.detail).optionCount) : null;
    const count = reported ?? optionCount;
    meta = joinMeta(formatCount(count, followUp ? 'follow-up option' : 'option'), timeWords(run.ms));
  }
  return {
    kind: 'hub',
    id: `${ctx.qid}:r${round.index}:draft`,
    rect: draftRect(round.index),
    job: 'draft',
    round: round.index,
    title,
    tool,
    meta,
    since: status === 'working' ? run.from : null,
    status,
    word,
    ariaLabel: aria(title, tool, word, meta),
    enterFrom: null,
    enterOrder: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// After the pick

interface Branch {
  steps: StepNode[];
  /** Rows that hand work from one step to the next, as (step index the dot travels into, key). */
  handoffs: Array<{ into: number; key: string }>;
  /** A confirm landed: the camera frames the branch. */
  confirmedAt: number | null;
  /** The errand or call, for words. */
  label: string;
}

function step(
  qid: string,
  round: number,
  pickedRank: number,
  i: number,
  id: string,
  fields: { status: TreeStatus; word?: string; eyebrow?: string | null; title: string; meta?: string | null; text?: string | null; since?: number | null; until?: number | null },
  parent: Rect,
): StepNode {
  const rect = stepRect(round, pickedRank, i);
  const word = fields.word ?? TREE_STATUS_WORDS[fields.status];
  return {
    kind: 'step',
    id: `${qid}:r${round}:${id}`,
    rect,
    round,
    status: fields.status,
    word,
    eyebrow: fields.eyebrow ?? null,
    title: fields.title,
    meta: fields.meta ?? null,
    text: fields.text ?? null,
    since: fields.since ?? null,
    until: fields.until ?? null,
    ariaLabel: aria(fields.eyebrow, fields.title, word, fields.meta, fields.text),
    enterFrom: from(parent, rect),
    enterOrder: 0,
  };
}

/** "Said out loud" after a reply pick, from the aloud speak rows and the question's spokenAt. */
function replyBranch(ctx: Context, round: Round, pick: Pick, pickedRank: number, parent: Rect): Branch | null {
  const aloud = ctx.events.filter((event) => {
    if (event.stage !== 'speak' || event.at < pick.at || event.at >= round.next) return false;
    const detail = loose(event.detail);
    if (detail.channel !== 'aloud') return false;
    const optionId = str(detail.optionId);
    return optionId === null || optionId === pick.optionId;
  });
  const spokenAt = ctx.question.spokenAt;
  const spoken = spokenAt !== null && spokenAt >= pick.at && spokenAt < round.next;
  if (pick.status !== 'ok' && aloud.length === 0 && !spoken) return null;
  const run = runOf(aloud);
  const latest = run.latest;
  const words = (latest ? screenText(loose(latest.detail).text) : null) ?? screenText(ctx.question.replyText);
  let status: TreeStatus;
  let word: string;
  let meta: string;
  if (run.status === 'done' || spoken) {
    status = 'done';
    word = 'Spoken';
    meta = 'Spoken in the room.';
  } else if (run.status === 'working') {
    const cut = ctx.cutAt !== null && run.from !== null && ctx.cutAt >= run.from;
    status = cut ? 'stopped' : 'working';
    word = cut ? 'Did not finish' : 'Saying it';
    meta = cut ? 'Did not finish.' : 'Saying it in the room.';
  } else if (run.status === 'failed') {
    status = 'failed';
    word = TREE_STATUS_WORDS.failed;
    meta = errorSentence(latest, 'Could not say it out loud.');
  } else {
    status = 'idle';
    word = 'Waiting';
    meta = 'Released, waiting for the room voice.';
  }
  const node = step(ctx.qid, round.index, pickedRank, 0, 'said', {
    status,
    word,
    title: 'Said out loud',
    meta,
    text: words ? quoted(words) : null,
    since: status === 'working' ? run.from : null,
  }, parent);
  const first = aloud[0];
  return { steps: [node], handoffs: first ? [{ into: 0, key: `h:${first.id}` }] : [], confirmedAt: null, label: 'the reply' };
}

const ERRAND_SENT = new Set<Errand['status']>(['confirmed', 'submitting', 'sent', 'unknown_outcome']);
const ERRAND_ENDED = new Set<Errand['status']>(['stopped', 'refused', 'failed']);

function endedStatus(status: 'stopped' | 'refused' | 'failed'): TreeStatus {
  return status;
}

function errandBranch(ctx: Context, round: Round, errand: Errand, pickedRank: number, parent: Rect): Branch {
  const qid = ctx.qid;
  const eyebrow = `Errand: ${screenText(errand.form) ?? 'a form'}`;
  const reason = screenText(errand.reason);
  const readDone = errand.readAloudAt !== null || errand.status === 'awaiting_confirm' || ERRAND_SENT.has(errand.status);
  const steps: StepNode[] = [];
  const handoffs: Branch['handoffs'] = [{ into: 0, key: `h:errand:${errand.id}` }];
  const ended = ERRAND_ENDED.has(errand.status) ? (errand.status as 'stopped' | 'refused' | 'failed') : null;

  // 1. The read-back: the form is filled in a browser, then its values are read back in the earpiece.
  if (readDone) {
    steps.push(step(qid, round.index, pickedRank, 0, 'e1', { status: 'done', eyebrow, title: 'Read back', meta: 'Read back in the earpiece.' }, parent));
  } else if (ended) {
    const meta = ended === 'stopped' ? (reason ? `Not sent: ${sentence(reason)}` : 'Stopped. Nothing was sent.') : reason ? `${sentence(reason)} Nothing was sent.` : 'Nothing was sent.';
    steps.push(step(qid, round.index, pickedRank, 0, 'e1', { status: endedStatus(ended), word: ended === 'stopped' ? 'Not sent' : undefined, eyebrow, title: 'Read back', meta }, parent));
  } else {
    const meta =
      errand.status === 'preparing'
        ? 'Filling in the form. Nothing is sent yet.'
        : errand.status === 'previewed'
          ? 'The form is filled. Nothing is sent yet.'
          : 'Reading it back in the earpiece.';
    steps.push(step(qid, round.index, pickedRank, 0, 'e1', { status: 'working', eyebrow, title: 'Read back', meta, since: errand.createdAt }, parent));
  }

  // 2. The confirm window: only a fresh CONFIRM sends it.
  if (readDone || (ended && errand.readAloudAt !== null)) {
    const e1 = steps[0]!.rect;
    let fields: Parameters<typeof step>[5];
    if (errand.confirmedAt !== null || ERRAND_SENT.has(errand.status)) {
      fields = { status: 'done', word: 'Confirmed', title: 'Confirm window', meta: confirmedWords(ctx.input) };
    } else if (ended) {
      const meta = ended === 'stopped' ? (reason ? `Not sent: ${sentence(reason)}` : 'Not confirmed. Nothing was sent.') : reason ? `${sentence(reason)} Nothing was sent.` : 'Nothing was sent.';
      fields = { status: endedStatus(ended), word: ended === 'stopped' ? 'Not sent' : undefined, title: 'Confirm window', meta };
    } else {
      fields = {
        status: 'waiting',
        word: 'Waiting',
        title: 'Confirm window',
        meta: `Waiting for ${withSignal('CONFIRM', ctx.input)}.`,
        until: errand.confirmClosesAt,
      };
    }
    steps.push(step(qid, round.index, pickedRank, 1, 'e2', fields, e1));
  }

  // 3. The result, once a CONFIRM released it.
  if (ERRAND_SENT.has(errand.status) || (errand.confirmedAt !== null && ended)) {
    const e2 = steps[1]?.rect ?? steps[0]!.rect;
    let fields: Parameters<typeof step>[5];
    if (errand.status === 'sent') {
      fields = { status: 'done', word: 'Sent', title: 'Sent', meta: screenText(errand.confirmationText) ?? 'Sent.' };
    } else if (errand.status === 'unknown_outcome') {
      fields = { status: 'failed', word: 'Unknown', title: 'Sending', meta: 'It may or may not have gone through. Nothing was sent again.' };
    } else if (ended) {
      fields = { status: endedStatus(ended), title: 'Sending', meta: reason ? sentence(reason) : 'It was not sent.' };
    } else {
      fields = { status: 'working', word: 'Sending', title: 'Sending', meta: 'Sending the form.', since: errand.confirmedAt };
    }
    steps.push(step(qid, round.index, pickedRank, 2, 'e3', fields, e2));
    if (errand.confirmedAt !== null) handoffs.push({ into: 2, key: `h:errand:${errand.id}:confirmed` });
  }
  return { steps, handoffs, confirmedAt: errand.confirmedAt, label: 'the errand' };
}

const CALL_DIALED = new Set<CallRequest['status']>(['confirmed', 'dialing', 'ringing', 'connected', 'ended', 'failed']);

function callBranch(ctx: Context, round: Round, call: CallRequest, pickedRank: number, parent: Rect): Branch {
  const qid = ctx.qid;
  const eyebrow = `Call: ${screenText(call.contactName) ?? 'a contact'}`;
  const reason = screenText(call.reason);
  const dialed = CALL_DIALED.has(call.status) || call.confirmedAt !== null;
  const readDone = call.readAloudAt !== null || call.status === 'awaiting_confirm' || dialed;
  const stoppedBefore = (call.status === 'stopped' || call.status === 'refused') && call.confirmedAt === null;
  const steps: StepNode[] = [];
  const handoffs: Branch['handoffs'] = [{ into: 0, key: `h:call:${call.id}` }];

  if (readDone) {
    steps.push(step(qid, round.index, pickedRank, 0, 'c1', { status: 'done', eyebrow, title: 'Read back', meta: 'Script read back in the earpiece.' }, parent));
  } else if (stoppedBefore) {
    const status: TreeStatus = call.status === 'refused' ? 'refused' : 'stopped';
    const meta = reason ? `${sentence(reason)} No call was made.` : 'Stopped before dialing. No call was made.';
    steps.push(step(qid, round.index, pickedRank, 0, 'c1', { status, eyebrow, title: 'Read back', meta }, parent));
  } else {
    steps.push(step(qid, round.index, pickedRank, 0, 'c1', { status: 'working', eyebrow, title: 'Read back', meta: 'Reading the script back in the earpiece.', since: call.createdAt }, parent));
  }

  if (readDone || (stoppedBefore && call.readAloudAt !== null)) {
    const c1 = steps[0]!.rect;
    let fields: Parameters<typeof step>[5];
    if (dialed) {
      fields = { status: 'done', word: 'Confirmed', title: 'Confirm window', meta: confirmedWords(ctx.input) };
    } else if (stoppedBefore) {
      const status: TreeStatus = call.status === 'refused' ? 'refused' : 'stopped';
      fields = { status, title: 'Confirm window', meta: reason ? `${sentence(reason)} No call was made.` : 'Not confirmed. No call was made.' };
    } else {
      fields = { status: 'waiting', word: 'Waiting', title: 'Confirm window', meta: `Waiting for ${withSignal('CONFIRM', ctx.input)}.`, until: call.confirmClosesAt };
    }
    steps.push(step(qid, round.index, pickedRank, 1, 'c2', fields, c1));
  }

  if (dialed) {
    const c2 = steps[1]?.rect ?? steps[0]!.rect;
    const word = callStatusWord(call);
    const ended = screenText(call.endReason);
    let fields: Parameters<typeof step>[5];
    switch (call.status) {
      case 'ended':
        fields = { status: 'done', word, title: 'Call', meta: ended ? sentence(ended) : 'The call ended.' };
        break;
      case 'failed':
        fields = { status: 'failed', word, title: 'Call', meta: ended || reason ? sentence(ended ?? reason ?? '') : 'The call failed.' };
        break;
      case 'stopped':
      case 'refused':
        fields = { status: call.status, word, title: 'Call', meta: reason ? sentence(reason) : 'No call was made.' };
        break;
      default:
        fields = {
          status: 'working',
          word,
          title: 'Call',
          meta: call.status === 'connected' ? 'Connected.' : call.status === 'ringing' ? 'Ringing.' : 'Dialing.',
          since: call.startedAt ?? call.ringingAt ?? call.dialedAt ?? call.confirmedAt,
        };
    }
    steps.push(step(qid, round.index, pickedRank, 2, 'c3', fields, c2));
    if (call.confirmedAt !== null) handoffs.push({ into: 2, key: `h:call:${call.id}:confirmed` });
  }
  return { steps: steps.map((node) => ({ ...node, meta: node.meta ? maskPhoneNumbers(node.meta) : null })), handoffs, confirmedAt: call.confirmedAt, label: 'the call' };
}

function newestFor<T extends { questionId: string | null; createdAt: number }>(rows: readonly T[], questionId: string, after: number): T | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row && row.questionId === questionId && row.createdAt >= after) return row;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The whole tree

/** The question this screen follows: the turn the scan is on while it runs, else the newest (as Conversation does). */
export function treeQuestion(rows: DataRows): Question | null {
  const newest = latestQuestion(rows.questions);
  const scan = rows.scan;
  if (scan === null || scan.outcome !== null || scan.phase === 'idle') return newest;
  return rows.questions.find((question) => question.id === scan.questionId) ?? newest;
}

function idleTree(): ReplyTree {
  const qid = 'idle';
  const question = questionNode(null);
  const hubs: HubNode[] = (['notes', 'web'] as const).map((region) => ({
    kind: 'hub',
    id: `${qid}:${region}:hub`,
    rect: hubRect(region),
    job: region,
    round: 1,
    title: JOB_TITLES[region],
    tool: region === 'notes' ? 'Moss' : 'Apify',
    meta: null,
    since: null,
    status: 'idle',
    word: TREE_STATUS_WORDS.idle,
    ariaLabel: aria(JOB_TITLES[region], TREE_STATUS_WORDS.idle),
    enterFrom: null,
    enterOrder: 0,
  }));
  const draft: HubNode = {
    kind: 'hub',
    id: `${qid}:r1:draft`,
    rect: draftRect(1),
    job: 'draft',
    round: 1,
    title: JOB_TITLES.draft,
    tool: null,
    meta: null,
    since: null,
    status: 'idle',
    word: TREE_STATUS_WORDS.idle,
    ariaLabel: aria(JOB_TITLES.draft, TREE_STATUS_WORDS.idle),
    enterFrom: null,
    enterOrder: 0,
  };
  const nodes: TreeNode[] = [regionNode(qid, 'notes'), regionNode(qid, 'web'), question, ...hubs, draft];
  const edge = (id: string, source: string, target: string): TreeEdge => ({
    id: `${qid}:e:${id}`,
    source,
    target,
    sourceHandle: 'right',
    targetHandle: 'left',
    shape: 'curve',
    tone: 'idle',
    running: false,
  });
  const edges = [
    edge('q-notes', question.id, hubs[0]!.id),
    edge('q-web', question.id, hubs[1]!.id),
    edge('q-draft', question.id, draft.id),
    edge('notes-draft', hubs[0]!.id, draft.id),
    edge('web-draft', hubs[1]!.id, draft.id),
  ];
  return {
    questionId: null,
    idle: true,
    nodes,
    edges,
    handoffs: [],
    camera: { key: 'idle', intent: 'overview', rect: firstRoundRect(), tight: lookupRect(), nodeIds: null },
    announcement: null,
    stop: { used: false, text: STOP_LINE, detail: null },
    pickedId: null,
  };
}

/**
 * The tree for the focused question, as a pure function of the rows. `questionId` picks another question (the
 * tests use it); by default the screen follows `treeQuestion`.
 */
export function deriveReplyTree(rows: DataRows, questionId?: string | null): ReplyTree {
  const question = questionId ? (rows.questions.find((q) => q.id === questionId) ?? null) : treeQuestion(rows);
  if (!question) return idleTree();
  const qid = question.id;
  const events = rows.pipelineEvents.filter((event) => event.questionId === qid);
  const later = rows.questions.find((q) => q.askedAt > question.askedAt && q.id !== qid) ?? null;
  const scan = rows.scan && rows.scan.questionId === qid ? rows.scan : null;
  const scanEnded = scan !== null && scan.outcome !== null && scan.outcome !== 'picked';
  const cutAt = later ? later.askedAt : scanEnded ? scan.stepStartedAt : null;
  const ctx: Context = { question, qid, events, input: rows.input, cutAt };
  const menu = question.origin === 'menu';

  // Rounds: the answer round, then one per pick that drafted follow-up options.
  const picks = picksOf(events);
  const questionOptions = rows.options.filter((option) => option.questionId === qid);
  const newest = latestOptions(questionOptions, qid);
  const rounds: Round[] = [];
  for (let i = 0; i <= picks.length; i++) {
    const start = i === 0 ? Number.NEGATIVE_INFINITY : picks[i - 1]!.at;
    const pick = picks[i] ?? null;
    const end = pick ? pick.at : Number.POSITIVE_INFINITY;
    const plan = events.filter((event) => event.stage === 'plan' && event.at >= start && event.at < end);
    if (i > 0 && pick === null) {
      // The open round after the last pick exists once a follow-up is being drafted or its options are on the board.
      const last = picks[i - 1]!;
      const published = newest.length > 0 && !newest.some((option) => option.id === last.optionId);
      if (plan.length === 0 && !published) break;
    }
    rounds.push({ index: i + 1, start, pick, end, next: picks[i + 1]?.at ?? Number.POSITIVE_INFINITY, plan, slots: [] });
  }
  for (const round of rounds) {
    const pick = round.pick;
    if (pick) {
      const own = questionOptions.find((option) => option.id === pick.optionId);
      if (own) {
        round.slots = slotsOf(questionOptions.filter((option) => option.version === own.version).sort((a, b) => a.rank - b.rank));
      } else {
        // Replaced on the board by a later version: keep the slots, with the pick's own words when the row has them.
        const ok = [...round.plan].reverse().find((event) => event.status === 'ok');
        const count = Math.min(OPTION_SLOTS, Math.max(num(ok ? loose(ok.detail).optionCount : null) ?? 0, pick.rank ?? 1, 1));
        round.slots = Array.from({ length: count }, (_, i) => ({ rank: i + 1, of: count, option: null }));
      }
    } else {
      const previous = rounds[round.index - 2]?.pick ?? null;
      const stillPrevious = previous !== null && newest.some((option) => option.id === previous.optionId);
      round.slots = stillPrevious ? [] : slotsOf(newest);
    }
  }

  const nodes: TreeNode[] = [];
  const edges: TreeEdge[] = [];
  const handoffs: Handoff[] = [];
  const firstPickAt = picks[0]?.at ?? Number.POSITIVE_INFINITY;
  const before = events.filter((event) => event.at < firstPickAt);

  // The root and the two lookup regions (round 1 only).
  const root = questionNode(ctx);
  const notesRows = before.filter((event) => event.stage === 'retrieve' && !WEB_RETRIEVE.test(labelOf(event) ?? '') && labelOf(event) !== 'memory write back');
  const webSearchRows = before.filter((event) => event.stage === 'search');
  const webIndexRows = before.filter((event) => event.stage === 'retrieve' && WEB_RETRIEVE.test(labelOf(event) ?? ''));
  const notes = notesRegion(ctx, notesRows);
  const web = webRegion(ctx, webSearchRows, webIndexRows);
  nodes.push(regionNode(qid, 'notes'), regionNode(qid, 'web'), root, notes.hub, web.hub);

  const round1 = rounds[0]!;
  const draft1 = draftHub(ctx, round1, round1.slots.length, menu);
  nodes.push(draft1);

  const edge = (
    id: string,
    source: string,
    target: string,
    tone: EdgeTone,
    running: boolean,
    shape: TreeEdge['shape'] = 'curve',
    sourceHandle: TreeEdge['sourceHandle'] = 'right',
    targetHandle: TreeEdge['targetHandle'] = 'left',
  ): TreeEdge => {
    const made: TreeEdge = { id: `${qid}:e:${id}`, source, target, sourceHandle, targetHandle, shape, tone, running };
    edges.push(made);
    return made;
  };
  const reached = (status: TreeStatus) => status !== 'idle';
  const toneFor = (status: TreeStatus): EdgeTone => (reached(status) ? 'done' : 'idle');

  const qNotes = edge('q-notes', root.id, notes.hub.id, toneFor(notes.hub.status), notes.hub.status === 'working');
  const qWeb = edge('q-web', root.id, web.hub.id, toneFor(web.hub.status), web.hub.status === 'working');
  edge('q-draft', root.id, draft1.id, toneFor(draft1.status), draft1.status === 'working', 'straight');
  if (notes.firstRow) handoffs.push({ key: `h:${notes.firstRow.id}`, edgeId: qNotes.id, tone: 'accent' });
  if (web.firstRow) handoffs.push({ key: `h:${web.firstRow.id}`, edgeId: qWeb.id, tone: 'accent' });

  // Children, and what each region hands to the drafting.
  const planStarts = round1.plan.filter((event) => event.status === 'started');
  for (const [region, build] of [
    ['notes', notes],
    ['web', web],
  ] as const) {
    const children = childNodes(qid, region, build);
    nodes.push(...children);
    const feeders = children.length > 0 ? children : [build.hub];
    children.forEach((child, i) => {
      const branch = edge(`${region}-c${i}`, build.hub.id, child.id, 'done', false, 'branch', 'kids', 'left');
      if (build.doneRow) handoffs.push({ key: `h:${build.doneRow.id}:c${i}`, edgeId: branch.id, tone: 'accent' });
    });
    for (const feeder of feeders) {
      const suffix = feeder.kind === 'hub' ? `${region}-draft` : `${feeder.id.split(':').pop()}-${region}-draft`;
      const tone: EdgeTone = feeder.kind === 'hub' ? (reached(feeder.status) && reached(draft1.status) ? 'done' : 'idle') : reached(draft1.status) ? 'done' : 'idle';
      const fed = edge(suffix, feeder.id, draft1.id, tone, draft1.status === 'working');
      for (const start of planStarts) handoffs.push({ key: `h:${start.id}:${fed.id}`, edgeId: fed.id, tone: 'accent' });
    }
  }

  // Each round: its drafting hub, its options, the pick and what grew from it.
  let camera: CameraTarget = {
    key: `${qid}:r1:${round1.slots.length > 0 ? 'options' : 'lookup'}`,
    intent: 'overview',
    rect: firstRoundRect(),
    tight: round1.slots.length > 0 ? optionsRect(1) : lookupRect(),
    nodeIds: null,
  };
  let focusAt = question.askedAt;
  let announcement: string | null = null;
  let pickedId: string | null = null;
  let stop: StopView = { used: false, text: STOP_LINE, detail: null };
  let previousTail: { id: string; rect: Rect; tone: EdgeTone } | null = null;

  const focus = (at: number, target: CameraTarget, said: string | null) => {
    if (at < focusAt) return;
    focusAt = at;
    camera = target;
    if (said) announcement = said;
  };

  for (const round of rounds) {
    const draft = round.index === 1 ? draft1 : draftHub(ctx, round, round.slots.length, menu);
    if (round.index > 1) {
      nodes.push(draft);
      if (previousTail) {
        const link = edge(`r${round.index}-in`, previousTail.id, draft.id, previousTail.tone === 'picked' ? 'picked' : toneFor(draft.status), draft.status === 'working');
        const start = round.plan.find((event) => event.status === 'started') ?? round.plan[0];
        if (start) handoffs.push({ key: `h:${start.id}`, edgeId: link.id, tone: 'accent' });
        const prev = rounds[round.index - 2]!;
        const prevRank = prev.pick?.rank ?? prev.slots.find((s) => s.option?.id === prev.pick?.optionId)?.rank ?? 1;
        const startAt = start?.at ?? prev.end;
        focus(
          startAt,
          {
            key: `${qid}:r${round.index}`,
            intent: 'round',
            rect: unionRect([optionRect(prev.index, Math.min(OPTION_SLOTS, Math.max(1, prevRank))), optionsRect(round.index)]),
            tight: optionsRect(round.index),
            nodeIds: null,
          },
          null,
        );
      }
    }

    // Which option is in the earpiece now, for the open round only.
    const readingRank =
      round.pick === null && scan && scan.outcome === null && (scan.phase === 'reading' || scan.phase === 'window') && round.slots.some((s) => s.option?.version === scan.version)
        ? scan.cursor
        : null;
    const ended = round.pick === null && scanEnded && round.slots.length > 0 && round.slots.some((s) => s.option === null || s.option.version === scan!.version);

    const pick = round.pick;
    const pickedSlot = pick ? (round.slots.find((s) => s.option?.id === pick.optionId) ?? round.slots.find((s) => s.option === null && s.rank === pick.rank) ?? null) : null;
    const planOk = [...round.plan].reverse().find((event) => event.status === 'ok') ?? null;

    let pickedNode: OptionNode | null = null;
    round.slots.forEach((s, i) => {
      const rect = optionRect(round.index, s.rank);
      const option = s.option;
      const words = option ? optionWords(option) : pickedSlot === s ? (pick?.text ?? null) : null;
      const kind = option?.kind ?? (pickedSlot === s ? pick?.kind : null) ?? null;
      const isPicked = pickedSlot === s;
      let state: OptionState = 'idle';
      if (isPicked) state = 'picked';
      else if (pick || ended) state = 'dimmed';
      else if (readingRank === s.rank) state = 'reading';
      let pickLine: string | null = null;
      if (isPicked && pick) {
        const lead = pickPhrase(ctx.input);
        if (pick.status === 'started' && (kind === 'reply' || kind === null)) pickLine = `${lead}. NO or STOP can still cancel it.`;
        else if ((kind === 'reply' || kind === 'menu' || kind === null) && question.spokenAt !== null && question.spokenAt >= pick.at && question.spokenAt < round.next) pickLine = `${lead}. Spoken in the room.`;
        else pickLine = `${lead}.`;
      }
      const status: TreeStatus = state === 'picked' ? 'picked' : state === 'reading' ? 'working' : 'idle';
      const word = state === 'picked' ? TREE_STATUS_WORDS.picked : state === 'reading' ? 'In the earpiece now' : state === 'dimmed' ? 'Not picked' : '';
      const heading = `Option ${s.rank} of ${s.of}`;
      const source = option ? sourceLine(option, words !== null) : null;
      const node: OptionNode = {
        kind: 'option',
        id: `${qid}:r${round.index}:o${s.rank}`,
        rect,
        round: round.index,
        rank: s.rank,
        heading,
        text: words,
        source,
        tag: kind ? KIND_TAGS[kind] : null,
        state,
        pickLine,
        status,
        word,
        ariaLabel: aria(heading, words ?? 'Words not shared on this screen', source, kind ? KIND_TAGS[kind] : null, pickLine ?? word),
        enterFrom: from(draft.rect, rect),
        enterOrder: i,
      };
      nodes.push(node);
      if (isPicked) pickedNode = node;
      const tone: EdgeTone = isPicked ? 'picked' : state === 'dimmed' ? 'dim' : 'done';
      const out = edge(`r${round.index}-o${s.rank}`, draft.id, node.id, tone, false);
      if (planOk) handoffs.push({ key: `h:${planOk.id}:o${s.rank}`, edgeId: out.id, tone: 'accent' });
      if (isPicked && pick) handoffs.push({ key: `h:${pick.firstRowId}`, edgeId: out.id, tone: 'picked' });
    });

    // A round that ended with no pick says how, beside its options.
    if (ended && scan && scan.outcome !== null && scan.outcome !== 'picked') {
      const ending = ENDINGS[scan.outcome] ?? ENDINGS.stopped;
      const rect = roundEndRect(round.index);
      nodes.push({
        kind: 'step',
        id: `${qid}:r${round.index}:end`,
        rect,
        round: round.index,
        status: 'stopped',
        word: scan.outcome === 'none' ? 'None of these' : TREE_STATUS_WORDS.stopped,
        eyebrow: null,
        title: ending.title,
        meta: ending.meta,
        text: null,
        since: null,
        until: null,
        ariaLabel: aria(ending.title, ending.meta),
        enterFrom: from(draft.rect, rect),
        enterOrder: 0,
      });
      if (scan.outcome === 'none') stop = { used: true, text: STOP_LINE, detail: ending.meta };
      focus(scan.stepStartedAt, { key: `${qid}:r${round.index}:end`, intent: 'end', rect: unionRect([optionsRect(round.index), rect]), tight: unionRect([optionsRect(round.index), rect]), nodeIds: null }, `${ending.title}. ${ending.meta}`);
    }

    if (!pick || !pickedNode) {
      previousTail = null;
      continue;
    }
    const picked: OptionNode = pickedNode;
    pickedId = picked.id;

    // What grew from the pick: said out loud for a reply, or the errand or the call with its own CONFIRM.
    const kind = picked.tag === 'Errand' ? 'errand' : picked.tag === 'Call' ? 'call' : 'reply';
    let branch: Branch | null = null;
    if (kind === 'errand') {
      const errand = rows.errands.find((row) => row.optionId === pick.optionId) ?? newestFor(rows.errands, qid, pick.at);
      if (errand) branch = errandBranch(ctx, round, errand, picked.rank, picked.rect);
    } else if (kind === 'call') {
      const call = rows.calls.find((row) => row.optionId === pick.optionId) ?? newestFor(rows.calls, qid, pick.at);
      if (call) branch = callBranch(ctx, round, call, picked.rank, picked.rect);
    } else {
      branch = replyBranch(ctx, round, pick, picked.rank, picked.rect);
    }
    const stepIds: string[] = [];
    if (branch) {
      nodes.push(...branch.steps);
      const edgeIds: string[] = [];
      branch.steps.forEach((node, i) => {
        stepIds.push(node.id);
        const made =
          i === 0
            ? edge(`r${round.index}-pick`, picked.id, node.id, 'picked', node.status === 'working')
            : edge(`r${round.index}-s${i}`, branch!.steps[i - 1]!.id, node.id, 'picked', node.status === 'working', 'straight', 'bottom', 'top');
        edgeIds.push(made.id);
      });
      for (const hand of branch.handoffs) {
        const edgeId = edgeIds[hand.into];
        if (edgeId) handoffs.push({ key: hand.key, edgeId, tone: 'picked' });
      }
      if (branch.confirmedAt !== null) {
        const confirmIds = stepIds.slice(1);
        focus(
          branch.confirmedAt,
          {
            key: `${qid}:r${round.index}:confirmed`,
            intent: 'confirm',
            rect: unionRect(branch.steps.slice(1).map((node) => node.rect)),
            tight: unionRect(branch.steps.slice(1).map((node) => node.rect)),
            nodeIds: confirmIds.length > 0 ? confirmIds : stepIds,
          },
          `CONFIRM landed for ${branch.label}.`,
        );
      }
    }
    const pickRects = [picked.rect, ...(branch?.steps.map((node) => node.rect) ?? [])];
    focus(
      pick.at,
      {
        key: `${qid}:pick:${pick.optionId}:${stepIds.length}`,
        intent: 'pick',
        rect: unionRect(pickRects),
        tight: unionRect(pickRects),
        nodeIds: [picked.id, ...stepIds],
      },
      `${pickPhrase(ctx.input)}: option ${picked.rank}.`,
    );
    const tail = branch?.steps[branch.steps.length - 1] ?? null;
    previousTail = tail ? { id: tail.id, rect: tail.rect, tone: 'picked' } : { id: picked.id, rect: picked.rect, tone: 'picked' };
  }

  // A failure anywhere is said once, unless something newer was said.
  if (announcement === null) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i]!;
      if (node.status !== 'failed') continue;
      if (node.kind === 'hub' || node.kind === 'step') announcement = `${node.title} failed.`;
      else if (node.kind === 'question') announcement = 'Could not hear the question.';
      else continue;
      break;
    }
  }

  return { questionId: qid, idle: false, nodes, edges, handoffs, camera, announcement, stop, pickedId };
}
