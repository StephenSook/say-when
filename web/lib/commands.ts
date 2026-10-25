/**
 * The direct select gesture legend (D18, docs/direct-select.md), the one source of truth for every screen. Three
 * gestures pick three options and a held jaw clench is STOP:
 *
 *   1      imagined left fist      PICK_1   pick option 1; in a confirm "One: send it"; while paused, resume
 *   2      imagined right fist     PICK_2   pick option 2; in a confirm "Two: cancel"
 *   3      single jaw clench       PICK_3   pick option 3
 *   STOP   held jaw clench         STOP     cancel, none of these, hang up, pause (hold about 1 second)
 *   none   double jaw clench       nothing  the decoder sends no command for it (PLAN D21)
 *
 * Since a double jaw clench means nothing in either input mode, no gesture gives option 4. PICK_4 stays a command name
 * (the module takes up to 4 options, and key 4 still picks option 4 in a keyboard test), but the legend, the command
 * strip and every "waiting for a pick" line present 1 to 3 (SHOWN_COMMANDS and GESTURE_PICKS in data/types.ts).
 *
 * The scan map (PLAN D11 with D17 and D21, the `say-when-demo` database) is imagined right fist YES, imagined left
 * fist NO, single jaw clench CONFIRM, held jaw clench STOP, and a double jaw clench nothing. In this web the station and
 * the screens speak direct select; /brain reads both maps (lib/brain/protocol.ts).
 *
 * Use these strings for the gesture legend, the command strip, option badges and the event feed, so every screen says
 * the same thing. Honest wording: the fists are imagined movements decoded from EEG (the brain part), and the jaw
 * clench is a muscle signal ("Jaw muscle, not brain"). Never claim more than those two signals.
 *
 * If the imagined squeezes fail the pre-registered test (PLAN D9, docs/brain-mode-test.md), the decoder runs
 * `--jaw-only` (its map is in eeg-data/README.md) and the station keys stand in for the rest. Change `signal` and
 * `short` here only.
 */
import { pickRank, SHOWN_COMMANDS, type CommandName, type InputKind, type PersonCommand, type SafetyState } from './data/types';

export interface CommandInfo {
  name: CommandName;
  /** The number or word the screens and the earpiece use: "1" to "4", "STOP", or "Headset off". */
  label: string;
  /** What the person does, in full. For HEADSET_OFF, what happened. */
  signal: string;
  /** The short form for chips. */
  short: string;
  /** What it means, in plain words. */
  meaning: string;
  /**
   * 'imagined': an imagined hand squeeze. 'jaw': a jaw clench, a muscle signal. 'none': no gesture gives it (PICK_4,
   * only key 4 in a keyboard test). 'system': not given by the person.
   */
  kind: 'imagined' | 'jaw' | 'none' | 'system';
}

export const COMMAND_INFO: Readonly<Record<CommandName, CommandInfo>> = {
  PICK_1: {
    name: 'PICK_1',
    label: '1',
    signal: 'Imagine squeezing the left fist',
    short: 'imagined left fist',
    meaning: 'Pick option 1. In a confirm: send it. While paused: resume.',
    kind: 'imagined',
  },
  PICK_2: {
    name: 'PICK_2',
    label: '2',
    signal: 'Imagine squeezing the right fist',
    short: 'imagined right fist',
    meaning: 'Pick option 2. In a confirm: cancel.',
    kind: 'imagined',
  },
  PICK_3: {
    name: 'PICK_3',
    label: '3',
    signal: 'Single jaw clench',
    short: 'single jaw clench',
    meaning: 'Pick option 3.',
    kind: 'jaw',
  },
  PICK_4: {
    name: 'PICK_4',
    label: '4',
    signal: 'No gesture (key 4 in a keyboard test)',
    short: 'no gesture',
    meaning: 'Pick option 4. No gesture gives it, since a double jaw clench means nothing; key 4 does in a keyboard test.',
    kind: 'none',
  },
  STOP: {
    name: 'STOP',
    label: 'STOP',
    signal: 'Hold a jaw clench (about 1 second)',
    short: 'held jaw clench',
    meaning: 'Cancel, none of these, hang up, pause.',
    kind: 'jaw',
  },
  HEADSET_OFF: {
    name: 'HEADSET_OFF',
    label: 'Headset off',
    signal: 'The headset lost contact',
    short: 'headset off',
    meaning: 'Cancels anything pending. Not a command the person gives.',
    kind: 'system',
  },
};

/** One row of the gesture legend: "1 = imagined left fist". */
export interface LegendRow {
  name: PersonCommand;
  label: string;
  signal: string;
  kind: CommandInfo['kind'];
}

/**
 * The gesture legend in order, 1, 2, 3 and STOP, for the input the session uses (key and switch sessions show their
 * own signals). Option 4 has no gesture, so it is never in the legend.
 */
export function gestureLegend(input: InputKind = 'headset'): LegendRow[] {
  return SHOWN_COMMANDS.map((name) => {
    const info = COMMAND_INFO[name];
    return { name, label: info.label, signal: commandSignal(name, input) ?? info.short, kind: info.kind };
  });
}

/** The legend in one line: "1 = imagined left fist · 2 = imagined right fist · 3 = single jaw clench · STOP = held jaw clench". */
export function legendLine(input: InputKind = 'headset'): string {
  return gestureLegend(input)
    .filter((row) => input !== 'switch' || SWITCH_PRESSES[row.name] !== null)
    .map((row) => `${row.label} = ${row.signal}`)
    .join(' · ');
}

