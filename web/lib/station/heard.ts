/**
 * The heard log (docs/station.md 2.6): which scan step and option the wearer was actually hearing at a command's
 * onset, measured by when the audio played, not by when the `scan_state` row arrived.
 *
 * The module resolves a gesture by the step the station says was heard (spacetime/src/gesture.ts `resolveHeard`): the
 * current option if `option_start_seq <= heard_step_seq <= step_seq`, the previous option within `grace_ms`, else
 * `ignored:stale_step`. So the station records one entry per `scan_state` update with a higher `step_seq`:
 *
 *   Reading, Pick        the option read at this step; empty until its clip starts, then play start + 200 ms
 *   Reading, yes or no   option 0; empty until the "Yes or no?" prompt starts, then play start + 200 ms
 *   Window               the option of its Reading entry, from the arrival time, never before that read was heard
 *   Preparing, Veto, Idle, Paused   option 0, from the arrival time
 *
 * A read whose audio never started is marked unheard once its step is over, and the lookup skips it for good (fail
 * closed). A read the earpiece holds (it waits behind the partner's question, lib/station/earpiece.ts) is not marked
 * unheard by later steps: it counts from when its audio really starts, or is released as unheard if it never plays.
 * Silent test mode has no audio, so every entry counts from its arrival time.
 *
 * All times are on one clock: `performance.now()` in the browser, the same base as a keydown's `event.timeStamp`.
 */

/** Nobody reacts to an option's words within 200 ms of its first sound, so an earlier onset belongs to the option before. */
export const HEARD_MARGIN_MS = 200;

/** Entries older than this are dropped. */
export const HEARD_KEEP_MS = 60_000;

export type HeardPhase = 'idle' | 'preparing' | 'reading' | 'window' | 'veto' | 'paused';

/** One `scan_state` update, reduced to what the log needs. */
export interface HeardStep {
  stepSeq: bigint;
  /** `scan_state.option_start_seq`: the step at which the current read began. */
  optionStartSeq: bigint;
  phase: HeardPhase;
  /** The `my_options` row read at this step; 0 for the yes or no prompt, or when the row is not known yet. */
  optionId: bigint;
}

export interface HeardEntry extends HeardStep {
  arrival: number;
  /** From when an onset counts as having heard this entry; null while its audio has not started. */
  heardFrom: number | null;
  /** Its audio never started: never returned by a lookup. */
  unheard: boolean;
}

export interface Heard {
  stepSeq: bigint;
  optionId: bigint;
}

export const NOTHING_HEARD: Heard = { stepSeq: 0n, optionId: 0n };

export interface HeardLogOptions {
  silent?: boolean;
  marginMs?: number;
  keepMs?: number;
}

export class HeardLog {
  private entries: HeardEntry[] = [];
  /** `option_start_seq` of reads that will play late: later steps do not mark them unheard. */
  private readonly held = new Set<bigint>();
  private silent: boolean;
  private readonly marginMs: number;
  private readonly keepMs: number;

  constructor(options: HeardLogOptions = {}) {
    this.silent = options.silent ?? false;
    this.marginMs = options.marginMs ?? HEARD_MARGIN_MS;
    this.keepMs = options.keepMs ?? HEARD_KEEP_MS;
  }

  /** Silent test mode: no audio, so every entry counts from its arrival. */
  setSilent(silent: boolean): void {
    this.silent = silent;
  }

  /** The newest step logged, or 0. */
  lastStepSeq(): bigint {
    return this.entries[this.entries.length - 1]?.stepSeq ?? 0n;
  }

