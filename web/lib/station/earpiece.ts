/**
 * Earpiece audio (docs/station.md 2.9): what the wearer hears, driven only by `scan_state`. The station never times a
 * scan itself.
 *
 * Synthesis ("prefetch" means every clip is ready before the cursor reaches it):
 *   1. The current version's options in rank order, one at a time, when its answer mode is Pick. Since direct select
 *      (D18) each clip is the option's number and short label, "One: good." (lib/station/phrases.ts optionEarText),
 *      and the module reads them once, in rank order, then waits for a pick. Menu items come from the phrase cache by
 *      their text.
 *   2. After each clip: `report_clip_ready(option_id, clip_ms, synth_ms)` once per option id. `clip_ms` must be 1 to
 *      30000, so a 0 ms clip is not reported and the scan starts at `clip_deadline_ms` with an estimate.
 *   3. Then the pending version, so a better version can switch in without a wait.
 *   4. A yes or no version is not synthesized: its scan reads the stock "Yes or no?" prompt.
 *   5. Options that left `my_options` lose their jobs and their clips. At most 16 clips are kept.
 *
 * Playback, on a `scan_state` update with a new `step_seq`:
 *   Reading, Pick      play that option's clip; if it is not ready, play it the moment it is, but only while that
 *                      same read or its Window is current
 *   Reading, yes or no play "Yes or no?"
 *   Window, Veto, Preparing   nothing new (a clip still playing finishes)
 *   Idle               stop the option audio
 *   Paused             stop the option audio and any read-back at once
 * Each play start goes to the heard log, and each read's word timings go to `report_word_timings` when the bindings
 * have it (module v2); without it the station does not report them.
 *
 * The partner's question (lib/station/question.ts, `playQuestion`): said on this channel before its list, only while
 * the scan has not begun reading that question (Preparing, or the scan row not here yet). It never cuts a read-back,
 * and it waits while a stock phrase plays on the other channel; a read of an older question is cut, since the module
 * moved on from it. While it plays, each read the module's clock starts is queued instead of played, its heard log
 * entry held (lib/station/heard.ts); when the question ends the queued reads play one after another, each counting
 * as heard from its real play start, until the earpiece has caught up with the clock. A queued read that is no longer
 * on the current list (another question or version, Idle) is dropped as unheard. A pause, `stopOptions` or anything
 * that stops the question drops the queue too. The question is not a read: it is not in the heard log and not
 * reported to the module.
 *
 * Silent test mode: nothing is synthesized, played or reported; the heard log uses arrival times.
 */
import { callErrorKind, callErrorText, sendWithResend } from '../role/calls';
import type { ReportWordTimingsArgs } from '../role/calls';
import type { HeardLog, HeardPhase } from './heard';
import type { QuestionPlay } from './question';

/** The parts of a cartesia `Clip` the station uses. */
export interface ClipLike {
  durationMs: number;
  totalMs: number;
  words: ReadonlyArray<{ word: string; startMs: number; endMs: number }>;
}

export type ChannelUse = 'option' | 'prompt' | 'readback' | 'question' | 'phrase';

/**
 * One `AudioOut` and what it is playing. `AudioOut.play()` stops whatever that output was playing, so options and
 * read-backs share one channel and stock phrases use another (docs/station.md 2.9 "Two outputs").
 */
export class Channel<Clip extends ClipLike = ClipLike> {
  private current: { use: ChannelUse; token: number; clip: Clip } | null = null;
  private token = 0;

  constructor(private readonly out: { play(clip: Clip): Promise<'ended' | 'stopped'>; stop(): void; positionMs(): number }) {}

  play(clip: Clip, use: ChannelUse): Promise<'ended' | 'stopped'> {
    const token = ++this.token;
    this.current = { use, token, clip };
    let result: Promise<'ended' | 'stopped'>;
    try {
      result = this.out.play(clip);
    } catch (error) {
      this.current = null;
      return Promise.reject(error);
    }
    return result.then((how) => {
      if (this.current?.token === token) this.current = null;
      return how;
    });
  }

