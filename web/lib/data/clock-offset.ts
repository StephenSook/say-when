/**
 * The database clock against this laptop's clock, for the SpacetimeDB source. Pure, no timers.
 *
 * Every time on a SpacetimeDB row comes from the server's clock, while the screens count with this
 * laptop's clock (lib/use-now.ts). Countdowns, running times and the 1.2 s command echo compare the
 * two, so a laptop clock a few seconds off would show wrong times, and an echo might never light.
 * docs/spacetime.md 2.1: count from the moment a row arrives, never from a raw clock difference.
 *
 * How it works:
 * - A new event (a pipeline step, a command, a scan step) reaches this laptop at most one network
 *   trip after the server wrote it, so `newest event time - arrival time` is a lower bound on
 *   (server clock - laptop clock). The largest bound seen in the last minute is the offset. It is
 *   off by the fastest trip, tens of milliseconds, which is the same as counting from the arrival.
 * - Only new events count. The first read after (re)connecting holds old rows, so it only records
 *   the newest time. A bound more than 15 s off is ignored: that is an old row, not clock skew.
 * - Before any usable sample the offset is 0: the clocks are assumed to agree.
 *
 * The source moves every row time by the offset (`shiftRows`), so the screens never see two clocks.
 */
import type { DataRows } from './types';

/** How long a sample counts. A laptop clock that is set right during the event is followed within a minute. */
export const OFFSET_WINDOW_MS = 60_000;

/** A bound further off than this is an old row, not clock skew. */
export const MAX_OFFSET_MS = 15_000;

export interface ClockOffset {
  /**
   * Reads the rows that arrived at `receivedAt` (laptop clock) and returns the offset in ms: server
   * clock minus laptop clock. `snapshot` marks the first read after connecting or reconnecting.
   */
  update(rows: DataRows, receivedAt: number, snapshot: boolean): number;
  /** The current offset in ms, 0 until the first usable sample. */
  current(): number;
}

interface Sample {
  at: number;
  value: number;
}

export function createClockOffset(): ClockOffset {
  let offset = 0;
  let newestSeen: number | null = null;
  let samples: Sample[] = [];

  return {
    update(rows, receivedAt, snapshot) {
      const newest = newestEventTime(rows);
      if (newest === null || !Number.isFinite(receivedAt)) return offset;
      if (snapshot || newestSeen === null) {
        newestSeen = newest;
        return offset;
      }
      if (newest > newestSeen) {
        newestSeen = newest;
        const value = newest - receivedAt;
        if (Math.abs(value) <= MAX_OFFSET_MS) samples.push({ at: receivedAt, value });
      }
      samples = samples.filter((sample) => sample.at > receivedAt - OFFSET_WINDOW_MS);
      if (samples.length > 0) offset = Math.max(...samples.map((sample) => sample.value));
      return offset;
    },
    current: () => offset,
  };
}

/**
 * The newest moment something happened on the server, across every row. Planned times, such as when
 * a scan step or a confirm window will end, are left out: they lie in the future on purpose.
 */
export function newestEventTime(rows: DataRows): number | null {
  let newest = Number.NEGATIVE_INFINITY;
  const see = (time: number | null | undefined) => {
    if (typeof time === 'number' && Number.isFinite(time) && time > newest) newest = time;
  };
  for (const question of rows.questions) {
    see(question.askedAt);
    see(question.spokenAt);
  }
  for (const event of rows.pipelineEvents) see(event.at);
  for (const command of rows.commands) see(command.at);
  for (const errand of rows.errands) {
    see(errand.createdAt);
    see(errand.previewedAt);
    see(errand.readAloudAt);
    see(errand.confirmedAt);
    see(errand.sentAt);
    see(errand.endedAt);
  }
  for (const call of rows.calls) {
    see(call.createdAt);
    see(call.readAloudAt);
    see(call.confirmedAt);
    see(call.dialedAt);
    see(call.ringingAt);
    see(call.startedAt);
    see(call.endedAt);
    for (const line of call.transcript) see(line.at);
  }
  see(rows.scan?.stepStartedAt);
  see(rows.safety.since);
  return newest === Number.NEGATIVE_INFINITY ? null : newest;
}

const move = (time: number, delta: number) => time + delta;
const moveOrNull = (time: number | null, delta: number) => (time === null ? null : time + delta);

/**
 * Every row time moved by `delta` ms (epoch milliseconds only). Pass minus the offset to turn server
 * times into laptop times. Times inside producer payloads (`fetchedAt`, `savedAt`) are left alone:
 * they are shown as clock times, never counted against now. Returns the same object for a 0 delta.
 */
export function shiftRows(rows: DataRows, delta: number): DataRows {
  if (delta === 0 || !Number.isFinite(delta)) return rows;
  return {
    questions: rows.questions.map((question) => ({
      ...question,
      askedAt: move(question.askedAt, delta),
      spokenAt: moveOrNull(question.spokenAt, delta),
    })),
    pipelineEvents: rows.pipelineEvents.map((event) => ({ ...event, at: move(event.at, delta) })),
    options: rows.options,
    errands: rows.errands.map((errand) => ({
      ...errand,
      confirmClosesAt: moveOrNull(errand.confirmClosesAt, delta),
      ...(errand.confirmOpensAt === undefined ? {} : { confirmOpensAt: moveOrNull(errand.confirmOpensAt, delta) }),
      createdAt: move(errand.createdAt, delta),
      previewedAt: moveOrNull(errand.previewedAt, delta),
      readAloudAt: moveOrNull(errand.readAloudAt, delta),
      confirmedAt: moveOrNull(errand.confirmedAt, delta),
      sentAt: moveOrNull(errand.sentAt, delta),
      endedAt: moveOrNull(errand.endedAt, delta),
    })),
    calls: rows.calls.map((call) => ({
      ...call,
      readAloudAt: moveOrNull(call.readAloudAt, delta),
      confirmClosesAt: moveOrNull(call.confirmClosesAt, delta),
      ...(call.confirmOpensAt === undefined ? {} : { confirmOpensAt: moveOrNull(call.confirmOpensAt, delta) }),
      createdAt: move(call.createdAt, delta),
      confirmedAt: moveOrNull(call.confirmedAt, delta),
      dialedAt: moveOrNull(call.dialedAt, delta),
      ringingAt: moveOrNull(call.ringingAt, delta),
      startedAt: moveOrNull(call.startedAt, delta),
      endedAt: moveOrNull(call.endedAt, delta),
      transcript: call.transcript.map((line) => ({ ...line, at: move(line.at, delta) })),
    })),
    commands: rows.commands.map((command) => ({ ...command, at: move(command.at, delta) })),
    scan: rows.scan === null ? null : { ...rows.scan, stepStartedAt: move(rows.scan.stepStartedAt, delta), stepEndsAt: move(rows.scan.stepEndsAt, delta) },
    safety: { ...rows.safety, since: moveOrNull(rows.safety.since, delta) },
    input: rows.input,
  };
}
