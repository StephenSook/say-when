/**
 * Reading the speaker's rows (docs/station.md 1.5 and 3): `my_session` (the reply to say), `scan_state` (the clock
 * estimate and the paused line), `config` (the room's sharing toggle) and `device_status` (two room voices online).
 *
 * `attachSpeakerRows` registers the row callbacks once per connection object, and `readSpeakerSnapshot` reads the
 * client cache when the subscription applies. Row callbacks from a subscription snapshot carry an event tagged
 * `SubscribeApplied` (spacetimedb 2.13.0, at connect and after every reconnect); everything else is a live change.
 * Only live `scan_state` updates feed the clock estimate, and only a live `my_session` change is said at once.
 */
import type { ReplySource, SpeakerEngine, SpeakerReply } from './engine';

interface TimestampLike {
  microsSinceUnixEpoch: bigint;
}

interface SessionReplyLike {
  questionId: bigint;
  text: string;
  tone: string;
  laugh: boolean;
  releasedAt: TimestampLike;
}

export interface SessionRowLike {
  sessionId: bigint;
  reply?: SessionReplyLike | undefined;
}

export interface ScanRowLike {
  sessionId: bigint;
  phase: { tag: string };
  pauseReason?: { tag: string } | undefined;
  updatedAt: TimestampLike;
}

export interface ConfigRowLike {
  activeSessionId: bigint;
  shareTextOnBoard: boolean;
}

export interface DeviceRowLike {
  role: { tag: string };
  online: boolean;
}

type Callback = (...args: any[]) => void;

interface TableLike<Row> {
  iter(): Iterable<Row>;
  onInsert(cb: Callback): void;
  removeOnInsert(cb: Callback): void;
  onDelete(cb: Callback): void;
  removeOnDelete(cb: Callback): void;
  onUpdate?(cb: Callback): void;
  removeOnUpdate?(cb: Callback): void;
}

export interface SpeakerConnLike {
  db: {
    mySession: TableLike<SessionRowLike>;
    scanState: TableLike<ScanRowLike>;
    config: TableLike<ConfigRowLike>;
    deviceStatus: TableLike<DeviceRowLike>;
  };
}

/** epoch ms from a SpacetimeDB Timestamp. */
export function timestampMs(ts: TimestampLike | null | undefined): number {
  if (!ts) return Number.NaN;
  return Number(ts.microsSinceUnixEpoch / 1000n);
}

/** `my_session.reply` as plain values, or null. */
export function replyFromSession(row: SessionRowLike | null | undefined): SpeakerReply | null {
  const reply = row?.reply;
  if (!reply) return null;
  return {
    questionId: reply.questionId,
    text: reply.text,
    tone: reply.tone,
    laugh: reply.laugh === true,
    releasedAtMs: timestampMs(reply.releasedAt),
  };
}

/** True for a row callback that belongs to a subscription snapshot rather than a live change. */
export function isSnapshotEvent(ctx: unknown): boolean {
  if (typeof ctx !== 'object' || ctx === null) return false;
  const event = (ctx as { event?: unknown }).event;
  return typeof event === 'object' && event !== null && (event as { tag?: unknown }).tag === 'SubscribeApplied';
}

/** What the room sees, apart from the reply: kept by the page for the screen. */
export interface SpeakerRoom {
  /** `config.share_text_on_board`. False until config has been read: no words on screen by default. */
  sharing: boolean;
  /** 'paused' or 'headset_off' while the active session's scan is paused, else null. */
  paused: 'paused' | 'headset_off' | null;
  /** Speaker devices shown online in `device_status`, this one included. */
  speakersOnline: number;
}

export const SPEAKER_ROOM_UNKNOWN: SpeakerRoom = { sharing: false, paused: null, speakersOnline: 0 };

function first<Row>(table: TableLike<Row>): Row | null {
  for (const row of table.iter()) return row;
  return null;
}

