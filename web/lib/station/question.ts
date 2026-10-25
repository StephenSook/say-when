/**
 * The partner's question in the earpiece (Stephen, Sun Oct 25 2026: "when Deem is speaking, Shashank should be able to
 * hear the question"). With the earpiece in, the wearer cannot hear the room well, so a new partner question is said
 * once in the earpiece, "Question: <its words>", and only then are its numbered options read.
 *
 * Which questions are said (from `my_session`, which names the scanned question):
 *   - a new question id whose origin is Partner (asked by voice or typed on the partner phone);
 *   - not the person's own menu (origin Menu);
 *   - not a follow-up turn the module opens after a confirmed web search or a category pick: such a turn copies the
 *     original question's words and origin (spacetime/src/clock.ts createFollowUp) and `my_session` has no parent
 *     id, so it is told apart by its words matching the question before it while the last gesture is the confirm or
 *     the category pick that opened it (`accepted:confirm_search`, `accepted:pick_category`);
 *   - not the question that was already current when this page took the session (Continue after a reload);
 *   - only under direct select (D18, `config.input_mode` Direct; the engine checks it): a pick there counts for any
 *     step of the live list, so a read that waits behind the question still counts, while the scan fallback resolves
 *     YES by the step heard and a late read would be stale.
 *
 * The words are the partner's, with anything shaped like a phone number said as "a number" and anything shaped like a
 * key or a token said as "a code", cut at a word to about 200 characters.
 *
 * Timing: the words are voiced the moment the question arrives (the same Cartesia player as the option clips, in the
 * assistant voice), so this synthesis is queued ahead of the options'. The clip goes to Earpiece.playQuestion, which
 * plays it on the options channel only when it can come before the list: once that question's list has begun it is
 * dropped, never cut in, and reads the module's clock starts while it plays wait behind it. A read-back or a stock
 * phrase still playing is waited for, up to 4 s. The question is never reported to the module as an option read.
 */
import { redact } from '../cartesia/events';
import { cleanText } from '../cartesia/tones';
import { replacePhoneNumbers } from '../format';
import type { ClipLike, SynthJob } from './earpiece';

export const QUESTION_PREFIX = 'Question:';
/** The partner's words are cut at a word to about this many characters. */
export const QUESTION_MAX_CHARS = 200;
/** A question that waits longer than this for a read-back or a stock phrase is not said. */
export const QUESTION_MAX_WAIT_MS = 4_000;
/** How often a waiting question looks whether the earpiece is free. */
export const QUESTION_POLL_MS = 100;
/** The last gesture outcomes after which the module opens a follow-up turn on the same question. */
export const FOLLOW_UP_OUTCOMES: readonly string[] = ['accepted:confirm_search', 'accepted:pick_category'];

/** What redact() writes for a key or a token. */
const KEY_OR_TOKEN = /\[(?:key|token)\]/;

/** `my_session`'s scanned question, reduced. */
export interface SessionQuestion {
  questionId: bigint;
  text: string;
  origin: 'partner' | 'menu';
  lastGestureOutcome: string;
}

/** The partner's words as the earpiece says them: no phone numbers, keys or tokens, about 200 characters at most. */
export function spokenQuestionText(text: string): string {
  const words = replacePhoneNumbers(String(text), 'a number')
    .split(/\s+/)
    .filter((word) => word !== '')
    .map((word) => (KEY_OR_TOKEN.test(redact(word)) ? 'a code' : word));
  return cutAtWord(cleanText(words.join(' ')), QUESTION_MAX_CHARS);
}

/** "Question: Want some tea?", or '' when there are no words to say. */
export function questionEarText(text: string): string {
  const words = spokenQuestionText(text);
  return words === '' ? '' : `${QUESTION_PREFIX} ${words}`;
}

/** A follow-up turn the module opened on the same question (see the top of this file). */
export function isFollowUp(q: Pick<SessionQuestion, 'text' | 'lastGestureOutcome'>, previousText: string): boolean {
  return q.text.trim() !== '' && q.text === previousText && FOLLOW_UP_OUTCOMES.includes(q.lastGestureOutcome);
}