/** The jaw lane on /brain, after "Jaw muscle, not brain": "3 single clench, hold = STOP" (a double clench sends nothing). */
export const JAW_LANE_LEGEND = '3 single clench, hold = STOP';

/** The honesty label every jaw lane and legend carries. */
export const JAW_HONESTY = 'Jaw muscle, not brain';

/** The two-option confirm, as the earpiece says it after every read-back (and the agent and errand cards show). */
export const CONFIRM_PROMPT = 'One: send it. Two: cancel.';
/** The confirm in screen words: "1 to send, 2 to cancel". */
export const CONFIRM_SHORT = '1 to send, 2 to cancel';

/** The confirm pick in a sentence: "1 (an imagined left fist)", "1 (key 1)", or "1" when the input is unknown. */
export function confirmPick(input: InputKind): string {
  const phrase = signalPhrase('PICK_1', input);
  return phrase === null ? '1' : `1 (${phrase})`;
}

/** The cancel pick in a sentence: "2 (an imagined right fist)", "2 (key 2)", or "2". */
export function cancelPick(input: InputKind): string {
  const phrase = signalPhrase('PICK_2', input);
  return phrase === null ? '2' : `2 (${phrase})`;
}

/** "1" for PICK_1, "STOP" for STOP, "Headset off" for HEADSET_OFF. */
export function commandLabel(name: CommandName): string {
  return COMMAND_INFO[name].label;
}

/** The badge an option carries on every screen: its number, "1" to "4". */
export function optionBadge(rank: number): string {
  return rank >= 1 && rank <= 4 ? String(rank) : '';
}

/** The words a numbered option shows: its short label, else its text. */
export function optionLabel(option: { label?: string | null; text: string }): string {
  const label = (option.label ?? '').trim();
  return label !== '' ? label : option.text;
}

// ---------------------------------------------------------------------------------------------
// The true input (docs/station.md 2.3 and 2.5, request W1). The headset words above hold only for a headset session.
// A keyboard session's commands are key presses (1, 2, 3, S; key 4 also picks option 4, as a test key), and a switch
// session's are presses of one switch (a short press is 1, two presses 2, a 1 s hold STOP; 3 is not on the switch).
// When the input is unknown, no screen names a brain or jaw signal.

const KEYS: Readonly<Record<PersonCommand, string>> = {
  PICK_1: 'key 1',
  PICK_2: 'key 2',
  PICK_3: 'key 3',
  PICK_4: 'key 4',
  STOP: 'key S',
};

const SWITCH_PRESSES: Readonly<Record<PersonCommand, string | null>> = {
  PICK_1: 'short switch press',
  PICK_2: 'double switch press',
  PICK_3: null,
  PICK_4: null,
  STOP: 'long switch press',
};

/**
 * What the person did for a command in this input, short: "imagined left fist", "key 1", "double switch press". null
 * when unknown, and for 4 on the headset, which no gesture gives.
 */
export function commandSignal(name: PersonCommand, input: InputKind): string | null {
  switch (input) {
    case 'headset':
      return COMMAND_INFO[name].kind === 'none' ? null : COMMAND_INFO[name].short;
    case 'keyboard':
      return KEYS[name];
    case 'switch':
      return SWITCH_PRESSES[name];
    default:
      return null;
  }
}

/** The same for a sentence, with its article: "a single jaw clench", "key 1", "a long switch press". null when unknown. */
export function signalPhrase(name: PersonCommand, input: InputKind): string | null {
  const signal = commandSignal(name, input);
  if (signal === null || input === 'keyboard') return signal;
  return `${/^[aeiou]/i.test(signal) ? 'an' : 'a'} ${signal}`;
}

/** "1, a single jaw clench" style: "STOP, a held jaw clench", "1, key 1", or "1" alone when the input is unknown. */
export function withSignal(name: PersonCommand, input: InputKind): string {
  const phrase = signalPhrase(name, input);
  const label = COMMAND_INFO[name].label;
  return phrase === null ? label : `${label}, ${phrase}`;
}

/** The command strip label: "1, imagined left fist", "1, key 1", "3, not on the switch", or "1" alone. */
export function commandChipLabel(name: PersonCommand, input: InputKind): string {
  const label = COMMAND_INFO[name].label;
  if (input === 'switch' && SWITCH_PRESSES[name] === null) return `${label}, not on the switch`;
  const signal = commandSignal(name, input);
  return signal === null ? label : `${label}, ${signal}`;
}

/** "Headset off" in a headset session; "Input off" for a key, a switch or an unknown input. */
export function offWord(input: InputKind): string {
  return input === 'headset' ? 'Headset off' : 'Input off';
}

/** The event feed name: "1" to "4", "STOP", or "Headset off" ("Input off") for the system event. */
export function commandWord(name: CommandName, input: InputKind): string {
  return name === 'HEADSET_OFF' ? offWord(input) : COMMAND_INFO[name].label;
}

/** "Pick 3" for PICK_3, "STOP" for STOP: the event feed's longer form. */
export function commandPhrase(name: CommandName, input: InputKind): string {
  const rank = pickRank(name);
  return rank !== null ? `Pick ${rank}` : commandWord(name, input);
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
