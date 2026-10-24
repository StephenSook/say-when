/**
 * Staleness (docs/station.md 2.15): a silent network drop may never fire `onDisconnect`, so after each `scan_state`
 * update in Reading, Window or Veto the station arms a timer for the step's planned length
 * (`step_ends_at - step_started_at`, a duration, never a clock difference) plus 1.5 s. If no newer update arrives
 * first, the link is treated as dead: stop the option audio, say "Connection lost. Nothing will be sent." once, and
 * show Reconnecting. Preparing is never timed this way: it can wait for the agent with no timer behind it.
 */
import type { HeardPhase } from './heard';

export const STALE_EXTRA_MS = 1_500;

export interface TimedStep {
  phase: HeardPhase;
  /** `step_started_at` and `step_ends_at` in microseconds since the epoch, as the bindings give them. */
  stepStartedAt: bigint;
  stepEndsAt: bigint;
}

/** How long after this update the link counts as dead, or null for a phase that is never timed. */
export function staleAfterMs(step: TimedStep): number | null {
  if (step.phase !== 'reading' && step.phase !== 'window' && step.phase !== 'veto') return null;
  const planned = step.stepEndsAt > step.stepStartedAt ? Number((step.stepEndsAt - step.stepStartedAt) / 1000n) : 0;
  return planned + STALE_EXTRA_MS;
}

export interface StalenessOptions {
  onStale: () => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class StalenessWatch {
  private timer: unknown = null;
  private stale = false;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: StalenessOptions) {
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Every `scan_state` update for the active session. Returns true when it cleared a stale state. */
  update(step: TimedStep): boolean {
    const wasStale = this.stale;
    this.stale = false;
    this.cancel();
    const after = staleAfterMs(step);
    if (after !== null) {
      this.timer = this.setTimer(() => {
        this.timer = null;
        this.stale = true;
        this.options.onStale();
      }, after);
    }
    return wasStale;
  }

  isStale(): boolean {
    return this.stale;
  }

  stop(): void {
    this.cancel();
    this.stale = false;
  }

  private cancel(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
}