  /** Stops the channel when it is playing one of `uses` (any use when omitted). Returns true when it stopped something. */
  stop(uses?: readonly ChannelUse[]): boolean {
    if (!this.current) return false;
    if (uses && !uses.includes(this.current.use)) return false;
    this.current = null;
    this.token++;
    this.out.stop();
    return true;
  }

  use(): ChannelUse | null {
    return this.current?.use ?? null;
  }

  clip(): Clip | null {
    return this.current?.clip ?? null;
  }

  busy(): boolean {
    return this.current !== null;
  }

  positionMs(): number {
    return this.out.positionMs();
  }
}

/** A `my_options` row, reduced. `kind` is the binding's tag: Reply, Errand, Call, Search, Category or Menu. */
export interface OptionRowLite {
  optionId: bigint;
  questionId: bigint;
  version: number;
  rank: number;
  kind: string;
  text: string;
  /** The short earpiece words (D18), read as "One: good."; '' means read `text`. */
  label: string;
  tone: string;
  laugh: boolean;
  current: boolean;
}

/** A `scan_state` row, reduced, for the active session. */
export interface ScanLite {
  sessionId: bigint;
  questionId: bigint;
  version: number;
  phase: HeardPhase;
  answerMode: 'pick' | 'yes_no';
  cursor: number;
  optionCount: number;
  stepSeq: bigint;
  optionStartSeq: bigint;
}

export interface SynthJob<Clip extends ClipLike = ClipLike> {
  done: Promise<Clip>;
  cancel(): void;
}

/** Word timings as the module accepts them: whole ms into the clip, sorted, ends at or after starts, capped, at most 100. */
export const WORD_TIMING_CAP_MS = 30_000;
export const WORD_TIMING_MAX_WORDS = 100;
export const MAX_CLIPS = 16;
/** `report_clip_ready` and `report_word_timings` are sent again after a disconnect for this long. */
export const REPORT_RESEND_MS = 10_000;

export function cleanWordTimings(words: ClipLike['words']): { startsMs: number[]; endsMs: number[] } | null {
  const pairs = words
    .filter((w) => Number.isFinite(w.startMs) && Number.isFinite(w.endMs))
    .map((w) => {
      const start = Math.min(WORD_TIMING_CAP_MS, Math.max(0, Math.round(w.startMs)));
      const end = Math.min(WORD_TIMING_CAP_MS, Math.max(start, Math.round(w.endMs)));
      return [start, end] as const;
    })
    .sort((a, b) => a[0] - b[0])
    .slice(0, WORD_TIMING_MAX_WORDS);
  if (pairs.length === 0) return null;
  return { startsMs: pairs.map((p) => p[0]), endsMs: pairs.map((p) => p[1]) };
}

/** `report_clip_ready` accepts 1 to 30000 ms. */
export function reportableClipMs(durationMs: number): number | null {
  const ms = Math.round(durationMs);
  return Number.isFinite(ms) && ms >= 1 && ms <= 30_000 ? ms : null;
}

export interface EarpieceDeps<Clip extends ClipLike = ClipLike> {
  /** The station clock (performance.now). */
  now(): number;
  /** The output's lead (50 ms in AudioOut) plus the context's output and base latency, in ms. */
  latencyMs(): number;
  heard: HeardLog;
  options: Channel<Clip>;
  /** Synthesizes one option (menu items from the phrase cache). */
  speakOption(row: OptionRowLite): SynthJob<Clip>;
  /** The cached "Yes or no?" prompt. */
  yesNoPrompt(): Promise<Clip>;
  silent(): boolean;
  /** The voice can synthesize now. While it cannot, nothing is asked for and nothing is marked failed. Default true. */
  ready?(): boolean;
  reportClip(args: { optionId: bigint; clipMs: number; synthMs: number }): Promise<void>;
  /** `report_word_timings` bound to the connection, or null with bindings from before module v2. */
  wordTimings(): ((args: ReportWordTimingsArgs) => Promise<void>) | null;
  waitForLive(timeoutMs: number): Promise<boolean>;
  /** A synthesis failed for a reason other than a cancel (credits, outage, a refused token). */
  onVoiceError?(error: unknown): void;
  /** A stock phrase plays on the phrase channel now: the partner's question waits for it. Default false. */
  promptsBusy?(): boolean;
  onChange?(): void;
  sleep?(ms: number): Promise<void>;
}