  /** A copy of the entries, oldest first, for the screen and tests. */
  list(): readonly HeardEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  /** Adds one entry for a `scan_state` update with a higher `step_seq`. Returns false for an old or repeated step. */
  add(step: HeardStep, arrival: number): boolean {
    if (step.stepSeq <= this.lastStepSeq()) return false;
    const sameRead = step.phase === 'window';
    // A read whose audio never started is over once a step that is not its own window arrives.
    for (const entry of this.entries) {
      if (entry.heardFrom !== null || entry.unheard) continue;
      if (sameRead && entry.optionStartSeq === step.optionStartSeq) continue;
      if (this.held.has(entry.optionStartSeq)) continue;
      entry.unheard = true;
    }

    const entry: HeardEntry = { ...step, arrival, heardFrom: null, unheard: false };
    switch (step.phase) {
      case 'reading':
        if (this.silent) entry.heardFrom = arrival;
        break;
      case 'window': {
        const read = this.readOf(step.optionStartSeq);
        if (read) entry.optionId = read.optionId;
        if (this.silent) entry.heardFrom = arrival;
        else if (!read || read.unheard) entry.unheard = true;
        else if (read.heardFrom !== null) entry.heardFrom = Math.max(arrival, read.heardFrom);
        // Otherwise it waits for its read's audio, like the read itself.
        break;
      }
      default:
        entry.optionId = 0n;
        entry.heardFrom = arrival;
        break;
    }
    this.entries.push(entry);
    this.prune(arrival);
    return true;
  }

  /**
   * The read that began at `optionStartSeq` started playing at `playStart` (the moment of `play()` plus the output's
   * lead and latency). Its entries count from `playStart + margin`. `optionId` fills in a row learned late.
   * Returns false when the read is unknown or already over (it was marked unheard).
   */
  played(optionStartSeq: bigint, playStart: number, optionId?: bigint): boolean {
    this.held.delete(optionStartSeq);
    const read = this.readOf(optionStartSeq);
    if (!read || read.unheard) return false;
    const from = playStart + this.marginMs;
    for (const entry of this.entries) {
      if (entry.optionStartSeq !== optionStartSeq || (entry.phase !== 'reading' && entry.phase !== 'window')) continue;
      if (entry.unheard) continue;
      if (optionId !== undefined) entry.optionId = optionId;
      entry.heardFrom = entry.phase === 'reading' ? from : Math.max(entry.arrival, from);
    }
    return true;
  }

  /** What the wearer was hearing at `onset`: the newest heard entry that had started by then, else step 0 and option 0. */
  lookup(onset: number): Heard {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i]!;
      if (entry.unheard || entry.heardFrom === null) continue;
      if (entry.heardFrom <= onset) return { stepSeq: entry.stepSeq, optionId: entry.optionId };
    }
    return NOTHING_HEARD;
  }

  /**
   * The read that began at `optionStartSeq` will start late (it waits behind the partner's question): until it plays
   * or is released, later steps do not mark it unheard. Returns false when the read is unknown, over, or already
   * playing.
   */
  hold(optionStartSeq: bigint): boolean {
    const read = this.readOf(optionStartSeq);
    if (!read || read.unheard || read.heardFrom !== null) return false;
    this.held.add(optionStartSeq);
    return true;
  }

  /** A held read will not play after all: if its audio never started, it is unheard from now on. */
  release(optionStartSeq: bigint): void {
    if (!this.held.delete(optionStartSeq)) return;
    for (const entry of this.entries) {
      if (entry.optionStartSeq !== optionStartSeq || entry.heardFrom !== null) continue;
      if (entry.phase === 'reading' || entry.phase === 'window') entry.unheard = true;
    }
  }

  clear(): void {
    this.entries = [];
    this.held.clear();
  }

  private readOf(optionStartSeq: bigint): HeardEntry | undefined {
    return this.entries.find((entry) => entry.phase === 'reading' && entry.stepSeq === optionStartSeq);
  }

  private prune(now: number): void {
    const cutoff = now - this.keepMs;
    // Keep the newest entry whatever its age, so a long Idle still answers a lookup.
    while (this.entries.length > 1 && this.entries[0]!.arrival < cutoff) this.entries.shift();
  }
}
