/**
 * The keyboard test keys and the USB switch (docs/station.md 2.5). Neither is headset input: every press is sent with
 * `source` `key` or `switch`, and the screen says so in words.
 *
 * Keyboard test (one capturing keydown listener, keyboard mode only, during a session), direct select (D18):
 *   1, 2, 3, 4 = PICK_1 to PICK_4 (in a confirm: 1 = send it, 2 = cancel), S = STOP, H = HEADSET_OFF (labeled "test")
 *   The onset is the keydown's `event.timeStamp`. Repeats and keys held with Cmd, Ctrl or Alt are ignored.
 *
 * USB switch, the jaw-only pattern on one learned key:
 *   a short press with no second press within 400 ms of its release   PICK_1, 400 ms after the release, onset at keydown
 *   a second keydown within 400 ms of the first release                 PICK_2 at that keydown, onset at the first keydown
 *   held for 1000 ms                                                    STOP when the hold reaches 1000 ms, onset at keydown
 *   Options 3 and 4 are not on the switch.
 */
import type { StationCommand } from './commands';

export const KEYBOARD_MAP: Readonly<Record<string, StationCommand>> = {
  '1': 'PICK_1',
  '2': 'PICK_2',
  '3': 'PICK_3',
  '4': 'PICK_4',
  s: 'STOP',
  h: 'HEADSET_OFF',
};

/**
 * The legend shown in keyboard mode: 1 to 3, like every screen (no gesture gives 4, since a double jaw clench means
 * nothing, PLAN D21). Key 4 still picks option 4, as a harmless test key, but the legend does not offer it.
 */
export const KEYBOARD_LEGEND = '1 2 3 = pick that option (in a confirm: 1 = send it, 2 = cancel)   S = STOP   H = headset off (test)';

/** Digits the station takes as picks while a session runs; the dashboard's screen keys must not fire then. */
export function isPickKey(key: string): boolean {
  return key === '1' || key === '2' || key === '3' || key === '4';
}

export interface KeyLike {
  key: string;
  code?: string;
  repeat: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/** The test command for a key, or null for anything else, a repeat, or a key held with Cmd, Ctrl or Alt. */
export function keyboardCommand(event: KeyLike): StationCommand | null {
  if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return null;
  if (typeof event.key !== 'string' || event.key.length !== 1) return null;
  return KEYBOARD_MAP[event.key.toLowerCase()] ?? null;
}

/** True for a target the person is typing into, where test keys must not fire. */
export function isTypingTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown };
  if (el.isContentEditable === true) return true;
  const tag = typeof el.tagName === 'string' ? el.tagName.toLowerCase() : '';
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

/** Keys that cannot be learned as a switch: they move focus or leave the page. */
const UNLEARNABLE = new Set(['Tab', 'Escape', 'MetaLeft', 'MetaRight']);

export function canLearnSwitchKey(code: string): boolean {
  return /^[A-Za-z0-9]{1,32}$/.test(code) && !UNLEARNABLE.has(code);
}

export const SWITCH_DOUBLE_MS = 400;
export const SWITCH_HOLD_MS = 1_000;

export interface SwitchPatternOptions {
  onCommand: (command: StationCommand, onset: number) => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

type SwitchState =
  | { kind: 'idle' }
  /** The key is down; a hold may become STOP. */
  | { kind: 'down'; at: number }
  /** Released after a short press; a second press within 400 ms makes PICK_2, else PICK_1. */
  | { kind: 'released'; firstAt: number }
  /** This press already produced its command (STOP, or the second press of PICK_2): ignore it until the key goes up. */
  | { kind: 'spent' };

/** The switch's press pattern as a small state machine. Feed it keydown and keyup times (no repeats). */
export class SwitchPattern {
  private state: SwitchState = { kind: 'idle' };
  private timer: unknown = null;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: SwitchPatternOptions) {
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  down(at: number): void {
    if (this.state.kind === 'released') {
      const firstAt = this.state.firstAt;
      this.cancel();
      this.state = { kind: 'spent' };
      this.options.onCommand('PICK_2', firstAt);
      return;
    }
    if (this.state.kind !== 'idle') return;
    this.state = { kind: 'down', at };
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.state.kind !== 'down') return;
      const onset = this.state.at;
      this.state = { kind: 'spent' };
      this.options.onCommand('STOP', onset);
    }, SWITCH_HOLD_MS);
  }

  up(_at: number): void {
    if (this.state.kind === 'spent') {
      this.state = { kind: 'idle' };
      return;
    }
    if (this.state.kind !== 'down') return;
    const firstAt = this.state.at;
    this.cancel();
    this.state = { kind: 'released', firstAt };
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.state.kind !== 'released') return;
      this.state = { kind: 'idle' };
      this.options.onCommand('PICK_1', firstAt);
    }, SWITCH_DOUBLE_MS);
  }

  /** Forget any press in progress (the session ended, or the mode changed). */
  reset(): void {
    this.cancel();
    this.state = { kind: 'idle' };
  }

  private cancel(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
}
