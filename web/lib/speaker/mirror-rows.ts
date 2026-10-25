/**
 * Where the mirror's words come from (lib/speaker/mirror.ts). The Speaker's own view, `my_session`, holds only the
 * reply, so the mirror reads what any screen in the room may read: the anonymous board views (spacetime/src/views.ts),
 * whose words appear only while the room's sharing toggle `config.share_text_on_board` is on, plus `scan_state`, which
 * the speaker already subscribes for its clock. No module change.
 *
 *   The partner's question   `scan_state.question_id` turns to a new id (the earpiece's QuestionReader fires on the
 *                            same change of `my_session.question_id`); its words are `public_board.text`. Said only
 *                            under direct select (`config.input_mode` Direct), for origin Partner, never for a
 *                            follow-up turn (`parent_question_id` set), as in lib/station/question.ts.
 *   Each option              a live `scan_state` step in Reading with a new `step_seq`: the option at rank `cursor` of
 *                            `public_board.options` for the same version, read as the earpiece reads it ("One: good.",
 *                            lib/station/phrases.ts optionEarText); a yes or no read is "Yes or no?".
 *   Each read-back           `board_errands` Previewed, `board_calls` Prepared or `board_searches` Prepared with its
 *                            digest and words, as lib/station/readback.ts readbackCandidate; errand and call
 *                            read-backs get "One: send it. Two: cancel." on the end, as in the earpiece.
 *
 * The board views are a separate subscription, so if they cannot be read the room voice still says the reply. Rows
 * from a subscription snapshot (connect, reconnect) only set the starting point: nothing old is ever said.
 */
import { renderSegments } from '../cartesia/tones';
import { optionEarText, PHRASES } from '../station/phrases';
import { questionEarText } from '../station/question';
import { readbackSegments } from '../station/readback';
import type { MirrorItem, SpeakerMirror } from './mirror';
import { roomSafeText } from './mirror';
import { isSnapshotEvent } from './rows';

type Callback = (...args: any[]) => void;

interface TableLike<Row> {
  iter(): Iterable<Row>;
  onInsert(cb: Callback): void;
  removeOnInsert(cb: Callback): void;
  onUpdate?(cb: Callback): void;
  removeOnUpdate?(cb: Callback): void;
}

export interface MirrorScanRow {
  sessionId: bigint;
  questionId: bigint;
  version: number;
  answerMode: { tag: string };
  phase: { tag: string };
  cursor: number;
  stepSeq: bigint;
  optionStartSeq: bigint;
}

export interface MirrorConfigRow {
  activeSessionId: bigint;
  shareTextOnBoard: boolean;
  inputMode?: { tag: string } | undefined;
}

export interface BoardOptionLike {
  rank: number;
  /** The option's text while sharing is on. */
  label: string;
  /** The earpiece label, or the text when it has none (D18). */
  shortLabel: string;
  tone: string;
}

export interface BoardQuestionLike {
  questionId: bigint;
  sessionId: bigint;
  origin: { tag: string };
  textShared: boolean;
  text: string;
  version: number;
  options: readonly BoardOptionLike[];
  parentQuestionId: bigint;
}

export interface BoardErrandLike {
  errandId: bigint;
  questionId: bigint;
  status: { tag: string };
  textShared: boolean;
  readBackText: string;
  previewDigest: string;
}

export interface BoardCallLike {
  callId: bigint;
  questionId: bigint;
  status: { tag: string };
  textShared: boolean;
  readBackText: string;
  scriptDigest: string;
}

export interface BoardSearchLike {
  searchId: bigint;
  questionId: bigint;
  status: { tag: string };
  readBackText: string;
  digest: string;
}

interface SubscriptionLike {
  onApplied(cb: Callback): SubscriptionLike;
  onError(cb: Callback): SubscriptionLike;
  subscribe(queries: any): unknown;
}

export interface MirrorConnLike {
  db: {
    scanState: TableLike<MirrorScanRow>;
    config: TableLike<MirrorConfigRow>;
    publicBoard: TableLike<BoardQuestionLike>;
    boardErrands: TableLike<BoardErrandLike>;
    boardCalls: TableLike<BoardCallLike>;
    boardSearches: TableLike<BoardSearchLike>;
  };
  subscriptionBuilder?(): SubscriptionLike;
}

export interface MirrorRowsTarget {
  mirror: Pick<SpeakerMirror, 'offer' | 'advance' | 'drop' | 'clear' | 'setSharing' | 'setProblem'>;
  /** True once this page is paired as the Speaker. Default: true. */
  paired?: () => boolean;
  now?: () => number;
}

const DIGEST_RE = /^[0-9a-f]{16}$/;

/** Statuses after which a read-back that has not been said yet no longer applies. */
const STOPPED: readonly string[] = ['Stopped', 'Refused', 'Failed'];