/** A read the module's clock started while the partner's question played: it plays once the question ends. */
interface QueuedRead<Clip extends ClipLike> {
  questionId: bigint;
  version: number;
  optionStartSeq: bigint;
  optionId: bigint;
  rank: number;
  kind: 'option' | 'prompt';
  /** Null until known: an option's clip still being voiced, or the yes or no prompt not fetched yet. */
  clip: Clip | null;
}

export interface NowPlaying {
  kind: 'option' | 'prompt';
  optionId: bigint;
  rank: number;
  optionStartSeq: bigint;
  startedAt: number;
}

export interface EarpieceState {
  /** Option clips ready for the current version, and how many it has. */
  readyCount: number;
  optionCount: number;
  synthesizing: bigint | null;
  /** Median of `play start - row arrival` over the last 20 reads. */
  lagMedianMs: number | null;
  /** The newest read that started playing. */
  nowPlaying: NowPlaying | null;
  /** The newest read whose clip was late and has not played yet. */
  waitingFor: bigint | null;
  wordTimingsOff: boolean;
  /** The yes or no prompt is longer than `yes_no_cue_ms`, in ms; null when it fits or is unknown. */
  yesNoPromptMs: number | null;
  /** The partner question whose words play now (lib/station/question.ts), or null. */
  question?: bigint | null;
  /** Reads queued behind the partner's question, still to play. */
  queued?: number;
}

function key(id: bigint): string {
  return id.toString();
}

export class Earpiece<Clip extends ClipLike = ClipLike> {
  private rows: OptionRowLite[] = [];
  private readonly clips = new Map<string, Clip>();
  private readonly reported = new Set<string>();
  private readonly failed = new Map<string, number>();
  private job: { optionId: bigint; job: SynthJob<Clip> } | null = null;
  private scan: ScanLite | null = null;
  private lastStepSeq = 0n;
  private readonly arrivals = new Map<string, number>();
  private pending: { optionStartSeq: bigint; optionId: bigint; rank: number } | null = null;
  private readonly lags: number[] = [];
  private readonly timingsSent = new Set<string>();
  private timingsOff = false;
  private nowPlaying: NowPlaying | null = null;
  private yesNoPromptMs: number | null = null;
  private answerHint: { questionId: bigint; mode: 'pick' | 'yes_no' } | null = null;
  /**
   * Set from the moment the partner's question starts until the reads queued behind it have all played. `leadIn`
   * while the question itself plays. `gen` ties each play's end to this state, so a late end of an older one is
   * ignored.
   */
  private behind: { gen: number; questionId: bigint; leadIn: boolean } | null = null;
  private gen = 0;
  private queue: QueuedRead<Clip>[] = [];
  /** The first queued read waits for its clip (or the yes or no prompt). */
  private queueWaiting = false;

  constructor(private readonly deps: EarpieceDeps<Clip>) {}

  getState(): EarpieceState {
    const current = this.rows.filter((r) => r.current);
    return {
      readyCount: current.filter((r) => this.clips.has(key(r.optionId))).length,
      optionCount: current.length,
      synthesizing: this.job?.optionId ?? null,
      lagMedianMs: this.lags.length ? [...this.lags].sort((a, b) => a - b)[Math.floor(this.lags.length / 2)]! : null,
      nowPlaying: this.nowPlaying,
      waitingFor: this.pending?.optionId ?? null,
      wordTimingsOff: this.timingsOff,
      yesNoPromptMs: this.yesNoPromptMs,
      question: this.behind?.leadIn ? this.behind.questionId : null,
      queued: this.queue.length,
    };
  }

