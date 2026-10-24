/**
 * Hold to ask on the partner phone (docs/station.md 4.2, 7.4 B3): Cartesia Ink-2 listens only while the button is held.
 * Plain TypeScript; `listen` and the module calls come in as functions, so the whole flow runs in a test.
 *
 * 1. Press: a new request id (a UUID); `partner_listening(request_id, true)` without waiting (the board shows
 *    "Listening"; errors ignored); then `listen({ getToken, keyterms, endOn: 'release', maxMs: 30 s })`. The token is
 *    minted per hold by the module and never stored.
 * 2. Release: `session.release()`, then `partner_listening(request_id, false)`.
 * 3. Result: text is sent with `ask_question(request_id, text, 'voice', listen_ms)`, where listen_ms is the time from
 *    the release to the transcript (how long speech to text took after the partner let go). No speech: "Did not catch
 *    that. Hold and ask again." An error: "Speech to text is not working. Type your question." The 30 s limit sends
 *    what was heard.
 * 4. A question that could not be sent keeps its request id, so Send again can never ask twice.
 */
import { buildKeyterms, type Listening, type ListenOptions, type ListenResult } from '../cartesia/browser';
import { countWords } from '../format';
import type { AskOutcome, AskRequest, AskSender } from './ask';

/** No household names here: a list in the page would ship them in a public bundle (docs/station.md 4.2, O7). */
export const PARTNER_KEYTERMS: readonly string[] = buildKeyterms(['NeuroLingo', 'Cal Hacks', 'care team']).keyterms;

/** A hard stop for a stuck button: Ink-2 bills every second sent. */
export const LISTEN_MAX_MS = 30_000;

export const HOLD_TEXT = {
  noSpeech: 'Did not catch that. Hold and ask again.',
  sttBroken: 'Speech to text is not working. Type your question.',
} as const;

export type HoldPhase =
  /** Not holding; nothing in flight. */
  | 'ready'
  | 'holding'
  /** Let go; waiting for the last words from Ink-2. */
  | 'hearing'
  | 'sending'
  /** The last question reached the module. */
  | 'sent'
  | 'problem';

export interface HoldProblem {
  kind: 'no_speech' | 'stt' | Exclude<AskOutcome, { ok: true }>['kind'];
  sentence: string;
  /** Raw detail, for a tooltip only. */
  title: string | null;
}

export interface PushToTalkState {
  phase: HoldPhase;
  /** What Ink-2 has heard in this hold: finished turns and the current partial. The page hides it with sharing off. */
  heard: string;
  words: number;
  problem: HoldProblem | null;
  /** A question that could not be sent, kept for Send again with the same request id. */
  unsent: AskRequest | null;
}

export const PUSH_TO_TALK_READY: PushToTalkState = { phase: 'ready', heard: '', words: 0, problem: null, unsent: null };

export interface PushToTalkOptions {
  listen(options: ListenOptions): Listening;
  /** A fresh `stt` token for the socket: `device.voice.getToken`. */
  getToken(): Promise<string>;
  /** `conn.reducers.partnerListening({ requestId, on })`. Errors are ignored. */
  setListening(requestId: string, on: boolean): Promise<void>;
  /** The shared ask sender (lib/partner/ask.ts). */
  send: AskSender;
  newRequestId(): string;
  keyterms?: readonly string[];
  now?: () => number;
}

export interface PushToTalk {
  getState(): PushToTalkState;
  subscribe(listener: () => void): () => void;
  /** The button went down. */
  press(): void;
  /** The button came up (or the hold ended for any reason). Safe to call more than once. */
  release(): void;
  /** Send again: the unsent question, with its request id. */
  sendAgain(): void;
  /** Clears a problem from the screen. */
  dismiss(): void;
  /** Throws away a hold in progress (the page is closing, or the phone was unpaired). */
  abort(): void;
}

interface Hold {
  requestId: string;
  session: Listening;
  releasedAt: number | null;
  turns: string[];
  partial: string;
}

