/**
 * How a role page reads the answer to a reducer or procedure call (docs/station.md 1.5 and 7.2 C1).
 *
 * Every reducer promise rejects with one of three errors from spacetimedb 2.13.0 (`lib/errors.d.ts`):
 *   SenderError             the module refused. Never retry: the same call gets the same answer.
 *   DisconnectedError       not sent. Safe to send again once the connection is back.
 *   UnknownCallResultError  the connection dropped before the answer; it may have run. Send the same arguments again:
 *                           every client call in the module is idempotent by its id (docs/spacetime.md 3.1).
 * The errors are classified by `error.name`, never by `instanceof`, so a second copy of the SDK cannot break it.
 */

export type CallErrorKind = 'sender' | 'disconnected' | 'unknown_result' | 'internal' | 'other';

/** The module's refusal messages the role pages act on (spacetime/src/auth.ts, index.ts). */
export const SENDER_MESSAGES = {
  notAllowed: 'not allowed',
  notSessionStation: 'not the session station',
  noActiveSession: 'no active session',
  alreadyPaired: 'already paired',
  codeTaken: 'code taken: pick a new code',
} as const;

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  if (typeof error === 'object' && error !== null && typeof (error as { name?: unknown }).name === 'string') return (error as { name: string }).name;
  return '';
}

export function callErrorKind(error: unknown): CallErrorKind {
  switch (errorName(error)) {
    case 'SenderError':
      return 'sender';
    case 'DisconnectedError':
      return 'disconnected';
    case 'UnknownCallResultError':
      return 'unknown_result';
    case 'InternalError':
      return 'internal';
    default:
      return 'other';
  }
}

/** The error's message, or its name when it has none. Never holds a token: no call here carries one. */
export function callErrorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  return 'unknown error';
}

/** True for the two answers that mean "send the same call again once connected". */
export function mayResend(error: unknown): boolean {
  const kind = callErrorKind(error);
  return kind === 'disconnected' || kind === 'unknown_result';
}

/** True when the module refused with exactly this message. */
export function isSenderMessage(error: unknown, message: string): boolean {
  return callErrorKind(error) === 'sender' && callErrorText(error).trim() === message;
}

/** A DisconnectedError for a call that was never made because the page has no live connection. */
export function notConnectedError(): Error {
  const error = new Error('Not connected.');
  error.name = 'DisconnectedError';
  return error;
}

export interface ResendOptions {
  /** Give up once the first attempt is this old (docs/station.md: 3 s for YES and NO, 30 s for STOP, 60 s for reply_spoken). */
  maxAgeMs: number;
  /** When the first attempt was made, on the `now` clock. Defaults to the call to sendWithResend. */
  startedAt?: number;
  /** Stop after this many attempts, the first included (the partner's ask_question allows 3). */
  maxTries?: number;
  /** Resolves true once the connection is live again, or false when `timeoutMs` passes first. */
  waitForLive: (timeoutMs: number) => Promise<boolean>;
  /** The shortest wait between two attempts, so a connection that claims to be live cannot spin. Default 250 ms. */
  minGapMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Calls `send`, and sends it again after a DisconnectedError or an UnknownCallResultError once the connection is
 * live, while the first attempt is younger than `maxAgeMs`. A SenderError, or any other error, is thrown at once.
 * When time or tries run out, the last error is thrown, so the caller can still classify it ("Not sent: connection").
 * `send` must build the same call each time (the same ids); it may refresh an age field such as `onsetAgeMs`.
 */
export async function sendWithResend<T>(send: (attempt: number) => Promise<T>, options: ResendOptions): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const started = options.startedAt ?? now();
  const minGap = options.minGapMs ?? 250;
  for (let attempt = 1; ; attempt++) {
    try {
      return await send(attempt);
    } catch (error) {
      if (!mayResend(error)) throw error;
      if (options.maxTries !== undefined && attempt >= options.maxTries) throw error;
      if (now() - started >= options.maxAgeMs) throw error;
      await sleep(minGap);
      const left = options.maxAgeMs - (now() - started);
      if (left <= 0) throw error;
      const live = await options.waitForLive(left);
      if (!live || now() - started >= options.maxAgeMs) throw error;
    }
  }
}

// ---------- Reducers a module version may not have ----------

/** `report_word_timings` arrives with module v2 (docs/station.md 2.9). Its generated call shape. */
export interface ReportWordTimingsArgs {
  stepSeq: bigint;
  optionId: bigint;
  startsMs: number[];
  endsMs: number[];
}

/**
 * A reducer that the bindings in this build may not know yet. Returns the call bound to the connection, or null when
 * `conn.reducers` has no function by that accessor name (the bindings were generated before the reducer existed).
 * A module published without it while the bindings have it fails the call itself; the caller logs that and stops.
 */
export function optionalReducer<Args>(conn: unknown, accessor: string): ((args: Args) => Promise<void>) | null {
  if (typeof conn !== 'object' || conn === null) return null;
  const reducers = (conn as { reducers?: unknown }).reducers;
  if (typeof reducers !== 'object' || reducers === null) return null;
  const call = (reducers as Record<string, unknown>)[accessor];
  if (typeof call !== 'function') return null;
  return (args: Args) => (call as (args: Args) => Promise<void>).call(reducers, args);
}

/** `conn.reducers.reportWordTimings`, or null with bindings from before module v2. */
export function wordTimingsReducer(conn: unknown): ((args: ReportWordTimingsArgs) => Promise<void>) | null {
  return optionalReducer<ReportWordTimingsArgs>(conn, 'reportWordTimings');
}