  /** The clip for an option, if synthesized. */
  clipOf(optionId: bigint): Clip | undefined {
    return this.clips.get(key(optionId));
  }

  rowOf(optionId: bigint): OptionRowLite | undefined {
    return this.rows.find((r) => r.optionId === optionId);
  }

  /** The scanned question's answer mode from `my_session`, for a version the scan has not reached yet. */
  setAnswerHint(questionId: bigint, mode: 'pick' | 'yes_no'): void {
    this.answerHint = { questionId, mode };
  }

  /** `yes_no_cue_ms` from config: the owner is told when the prompt is longer than its dwell plus 150 ms. */
  noteYesNoCue(cueMs: number, promptMs: number): void {
    const next = promptMs > cueMs ? Math.round(promptMs) : null;
    if (next !== this.yesNoPromptMs) {
      this.yesNoPromptMs = next;
      this.deps.onChange?.();
    }
  }

  /** Every `my_options` change: the whole view as it is now. */
  setOptions(rows: readonly OptionRowLite[]): void {
    this.rows = [...rows];
    const present = new Set(rows.map((r) => key(r.optionId)));
    if (this.job && !present.has(key(this.job.optionId))) {
      const old = this.job;
      this.job = null;
      old.job.cancel();
    }
    for (const id of [...this.clips.keys()]) if (!present.has(id)) this.clips.delete(id);
    this.pump();
    // A queued read waiting for a clip that left with its row moves on.
    this.resumeQueue();
    this.deps.onChange?.();
  }

  /** Every `scan_state` update for the active session, with its arrival time on the station clock. */
  onScan(scan: ScanLite, arrival: number): void {
    const previous = this.scan;
    this.scan = scan;
    if (scan.stepSeq <= this.lastStepSeq) return;
    this.lastStepSeq = scan.stepSeq;
    const row = scan.phase === 'reading' && scan.answerMode === 'pick' ? this.rowAt(scan.questionId, scan.version, scan.cursor) : undefined;
    this.deps.heard.setSilent(this.deps.silent());
    this.deps.heard.add(
      {
        stepSeq: scan.stepSeq,
        optionStartSeq: scan.optionStartSeq,
        phase: scan.phase,
        // A Window entry takes its read's option; a yes or no read is option 0.
        optionId: row?.optionId ?? 0n,
      },
      arrival,
    );

    switch (scan.phase) {
      case 'reading':
        this.arrivals.set(key(scan.optionStartSeq), arrival);
        if (this.deps.silent()) break;
        if (scan.answerMode === 'yes_no') this.readPrompt(scan);
        else this.readOption(scan, row);
        break;
      case 'idle':
        this.pending = null;
        this.deps.options.stop(['option', 'prompt']);
        break;
      case 'paused':
        this.pending = null;
        this.endBehind();
        this.deps.options.stop();
        break;
      default:
        // Window, Veto, Preparing: nothing new. A late clip may still play inside its own Window.
        if (scan.phase !== 'window') this.pending = null;
        else if (this.pending && this.pending.optionStartSeq !== scan.optionStartSeq) this.pending = null;
        break;
    }
    // Reads queued behind the question that this step took off the list (Idle, a new version) never play.
    if (this.behind) this.pruneQueue();
    if (previous?.questionId !== scan.questionId || previous?.version !== scan.version) this.pump();
    this.deps.onChange?.();
  }

