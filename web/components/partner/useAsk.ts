'use client';

/**
 * How the partner phone sends a question: the `ask_question(request_id, text, via, listen_ms)` reducer,
 * called from a paired Partner device (docs/spacetime.md 7.1 and 7.3).
 *
 * TODO(data layer): the data sources in lib/data cannot call reducers yet, so this returns null and the
 * typed question box stays hidden. docs/ui.md: until the reducer exists, the phone is read-only and the
 * partner asks out loud. Once the provider offers a sender, return it here; the box then appears and
 * sends with no other change on this screen.
 */
export interface AskRequest {
  /** A UUID. A retry of the same words reuses it, so a question is never asked twice. */
  requestId: string;
  /** 1 to 500 characters. */
  text: string;
  via: 'voice' | 'typed';
  /** How long the partner held the button. 0 for a typed question. */
  listenMs: number;
}

/** Resolves once the reducer accepted the question; rejects with the reducer's error otherwise. */
export type AskFn = (request: AskRequest) => Promise<void>;

/** The reducer's limit on a question's length. */
export const MAX_QUESTION_LENGTH = 500;

export function useAsk(): AskFn | null {
  return null;
}

/** A random UUID (version 4). crypto.randomUUID needs HTTPS; getRandomValues works on any page. */
export function newRequestId(): string {
  const random = globalThis.crypto;
  if (typeof random?.randomUUID === 'function') return random.randomUUID();
  const bytes = new Uint8Array(16);
  random.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
