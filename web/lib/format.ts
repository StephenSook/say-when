/**
 * Time and number formatting for every screen. Pure functions, no React.
 *
 * Clock times are shown in Pacific time (the event is in San Francisco), 24-hour, so
 * "12:41:06" never needs an AM or PM and every laptop shows the same clock.
 * Use the `num` class (tabular figures) wherever these values update live.
 */

/** Epoch milliseconds, an ISO 8601 string (as apify/client sends `fetchedAt`), or a Date. */
export type TimeInput = number | string | Date;

export const TIME_ZONE = 'America/Los_Angeles';

const clockFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const clockShortFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const dateFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  month: 'short',
  day: 'numeric',
});

const zoneFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  timeZoneName: 'short',
});

const integerFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Epoch milliseconds for any time input. NaN when the input cannot be read. */
export function toMillis(input: TimeInput): number {
  if (typeof input === 'number') return input;
  if (input instanceof Date) return input.getTime();
  return Date.parse(input);
}

function valid(ms: number): boolean {
  return Number.isFinite(ms);
}

/** A whole number with thousands separators: 1104 -> "1,104". */
export function formatInteger(value: number): string {
  return integerFormat.format(Math.round(value));
}

/** Milliseconds for the raw event feed: 81 -> "81 ms", 1104 -> "1,104 ms". */
export function formatMs(ms: number): string {
  if (!valid(ms)) return '';
  return `${formatInteger(Math.max(0, ms))} ms`;
}

/**
 * Seconds for stage times and the headline latency.
 * 80 -> "0.08 s", 412 -> "0.4 s", 2900 -> "2.9 s", 12345 -> "12 s", 65000 -> "1 min 5 s".
 */
export function formatSeconds(ms: number): string {
  if (!valid(ms)) return '';
  const safe = Math.max(0, ms);
  if (safe === 0) return '0 s';
  if (safe < 100) return `${(safe / 1000).toFixed(2)} s`;
  if (safe < 10_000) {
    const tenths = Math.round(safe / 100) / 10;
    if (tenths < 10) return `${tenths.toFixed(1)} s`;
  }
  const seconds = Math.round(safe / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

/** A live duration on a clock face, for call and ring timers: 42000 -> "0:42", 3723000 -> "1:02:03". */
export function formatClockDuration(ms: number): string {
  if (!valid(ms)) return '';
  const total = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  return `${minutes}:${ss}`;
}

/** Whole seconds left on a countdown, rounded up so it never shows 0 while time remains: "6 s left". */
export function formatTimeLeft(ms: number): string {
  if (!valid(ms)) return '';
  return `${Math.ceil(Math.max(0, ms) / 1000)} s left`;
}

/** Clock time in Pacific time, 24-hour: "12:41:06". */
export function formatClock(input: TimeInput): string {
  const ms = toMillis(input);
  return valid(ms) ? clockFormat.format(ms) : '';
}

/** Clock time without seconds: "12:41". */
export function formatClockShort(input: TimeInput): string {
  const ms = toMillis(input);
  return valid(ms) ? clockShortFormat.format(ms) : '';
}

/** Short date in Pacific time: "Oct 12". */
export function formatDate(input: TimeInput): string {
  const ms = toMillis(input);
  return valid(ms) ? dateFormat.format(ms) : '';
}

/** "PDT" or "PST" for the given moment. */
export function timeZoneLabel(input: TimeInput = Date.now()): string {
  const ms = toMillis(input);
  if (!valid(ms)) return '';
  return zoneFormat.formatToParts(ms).find((part) => part.type === 'timeZoneName')?.value ?? '';
}

/**
 * How long ago something happened: "just now", "8 s ago", "3 min ago", "2 h ago", "3 d ago".
 * A time in the future (a clock a little ahead of ours) reads as "just now".
 */
export function formatAge(input: TimeInput, now: number = Date.now()): string {
  const ms = toMillis(input);
  if (!valid(ms) || !valid(now)) return '';
  const diff = now - ms;
  if (diff < 5_000) return 'just now';
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** A count with its noun: (1, "row") -> "1 row", (6, "row") -> "6 rows", (1204, "word") -> "1,204 words". */
export function formatCount(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${formatInteger(count)} ${count === 1 ? singular : plural}`;
}

/** Number of words in a sentence, for the "10 words" label after Listen. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/** Seven or more digits, with spaces, dots, dashes or brackets between them, and an optional leading +. */
const PHONE_LIKE = /\+?\(?\d(?:[\s().-]{0,2}\d){6,}/g;

/**
 * Hides anything that looks like a phone number: "call (510) 555-0100" -> "call [number hidden]".
 * Screens never show a phone number (docs/ui.md), and the call agent's welcome speaks a callback
 * number, so run every transcript line through this before it reaches a screen. Times such as
 * "12:41:06", prices and short counts are left alone.
 */
export function maskPhoneNumbers(text: string): string {
  return text.replace(PHONE_LIKE, '[number hidden]');
}

/**
 * The same match as maskPhoneNumbers with other words in its place, for text that is spoken rather than shown:
 * the earpiece says "Call me at a number" (lib/station/question.ts).
 */
export function replacePhoneNumbers(text: string, words: string): string {
  return text.replace(PHONE_LIKE, () => words);
}