export function createPushToTalk(options: PushToTalkOptions): PushToTalk {
  const now = options.now ?? Date.now;
  const keyterms = options.keyterms ?? PARTNER_KEYTERMS;
  let state: PushToTalkState = PUSH_TO_TALK_READY;
  let hold: Hold | null = null;
  const listeners = new Set<() => void>();

  const set = (next: PushToTalkState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const signal = (requestId: string, on: boolean) => {
    try {
      void options.setListening(requestId, on).catch(() => undefined);
    } catch {
      // Not connected: the board just does not show "Listening".
    }
  };

  const heardOf = (h: Hold) => [...h.turns, h.partial.trim()].filter((part) => part !== '').join(' ');

  const showHeard = (h: Hold) => {
    if (hold !== h || state.phase !== 'holding') return;
    const heard = heardOf(h);
    set({ ...state, heard, words: countWords(heard) });
  };

  const sendVoice = async (request: AskRequest) => {
    set({ ...state, phase: 'sending', problem: null, unsent: null });
    let outcome: AskOutcome;
    try {
      outcome = await options.send(request);
    } catch (error) {
      outcome = { ok: false, kind: 'refused', sentence: 'Could not send. Try again.', title: error instanceof Error ? error.message : String(error) };
    }
    if (hold !== null) return; // A new hold started meanwhile; its own state wins.
    if (outcome.ok) {
      set({ ...PUSH_TO_TALK_READY, phase: 'sent' });
      return;
    }
    const keep = outcome.kind === 'not_sent' || outcome.kind === 'refused';
    set({ ...PUSH_TO_TALK_READY, phase: 'problem', problem: { kind: outcome.kind, sentence: outcome.sentence, title: outcome.title }, unsent: keep ? request : null });
  };

  const finished = (h: Hold, result: ListenResult) => {
    if (hold !== h) return;
    hold = null;
    if (h.releasedAt === null) {
      // The session ended by itself (the 30 s limit, or the socket closed): end the hold too.
      h.releasedAt = now();
      signal(h.requestId, false);
    }
    const listenMs = Math.max(0, Math.round(now() - h.releasedAt));
    if (result.ok) {
      const text = result.text.trim();
      if (text !== '') {
        void sendVoice({ requestId: h.requestId, text, via: 'voice', listenMs });
        return;
      }
      set({ ...PUSH_TO_TALK_READY, phase: 'problem', problem: { kind: 'no_speech', sentence: HOLD_TEXT.noSpeech, title: null } });
      return;
    }
    if (result.reason === 'aborted') {
      set(PUSH_TO_TALK_READY);
      return;
    }
    if (result.reason === 'no_speech') {
      set({ ...PUSH_TO_TALK_READY, phase: 'problem', problem: { kind: 'no_speech', sentence: HOLD_TEXT.noSpeech, title: null } });
      return;
    }
    set({ ...PUSH_TO_TALK_READY, phase: 'problem', problem: { kind: 'stt', sentence: HOLD_TEXT.sttBroken, title: result.message || null } });
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    press() {
      if (hold !== null || state.phase === 'sending') return;
      const requestId = options.newRequestId();
      signal(requestId, true);
      const h: Hold = { requestId, session: null as unknown as Listening, releasedAt: null, turns: [], partial: '' };
      hold = h;
      set({ ...PUSH_TO_TALK_READY, phase: 'holding' });
      try {
        h.session = options.listen({
          getToken: () => options.getToken(),
          keyterms,
          endOn: 'release',
          maxMs: LISTEN_MAX_MS,
          onPartial: (text) => {
            h.partial = text;
            showHeard(h);
          },
          onTurn: (text) => {
            h.turns.push(text);
            h.partial = '';
            showHeard(h);
          },
        });
      } catch (error) {
        finished(h, { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error), ms: 0 });
        return;
      }
      h.session.done.then(
        (result) => finished(h, result),
        (error: unknown) => finished(h, { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error), ms: 0 }),
      );
    },
    release() {
      const h = hold;
      if (!h || h.releasedAt !== null) return;
      h.releasedAt = now();
      try {
        h.session.release();
      } catch {
        // Already finished.
      }
      signal(h.requestId, false);
      if (hold === h && state.phase === 'holding') set({ ...state, phase: 'hearing' });
    },
    sendAgain() {
      const request = state.unsent;
      if (!request || hold !== null || state.phase === 'sending') return;
      void sendVoice(request);
    },
    dismiss() {
      if (state.phase === 'problem' || state.phase === 'sent') set(PUSH_TO_TALK_READY);
    },
    abort() {
      const h = hold;
      hold = null;
      if (h) {
        try {
          h.session.abort();
        } catch {
          // Already finished.
        }
        if (h.releasedAt === null) signal(h.requestId, false);
      }
      if (state.phase === 'holding' || state.phase === 'hearing') set(PUSH_TO_TALK_READY);
    },
  };
}