function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.!?-]+$/, '');
}

/** Earpiece.playQuestion's answer: it plays now, the earpiece is busy with something not to be cut, or it is too late. */
export type QuestionPlay = 'played' | 'wait' | 'late';

export interface QuestionReaderDeps<Clip extends ClipLike = ClipLike> {
  now(): number;
  /** The setting is on, this page runs the session, and the earpiece has a voice (not the silent test). */
  enabled(): boolean;
  /** The voice can synthesize now; while it cannot, a question is not said at all. Default true. */
  ready?(): boolean;
  /** Synthesizes the words in the assistant voice (the station's Cartesia player). */
  synth(text: string): SynthJob<Clip>;
  /** Earpiece.playQuestion. */
  play(questionId: bigint, clip: Clip): QuestionPlay;
  /** A synthesis failed for a reason other than a cancel. */
  onVoiceError?(error: unknown): void;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

/** Decides which `my_session` questions are said, voices them, and hands each clip to the earpiece once. */
export class QuestionReader<Clip extends ClipLike = ClipLike> {
  private lastId = 0n;
  private lastText = '';
  private current: { questionId: bigint; job: SynthJob<Clip>; clip: Clip | null; readyAt: number } | null = null;
  private timer: unknown = null;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: QuestionReaderDeps<Clip>) {
    this.setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** The question being voiced or waiting for the earpiece, if any. */
  busyWith(): bigint | null {
    return this.current?.questionId ?? null;
  }

  /** This page now runs a session: the question current now was asked before, and is not said. */
  begin(q: SessionQuestion | null): void {
    this.cancel();
    this.lastId = q?.questionId ?? 0n;
    this.lastText = q?.text ?? '';
  }

  /** Every `my_session` read while this page runs the session. */
  update(q: SessionQuestion | null): void {
    if (!q || q.questionId === 0n || q.questionId === this.lastId) return;
    const previousText = this.lastText;
    this.lastId = q.questionId;
    this.lastText = q.text;
    // A newer question replaces one still being voiced or waiting.
    this.cancel();
    if (q.origin !== 'partner' || isFollowUp(q, previousText)) return;
    if (!this.deps.enabled() || (this.deps.ready && !this.deps.ready())) return;
    const text = questionEarText(q.text);
    if (text === '') return;
    let job: SynthJob<Clip>;
    try {
      job = this.deps.synth(text);
    } catch (error) {
      this.deps.onVoiceError?.(error);
      return;
    }
    const entry: { questionId: bigint; job: SynthJob<Clip>; clip: Clip | null; readyAt: number } = { questionId: q.questionId, job, clip: null, readyAt: 0 };
    this.current = entry;
    job.done.then(
      (clip) => {
        if (this.current !== entry) return;
        entry.clip = clip;
        entry.readyAt = this.deps.now();
        this.tryPlay();
      },
      (error: unknown) => {
        if (this.current !== entry) return;
        this.current = null;
        if (!(error instanceof Error && error.name === 'TtsCancelled')) this.deps.onVoiceError?.(error);
      },
    );
  }

  /** Drop the question being voiced or waiting (a newer one, the setting turned off, the session ended). */
  cancel(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    const entry = this.current;
    this.current = null;
    entry?.job.cancel();
  }

  private tryPlay(): void {
    this.timer = null;
    const entry = this.current;
    if (!entry || !entry.clip) return;
    if (!this.deps.enabled()) {
      this.current = null;
      return;
    }
    const result = this.deps.play(entry.questionId, entry.clip);
    if (result === 'wait' && this.deps.now() - entry.readyAt < QUESTION_MAX_WAIT_MS) {
      this.timer = this.setTimer(() => this.tryPlay(), QUESTION_POLL_MS);
      return;
    }
    // Played, too late, or waited too long: either way it is done.
    this.current = null;
  }
}
