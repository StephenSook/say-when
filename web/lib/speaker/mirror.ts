/**
 * Mirror the earpiece (Stephen, Sun Oct 25 2026: "make Cartesia output the voice every time when it's reading the
 * stuff back"). Judges in the room cannot hear the headset, so the room voice also says every read-back ("...
 * Clench your jaw to send it."), as well as the picked reply it already says. Since Oct 25 (Stephen: "take off question
 * repeating", "take off answer choices being repeated") it says neither the partner's question nor the numbered
 * options: lib/speaker/mirror-rows.ts offers read-backs only. Plain TypeScript outside React; the audio is the same
 * Cartesia voice as the reply.
 *
 * The rules:
 * 1. Lines are said one at a time, in the order they arrive. The room voice never talks over itself.
 * 2. Each line has a key and is said at most once. A line for an older question than the newest one seen is dropped,
 *    and a newer question drops the queued lines of older ones and cuts the one being said.
 * 3. The picked reply has priority: when it starts, the line being said is cut and every queued line for that
 *    question or an older one is dropped. No line starts while the reply (or the test sentence) plays.
 * 4. A pause drops everything. `drop` removes lines that no longer apply (options at Idle, a read-back that stopped).
 * 5. A line waits for the room voice when it is not started, and is dropped once it is 20 s old: a judge must never
 *    hear a stale question.
 * 6. A failed line is tried once more (the voice opens a fresh socket and token). A line stopped before its end by
 *    the audio stopping, or by the voice giving way to the reply or the test sentence, goes back to the front of the
 *    queue and is said from the start once it can be, if it still applies (a few times at most). A second failure
 *    shows on the page and the next line goes on.
 * 7. Off, or with the room's sharing toggle off (the board views hide the words then), nothing is queued.
 */
import { redact } from '../cartesia/events';
import { cleanText } from '../cartesia/tones';
import { replacePhoneNumbers } from '../format';
import type { SayJob, SayResult } from './engine';

/** A line older than this when its turn comes is dropped, not said. */
export const MIRROR_STALE_MS = 20_000;

/** At most this many lines wait; the oldest goes first. */
export const MIRROR_MAX_QUEUE = 12;

/** One try, and one more with a fresh socket and token. */
export const MIRROR_SAY_TRIES = 2;

/** A line stopped before its end (the audio stopped, the reply or the test took the voice) goes back this often. */
export const MIRROR_PUT_BACKS = 3;

/** How many keys are remembered so a line is never said twice. */
const SEEN_LIMIT = 400;

export type MirrorKind = 'question' | 'option' | 'readback';

export interface MirrorItem {
  /** Unique per line: `q:<question>`, `read:<session>:<option_start_seq>`, `rb:<kind>:<id>:<digest>`. */
  key: string;
  kind: MirrorKind;
  /** The question the line belongs to. */
  questionId: bigint;
  /** The words, already safe for the room (roomSafeText). */
  text: string;
  /** The assistant voice (question, prompts, read-backs) or the reply voice with the option's tone, as in the earpiece. */
  voice: 'assistant' | 'reply';
  tone: string;
  /** When it arrived, on the laptop clock. */
  at: number;
}

export type MirrorPhase =
  /** The toggle is off: only the picked reply is said. */
  | 'off'
  /** The room's sharing toggle is off: the board hides the words, so there is nothing to mirror. */
  | 'no_sharing'
  /** The board views could not be read. */
  | 'unavailable'
  | 'idle'
  /** Lines are waiting for the room voice to start. */
  | 'waiting_audio'
  | 'speaking'
  /** The last line failed twice. */
  | 'failed';

export interface MirrorState {
  phase: MirrorPhase;
  on: boolean;
  sharing: boolean;
  /** The line being said, or the one that failed. */
  current: MirrorItem | null;
  queued: number;
  /** Raw error text, for a tooltip only. */
  errorText: string | null;
}

export const MIRROR_INITIAL: MirrorState = { phase: 'off', on: false, sharing: false, current: null, queued: 0, errorText: null };

