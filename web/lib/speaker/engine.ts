/**
 * The room voice (docs/station.md 3, 7.4 B1): says the newest released reply once, in the reply voice, then records it
 * with `reply_spoken(question_id, ms)`. Plain TypeScript outside React; the page renders its snapshot. The audio and
 * the module call come in as functions, so every rule here runs in a test with fakes.
 *
 * The rules:
 * 1. A reply is offered from `my_session` (a Speaker sees only `reply` for the newest Released question). Only a reply
 *    whose question id is greater than the last one this page said, skipped or is saying is taken. Never an older id.
 * 2. A reply from a subscription snapshot (at connect, and after every reconnect) that was released more than 20 s ago
 *    by the server clock estimate is not said: it shows as missed, with Say it now. A live update is said at once,
 *    whatever its timestamp.
 * 3. While the room voice is not started (no tap yet), a fresh reply waits; when the tap comes it is said if it is
 *    still under 20 s old, else it shows as missed.
 * 4. After the speech has played to the end, `reply_spoken(question_id, clip ms)`. It is resent after a
 *    DisconnectedError or an UnknownCallResultError for up to 60 s (the module returns quietly for a repeat).
 *    `reply is not released` or `no such question` stops it. Words nobody heard are never reported.
 * 5. Progress is kept in localStorage (`neurolingo/speaker/<db>/last`): `started` before speaking, `done` once it
 *    played to the end. After a reload, a reply marked `done` is not said again; one marked `started` follows rule 2.
 *    The clip length of a report still in flight is kept beside it, so a reload can finish the report.
 * 6. A failed speech is tried once more (the voice opens a fresh socket and token). A second failure shows
 *    "Could not say the reply" with Say it now. A speech that failed because the room voice stopped (the browser
 *    paused the audio) waits for it instead, as in rule 3, and is said from the start once it runs again.
 * 7. A newer reply that arrives while one is being said waits for it to finish, then goes through rule 2.
 */
import { callErrorKind, callErrorText, sendWithResend } from '../role/calls';
import { browserStorage, readItem, readSpeakerProgress, removeItem, saveSpeakerProgress, writeItem, type StorageLike } from '../role/storage';
import { createServerClock, type ServerClock } from './clock';

/** A reply from a snapshot older than this is shown as missed, not said (docs/station.md 3, step 2). */
export const SPEAKER_MISSED_AFTER_MS = 20_000;

/** `reply_spoken` is resent for this long after the first try (docs/station.md 3, step 5). */
export const SPEAKER_REPORT_WINDOW_MS = 60_000;

/** One try, and one more with a fresh socket and token (docs/station.md 3, step 7). */
export const SPEAKER_SAY_TRIES = 2;

/** The module's answers that mean "stop reporting": the reply was not Released any more, or it was purged. */
export const SPEAKER_STOP_MESSAGES: readonly string[] = ['reply is not released', 'no such question'];

const U32_MAX = 4_294_967_295;

/** The reply as plain values: `my_session.reply` (question_id, text, tone, laugh, released_at). */
export interface SpeakerReply {
  questionId: bigint;
  text: string;
  tone: string;
  laugh: boolean;
  /** `released_at` on the server clock, in epoch ms. */
  releasedAtMs: number;
}

/** Where an offered reply came from: a subscription snapshot (connect, reconnect) or a live change. */
export type ReplySource = 'snapshot' | 'live';

export type SayResult = { ok: true; clipMs: number } | { ok: false; reason: 'failed' | 'stopped'; message: string };

export interface SayJob {
  /** Resolves once the speech has finished playing (or failed, or was stopped). Never rejects. */
  readonly done: Promise<SayResult>;
  cancel(): void;
}

export type SpeakerPhase =
  /** Nothing to say. */
  | 'idle'
  /** A fresh reply is here, but the room voice has not been started. */
  | 'waiting_audio'
  | 'speaking'
  | 'said'
  /** Released too long ago when this page saw it (rule 2), or too long ago when the tap came (rule 3). */
  | 'missed'
  /** The voice failed twice. */
  | 'failed';

export type ReportStatus =
  | 'none'
  | 'sending'
  /** The connection dropped; sending again once it is back. */
  | 'retrying'
  | 'done'
  /** The module said the reply is not waiting any more (rule 4). */
  | 'stopped'
  /** The module refused for another reason (shown as is). */
  | 'refused'
  /** Not connected for 60 s. */
  | 'gave_up';

export interface SpeakerState {
  phase: SpeakerPhase;
  /** The reply on screen, or null. */
  reply: SpeakerReply | null;
  /** True while `my_session` still shows this reply (it is still Released), so Say it now makes sense. */
  stillReleased: boolean;
  /** When this page finished saying it (laptop clock); null when it was said before a reload. */
  saidAt: number | null;
  clipMs: number | null;
  /** Raw error text of a failed speech, for a tooltip only. */
  errorText: string | null;
  report: ReportStatus;
  /** The module's words for a stopped or refused report, or the last error, for a tooltip. */
  reportText: string | null;
}

