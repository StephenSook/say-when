/**
 * The decoder panel in the stage's brain slot, built only from rows that exist today: the session's input (from its
 * label) and the command events in the session ledger. It never draws brain activity and never claims a signal the
 * rows do not name. Pure, so a test can run it over the sample replay.
 *
 * Honest wording (lib/commands.ts): in a headset session YES and NO are imagined fist squeezes (the brain part) and
 * CONFIRM and STOP are jaw clenches (a muscle signal); a keyboard session's commands are keys, a switch session's are
 * presses, and an unknown input names no signal at all. Only an imagined squeeze gets a hand mark (YES cyan, NO amber).
 */
import { commandSignal, commandWord, COMMAND_INFO } from '../commands';
import type { CommandEvent, InputKind, PersonCommand } from '../data/types';
import { PERSON_COMMANDS } from '../data/types';
import { formatAge } from '../format';

/** A brain-related mark: an imagined right fist (YES) or left fist (NO) in a headset session. */
export type HandMark = 'yes' | 'no';

export interface DecoderLine {
  id: string;
  /** "YES", "CONFIRM", or "Headset off" ("Input off") for the system event. */
  word: string;
  /** What the person did in this input: "imagined right fist", "key Y", "single jaw clench". null when not known. */
  signal: string | null;
  /** Set only for an imagined squeeze in a headset session. */
  hand: HandMark | null;
  /** "just now", "8 s ago". Empty before the page knows the time. */
  ago: string;
  /** Why the command did not count, such as "Repeat inside the refractory time". null when it counted. */
  ignored: string | null;
  /** The decoder's confidence, "0.91", in a headset session only. */
  confidence: string | null;
}

export interface DecoderView {
  title: string;
  /** How this input gives commands, in one line. null when the input is unknown. */
  how: string | null;
  /** The newest command that counted, shown large. null before the first one. */
  last: DecoderLine | null;
  /** In its place while `last` is null: "No command yet." or "No command counted yet." */
  none: string | null;
  /** The other newest commands, newest first, a not-counted repeat included, so the debounce shows. */
  earlier: DecoderLine[];
}

/** How many other commands the panel lists under the one shown large. */
export const EARLIER_COUNT = 3;

export const NO_COMMAND_YET = 'No command yet.';
export const NO_COMMAND_COUNTED = 'No command counted yet.';

const TITLES: Readonly<Record<InputKind, string>> = {
  headset: 'Headset',
  keyboard: 'Keyboard test',
  switch: 'Switch',
  unknown: 'Commands',
};

const HOW: Readonly<Record<InputKind, string | null>> = {
  headset: 'Imagined fists choose. Jaw clenches send or stop.',
  keyboard: 'Keys Y, N, C and S.',
  switch: 'One switch: short press, double press, long press.',
  unknown: null,
};

function isPersonCommand(name: CommandEvent['command']): name is PersonCommand {
  return (PERSON_COMMANDS as readonly string[]).includes(name);
}

export function decoderLine(event: CommandEvent, input: InputKind, now: number): DecoderLine {
  const person = isPersonCommand(event.command);
  const imagined = input === 'headset' && person && COMMAND_INFO[event.command].kind === 'imagined';
  const confidence =
    input === 'headset' && event.confidence !== null && Number.isFinite(event.confidence) ? event.confidence.toFixed(2) : null;
  return {
    id: event.id,
    word: commandWord(event.command, input),
    signal: person ? commandSignal(event.command as PersonCommand, input) : null,
    hand: imagined ? (event.command === 'YES' ? 'yes' : 'no') : null,
    ago: now > 0 ? formatAge(event.at, now) : '',
    ignored: event.accepted ? null : (event.ignoredReason ?? 'Did not count'),
    confidence,
  };
}

/**
 * The panel for this session. The newest command that counted is shown large, because that is the one the system
 * acted on; an ignored repeat after it (inside the refractory time) does not take its place, it is listed as not
 * counted.
 */
export function buildDecoderView(commands: readonly CommandEvent[], input: InputKind, now: number): DecoderView {
  let lastIndex = -1;
  for (let i = commands.length - 1; i >= 0; i--) {
    if (commands[i]?.accepted) {
      lastIndex = i;
      break;
    }
  }
  const earlier: DecoderLine[] = [];
  for (let i = commands.length - 1; i >= 0 && earlier.length < EARLIER_COUNT; i--) {
    const event = commands[i];
    if (event && i !== lastIndex) earlier.push(decoderLine(event, input, now));
  }
  const last = lastIndex >= 0 ? decoderLine(commands[lastIndex]!, input, now) : null;
  return {
    title: TITLES[input],
    how: HOW[input],
    last,
    none: last !== null ? null : commands.length === 0 ? NO_COMMAND_YET : NO_COMMAND_COUNTED,
    earlier,
  };
}
