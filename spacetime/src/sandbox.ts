// The judge try sandbox (PLAN 5.11, docs/spacetime.md 15). A judge opens /try on their own phone or laptop and runs
// Eleven with on-screen buttons standing in for the headset. Every rule here applies only while the owner has turned
// the sandbox on with `set_sandbox` (the `sandbox_settings` row, id 0, with `on` true); with no row, every reducer
// behaves exactly as before. It is turned on only on the `say-when-try` database, never on `say-when-dev` or
// `say-when-demo`.
//
// What it changes, and why:
// - Pairing: a Station, Partner or Speaker is approved the moment it asks (no owner at the table), never as a
//   caregiver. An Agent still waits for the owner, because an Agent can publish options and send errands.
// - Sessions: one database runs one session at a time. A new try may replace the active one when its station has
//   been silent for `stale_try_ms` (the judge closed the tab) or it is older than `max_try_ms`; a heartbeat ends a try
//   that has run past `max_try_ms`.
// - Caps: questions per try, tries per hour, questions per day, pairings per hour, and Cartesia tokens per device and
//   per hour. Past a cap the reducer refuses with a sentence that starts "try limit:", which the page shows as is.
import { Timestamp, type Identity } from 'spacetimedb';
import { SenderError } from 'spacetimedb/server';
import type { Ctx, ReadDb } from './ctx';
import type { SandboxSettings } from './schema';
import { msBetween } from './util';

/** A reducer's context, or a procedure's transaction: both can write the meter. */
type MeterCtx = Pick<Ctx, 'db' | 'timestamp'>;

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/** The defaults `set_sandbox '{"on":true}'` starts from. Each one can be changed by name. */
export const SANDBOX_DEFAULTS = {
  questionsPerTry: 5,
  triesPerHour: 12,
  questionsPerDay: 150,
  pairingsPerHour: 90,
  tokensPerDevicePerHour: 120,
  tokensPerHour: 1200,
  maxTryMs: 6 * 60 * 1000,
  staleTryMs: 15 * 1000,
} as const;

type Limits = Omit<SandboxSettings, 'id' | 'on' | 'updatedAt'>;

/** snake_case JSON key, field, smallest and largest value. */
const KEYS: ReadonlyArray<[string, keyof Limits, number, number]> = [
  ['questions_per_try', 'questionsPerTry', 1, 20],
  ['tries_per_hour', 'triesPerHour', 1, 120],
  ['questions_per_day', 'questionsPerDay', 1, 5000],
  ['pairings_per_hour', 'pairingsPerHour', 3, 1000],
  ['tokens_per_device_per_hour', 'tokensPerDevicePerHour', 1, 2000],
  ['tokens_per_hour', 'tokensPerHour', 1, 20000],
  ['max_try_ms', 'maxTryMs', 60_000, 30 * 60 * 1000],
  ['stale_try_ms', 'staleTryMs', 5_000, 120_000],
];

/** The settings row while the sandbox is on; undefined while it is off (no row, or `on` false). */
export function sandboxOn(db: ReadDb): SandboxSettings | undefined {
  const row = db.sandboxSettings.id.find(0);
  return row && row.on ? row : undefined;
}

/**
 * The next settings row from the owner's JSON: `on` (true or false) and any of the limits in KEYS. Keys left out keep
 * their current value (the defaults on the first call). An unknown key or a value out of range changes nothing and
 * throws, naming the key.
 */
export function nextSandboxSettings(current: SandboxSettings | null | undefined, json: string, at: Timestamp): SandboxSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SenderError('set_sandbox takes a JSON object');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SenderError('set_sandbox takes a JSON object');
  const next: SandboxSettings = current ? { ...current } : { id: 0, on: false, ...SANDBOX_DEFAULTS, updatedAt: at };
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key === 'on') {
      if (typeof value !== 'boolean') throw new SenderError('on must be true or false');
      next.on = value;
      continue;
    }
    const spec = KEYS.find(([name]) => name === key);
    if (!spec) throw new SenderError(`unknown sandbox setting: ${key.slice(0, 40)}`);
    const [, field, min, max] = spec;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new SenderError(`${key} must be a whole number from ${min} to ${max}`);
    }
    next[field] = value;
  }
  next.updatedAt = at;
  return next;
}

/**
 * Counts one use of `key` inside a fixed window of `windowMs` that starts at the key's first use (and again at its
 * first use after the window ends). Returns false, and counts nothing, when `limit` uses are already in the window.
 * A reducer that throws afterwards rolls the count back with everything else.
 */
export function meter(ctx: MeterCtx, key: string, windowMs: number, limit: number): boolean {
  const row = ctx.db.sandboxMeter.key.find(key);
  if (!row || msBetween(ctx.timestamp, row.windowStartedAt) >= windowMs || msBetween(ctx.timestamp, row.windowStartedAt) < 0) {
    if (limit < 1) return false;
    const fresh = { key, windowStartedAt: ctx.timestamp, count: 1 };
    if (row) ctx.db.sandboxMeter.key.update(fresh);
    else ctx.db.sandboxMeter.insert(fresh);
    return true;
  }
  if (row.count >= limit) return false;
  ctx.db.sandboxMeter.key.update({ ...row, count: row.count + 1 });
  return true;
}

/** Throws the page's sentence when `meter` says the cap is reached. */
export function requireMeter(ctx: MeterCtx, key: string, windowMs: number, limit: number, sentence: string): void {
  if (!meter(ctx, key, windowMs, limit)) throw new SenderError(`try limit: ${sentence}`);
}

/** The meter key for one device's Cartesia tokens. */
export function tokenKey(identity: Identity): string {
  return `tokens:${identity.toHexString()}`;
}