export interface SpeakerMirrorOptions {
  /** Starts saying one line. `attempt` is 1, then 2 for the retry (a fresh socket and token). */
  say(item: MirrorItem, attempt: number): SayJob;
  /** True while the room voice runs (the tap was made and the AudioContext runs). */
  audioReady(): boolean;
  /** True while no reply and no test sentence is playing. */
  replyIdle(): boolean;
  /** The saved toggle. Default on. */
  on?: boolean;
  now?: () => number;
}

export interface SpeakerMirror {
  getState(): MirrorState;
  subscribe(listener: () => void): () => void;
  setOn(on: boolean): void;
  /** `config.share_text_on_board`. */
  setSharing(sharing: boolean): void;
  /** The board views could not be read (null once they are). */
  setProblem(text: string | null): void;
  /** A new line from the rows. */
  offer(item: MirrorItem): void;
  /** A newer question is scanned: older lines go (rule 2). */
  advance(questionId: bigint): void;
  /** Drops queued lines that match, and cuts the one being said if it matches. */
  drop(match: (item: MirrorItem) => boolean): void;
  /** A pause: drop everything and cut what plays. */
  clear(): void;
  /** The picked reply for `questionId` starts (rule 3). */
  replyStarted(questionId: bigint): void;
  /** Look again: the reply ended, the room voice started. */
  kick(): void;
  /** The page is closing. */
  stop(): void;
}

/** What redact() writes for a key or a token. */
const KEY_OR_TOKEN = /\[(?:key|token)\]/;

/**
 * Words safe to say in the room: anything shaped like a phone number is said as "a number" and anything shaped like
 * a key or a token as "a code", as the earpiece does with the partner's question (lib/station/question.ts).
 */