  /**
   * The partner's question (lib/station/question.ts), said before its list. 'late': the scan has begun reading that
   * question (or is paused, or moved on to a newer one), so it is not said and nothing is cut. 'wait': a read-back on
   * this channel or a stock phrase on the other is playing. 'played': it plays now, cutting only a read of an older
   * question, and the reads the module's clock starts meanwhile wait behind it.
   */
  playQuestion(questionId: bigint, clip: Clip): QuestionPlay {
    if (this.deps.silent()) return 'late';
    const s = this.scan;
    if (s && (s.phase === 'paused' || s.questionId > questionId || (s.questionId === questionId && s.phase !== 'preparing'))) return 'late';
    if (this.deps.options.use() === 'readback' || this.deps.promptsBusy?.()) return 'wait';
    this.endBehind();
    this.pending = null;
    const gen = this.gen;
    this.behind = { gen, questionId, leadIn: true };
    this.deps.options.play(clip, 'question').then(
      (how) => this.questionEnded(gen, how),
      (error: unknown) => {
        console.error('Eleven: the earpiece could not play the question', error);
        this.questionEnded(gen, 'stopped');
      },
    );
    this.deps.onChange?.();
    return 'played';
  }

  /** Stop option audio at once (input went unhealthy, the link went stale, a safety cue), the question too. */
  stopOptions(): void {
    this.pending = null;
    this.endBehind();
    this.deps.options.stop(['option', 'prompt', 'question']);
    this.deps.onChange?.();
  }

  /** A new session: forget the reads and the word timing switch. */
  resetSession(): void {
    this.lastStepSeq = 0n;
    this.timingsSent.clear();
    this.timingsOff = false;
    this.pending = null;
    this.endBehind();
    this.nowPlaying = null;
    this.deps.heard.clear();
    this.deps.onChange?.();
  }

  /** Drop every clip and job (the speed changed, or the page is closing). */
  dispose(): void {
    this.endBehind();
    if (this.job) this.job.job.cancel();
    this.job = null;
    this.clips.clear();
    this.reported.clear();
  }

  private rowAt(questionId: bigint, version: number, rank: number): OptionRowLite | undefined {
    return this.rows.find((r) => r.questionId === questionId && r.version === version && r.rank === rank);
  }

  private answerModeOf(row: OptionRowLite): 'pick' | 'yes_no' {
    const s = this.scan;
    if (s && s.questionId === row.questionId && s.version === row.version) return s.answerMode;
    if (row.current && this.answerHint && this.answerHint.questionId === row.questionId) return this.answerHint.mode;
    // A pending version's answer mode is not in any view: synthesize it either way.
    return 'pick';
  }

  /**
   * The next option to synthesize: the late clip first (or the queued read waiting for its clip), then current Pick
   * options by rank, then the pending version.
   */
  private next(): OptionRowLite | undefined {
    const usable = (r: OptionRowLite) => !this.clips.has(key(r.optionId)) && (this.failed.get(key(r.optionId)) ?? 0) === 0;
    const lateId = this.pending?.optionId ?? (this.queueWaiting && this.queue[0]?.kind === 'option' ? this.queue[0].optionId : null);
    if (lateId !== null) {
      const late = this.rows.find((r) => r.optionId === lateId);
      if (late && usable(late)) return late;
    }
    const byRank = (a: OptionRowLite, b: OptionRowLite) => a.rank - b.rank;
    const current = this.rows.filter((r) => r.current && this.answerModeOf(r) === 'pick' && usable(r)).sort(byRank);
    if (current[0]) return current[0];
    return this.rows.filter((r) => !r.current && usable(r)).sort(byRank)[0];
  }

  /** Look again for work, for example once the voice became ready. */
  kick(): void {
    this.pump();
  }

  private pump(): void {
    if (this.job || this.deps.silent() || (this.deps.ready && !this.deps.ready())) return;
    const row = this.next();
    if (!row) return;
    let job: SynthJob<Clip>;
    try {
      job = this.deps.speakOption(row);
    } catch (error) {
      this.failed.set(key(row.optionId), 1);
      this.deps.onVoiceError?.(error);
      this.pump();
      return;
    }
    this.job = { optionId: row.optionId, job };
    this.deps.onChange?.();
    job.done.then(
      (clip) => this.synthesized(row, job, clip),
      (error: unknown) => this.synthFailed(row, job, error),
    );
  }