/** The room facts from the client cache. */
export function readRoom(conn: SpeakerConnLike): SpeakerRoom {
  const config = first(conn.db.config);
  const active = config?.activeSessionId ?? 0n;
  let paused: SpeakerRoom['paused'] = null;
  if (active !== 0n) {
    for (const scan of conn.db.scanState.iter()) {
      if (scan.sessionId !== active || scan.phase.tag !== 'Paused') continue;
      paused = scan.pauseReason?.tag === 'HeadsetOff' ? 'headset_off' : 'paused';
    }
  }
  let speakersOnline = 0;
  for (const device of conn.db.deviceStatus.iter()) {
    if (device.role.tag === 'Speaker' && device.online) speakersOnline++;
  }
  return { sharing: config?.shareTextOnBoard === true, paused, speakersOnline };
}

/** The reply `my_session` shows now, from the client cache. */
export function readReply(conn: SpeakerConnLike): SpeakerReply | null {
  let newest: SpeakerReply | null = null;
  for (const row of conn.db.mySession.iter()) {
    const reply = replyFromSession(row);
    if (reply && (newest === null || reply.questionId > newest.questionId)) newest = reply;
  }
  return newest;
}

export interface SpeakerRowsTarget {
  engine: Pick<SpeakerEngine, 'offer' | 'noteServerTime'>;
  /** Called with the room facts after any change to them. */
  room(next: SpeakerRoom): void;
  /**
   * True once this page is paired as the Speaker. Until then no reply is offered: the view starts returning the
   * reply when the owner approves the code, and that first sight must count as a snapshot (an old reply is missed,
   * not said), so the page offers the cache as a snapshot when pairing completes (`offerSnapshot`). Default: true.
   */
  paired?: () => boolean;
  now?: () => number;
}

/** Registers the row callbacks on one connection object. Returns the function that removes them. */
export function attachSpeakerRows(conn: SpeakerConnLike, target: SpeakerRowsTarget): () => void {
  const now = target.now ?? Date.now;
  const db = conn.db;
  const paired = target.paired ?? (() => true);
  const sessionChanged = (ctx: unknown) => {
    if (!paired()) return;
    const source: ReplySource = isSnapshotEvent(ctx) ? 'snapshot' : 'live';
    target.engine.offer(readReply(conn), source);
  };
  const scanChanged = (ctx: unknown, a?: ScanRowLike, b?: ScanRowLike) => {
    const row = b ?? a;
    if (row && !isSnapshotEvent(ctx)) target.engine.noteServerTime(timestampMs(row.updatedAt), now());
    target.room(readRoom(conn));
  };
  const roomChanged = () => target.room(readRoom(conn));

  db.mySession.onInsert(sessionChanged);
  db.mySession.onDelete(sessionChanged);
  db.scanState.onInsert(scanChanged);
  db.scanState.onUpdate?.(scanChanged);
  db.scanState.onDelete(roomChanged);
  db.config.onInsert(roomChanged);
  db.config.onUpdate?.(roomChanged);
  db.deviceStatus.onInsert(roomChanged);
  db.deviceStatus.onUpdate?.(roomChanged);
  db.deviceStatus.onDelete(roomChanged);

  return () => {
    db.mySession.removeOnInsert(sessionChanged);
    db.mySession.removeOnDelete(sessionChanged);
    db.scanState.removeOnInsert(scanChanged);
    db.scanState.removeOnUpdate?.(scanChanged);
    db.scanState.removeOnDelete(roomChanged);
    db.config.removeOnInsert(roomChanged);
    db.config.removeOnUpdate?.(roomChanged);
    db.deviceStatus.removeOnInsert(roomChanged);
    db.deviceStatus.removeOnUpdate?.(roomChanged);
    db.deviceStatus.removeOnDelete(roomChanged);
  };
}

/** When the subscription applies (connect and every reconnect): the cache as a snapshot. */
export function readSpeakerSnapshot(conn: SpeakerConnLike, target: SpeakerRowsTarget): void {
  target.room(readRoom(conn));
  offerSnapshot(conn, target);
}

/** Offers the reply in the cache as a snapshot, once paired: at subscription apply, and when pairing completes. */
export function offerSnapshot(conn: SpeakerConnLike, target: SpeakerRowsTarget): void {
  if (!(target.paired ?? (() => true))()) return;
  target.engine.offer(readReply(conn), 'snapshot');
}
