/**
 * What the role pages (/station, /speaker, and asking on /partner) keep in the browser (docs/station.md 1.4, 7.2 C1).
 *
 * - The SpacetimeDB identity token, one per role per browser profile, under `<host>/<db>/auth_token/<role>`, so two
 *   role pages in one browser never share an identity (docs/spacetime.md 1.3). Never in a page address, a link, a
 *   QR code, a log line, an error message or the screen.
 * - The station's setup choices (decoder port, input mode, the learned switch key, the two speeds) and the speaker's
 *   volume and progress. None of these is a secret.
 *
 * Every read and write sits in a `try`: a private window or blocked site data can throw on access, and the page must
 * still work (it then gets a new identity on each load, which `RoleConnectionState.tokenSaved` reports).
 */
import type { SpacetimeSettings } from '../data/source-mode';

/** The three paired roles a browser page can take. The agent sidecar pairs from Node, not from here. */
export type DeviceRole = 'station' | 'speaker' | 'partner';

export const DEVICE_ROLES: readonly DeviceRole[] = ['station', 'speaker', 'partner'];

/** The part of the Web Storage API this file uses, so tests can pass a fake. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The page's localStorage, or null on the server or when the browser refuses it. */
export function browserStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readItem(key: string, storage: StorageLike | null = browserStorage()): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/** True when the value was stored. */
export function writeItem(key: string, value: string, storage: StorageLike | null = browserStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** True when the key is gone afterwards. */
export function removeItem(key: string, storage: StorageLike | null = browserStorage()): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

// ---------- The SpacetimeDB identity token ----------

/**
 * `<host>/<db>/auth_token/<role>`, with `host` exactly as NEXT_PUBLIC_SPACETIMEDB_HOST is set, for example
 * `https://maincloud.spacetimedb.com/say-when-dev/auth_token/station`.
 */
export function tokenKey(settings: SpacetimeSettings, role: DeviceRole): string {
  return `${settings.host}/${settings.db}/auth_token/${role}`;
}

/** The saved token, or undefined on a first visit (the server then makes a new identity). */
export function readToken(settings: SpacetimeSettings, role: DeviceRole, storage: StorageLike | null = browserStorage()): string | undefined {
  const value = readItem(tokenKey(settings, role), storage);
  return value !== null && value.trim() !== '' ? value : undefined;
}

/** True when the token was stored, so a reload keeps this identity. */
export function saveToken(settings: SpacetimeSettings, role: DeviceRole, token: string, storage: StorageLike | null = browserStorage()): boolean {
  if (token.trim() === '') return false;
  return writeItem(tokenKey(settings, role), token, storage);
}

/** "Forget this device": the next load gets a new identity, which the owner must pair again. */
export function forgetToken(settings: SpacetimeSettings, role: DeviceRole, storage: StorageLike | null = browserStorage()): boolean {
  return removeItem(tokenKey(settings, role), storage);
}

// ---------- The station's setup choices ----------

export const STATION_KEYS = {
  decoderPort: 'neurolingo/station/decoder_port',
  inputMode: 'neurolingo/station/input_mode',
  switchKey: 'neurolingo/station/switch_key',
  assistantSpeed: 'neurolingo/station/assistant_speed',
  optionSpeed: 'neurolingo/station/option_speed',
} as const;

/** The decoder's port on 127.0.0.1 (docs/station.md 2.4; proposed, Shashank confirms). */
export const DEFAULT_DECODER_PORT = 8765;

export type InputMode = 'headset' | 'keyboard' | 'switch';

export const INPUT_MODES: readonly InputMode[] = ['headset', 'keyboard', 'switch'];

/** Speeds the station's setup screen allows (docs/station.md 2.9). */
export const SPEED_RANGE = { min: 0.6, max: 1.5 } as const;

function readNumber(key: string, min: number, max: number, storage: StorageLike | null, integer = false): number | null {
  const raw = readItem(key, storage);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) return null;
  if (integer && !Number.isInteger(value)) return null;
  return value;
}

export function readDecoderPort(storage: StorageLike | null = browserStorage()): number {
  return readNumber(STATION_KEYS.decoderPort, 1, 65_535, storage, true) ?? DEFAULT_DECODER_PORT;
}