  private synthesized(row: OptionRowLite, job: SynthJob<Clip>, clip: Clip): void {
    if (this.job?.job !== job) return;
    this.job = null;
    const id = key(row.optionId);
    if (this.rows.some((r) => r.optionId === row.optionId)) {
      this.clips.set(id, clip);
      while (this.clips.size > MAX_CLIPS) this.clips.delete(this.clips.keys().next().value as string);
      this.report(row.optionId, clip);
      if (this.pending && this.pending.optionId === row.optionId) this.playLate();
    }
    this.resumeQueue();
    this.pump();
    this.deps.onChange?.();
  }

  private synthFailed(row: OptionRowLite, job: SynthJob<Clip>, error: unknown): void {
    if (this.job?.job !== job) return;
    this.job = null;
    const cancelled = error instanceof Error && error.name === 'TtsCancelled';
    if (!cancelled) {
      const id = key(row.optionId);
      const closed = (error as { errorCode?: unknown } | null)?.errorCode === 'closed';
      const tries = (this.failed.get(id) ?? 0) + 1;
      // A socket closed at token expiry is retried once (docs/station.md 2.9); anything else is a voice problem.
      if (closed && tries === 1) this.failed.delete(id);
      else {
        this.failed.set(id, tries);
        this.deps.onVoiceError?.(error);
      }
    }
    // A queued read whose clip failed for good moves on; one being retried keeps waiting.
    this.resumeQueue();
    this.pump();
    this.deps.onChange?.();
  }

  private report(optionId: bigint, clip: Clip): void {
    const id = key(optionId);
    if (this.reported.has(id)) return;
    const clipMs = reportableClipMs(clip.durationMs);
    if (clipMs === null) return;
    this.reported.add(id);
    const synthMs = Math.min(0xffff_ffff, Math.max(0, Math.round(clip.totalMs)));
    sendWithResend(() => this.deps.reportClip({ optionId, clipMs, synthMs }), {
      maxAgeMs: REPORT_RESEND_MS,
      waitForLive: (ms) => this.deps.waitForLive(ms),
      sleep: this.deps.sleep,
    }).catch((error: unknown) => {
      console.error('Eleven: report_clip_ready was not accepted', callErrorText(error));
    });
  }

  private readOption(scan: ScanLite, row: OptionRowLite | undefined): void {
    if (!row) {
      // The row is not in the cache yet: nothing can play, and the heard log keeps this read empty.
      this.pending = null;
      return;
    }
    const clip = this.clips.get(key(row.optionId));
    if (this.isBehind()) {
      // The partner's question (or reads queued behind it) still plays: this read waits its turn, clip or not.
      this.pending = null;
      this.enqueue(scan, row.optionId, row.rank, 'option', clip ?? null);
      if (!clip) this.pump();
      return;
    }
    if (clip) {
      this.pending = null;
      this.start(clip, scan.optionStartSeq, row.optionId, row.rank, 'option');
      return;
    }
    this.pending = { optionStartSeq: scan.optionStartSeq, optionId: row.optionId, rank: row.rank };
    this.pump();
  }

  private readPrompt(scan: ScanLite): void {
    this.pending = null;
    if (this.isBehind()) {
      this.enqueue(scan, 0n, 0, 'prompt', null);
      return;
    }
    const seq = scan.optionStartSeq;
    this.deps.yesNoPrompt().then(
      (clip) => {
        if (!this.stillReading(seq)) return;
        this.start(clip, seq, 0n, 0, 'prompt');
      },
      (error: unknown) => this.deps.onVoiceError?.(error),
    );
  }

  /** The read that began at `seq` is still current: its Reading step or its Window. */
  private stillReading(seq: bigint): boolean {
    const s = this.scan;
    return s !== null && s.optionStartSeq === seq && (s.phase === 'reading' || s.phase === 'window');
  }

  private playLate(): void {
    const late = this.pending;
    if (!late) return;
    const clip = this.clips.get(key(late.optionId));
    if (!clip) return;
    this.pending = null;
    if (!this.stillReading(late.optionStartSeq)) return;
    this.start(clip, late.optionStartSeq, late.optionId, late.rank, 'option');
  }