type WorkKind = 'errand' | 'call' | 'search';

interface WorkLine {
  kind: WorkKind;
  id: bigint;
  questionId: bigint;
  status: string;
  /** The read-back words when this row should be read back now, else null. */
  text: string | null;
  digest: string;
}

function errandLine(row: BoardErrandLike): WorkLine {
  const ok = row.status.tag === 'Previewed' && row.textShared && DIGEST_RE.test(row.previewDigest) && row.readBackText.trim() !== '';
  return { kind: 'errand', id: row.errandId, questionId: row.questionId, status: row.status.tag, text: ok ? row.readBackText : null, digest: row.previewDigest };
}

function callLine(row: BoardCallLike): WorkLine {
  const ok = row.status.tag === 'Prepared' && row.textShared && row.scriptDigest.trim() !== '' && row.readBackText.trim() !== '';
  return { kind: 'call', id: row.callId, questionId: row.questionId, status: row.status.tag, text: ok ? row.readBackText : null, digest: row.scriptDigest };
}

function searchLine(row: BoardSearchLike): WorkLine {
  // A search read-back is the module's own fixed sentence, content-free, so it carries no sharing flag.
  const ok = row.status.tag === 'Prepared' && DIGEST_RE.test(row.digest) && row.readBackText.trim() !== '';
  return { kind: 'search', id: row.searchId, questionId: row.questionId, status: row.status.tag, text: ok ? row.readBackText : null, digest: row.digest };
}

function workKey(line: WorkLine): string {
  return `rb:${line.kind}:${line.id}:${line.digest}`;
}

/** The read-back as the earpiece says it, made safe for the room. */
export function mirrorReadbackText(kind: WorkKind, text: string): string {
  return renderSegments(readbackSegments(roomSafeText(text), 'headset', kind));
}

function first<Row>(table: TableLike<Row>): Row | null {
  for (const row of table.iter()) return row;
  return null;
}

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message || value.name;
  if (typeof value === 'object' && value !== null && 'event' in value) return errorText((value as { event: unknown }).event);
  return String(value ?? 'The board views could not be read.');
}

/**
 * Registers the row callbacks on one connection object and, when `queries` are given, subscribes the board views on
 * their own subscription. Returns the function that removes the callbacks.
 */
