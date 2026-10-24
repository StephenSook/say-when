/**
 * Sending a question from the partner phone: `ask_question(request_id, text, via, listen_ms)` (docs/station.md 4.3,
 * 7.4 B3). One sender for Hold to ask and the typed box.
 *
 * - The text is trimmed, control characters other than tab, newline and carriage return are removed (the module
 *   refuses them), and it must be 1 to 500 characters. A text outside that is refused here, before sending.
 * - `request_id` is a UUID made at the press (voice) or for those words (typed). The module returns quietly for a
 *   request id it has seen, so a retry can never ask twice.
 * - DisconnectedError or UnknownCallResultError: sent again with the same request id once the connection is back, up
 *   to 3 tries within 30 s, showing "Not connected. Trying again." meanwhile. A SenderError is never retried.
 */
import { callErrorKind, callErrorText, isSenderMessage, sendWithResend, SENDER_MESSAGES } from '../role/calls';

/** The module's limit on a question (spacetime/src/index.ts `askQuestion`, `requireText(text, 'text', 500)`). */
export const MAX_QUESTION_CHARS = 500;

/** Resend window and tries for `ask_question` (docs/station.md 4.3). */
export const ASK_RESEND_MS = 30_000;
export const ASK_MAX_TRIES = 3;

/** The module's request id rule (`REQUEST_ID_RE`). A UUID matches it. */
export const REQUEST_ID_RE = /^[A-Za-z0-9:_-]{1,64}$/;

/** Control characters the module refuses: everything below space except tab, newline and carriage return, and DEL. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export const ASK_TEXT = {
  tooLong: `Too long. Keep it under ${MAX_QUESTION_CHARS} characters.`,
  empty: 'Type a question first.',
  noSession: 'The station is not running. Nothing was sent.',
  notPaired: 'This phone is not paired anymore. Pair it again to ask.',
  couldNotSend: 'Could not send. Try again.',
  retrying: 'Not connected. Trying again.',
} as const;

export type PreparedQuestion = { ok: true; text: string } | { ok: false; reason: 'empty' | 'too_long'; sentence: string };

/** The words as the module will accept them, or why not. */
export function prepareQuestion(raw: string): PreparedQuestion {
  const text = String(raw).replace(CONTROL_CHARS, '').trim();
  if (text.length === 0) return { ok: false, reason: 'empty', sentence: ASK_TEXT.empty };
  if (text.length > MAX_QUESTION_CHARS) return { ok: false, reason: 'too_long', sentence: ASK_TEXT.tooLong };
  return { ok: true, text };
}

export interface AskRequest {
  /** A UUID. A retry of the same question reuses it, so it is never asked twice. */
  requestId: string;
  /** 1 to 500 characters, already prepared. */
  text: string;
  via: 'voice' | 'typed';
  /** For voice: from the release to the transcript (speech to text time). 0 for typed. */
  listenMs: number;
}

export type AskOutcome =
  | { ok: true }
  | {
      ok: false;
      /** no_session: no active session. not_paired: `not allowed`. refused: another refusal. not_sent: no connection. */
      kind: 'no_session' | 'not_paired' | 'refused' | 'not_sent' | 'bad_text';
      sentence: string;
      /** Raw detail for a tooltip only. */
      title: string | null;
    };

/** Thrown by the typed box's sender, carrying the sentence to show. */
export class AskError extends Error {
  readonly kind: Exclude<AskOutcome, { ok: true }>['kind'];
  readonly sentence: string;
  readonly title: string | null;
  constructor(outcome: Exclude<AskOutcome, { ok: true }>) {
    super(outcome.sentence);
    this.name = 'AskError';
    this.kind = outcome.kind;
    this.sentence = outcome.sentence;
    this.title = outcome.title;
  }
}

/** What the phone says for a failed `ask_question`. */
export function askFailure(error: unknown): Exclude<AskOutcome, { ok: true }> {
  const text = callErrorText(error);
  switch (callErrorKind(error)) {
    case 'sender':
      if (isSenderMessage(error, SENDER_MESSAGES.noActiveSession)) return { ok: false, kind: 'no_session', sentence: ASK_TEXT.noSession, title: text };
      if (isSenderMessage(error, SENDER_MESSAGES.notAllowed)) return { ok: false, kind: 'not_paired', sentence: ASK_TEXT.notPaired, title: text };
      return { ok: false, kind: 'refused', sentence: ASK_TEXT.couldNotSend, title: text };
    case 'disconnected':
    case 'unknown_result':
      return { ok: false, kind: 'not_sent', sentence: ASK_TEXT.couldNotSend, title: text };
    default:
      return { ok: false, kind: 'refused', sentence: ASK_TEXT.couldNotSend, title: text };
  }
}

export interface AskSenderOptions {
  /** `conn.reducers.askQuestion({ requestId, text, via, listenMs })`. */
  call(request: AskRequest): Promise<void>;
  /** Resolves true once the role connection is live, false after `timeoutMs`. */
  waitForLive(timeoutMs: number): Promise<boolean>;
  /** Every refusal goes here too (`not allowed` shows the pairing card). */
  noteCallError?(error: unknown): void;
  /** Called with true while the sender waits to send again, and false when it stops waiting. */
  onRetrying?(retrying: boolean): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type AskSender = (request: AskRequest) => Promise<AskOutcome>;

export function createAskSender(options: AskSenderOptions): AskSender {
  return async (request) => {
    const prepared = prepareQuestion(request.text);
    if (!prepared.ok) return { ok: false, kind: 'bad_text', sentence: prepared.sentence, title: null };
    if (!REQUEST_ID_RE.test(request.requestId)) return { ok: false, kind: 'bad_text', sentence: ASK_TEXT.couldNotSend, title: 'bad request id' };
    const listenMs = Math.min(4_294_967_295, Math.max(0, Math.round(Number.isFinite(request.listenMs) ? request.listenMs : 0)));
    const sent: AskRequest = { requestId: request.requestId, text: prepared.text, via: request.via, listenMs };
    let retrying = false;
    try {
      await sendWithResend(() => options.call(sent), {
        maxAgeMs: ASK_RESEND_MS,
        maxTries: ASK_MAX_TRIES,
        now: options.now,
        sleep: options.sleep,
        waitForLive: (timeoutMs) => {
          if (!retrying) {
            retrying = true;
            options.onRetrying?.(true);
          }
          return options.waitForLive(timeoutMs);
        },
      });
      return { ok: true };
    } catch (error) {
      options.noteCallError?.(error);
      return askFailure(error);
    } finally {
      if (retrying) options.onRetrying?.(false);
    }
  };
}

/**
 * The typed box keeps one request id while the words stay the same, so Send again after a dropped connection is the
 * same question, not a second one. New words get a new id.
 */
export function requestIdFor(previous: { text: string; requestId: string } | null, text: string, make: () => string): { text: string; requestId: string } {
  return previous && previous.text === text ? previous : { text, requestId: make() };
}
