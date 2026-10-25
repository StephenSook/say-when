/**
 * The D11 command map in words (PLAN.md D11, with D17: CONFIRM is a single jaw clench, STOP a double):
 * the brain chooses, the jaw commits or stops.
 * Use these strings for the command strip, the event feed and any legend, so every screen says the
 * same thing. Honest wording: the jaw clench is a muscle signal and the imagined squeeze is the
 * brain part. Never claim more than those two signals.
 *
 * If the imagined squeezes fail the pre-registered test (PLAN D9, docs/brain-mode-test.md), YES
 * becomes a single jaw clench, CONFIRM a double jaw clench, NO becomes silence, and there is no STOP gesture
 * (D16, kept by D17); change `signal` and `short` here and the headset `{act}` in station/phrases.ts only.
 */
import type { CommandName, InputKind, PersonCommand, SafetyState } from './data/types';

export interface CommandInfo {
  name: CommandName;
  /** What the person does, in full. For HEADSET_OFF, what happened. */
  signal: string;
  /** The short form for chips. */
  short: string;
  /** What it means, in plain words. */
  meaning: string;
  /** 'imagined': an imagined hand squeeze. 'jaw': a jaw clench, a muscle signal. 'system': not given by the person. */
  kind: 'imagined' | 'jaw' | 'system';
}

export const COMMAND_INFO: Readonly<Record<CommandName, CommandInfo>> = {
  YES: {
    name: 'YES',
    signal: 'Imagine squeezing the right fist',
    short: 'imagined right fist',
    meaning: "Pick this one, or answer yes. While nothing is happening, it opens the person's menu.",
    kind: 'imagined',
  },
  NO: {
    name: 'NO',
    signal: 'Imagine squeezing the left fist',
    short: 'imagined left fist',
    meaning: 'Skip this one, or answer no.',
    kind: 'imagined',
  },
  CONFIRM: {
    name: 'CONFIRM',
    signal: 'Single jaw clench',
    short: 'single jaw clench',
    meaning: 'Send it. The only way anything leaves the room, after the read-back.',
    kind: 'jaw',
  },
  STOP: {
    name: 'STOP',
    signal: 'Double jaw clench',
    short: 'double jaw clench',
    meaning: 'Cancel, none of these, hang up, pause.',
    kind: 'jaw',
  },
  HEADSET_OFF: {
    name: 'HEADSET_OFF',
    signal: 'The headset lost contact',
    short: 'headset off',
    meaning: 'Cancels anything pending. Not a command the person gives.',
    kind: 'system',
  },
};

// ---------------------------------------------------------------------------------------------
// The true input (docs/station.md 2.3 and 2.5, request W1). The headset words above hold only for a headset session.
// A keyboard session's commands are key presses (Y, N, C, S), and a switch session's are presses of one switch (a
// short press is YES, two presses CONFIRM, a 1 s hold STOP; NO is not on the switch). When the input is unknown, no
// screen names a brain or jaw signal.

const KEYS: Readonly<Record<PersonCommand, string>> = { YES: 'key Y', NO: 'key N', CONFIRM: 'key C', STOP: 'key S' };

const SWITCH_PRESSES: Readonly<Record<PersonCommand, string | null>> = {
  YES: 'short switch press',
  NO: null,
  CONFIRM: 'double switch press',
  STOP: 'long switch press',
};

/** What the person did for a command in this input, short: "imagined right fist", "key Y", "double switch press". null when unknown. */
export function commandSignal(name: PersonCommand, input: InputKind): string | null {
  switch (input) {
    case 'headset':
      return COMMAND_INFO[name].short;
    case 'keyboard':
      return KEYS[name];
    case 'switch':
      return SWITCH_PRESSES[name];
    default:
      return null;
  }
}

/** The same for a sentence, with its article: "a single jaw clench", "key C", "a long switch press". null when unknown. */
export function signalPhrase(name: PersonCommand, input: InputKind): string | null {
  const signal = commandSignal(name, input);
  if (signal === null || input === 'keyboard') return signal;
  return `${/^[aeiou]/i.test(signal) ? 'an' : 'a'} ${signal}`;
}

/** "CONFIRM, a single jaw clench", "CONFIRM, key C", or "CONFIRM" alone when the input is unknown. */
export function withSignal(name: PersonCommand, input: InputKind): string {
  const phrase = signalPhrase(name, input);
  return phrase === null ? name : `${name}, ${phrase}`;
}

/** The command strip label: "YES, imagined right fist", "YES, key Y", "NO, not on the switch", or "YES" alone. */
export function commandChipLabel(name: PersonCommand, input: InputKind): string {
  if (input === 'switch' && SWITCH_PRESSES[name] === null) return `${name}, not on the switch`;
  const signal = commandSignal(name, input);
  return signal === null ? name : `${name}, ${signal}`;
}

/** "Headset off" in a headset session; "Input off" for a key, a switch or an unknown input. */
export function offWord(input: InputKind): string {
  return input === 'headset' ? 'Headset off' : 'Input off';
}

/** The event feed name: "YES", "NO", "CONFIRM", "STOP", or "Headset off" ("Input off") for the system event. */
export function commandWord(name: CommandName, input: InputKind): string {
  return name === 'HEADSET_OFF' ? offWord(input) : name;
}

/** The header chip: the input, and whether it is on, off or paused (docs/ui.md "Headset chip"). */
export interface InputChipView {
  words: string;
  tone: 'muted' | 'error';
  lead: 'headset' | 'dot' | 'cross' | 'pause';
  /** Not known to be on: no session, or the session ended. */
  dashed: boolean;
  /** The chip's accessible name. */
  name: string;
}

const INPUT_NAMES: Readonly<Record<InputKind, string>> = {
  headset: 'Headset',
  keyboard: 'Keyboard input',
  switch: 'Switch input',
  unknown: 'Input',
};

/**
 * A headset session keeps "Headset on", "Headset off" and "Paused". A keyboard or switch session says so on the chip
 * ("Keyboard input", "Input off"), so key presses never pass as headset input; an unknown input says "Input on".
 */
export function inputChip(state: SafetyState['state'], input: InputKind): InputChipView {
  const name = INPUT_NAMES[input];
  if (state === 'paused') return { words: 'Paused', tone: 'error', lead: 'pause', dashed: false, name };
  if (state === 'headset_off') return { words: offWord(input), tone: 'error', lead: 'cross', dashed: false, name };
  const lead = input === 'headset' ? 'headset' : 'dot';
  if (input === 'headset') {
    return state === 'ok'
      ? { words: 'Headset on', tone: 'muted', lead, dashed: false, name }
      : { words: 'Headset unknown', tone: 'muted', lead, dashed: true, name };
  }
  if (input === 'unknown') {
    return state === 'ok'
      ? { words: 'Input on', tone: 'muted', lead, dashed: false, name }
      : { words: 'Input unknown', tone: 'muted', lead, dashed: true, name };
  }
  return { words: name, tone: 'muted', lead, dashed: state !== 'ok', name };
}

/** The shell banner while paused or off: both cancel anything pending, so the room must see them. */
export function safetySentence(state: SafetyState['state'], input: InputKind): string | null {
  if (state === 'paused') return 'Paused. Nothing will be sent.';
  if (state === 'headset_off') return `${offWord(input)}. Nothing will be sent.`;
  return null;
}