export function attachMirrorRows(conn: MirrorConnLike, target: MirrorRowsTarget, queries?: readonly unknown[]): () => void {
  const db = conn.db;
  const now = target.now ?? Date.now;
  const paired = target.paired ?? (() => true);
  const mirror = target.mirror;

  /** True once the board views' subscription has applied: until then a scan step cannot be read. */
  let applied = queries === undefined;
  let activeSession = 0n;
  let direct = false;
  /** The newest question id seen in `scan_state` (ids grow across sessions). */
  let lastQuestion = 0n;
  /** The newest `step_seq` seen per session. */
  const steps = new Map<bigint, bigint>();
  const known = new Set<string>();

  const readConfig = () => {
    const config = first(db.config);
    activeSession = config?.activeSessionId ?? 0n;
    direct = config?.inputMode?.tag === 'Direct';
    mirror.setSharing(config?.shareTextOnBoard === true);
  };

  const boardQuestion = (questionId: bigint): BoardQuestionLike | null => {
    for (const row of db.publicBoard.iter()) if (row.questionId === questionId) return row;
    return null;
  };

  /** A step this page has not seen yet for its session; records it. */
  const newStep = (row: MirrorScanRow): boolean => {
    const last = steps.get(row.sessionId) ?? 0n;
    if (row.stepSeq <= last) return false;
    steps.set(row.sessionId, row.stepSeq);
    return true;
  };

  /** Snapshot rows, and rows from before the board applied or before pairing, only move the starting point. */
  const baseline = (row: MirrorScanRow) => {
    if (row.questionId > lastQuestion) lastQuestion = row.questionId;
    newStep(row);
  };

  const scanChanged = (ctx: unknown, a?: MirrorScanRow, b?: MirrorScanRow) => {
    const row = b ?? a;
    if (!row) return;
    if (isSnapshotEvent(ctx) || !applied || !paired()) {
      baseline(row);
      return;
    }
    if (activeSession === 0n) readConfig();
    if (row.sessionId !== activeSession) {
      baseline(row);
      return;
    }
    if (row.phase.tag === 'Paused') {
      // As the earpiece: a pause stops everything at once.
      mirror.clear();
      baseline(row);
      return;
    }
    if (row.questionId !== 0n && row.questionId > lastQuestion) {
      lastQuestion = row.questionId;
      mirror.advance(row.questionId);
      const q = boardQuestion(row.questionId);
      if (direct && q && q.origin.tag === 'Partner' && q.parentQuestionId === 0n && q.textShared) {
        const text = questionEarText(q.text);
        if (text !== '') mirror.offer({ key: `q:${q.questionId}`, kind: 'question', questionId: q.questionId, text, voice: 'assistant', tone: '', at: now() });
      }
    }
    if (!newStep(row)) return;
    if (row.phase.tag === 'Idle') {
      // As the earpiece: Idle stops the option reads, not a read-back.
      mirror.drop((item) => item.kind === 'option');
      return;
    }
    if (row.phase.tag !== 'Reading') return;
    const key = `read:${row.sessionId}:${row.optionStartSeq}`;
    if (row.answerMode.tag === 'YesNo') {
      mirror.offer({ key, kind: 'option', questionId: row.questionId, text: PHRASES.yesOrNo, voice: 'assistant', tone: '', at: now() });
      return;
    }
    const q = boardQuestion(row.questionId);
    if (!q || !q.textShared || q.version !== row.version) return;
    const option = q.options.find((o) => o.rank === row.cursor);
    if (!option) return;
    const text = roomSafeText(optionEarText(option.rank, option.shortLabel, option.label));
    if (text !== '') mirror.offer({ key, kind: 'option', questionId: row.questionId, text, voice: 'reply', tone: option.tone, at: now() });
  };

  const workChanged = (line: WorkLine, ctx: unknown) => {
    const key = workKey(line);
    if (isSnapshotEvent(ctx) || !applied || !paired()) {
      if (line.text !== null) known.add(key);
      return;
    }
    if (line.text !== null) {
      if (known.has(key)) return;
      known.add(key);
      mirror.offer({
        key,
        kind: 'readback',
        questionId: line.questionId,
        text: mirrorReadbackText(line.kind, line.text),
        voice: 'assistant',
        tone: '',
        at: now(),
      });
    } else if (STOPPED.includes(line.status)) {
      const prefix = `rb:${line.kind}:${line.id}:`;
      mirror.drop((item) => item.key.startsWith(prefix));
    }
  };

  const errandChanged = (ctx: unknown, a?: BoardErrandLike, b?: BoardErrandLike) => {
    const row = b ?? a;
    if (row) workChanged(errandLine(row), ctx);
  };
  const callChanged = (ctx: unknown, a?: BoardCallLike, b?: BoardCallLike) => {
    const row = b ?? a;
    if (row) workChanged(callLine(row), ctx);
  };
  const searchChanged = (ctx: unknown, a?: BoardSearchLike, b?: BoardSearchLike) => {
    const row = b ?? a;
    if (row) workChanged(searchLine(row), ctx);
  };
  const configChanged = () => readConfig();

  /** The board applied (connect, reconnect): the read-backs waiting now are the starting point, never said. */
  const boardApplied = () => {
    for (const row of db.boardErrands.iter()) workChanged(errandLine(row), { event: { tag: 'SubscribeApplied' } });
    for (const row of db.boardCalls.iter()) workChanged(callLine(row), { event: { tag: 'SubscribeApplied' } });
    for (const row of db.boardSearches.iter()) workChanged(searchLine(row), { event: { tag: 'SubscribeApplied' } });
    for (const row of db.scanState.iter()) baseline(row);
    applied = true;
    mirror.setProblem(null);
  };

  db.scanState.onInsert(scanChanged);
  db.scanState.onUpdate?.(scanChanged);
  db.config.onInsert(configChanged);
  db.config.onUpdate?.(configChanged);
  db.boardErrands.onInsert(errandChanged);
  db.boardErrands.onUpdate?.(errandChanged);
  db.boardCalls.onInsert(callChanged);
  db.boardCalls.onUpdate?.(callChanged);
  db.boardSearches.onInsert(searchChanged);
  db.boardSearches.onUpdate?.(searchChanged);

  readConfig();
  if (queries !== undefined && conn.subscriptionBuilder) {
    try {
      conn
        .subscriptionBuilder()
        .onApplied(() => {
          readConfig();
          boardApplied();
        })
        .onError((ctx: unknown) => mirror.setProblem(errorText(ctx)))
        .subscribe([...queries]);
    } catch (error) {
      mirror.setProblem(errorText(error));
    }
  }

  return () => {
    db.scanState.removeOnInsert(scanChanged);
    db.scanState.removeOnUpdate?.(scanChanged);
    db.config.removeOnInsert(configChanged);
    db.config.removeOnUpdate?.(configChanged);
    db.boardErrands.removeOnInsert(errandChanged);
    db.boardErrands.removeOnUpdate?.(errandChanged);
    db.boardCalls.removeOnInsert(callChanged);
    db.boardCalls.removeOnUpdate?.(callChanged);
    db.boardSearches.removeOnInsert(searchChanged);
    db.boardSearches.removeOnUpdate?.(searchChanged);
  };
}