/** False for a port outside 1 to 65535 (nothing is stored). */
export function saveDecoderPort(port: number, storage: StorageLike | null = browserStorage()): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return false;
  return writeItem(STATION_KEYS.decoderPort, String(port), storage);
}

export function readInputMode(storage: StorageLike | null = browserStorage()): InputMode | null {
  const raw = readItem(STATION_KEYS.inputMode, storage);
  return raw !== null && (INPUT_MODES as readonly string[]).includes(raw) ? (raw as InputMode) : null;
}

export function saveInputMode(mode: InputMode, storage: StorageLike | null = browserStorage()): boolean {
  return writeItem(STATION_KEYS.inputMode, mode, storage);
}

/** A KeyboardEvent.code, such as "Space" or "KeyJ". */
const KEY_CODE_RE = /^[A-Za-z0-9]{1,32}$/;

export function readSwitchKey(storage: StorageLike | null = browserStorage()): string | null {
  const raw = readItem(STATION_KEYS.switchKey, storage);
  return raw !== null && KEY_CODE_RE.test(raw) ? raw : null;
}

export function saveSwitchKey(code: string, storage: StorageLike | null = browserStorage()): boolean {
  if (!KEY_CODE_RE.test(code)) return false;
  return writeItem(STATION_KEYS.switchKey, code, storage);
}

/** The assistant voice's speed (prompts and read-backs at the person's pace), or null for the voice default. */
export function readAssistantSpeed(storage: StorageLike | null = browserStorage()): number | null {
  return readNumber(STATION_KEYS.assistantSpeed, SPEED_RANGE.min, SPEED_RANGE.max, storage);
}

/** The option voice's speed, or null when unset. */
export function readOptionSpeed(storage: StorageLike | null = browserStorage()): number | null {
  return readNumber(STATION_KEYS.optionSpeed, SPEED_RANGE.min, SPEED_RANGE.max, storage);
}

/** Saves a speed, or clears it with null. False for a value outside 0.6 to 1.5. */
export function saveSpeed(which: 'assistant' | 'option', speed: number | null, storage: StorageLike | null = browserStorage()): boolean {
  const key = which === 'assistant' ? STATION_KEYS.assistantSpeed : STATION_KEYS.optionSpeed;
  if (speed === null) return removeItem(key, storage);
  if (!Number.isFinite(speed) || speed < SPEED_RANGE.min || speed > SPEED_RANGE.max) return false;
  return writeItem(key, String(speed), storage);
}

// ---------- The speaker's volume and progress ----------

export const SPEAKER_VOLUME_KEY = 'neurolingo/speaker/reply_volume';

export const VOLUME_RANGE = { min: 0.5, max: 2 } as const;

export function readReplyVolume(storage: StorageLike | null = browserStorage()): number {
  return readNumber(SPEAKER_VOLUME_KEY, VOLUME_RANGE.min, VOLUME_RANGE.max, storage) ?? 1;
}

export function saveReplyVolume(volume: number, storage: StorageLike | null = browserStorage()): boolean {
  if (!Number.isFinite(volume) || volume < VOLUME_RANGE.min || volume > VOLUME_RANGE.max) return false;
  return writeItem(SPEAKER_VOLUME_KEY, String(volume), storage);
}

/** `neurolingo/speaker/<db>/last` (docs/station.md 3, step 6). */
export function speakerProgressKey(db: string): string {
  return `neurolingo/speaker/${db}/last`;
}

export interface SpeakerProgress {
  /** The question id as decimal text (a u64 does not fit a JSON number). */
  questionId: string;
  state: 'started' | 'done';
}

export function readSpeakerProgress(db: string, storage: StorageLike | null = browserStorage()): SpeakerProgress | null {
  const raw = readItem(speakerProgressKey(db), storage);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SpeakerProgress> | null;
    if (!parsed || typeof parsed.questionId !== 'string' || !/^\d{1,20}$/.test(parsed.questionId)) return null;
    if (parsed.state !== 'started' && parsed.state !== 'done') return null;
    return { questionId: parsed.questionId, state: parsed.state };
  } catch {
    return null;
  }
}

export function saveSpeakerProgress(db: string, progress: SpeakerProgress, storage: StorageLike | null = browserStorage()): boolean {
  if (!/^\d{1,20}$/.test(progress.questionId)) return false;
  return writeItem(speakerProgressKey(db), JSON.stringify({ questionId: progress.questionId, state: progress.state }), storage);
}