export function roomSafeText(text: string): string {
  const words = replacePhoneNumbers(String(text), 'a number')
    .split(/\s+/)
    .filter((word) => word !== '')
    .map((word) => (KEY_OR_TOKEN.test(redact(word)) ? 'a code' : word));
  return cleanText(words.join(' '));
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

export function createSpeakerMirror(options: SpeakerMirrorOptions): SpeakerMirror {
  const now = options.now ?? Date.now;
  let on = options.on ?? true;
  let sharing = false;
  let problem: string | null = null;
  let queue: MirrorItem[] = [];
  let job: { item: MirrorItem; job: SayJob } | null = null;
  /** The line shown: being said, or failed. */
  let shown: { item: MirrorItem; failed: boolean; errorText: string | null } | null = null;
  let newest: bigint = 0n;
  let lastReply: bigint | null = null;
  const seen = new Set<string>();
  const putBacks = new WeakMap<MirrorItem, number>();
  const listeners = new Set<() => void>();

  const compute = (): MirrorState => {
    let phase: MirrorPhase;
    if (!on) phase = 'off';
    else if (problem !== null) phase = 'unavailable';
    else if (!sharing) phase = 'no_sharing';
    else if (job) phase = 'speaking';
    else if (queue.length > 0 && !options.audioReady()) phase = 'waiting_audio';
    else if (shown?.failed) phase = 'failed';
    else phase = 'idle';
    return {
      phase,
      on,
      sharing,
      current: job ? job.item : shown?.failed ? shown.item : null,
      queued: queue.length,
      errorText: phase === 'unavailable' ? problem : shown?.failed ? shown.errorText : null,
    };
  };

  let state: MirrorState = compute();

  const changed = () => {
    const next = compute();
    if (
      next.phase === state.phase &&
      next.on === state.on &&
      next.sharing === state.sharing &&
      next.current === state.current &&
      next.queued === state.queued &&
      next.errorText === state.errorText
    ) {
      return;
    }
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const remember = (key: string) => {
    seen.add(key);
    if (seen.size > SEEN_LIMIT) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
  };

  /** Cuts the line being said; its job ends as stopped and is not retried. */
  const cut = () => {
    const current = job;
    job = null;
    current?.job.cancel();
  };

  const start = (item: MirrorItem, attempt: number) => {
    let started: SayJob;
    try {
      started = options.say(item, attempt);
    } catch (error) {
      started = { done: Promise.resolve({ ok: false, reason: 'failed', message: errorText(error) }), cancel() {} };
    }
    const mine = { item, job: started };
    job = mine;
    shown = { item, failed: false, errorText: null };
    started.done.then(
      (result) => finish(mine, attempt, result),
      (error: unknown) => finish(mine, attempt, { ok: false, reason: 'failed', message: errorText(error) }),
    );
    changed();
  };

  const finish = (mine: { item: MirrorItem; job: SayJob }, attempt: number, result: SayResult) => {
    if (job !== mine) {
      // Cut on purpose (a newer question, the reply, a pause): nothing to retry.
      changed();
      return;
    }
    job = null;
    const item = mine.item;
    if (result.ok && result.clipMs > 0) {
      shown = null;
    } else if (!result.ok && result.reason === 'stopped') {
      // The voice stopped it for the reply or the test sentence: it is said again afterwards, if it still applies.
      shown = null;
      putBack(item);
    } else {
      const message = result.ok ? 'The speech had no sound.' : result.message;
      if (!options.audioReady() || !options.replyIdle()) {
        // The room voice stopped under it, or the reply took over: said again from the start once it can be.
        shown = null;
        putBack(item);
      } else if (attempt < MIRROR_SAY_TRIES && stillApplies(item)) {
        start(item, attempt + 1);
        return;
      } else {
        shown = { item, failed: true, errorText: message };
      }
    }
    pump();
  };

  /** A line not yet heard to the end still belongs: fresh, the mirror on, its question not passed or answered. */
  const stillApplies = (item: MirrorItem): boolean =>
    on &&
    sharing &&
    problem === null &&
    now() - item.at <= MIRROR_STALE_MS &&
    item.questionId >= newest &&
    (lastReply === null || item.questionId > lastReply);

  /** Puts a line that was stopped before its end back at the front, a few times at most. */
  const putBack = (item: MirrorItem) => {
    const times = putBacks.get(item) ?? 0;
    if (times >= MIRROR_PUT_BACKS || !stillApplies(item)) return;
    putBacks.set(item, times + 1);
    queue.unshift(item);
  };

  const pump = () => {
    if (job || !on || !sharing || problem !== null) {
      changed();
      return;
    }
    while (queue.length > 0) {
      const head = queue[0]!;
      if (now() - head.at > MIRROR_STALE_MS || head.questionId < newest) {
        queue.shift();
        continue;
      }
      if (!options.audioReady() || !options.replyIdle()) break;
      queue.shift();
      start(head, 1);
      return;
    }
    changed();
  };

  const advanceTo = (questionId: bigint) => {
    if (questionId <= newest) return;
    newest = questionId;
    queue = queue.filter((item) => item.questionId >= newest);
    if (job && job.item.questionId < newest) cut();
    if (shown?.failed && shown.item.questionId < newest) shown = null;
  };

  const clearAll = () => {
    queue = [];
    cut();
    shown = null;
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setOn(next) {
      if (next === on) return;
      on = next;
      if (!on) clearAll();
      pump();
    },
    setSharing(next) {
      if (next === sharing) return;
      sharing = next;
      if (!sharing) clearAll();
      pump();
    },
    setProblem(text) {
      if (text === problem) return;
      problem = text;
      if (problem !== null) clearAll();
      pump();
    },
    offer(item) {
      if (seen.has(item.key)) return;
      remember(item.key);
      if (!on || !sharing || problem !== null || item.text.trim() === '') return;
      if (item.questionId < newest) return;
      advanceTo(item.questionId);
      // The reply to this question already started: its question and options are past.
      if (lastReply !== null && item.questionId <= lastReply) return;
      queue.push(item);
      while (queue.length > MIRROR_MAX_QUEUE) queue.shift();
      pump();
    },
    advance(questionId) {
      advanceTo(questionId);
      pump();
    },
    drop(match) {
      queue = queue.filter((item) => !match(item));
      if (job && match(job.item)) cut();
      if (shown?.failed && match(shown.item)) shown = null;
      pump();
    },
    clear() {
      clearAll();
      changed();
    },
    replyStarted(questionId) {
      if (lastReply !== null && questionId <= lastReply) return;
      lastReply = questionId;
      queue = queue.filter((item) => item.questionId > questionId);
      if (job && job.item.questionId <= questionId) cut();
      changed();
    },
    kick() {
      pump();
    },
    stop() {
      clearAll();
      changed();
    },
  };
}