  private start(clip: Clip, optionStartSeq: bigint, optionId: bigint, rank: number, kind: 'option' | 'prompt'): void {
    // A prompt fetched while the question started: it waits behind the question like any other read.
    if (this.isBehind() && this.scan) {
      this.enqueue(this.scan, optionId, rank, kind, clip);
      return;
    }
    void this.begin(clip, optionStartSeq, optionId, rank, kind, true);
  }

  /** Plays one read now: the heard log, the now-playing view, the lag (unless it waited behind the question), the word timings. */
  private begin(clip: Clip, optionStartSeq: bigint, optionId: bigint, rank: number, kind: 'option' | 'prompt', countLag: boolean): Promise<'ended' | 'stopped'> {
    const playStart = this.deps.now() + Math.max(0, this.deps.latencyMs());
    const played = this.deps.options.play(clip, kind);
    played.catch((error: unknown) => {
      console.error('Eleven: the earpiece could not play a clip', error);
    });
    this.deps.heard.played(optionStartSeq, playStart, kind === 'option' ? optionId : undefined);
    this.nowPlaying = { kind, optionId, rank, optionStartSeq, startedAt: playStart };
    const arrival = this.arrivals.get(key(optionStartSeq));
    if (arrival !== undefined) {
      // A read that waited behind the partner's question is late by design, not by the voice: it is not a lag sample.
      if (countLag) {
        this.lags.push(Math.max(0, playStart - arrival));
        if (this.lags.length > 20) this.lags.shift();
      }
      this.arrivals.delete(key(optionStartSeq));
    }
    if (this.scan) this.sendWordTimings(this.scan.sessionId, optionStartSeq, optionId, clip);
    this.deps.onChange?.();
    return played;
  }

  // ---------- Reads queued behind the partner's question ----------

  /**
   * Whether reads must wait. Also heals a state whose end was never delivered: a question no longer on the channel
   * (stopped or replaced), or a queued read that no longer plays while nothing is awaited.
   */
  private isBehind(): boolean {
    const b = this.behind;
    if (!b) return false;
    const use = this.deps.options.use();
    if (b.leadIn ? use !== 'question' : !this.queueWaiting && use !== 'option' && use !== 'prompt') {
      this.endBehind();
      return false;
    }
    return true;
  }

  private enqueue(scan: ScanLite, optionId: bigint, rank: number, kind: 'option' | 'prompt', clip: Clip | null): void {
    this.queue.push({ questionId: scan.questionId, version: scan.version, optionStartSeq: scan.optionStartSeq, optionId, rank, kind, clip });
    this.deps.heard.hold(scan.optionStartSeq);
    this.deps.onChange?.();
  }

  /** The queued read is still on the current list: same question and version, Reading or the wait after it. */
  private listed(read: QueuedRead<Clip>): boolean {
    const s = this.scan;
    return s !== null && s.questionId === read.questionId && s.version === read.version && (s.phase === 'reading' || s.phase === 'window');
  }

  /** Drop the queued reads that left the list; they are unheard. A head that was waiting is replaced by the next read. */
  private pruneQueue(): void {
    const head = this.queue[0];
    this.queue = this.queue.filter((read) => {
      if (this.listed(read)) return true;
      this.deps.heard.release(read.optionStartSeq);
      return false;
    });
    const b = this.behind;
    if (this.queueWaiting && this.queue[0] !== head) {
      this.queueWaiting = false;
      if (b && !b.leadIn) this.drain(b.gen);
    }
  }

  /** Look at the queue again when the read at its head was waiting (a clip came, failed or left). */
  private resumeQueue(): void {
    const b = this.behind;
    if (!b || b.leadIn || !this.queueWaiting || this.queue[0]?.kind === 'prompt') return;
    this.queueWaiting = false;
    this.drain(b.gen);
  }

