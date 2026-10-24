/**
 * The D11 command map in words (PLAN.md D11): the brain chooses, the jaw commits or stops.
 * Use these strings for the command strip, the event feed and any legend, so every screen says the
 * same thing. Honest wording: the jaw clench is a muscle signal and the imagined squeeze is the
 * brain part. Never claim more than those two signals.
 *
 * If the imagined squeezes fail the pre-registered test (PLAN D9, docs/brain-mode-test.md), YES
 * becomes a single short jaw clench and NO becomes silence; change `signal` and `short` here only.
 */
import type { CommandName, PersonCommand } from './data/types';

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
    signal: 'Double jaw clench',
    short: 'double jaw clench',
    meaning: 'Send it. The only way anything leaves the room, after the read-back.',
    kind: 'jaw',
  },
  STOP: {
    name: 'STOP',
    signal: 'Long jaw clench, about 1 s',
    short: 'long jaw clench',
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

/** The command strip label: "YES, imagined right fist" (docs/mockups/conversation.html). */
export function commandChipLabel(name: PersonCommand): string {
  return `${name}, ${COMMAND_INFO[name].short}`;
}

/** The event feed name: "YES", "NO", "CONFIRM", "STOP", or "Headset off" for the system event. */
export function commandWord(name: CommandName): string {
  return name === 'HEADSET_OFF' ? 'Headset off' : name;
}