export const SPEAKER_IDLE: SpeakerState = {
  phase: 'idle',
  reply: null,
  stillReleased: false,
  saidAt: null,
  clipMs: null,
  errorText: null,
  report: 'none',
  reportText: null,
};

export interface SpeakerEngineOptions {
  /** The database name, for the progress keys. */
  db: string;
  /** Starts saying a reply. `attempt` is 1, then 2 for the retry (which should use a fresh socket and token). */
  say(reply: SpeakerReply, attempt: number): SayJob;
  /** True while the room voice runs (the AudioContext was started by a tap and is running). */
  audioReady(): boolean;
  /** `conn.reducers.replySpoken({ questionId, ms })`. */
  reportSpoken(questionId: bigint, ms: number): Promise<void>;
  /** Resolves true once the role connection is live again, false after `timeoutMs`. */
  waitForLive(timeoutMs: number): Promise<boolean>;
  /** Any other refusal goes here (`not allowed` shows the pairing card again). */
  noteCallError?(error: unknown): void;
  storage?: StorageLike | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  clock?: ServerClock;
}

export interface SpeakerEngine {
  getState(): SpeakerState;
  subscribe(listener: () => void): () => void;
  /** The newest released reply from `my_session`, or null when it shows none. */
  offer(reply: SpeakerReply | null, source: ReplySource): void;
  /** A live `scan_state` update: its `updated_at` (server ms) and when it arrived here. */
  noteServerTime(serverMs: number, arrivedAt: number): void;
  /** Server clock minus laptop clock, in ms. */
  clockOffset(): number;
  /** How long ago the reply was released, by the server clock estimate. */
  ageMs(reply: SpeakerReply): number;
  /** Call when the room voice starts or stops: a waiting reply may be said now (rule 3). */
  audioChanged(): void;
  /** The Say it now link: says the reply on screen from the start. False when it cannot. */
  sayNow(): boolean;
  /** Stops any speech in progress (the page is closing). */
  stop(): void;
}

/** `neurolingo/speaker/<db>/report`: the clip length of a `reply_spoken` still in flight. */
export function speakerReportKey(db: string): string {
  return `neurolingo/speaker/${db}/report`;
}

interface PendingReport {
  questionId: string;
  ms: number;
}

