/**
 * What the earpiece says (docs/station.md Appendix A), as data. Stock phrases use the assistant voice at the person's
 * pace and are cached once at start; menu items use the reply voice with no tone, exactly as the module writes them.
 *
 * `{act}` is how the person confirms in the session's input mode: "clench twice" with the headset (the double jaw
 * clench), "press C" in the keyboard test, "press twice" on a USB switch. The words never claim more than that.
 */
import type { InputMode } from '../role/storage';

export const PHRASES = {
  paused: 'Paused. Nothing will be sent.',
  pausedIdle: 'Paused after a quiet spell. Nothing will be sent.',
  pausedHelper: 'Paused by a helper. Nothing will be sent.',
  headsetOff: 'Headset off. Nothing will be sent.',
  inputOff: 'Input off. Nothing will be sent.',
  signalLost: 'Signal lost. Nothing will be sent.',
  connectionLost: 'Connection lost. Nothing will be sent.',
  resumed: 'Resumed.',
  oneMoment: 'One moment.',
  yesOrNo: 'Yes or no?',
  noneOfThese: 'None of these.',
  noPick: 'No pick. Nothing was said.',
  cancelled: 'Cancelled. Nothing was said.',
  noOptions: 'No options this time. Nothing was said.',
  questionWaiting: 'A new question is waiting.',
  confirmTail: 'To send it, {act}. To cancel, do nothing.',
  sayConfirm: 'That needs a confirm. To send it, {act}.',
  tooSoon: 'Too soon. Wait a moment, then {act}.',
  confirmed: 'Confirmed.',
  preparing: 'Getting it ready.',
  sent: 'Sent.',
  notSent: 'Not sent.',
  windowClosed: 'Stopped, nothing sent.',
  readbackLate: 'The read-back did not finish. Nothing was sent.',
  interrupted: 'A new question came in. Nothing was sent.',
  unknownOutcome: 'It may or may not have gone through.',
  tooLate: 'Too late to stop it. It is already sending.',
  noCall: 'No call was made.',
  hangingUp: 'Hanging up.',
  callEnded: 'The call ended.',
  voiceDown: 'The voice is not working. Nothing will be sent.',
  tooLong: 'That request is too long to read back. Nothing will be sent.',
} as const;

export type PhraseKey = keyof typeof PHRASES;

/** The module's four menu items (spacetime/src/clock.ts MENU_ITEMS), read like answers in the reply voice. */
export const MENU_ITEM_TEXTS: readonly string[] = ['I need something', 'Send a request', 'Call', 'Say something else'];

/**
 * A menu row is voiced from the phrase cache (and so kept in the browser's phrase store) only when its words are one
 * of the four module menu items; any other words are voiced fresh and never stored.
 */
export function isMenuItemText(text: string): boolean {
  return MENU_ITEM_TEXTS.includes(text);
}

/** How the person confirms in each input mode. */
export const ACT_WORDS: Readonly<Record<InputMode, string>> = {
  headset: 'clench twice',
  keyboard: 'press C',
  switch: 'press twice',
};

/** A phrase's words for the session's input mode. */
export function phraseText(key: PhraseKey, mode: InputMode): string {
  return PHRASES[key].replace('{act}', ACT_WORDS[mode]);
}

/**
 * The stock phrases cached at start for one input mode (docs/station.md 2.9 "Phrases ready"): the mode's variants
 * only, never `confirmTail` alone (it is spoken inside each read-back), and the headset or input off line that fits
 * the mode. With the four menu items this is 34 clips.
 */
export function warmPhraseKeys(mode: InputMode): PhraseKey[] {
  return (Object.keys(PHRASES) as PhraseKey[]).filter((key) => {
    if (key === 'confirmTail') return false;
    if (key === 'headsetOff') return mode === 'headset';
    if (key === 'inputOff') return mode !== 'headset';
    return true;
  });
}

/** The headset or input off line for a mode (cue `paused` with reason `headset_off`). */
export function inputOffPhrase(mode: InputMode): PhraseKey {
  return mode === 'headset' ? 'headsetOff' : 'inputOff';
}
