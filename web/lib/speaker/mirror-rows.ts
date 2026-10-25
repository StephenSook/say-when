/**
 * Where the mirror's words come from (lib/speaker/mirror.ts). The Speaker's own view, `my_session`, holds only the
 * reply, so the mirror reads what any screen in the room may read: the anonymous board views (spacetime/src/views.ts),
 * whose words appear only while the room's sharing toggle `config.share_text_on_board` is on, plus `scan_state`, which
 * the speaker already subscribes for its clock. No module change.
 *
 *   Each read-back           `board_errands` Previewed, `board_calls` Prepared or `board_searches` Prepared with its
 *                            digest and words, as lib/station/readback.ts readbackCandidate; errand and call
 *                            read-backs get "One: send it. Two: cancel." on the end, as in the earpiece.
 *   A newer question         `scan_state.question_id` turns to a new id: the read-backs of older questions go
 *                            (mirror rule 2), and a pause clears everything.
 *
 * Since Oct 25 (Stephen: "take off question repeating", "take off answer choices being repeated") the room voice
 * says neither the partner's question nor the numbered options; the earpiece wearer still hears the options.
 *
 * The board views are a separate subscription, so if they cannot be read the room voice still says the reply. Rows
 * from a subscription snapshot (connect, reconnect) only set the starting point: nothing old is ever said.
 */
import { renderSegments } from '../cartesia/tones';
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

  /** True once the board views' subscription has applied: until then nothing is offered. */
  let applied = queries === undefined;
  let activeSession = 0n;
  /** The newest question id seen in `scan_state` (ids grow across sessions). */
  let lastQuestion = 0n;
  const known = new Set<string>();

  const readConfig = () => {
    const config = first(db.config);
    activeSession = config?.activeSessionId ?? 0n;
    mirror.setSharing(config?.shareTextOnBoard === true);
  };

  /** Snapshot rows, and rows from before the board applied or before pairing, only move the starting point. */
  const baseline = (row: MirrorScanRow) => {
    if (row.questionId > lastQuestion) lastQuestion = row.questionId;
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
    // A newer question drops the read-backs of older ones. Its words and its numbered options are not said (Oct 25).
    if (row.questionId !== 0n && row.questionId > lastQuestion) {
      lastQuestion = row.questionId;
      mirror.advance(row.questionId);
    }
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
