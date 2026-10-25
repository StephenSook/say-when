// The person's timing and the room's switches (docs/spacetime.md 2.10). Defaults are builder starting points;
// set each from the wearer's calibration with `set_timing`.
import type { Identity } from 'spacetimedb';
import { SenderError } from 'spacetimedb/server';
import type { ReadDb } from './ctx';
import type { Config } from './schema';
import { hasKey } from './util';

type NumericKey = {
  [K in keyof Config]: Config[K] extends number ? K : never;
}[keyof Config];

export interface TimingSpec {
  field: NumericKey;
  def: number;
  min: number;
  max: number;
}

/** Keys are the snake_case names `set_timing` takes. Order and ranges follow the table in 2.10. */
export const TIMING: Readonly<Record<string, TimingSpec>> = {
  response_window_ms: { field: 'responseWindowMs', def: 3500, min: 1000, max: 10000 },
  grace_ms: { field: 'graceMs', def: 1000, min: 0, max: 3000 },
  refractory_ms: { field: 'refractoryMs', def: 1000, min: 200, max: 5000 },
  quiet_hold_ms: { field: 'quietHoldMs', def: 1000, min: 500, max: 5000 },
  confirm_window_ms: { field: 'confirmWindowMs', def: 8000, min: 3000, max: 20000 },
  reply_veto_ms: { field: 'replyVetoMs', def: 700, min: 300, max: 3000 },
  yes_no_cue_ms: { field: 'yesNoCueMs', def: 900, min: 300, max: 3000 },
  audio_pad_ms: { field: 'audioPadMs', def: 150, min: 0, max: 1000 },
  clip_deadline_ms: { field: 'clipDeadlineMs', def: 4000, min: 1000, max: 15000 },
  max_passes: { field: 'maxPasses', def: 2, min: 1, max: 3 },
  max_options: { field: 'maxOptions', def: 4, min: 2, max: 4 },
  heartbeat_ms: { field: 'heartbeatMs', def: 500, min: 200, max: 2000 },
  liveness_lease_ms: { field: 'livenessLeaseMs', def: 1500, min: 1000, max: 5000 },
  resume_good_contact_ms: { field: 'resumeGoodContactMs', def: 3000, min: 0, max: 30000 },
  idle_pause_ms: { field: 'idlePauseMs', def: 120000, min: 30000, max: 1800000 },
  readback_deadline_ms: { field: 'readbackDeadlineMs', def: 30000, min: 5000, max: 120000 },
  preview_timeout_ms: { field: 'previewTimeoutMs', def: 60000, min: 10000, max: 180000 },
  submit_lease_ms: { field: 'submitLeaseMs', def: 60000, min: 10000, max: 180000 },
  call_lease_ms: { field: 'callLeaseMs', def: 240000, min: 60000, max: 600000 },
  job_lease_ms: { field: 'jobLeaseMs', def: 45000, min: 5000, max: 180000 },
  job_max_attempts: { field: 'jobMaxAttempts', def: 3, min: 1, max: 5 },
  pairing_ttl_ms: { field: 'pairingTtlMs', def: 300000, min: 30000, max: 900000 },
};

/** Booleans `set_timing` also accepts, so PLAN Q9 (`menu_enabled`) flips without a schema change. */
export const SWITCHES = {
  menu_enabled: 'menuEnabled',
  auto_resume: 'autoResume',
} as const;

export function defaultConfig(owner: Identity): Config {
  const cfg = {
    id: 0,
    owner,
    activeSessionId: 0n,
    shareTextOnBoard: false,
    menuEnabled: true,
    autoResume: true,
    dispatchMode: 'sidecar',
    // D18: a new database answers by direct select. `set_input_mode scan` brings back the cursor.
    inputMode: { tag: 'Direct' },
  } as Config;
  for (const spec of Object.values(TIMING)) {
    (cfg as Record<string, unknown>)[spec.field] = spec.def;
  }
  return cfg;
}

/** The config row. Every database has one from `init`; a missing row is a broken publish. */
export function getConfig(db: ReadDb): Config {
  const cfg = db.config.id.find(0);
  if (!cfg) throw new SenderError('config missing');
  return cfg;
}

/** D18: the database answers by direct select (four gestures for four options), not the scanning cursor. */
export function isDirect(db: ReadDb): boolean {
  return getConfig(db).inputMode.tag === 'Direct';
}

/**
 * Applies a `set_timing` JSON object to a copy of the config. Throws (and so changes nothing) on an unknown key,
 * a value that is not a whole number in range, or a cross-rule failure. Returns the changed keys.
 */
export function applyTiming(cfg: Config, json: string): { next: Config; changed: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SenderError('timing must be a JSON object');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SenderError('timing must be a JSON object');
  }
  const next: Record<string, unknown> = { ...cfg };
  const changed: string[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    // Own keys only: `constructor` or `__proto__` must be unknown keys, not lookups into Object.prototype.
    const spec = hasKey(TIMING, key) ? TIMING[key] : undefined;
    if (spec) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < spec.min || value > spec.max) {
        throw new SenderError(`${key} must be a whole number from ${spec.min} to ${spec.max}`);
      }
      next[spec.field] = value;
      changed.push(key);
      continue;
    }
    if (hasKey(SWITCHES, key)) {
      if (typeof value !== 'boolean') throw new SenderError(`${key} must be true or false`);
      next[SWITCHES[key as keyof typeof SWITCHES]] = value;
      changed.push(key);
      continue;
    }
    throw new SenderError(`unknown timing key ${key}`);
  }
  const out = next as Config;
  // A YES may only land on the previous option while a NO for it would still be refractory (2.10).
  if (out.graceMs > out.refractoryMs) throw new SenderError('grace_ms must not exceed refractory_ms');
  // A lease shorter than the beat would pause on every heartbeat.
  if (out.livenessLeaseMs <= out.heartbeatMs) throw new SenderError('liveness_lease_ms must exceed heartbeat_ms');
  return { next: out, changed };
}

/** When a clip is late: 300 ms plus 60 ms per character, capped at 6 s (3.10 `enterReading`). */
export function estimateClipMs(text: string): number {
  return Math.min(6000, 300 + 60 * text.length);
}