  /** Forget the question and every queued read (the queued ones are unheard). Ends of older plays are ignored. */
  private endBehind(): void {
    this.gen++;
    this.behind = null;
    this.queueWaiting = false;
    for (const read of this.queue.splice(0)) this.deps.heard.release(read.optionStartSeq);
  }

  private questionEnded(gen: number, how: 'ended' | 'stopped'): void {
    if (!this.behind || this.behind.gen !== gen) return;
    if (how !== 'ended') {
      // Stopped by a pause, a safety cue, a read-back taking the channel, or the audio stopping: the queue goes too.
      this.endBehind();
      this.deps.onChange?.();
      return;
    }
    this.behind.leadIn = false;
    this.drain(gen);
  }

  /** Plays the queued reads one after another; once none is left, reads play as the module's clock starts them again. */
  private drain(gen: number): void {
    while (this.behind && this.behind.gen === gen && !this.behind.leadIn) {
      const read = this.queue[0];
      if (!read) {
        this.behind = null;
        this.deps.onChange?.();
        return;
      }
      if (!this.listed(read)) {
        this.queue.shift();
        this.deps.heard.release(read.optionStartSeq);
        continue;
      }
      const clip = read.clip ?? (read.kind === 'option' ? this.clips.get(key(read.optionId)) : undefined);
      if (clip) {
        this.queue.shift();
        this.playQueued(gen, read, clip);
        return;
      }
      if (read.kind === 'prompt') {
        this.queueWaiting = true;
        const settle = (c: Clip | null) => {
          if (this.behind?.gen !== gen || this.queue[0] !== read) return;
          this.queueWaiting = false;
          if (c) read.clip = c;
          else {
            this.queue.shift();
            this.deps.heard.release(read.optionStartSeq);
          }
          this.drain(gen);
        };
        this.deps.yesNoPrompt().then(settle, (error: unknown) => {
          this.deps.onVoiceError?.(error);
          settle(null);
        });
        return;
      }
      // The option's clip is still being voiced: wait for it, unless its row left or it failed for good.
      if (this.rows.some((r) => r.optionId === read.optionId) && (this.failed.get(key(read.optionId)) ?? 0) === 0) {
        this.queueWaiting = true;
        this.pump();
        this.deps.onChange?.();
        return;
      }
      this.queue.shift();
      this.deps.heard.release(read.optionStartSeq);
    }
  }

  private playQueued(gen: number, read: QueuedRead<Clip>, clip: Clip): void {
    this.begin(clip, read.optionStartSeq, read.optionId, read.rank, read.kind, false).then(
      (how) => {
        if (this.behind?.gen !== gen) return;
        if (how === 'ended') this.drain(gen);
        else {
          this.endBehind();
          this.deps.onChange?.();
        }
      },
      () => {
        if (this.behind?.gen !== gen) return;
        this.endBehind();
        this.deps.onChange?.();
      },
    );
  }

  private sendWordTimings(sessionId: bigint, stepSeq: bigint, optionId: bigint, clip: Clip): void {
    if (this.timingsOff) return;
    const id = `${sessionId}:${stepSeq}`;
    if (this.timingsSent.has(id)) return;
    const timings = cleanWordTimings(clip.words);
    if (!timings) return;
    const call = this.deps.wordTimings();
    if (!call) return;
    this.timingsSent.add(id);
    sendWithResend(() => call({ sessionId, stepSeq, optionId, ...timings }), {
      maxAgeMs: REPORT_RESEND_MS,
      waitForLive: (ms) => this.deps.waitForLive(ms),
      sleep: this.deps.sleep,
    }).catch((error: unknown) => {
      const kind = callErrorKind(error);
      const text = callErrorText(error);
      // A module without v2 fails the call in a way the SDK does not document: log once and stop for the session.
      if (kind === 'internal' || kind === 'other' || /reducer/i.test(text)) {
        if (!this.timingsOff) console.error('Eleven: report_word_timings is not available; not calling it again this session', text);
        this.timingsOff = true;
        this.deps.onChange?.();
        return;
      }
      console.error('Eleven: report_word_timings was not accepted', text);
    });
  }
}
