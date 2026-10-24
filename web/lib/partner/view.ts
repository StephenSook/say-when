/**
 * What the asking part of the partner phone shows at each step (docs/station.md 4.4), as a pure function, so every
 * row of that table is tested without a browser. The status sentences above it come from components/partner/model.ts
 * and are unchanged.
 *
 * Privacy: with the room's sharing toggle (`config.share_text_on_board`) off, the words Ink-2 hears are never shown,
 * only a count ("12 words so far"). The phone never shows option words in any state.
 */
import type { PairingPhase } from '../role/pairing';
import type { VoiceState } from '../voice/token';
import { formatCount } from '../format';
import { ASK_TEXT } from './ask';
import type { PushToTalkState } from './push-to-talk';

export const ASK_VIEW_TEXT = {
  // The pairing link right under it says "Pair this phone to ask", so the note does not repeat it.
  pairToAsk: 'Only a paired phone can ask.',
  checking: 'Checking whether this phone can ask.',
  notPairedAnymore: 'This phone is not paired anymore.',
  listeningWhileHeld: 'Listening only while you hold.',
  replaces: 'Asking now replaces the question they are answering.',
  sending: 'Sending',
  sttOff: 'Speech to text is off here. Type your question.',
} as const;

export interface AskViewInput {
  pairing: { phase: PairingPhase; revokedBefore: boolean };
  voice: VoiceState;
  hold: PushToTalkState;
  /** `config.share_text_on_board`; false until config has been read. */
  sharing: boolean;
  /** The board shows Reading or Window: a new question would replace the one being answered. */
  scanReading: boolean;
  /** The sender is waiting for the connection to send again. */
  retrying: boolean;
}

export interface AskProblemView {
  sentence: string;
  title: string | null;
  /** 'stopped' is muted (nothing went wrong on purpose or it was safe); 'failed' is in the error color. */
  tone: 'stopped' | 'failed';
  /** Offer Send again (the same request id). */
  sendAgain: boolean;
}

export interface AskView {
  /** Pass `onHoldChange` to Hold to ask: it streams to Ink-2 while held. */
  canHold: boolean;
  holdDisabled: boolean;
  /** The line under the button. */
  note: string;
  /** While holding: the words as Ink-2 hears them (sharing on), or "12 words so far" (sharing off). */
  heard: string | null;
  /** The button's words while a question is on its way, with a spinner. */
  busy: string | null;
  problem: AskProblemView | null;
  /** The text link that opens the pairing card. */
  showPairLink: boolean;
  /** The typed box is shown once the phone is paired. */
  canType: boolean;
}

/** Words heard so far, as the phone may show them. */
export function heardText(hold: PushToTalkState, sharing: boolean): string | null {
  if (hold.phase !== 'holding') return null;
  if (sharing) return hold.heard.trim() === '' ? null : `"${hold.heard.trim()}"`;
  return hold.words > 0 ? `${formatCount(hold.words, 'word')} so far` : null;
}

export function buildAskView(input: AskViewInput): AskView {
  const { hold } = input;
  if (input.pairing.phase === 'connecting' || input.pairing.phase === 'checking') {
    return {
      canHold: false,
      holdDisabled: true,
      note: ASK_VIEW_TEXT.checking,
      heard: null,
      busy: null,
      problem: null,
      showPairLink: false,
      canType: false,
    };
  }
  if (input.pairing.phase !== 'paired') {
    return {
      canHold: false,
      holdDisabled: true,
      note: input.pairing.revokedBefore ? ASK_VIEW_TEXT.notPairedAnymore : ASK_VIEW_TEXT.pairToAsk,
      heard: null,
      busy: null,
      problem: null,
      showPairLink: true,
      canType: false,
    };
  }

  // A voice problem that every hold would hit: no Cartesia key, or a bug in the page.
  const voiceOff = input.voice.status === 'problem' && (input.voice.problem === 'key_missing' || input.voice.problem === 'bug');
  const busyNow = hold.phase === 'hearing' || hold.phase === 'sending';
  let busy: string | null = null;
  if (input.retrying) busy = ASK_TEXT.retrying;
  else if (busyNow) busy = ASK_VIEW_TEXT.sending;

  let problem: AskProblemView | null = null;
  if (hold.phase === 'problem' && hold.problem) {
    const p = hold.problem;
    const tone: AskProblemView['tone'] = p.kind === 'no_speech' || p.kind === 'no_session' ? 'stopped' : 'failed';
    problem = { sentence: p.sentence, title: p.title, tone, sendAgain: hold.unsent !== null };
  }

  let note: string = ASK_VIEW_TEXT.listeningWhileHeld;
  if (voiceOff) note = ASK_VIEW_TEXT.sttOff;
  else if (input.scanReading) note = ASK_VIEW_TEXT.replaces;

  return {
    canHold: !voiceOff,
    holdDisabled: voiceOff || busyNow || input.retrying,
    note,
    heard: heardText(hold, input.sharing),
    busy,
    problem,
    showPairLink: false,
    canType: true,
  };
}