function readPending(db: string, storage: StorageLike | null): PendingReport | null {
  const raw = readItem(speakerReportKey(db), storage);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingReport> | null;
    if (!parsed || typeof parsed.questionId !== 'string' || !/^\d{1,20}$/.test(parsed.questionId)) return null;
    if (typeof parsed.ms !== 'number' || !Number.isInteger(parsed.ms) || parsed.ms < 0 || parsed.ms > U32_MAX) return null;
    return { questionId: parsed.questionId, ms: parsed.ms };
  } catch {
    return null;
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createSpeakerEngine(options: SpeakerEngineOptions): SpeakerEngine {
  const { db } = options;
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const clock = options.clock ?? createServerClock();

  let state: SpeakerState = SPEAKER_IDLE;
  const listeners = new Set<() => void>();
  /** The highest question id this page has said, skipped, or is saying. */
  let handled: bigint | null = null;
  /** The question id `my_session` shows now, or null. */
  let released: bigint | null = null;
  let job: { questionId: bigint; job: SayJob } | null = null;
  let queued: { reply: SpeakerReply; source: ReplySource } | null = null;
  const reporting = new Set<string>();

  const set = (next: SpeakerState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const show = (patch: Partial<SpeakerState> & { phase: SpeakerPhase; reply: SpeakerReply }) => {
    set({ ...SPEAKER_IDLE, stillReleased: released === patch.reply.questionId, ...patch });
  };

  const ageMs = (reply: SpeakerReply) => now() + clock.offset(now()) - reply.releasedAtMs;

  const clearPending = (id: string) => {
    const pending = readPending(db, storage);
    if (pending?.questionId === id) removeItem(speakerReportKey(db), storage);
  };

  const report = async (reply: SpeakerReply, ms: number) => {
    const id = reply.questionId.toString();
    if (reporting.has(id)) return;
    reporting.add(id);
    const mark = (status: ReportStatus, text: string | null = null) => {
      if (state.reply?.questionId === reply.questionId) set({ ...state, report: status, reportText: text });
    };
    mark('sending');
    try {
      await sendWithResend(() => options.reportSpoken(reply.questionId, ms), {
        maxAgeMs: SPEAKER_REPORT_WINDOW_MS,
        now,
        sleep,
        waitForLive: (timeoutMs) => {
          mark('retrying');
          return options.waitForLive(timeoutMs);
        },
      });
      mark('done');
    } catch (error) {
      const message = callErrorText(error).trim();
      if (callErrorKind(error) === 'sender') {
        if (SPEAKER_STOP_MESSAGES.includes(message)) {
          mark('stopped', message);
        } else {
          options.noteCallError?.(error);
          mark('refused', message);
        }
      } else {
        mark('gave_up', message);
      }
    } finally {
      reporting.delete(id);
      clearPending(id);
    }
  };

  const speak = (reply: SpeakerReply, attempt: number) => {
    const id = reply.questionId.toString();
    saveSpeakerProgress(db, { questionId: id, state: 'started' }, storage);
    show({ phase: 'speaking', reply });
    let started: SayJob;
    try {
      started = options.say(reply, attempt);
    } catch (error) {
      started = { done: Promise.resolve({ ok: false, reason: 'failed', message: errorText(error) }), cancel() {} };
    }
    const mine = { questionId: reply.questionId, job: started };
    job = mine;
    started.done.then(
      (result) => finish(mine, reply, attempt, result),
      (error: unknown) => finish(mine, reply, attempt, { ok: false, reason: 'failed', message: errorText(error) }),
    );
  };

  const finish = (mine: { questionId: bigint; job: SayJob }, reply: SpeakerReply, attempt: number, result: SayResult) => {
    if (job !== mine) return;
    job = null;
    const id = reply.questionId.toString();
    if (result.ok && result.clipMs > 0) {
      const ms = Math.min(U32_MAX, Math.max(1, Math.round(result.clipMs)));
      saveSpeakerProgress(db, { questionId: id, state: 'done' }, storage);
      writeItem(speakerReportKey(db), JSON.stringify({ questionId: id, ms }), storage);
      show({ phase: 'said', reply, saidAt: now(), clipMs: ms });
      void report(reply, ms);
    } else if (!result.ok && result.reason === 'stopped') {
      // This page stopped it. Nothing was reported; Say it now can start it again.
      show({ phase: 'failed', reply, errorText: result.message });
    } else {
      const message = result.ok ? 'The speech had no sound.' : result.message;
      if (attempt < SPEAKER_SAY_TRIES && options.audioReady()) {
        speak(reply, attempt + 1);
        return;
      }
      if (!options.audioReady()) {
        // The room voice stopped under it (the browser paused it, the output changed): it waits for the room voice
        // and is said from the start once that runs, if it is still under 20 s old (rule 3).
        show({ phase: 'waiting_audio', reply, errorText: message });
      } else {
        show({ phase: 'failed', reply, errorText: message });
      }
    }
    next();
  };

  /** Decides what to do with a reply this page has not handled yet (rules 2, 3 and 5). */
  const begin = (reply: SpeakerReply, source: ReplySource) => {
    const id = reply.questionId.toString();
    const progress = readSpeakerProgress(db, storage);
    if (progress?.questionId === id && progress.state === 'done') {
      // Said to the end before a reload. Never again; finish its report if that was still in flight.
      show({ phase: 'said', reply });
      const pending = readPending(db, storage);
      if (pending?.questionId === id) void report(reply, pending.ms);
      return;
    }
    if (source === 'snapshot' && ageMs(reply) > SPEAKER_MISSED_AFTER_MS) {
      show({ phase: 'missed', reply });
      return;
    }
    if (!options.audioReady()) {
      show({ phase: 'waiting_audio', reply });
      return;
    }
    speak(reply, 1);
  };

  const next = () => {
    if (job || !queued) return;
    const waiting = queued;
    queued = null;
    if (handled !== null && waiting.reply.questionId <= handled) return;
    handled = waiting.reply.questionId;
    begin(waiting.reply, waiting.source);
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    offer(reply, source) {
      released = reply ? reply.questionId : null;
      if (!reply) {
        // The reply is no longer waiting to be said: drop a reply that waited for the tap, keep the rest on screen.
        if (state.phase === 'waiting_audio') set(SPEAKER_IDLE);
        else if (state.stillReleased) set({ ...state, stillReleased: false });
        return;
      }
      if (state.reply && state.stillReleased !== (state.reply.questionId === reply.questionId)) {
        set({ ...state, stillReleased: state.reply.questionId === reply.questionId });
      }
      const top = queued && (handled === null || queued.reply.questionId > handled) ? queued.reply.questionId : handled;
      if (top !== null && reply.questionId <= top) return;
      if (job) {
        queued = { reply, source };
        return;
      }
      handled = reply.questionId;
      begin(reply, source);
    },
    noteServerTime(serverMs, arrivedAt) {
      clock.sample(serverMs, arrivedAt);
    },
    clockOffset: () => clock.offset(now()),
    ageMs,
    audioChanged() {
      if (state.phase !== 'waiting_audio' || !state.reply || job || !options.audioReady()) return;
      const reply = state.reply;
      if (ageMs(reply) > SPEAKER_MISSED_AFTER_MS) show({ phase: 'missed', reply });
      else speak(reply, 1);
    },
    sayNow() {
      const reply = state.reply;
      if (job || !reply || !state.stillReleased) return false;
      if (state.phase !== 'missed' && state.phase !== 'failed' && state.phase !== 'waiting_audio') return false;
      if (!options.audioReady()) return false;
      speak(reply, 1);
      return true;
    },
    stop() {
      const current = job;
      job = null;
      queued = null;
      current?.job.cancel();
    },
  };
}
