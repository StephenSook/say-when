'use client';

/**
 * How the partner phone sends a question: the `ask_question(request_id, text, via, listen_ms)` reducer, called from a
 * paired Partner device (docs/station.md 4.3; docs/spacetime.md 7.1 and 7.3).
 *
 * `useAsk()` returns the sender once this phone is paired (components/partner/usePartnerAsk.tsx), and null before
 * that, or on a page with no database settings: the typed box then stays hidden and the phone is read-only.
 * The sender rejects with an AskError (lib/partner/ask.ts) that carries the sentence to show.
 */
import { useContext } from 'react';
import { MAX_QUESTION_CHARS, type AskRequest } from '@/lib/partner/ask';
import { PartnerAskContext } from './askContext';

export type { AskRequest } from '@/lib/partner/ask';

/** Resolves once the reducer accepted the question; rejects with an AskError otherwise. */
export type AskFn = (request: AskRequest) => Promise<void>;

/** The reducer's limit on a question's length. */
export const MAX_QUESTION_LENGTH = MAX_QUESTION_CHARS;

export function useAsk(): AskFn | null {
  return useContext(PartnerAskContext)?.ask ?? null;
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
