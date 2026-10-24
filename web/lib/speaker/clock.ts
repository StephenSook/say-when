/**
 * The speaker's estimate of the database clock against this laptop's clock (docs/station.md 3, step 2), the same
 * method as lib/data/clock-offset.ts, kept small because the speaker reads only `scan_state`.
 *
 * A live `scan_state` update reaches this page at most one network trip after the server wrote it, so
 * `updated_at - arrival time` is a lower bound on (server clock - laptop clock). The largest bound seen in the last
 * minute is the estimate. Rows from a subscription snapshot are old and never count. With no sample the clocks are
 * assumed to agree (an offset of 0). A bound further off than 15 s is an old row, not clock skew, and is dropped.
 */

/** How long a sample counts. */
export const SERVER_CLOCK_WINDOW_MS = 60_000;

/** A bound further off than this is an old row, not clock skew. */
export const SERVER_CLOCK_MAX_OFFSET_MS = 15_000;

export interface ServerClock {
  /** A live row written at `serverMs` (server clock) arrived at `arrivedAt` (laptop clock). */
  sample(serverMs: number, arrivedAt: number): void;
  /** Server clock minus laptop clock in ms at laptop time `at`; 0 with no sample in the last minute. */
  offset(at: number): number;
}

export function createServerClock(): ServerClock {
  let samples: Array<{ at: number; value: number }> = [];
  return {
    sample(serverMs, arrivedAt) {
      if (!Number.isFinite(serverMs) || !Number.isFinite(arrivedAt)) return;
      const value = serverMs - arrivedAt;
      if (Math.abs(value) > SERVER_CLOCK_MAX_OFFSET_MS) return;
      samples = samples.filter((sample) => sample.at > arrivedAt - SERVER_CLOCK_WINDOW_MS);
      samples.push({ at: arrivedAt, value });
    },
    offset(at) {
      let best: number | null = null;
      for (const sample of samples) {
        if (sample.at <= at - SERVER_CLOCK_WINDOW_MS) continue;
        if (best === null || sample.value > best) best = sample.value;
      }
      return best ?? 0;
    },
  };
}
