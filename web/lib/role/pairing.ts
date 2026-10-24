/**
 * Pairing a role page, as a pure state machine (docs/station.md 1.2 and 1.3, 7.2 C2). No timers, no network, no
 * randomness here: `pairingStep(state, event)` returns the next state and the effects to run, and
 * lib/role/device.ts runs them against the connection. That keeps every rule testable with plain values.
 *
 * The flow:
 *   connecting   no identity, or `device_status` not applied yet
 *   unpaired     no `device_status` row for this identity. Station and speaker ask for a code at once; the partner
 *                phone waits until someone picks its label ("Pair this phone to ask").
 *   requesting   `request_pairing(code, role, label)` is on its way
 *   waiting      the code is on screen; the owner approves it from the CLI
 *   expired      the code ran out (`config.pairing_ttl_ms`, 5 minutes); New code asks again
 *   checking     a row for this identity and role exists; `mint_voice_token` decides whether it is still paired
 *   paired       the voice check said so (a token, or "no Cartesia key", or a voice service problem)
 *   revoked      it was paired and is not anymore (`not allowed`, or the mint said `not_paired_for_purpose`)
 *   wrong_role   this identity is paired as another role (should not happen: tokens are kept per role)
 *   error        the module refused the request for a reason the page cannot fix by itself
 *
 * Why the voice check decides: `device_status` keeps its row after `revoke_device` (it only sets `online` to false,
 * and there is no public revoked flag), while `mint_voice_token` checks the private `device` row, revoked or not
 * (spacetime/src/index.ts `mintVoiceToken`, auth.ts `deviceOf`). After a revocation the row's `last_seen_at` is
 * remembered; a later approval rewrites the row, which changes that stamp, and the check runs again.
 */
import { SENDER_MESSAGES, type CallErrorKind } from './calls';
import type { DeviceRole } from './storage';

/** The only labels a page offers: labels are public in `device_status`, so nobody types a name (docs/station.md 1.1). */
export const PAIRING_LABELS: Readonly<Record<DeviceRole, readonly string[]>> = {
  station: ['station'],
  speaker: ['speaker'],
  partner: ['partner phone 1', 'partner phone 2', 'partner phone 3'],
};

export function isPairingLabel(role: DeviceRole, label: string): boolean {
  return PAIRING_LABELS[role].includes(label);
}

/** The label a page asks with on its own, or null when a person picks one (the partner phone). */
export function autoPairingLabel(role: DeviceRole): string | null {
  return role === 'partner' ? null : (PAIRING_LABELS[role][0] ?? null);
}

/** `config.pairing_ttl_ms` default (spacetime/src/config.ts). */
export const DEFAULT_PAIRING_TTL_MS = 300_000;

export const PAIRING_CODE_MIN = 100_000;
export const PAIRING_CODE_MAX = 999_999;

/** A uniform random code from 100000 to 999999, from `crypto.getRandomValues` (rejection sampling, no modulo bias). */
export function newPairingCode(fill: (array: Uint32Array) => Uint32Array = (array) => globalThis.crypto.getRandomValues(array)): number {
  const span = PAIRING_CODE_MAX - PAIRING_CODE_MIN + 1;
  const limit = Math.floor(0x1_0000_0000 / span) * span;
  const buffer = new Uint32Array(1);
  for (let i = 0; i < 64; i++) {
    const value = fill(buffer)[0] ?? 0;
    if (value < limit) return PAIRING_CODE_MIN + (value % span);
  }
  throw new Error('No random source for the pairing code.');
}

/** 482913 reads as "482 913". */
export function formatPairingCode(code: number): string {
  const digits = String(code).padStart(6, '0');
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

export type PairingPhase =
  | 'connecting'
  | 'unpaired'
  | 'requesting'
  | 'waiting'
  | 'expired'
  | 'checking'
  | 'paired'
  | 'revoked'
  | 'wrong_role'
  | 'error';

/** What `mint_voice_token` said, reduced to what pairing needs (lib/voice/token.ts `voiceProblemOf`). */
export type VoiceOutcome = 'ok' | 'not_paired' | 'key_missing' | 'service' | 'bug' | 'offline';

/** A `device_status` row, reduced to plain values. */
export interface DeviceRowLite {
  identityHex: string;
  /** 'station', 'speaker', 'partner' or 'agent'. */
  role: string;
  label: string;
  online: boolean;
  /** `last_seen_at` in microseconds, as text. A new approval rewrites it. */
  stamp: string;
}

export interface PairingState {
  role: DeviceRole;
  phase: PairingPhase;
  identityHex: string | null;
  live: boolean;
  /** `device_status` has been read at least once on this connection. */
  rowsApplied: boolean;
  /** This identity's `device_status` row, if any. */
  myRow: DeviceRowLite | null;
  /** The label for the next request: fixed for station and speaker, picked on the partner phone. */
  label: string | null;
  /** Ask for a code on its own when unpaired or revoked (station and speaker). */
  autoRequest: boolean;
  code: number | null;
  /** When the code runs out, on the page's clock (Date.now at the answer plus `pairing_ttl_ms`). */
  expiresAt: number | null;
  /** A request that did not reach the module (the connection dropped): sent again once live. */
  resendPending: boolean;
  /** `code taken` is retried once with a new code. */
  codeTakenRetried: boolean;
  /** The row's stamp when it was last known not to mean "paired"; only a changed stamp starts a new check. */
  staleStamp: string | null;
  checkInFlight: boolean;
  /** It was paired on this load and then was not: the card says "This device is not paired anymore." */
  revokedBefore: boolean;
  /** For wrong_role: the role this identity is paired as. */
  pairedRole: string | null;
  /** For error: the module's words, shown as they are. */
  errorText: string | null;
  /** The last voice check's outcome, null before the first one. */
  voice: VoiceOutcome | null;
}

export type PairingEvent =
  | { type: 'connection'; identityHex: string | null; live: boolean }
  /** `device_status` after the subscription applied, and after every change to it. */
  | { type: 'rows'; rows: readonly DeviceRowLite[] }
  /** The page is about to call `request_pairing` with this code and label. */
  | { type: 'request'; code: number; label: string }
  | { type: 'request_ok'; code: number; at: number; ttlMs: number }
  | { type: 'request_failed'; code: number; kind: CallErrorKind; message: string }
  | { type: 'tick'; at: number }
  | { type: 'voice'; outcome: VoiceOutcome; at: number }
  /** A role call was refused with `not allowed`, or a later mint said `not_paired_for_purpose`. */
  | { type: 'not_allowed' }
  /** A person picked a label on the partner phone. */
  | { type: 'choose_label'; label: string };

export type PairingEffect =
  /** Call `request_pairing`: with a new code when `fresh`, else the same code again. */
  | { type: 'send_request'; fresh: boolean; delayMs?: number }
  | { type: 'check_voice'; delayMs?: number };

export interface PairingStep {
  state: PairingState;
  effects: PairingEffect[];
}

/** How long to wait before trying again when the connection says live but the call said "not sent". */
export const PAIRING_RETRY_MS = 2_000;

export function initialPairingState(role: DeviceRole, label: string | null = autoPairingLabel(role)): PairingState {
  return {
    role,
    phase: 'connecting',
    identityHex: null,
    live: false,
    rowsApplied: false,
    myRow: null,
    label: label !== null && isPairingLabel(role, label) ? label : null,
    autoRequest: role !== 'partner',
    code: null,
    expiresAt: null,
    resendPending: false,
    codeTakenRetried: false,
    staleStamp: null,
    checkInFlight: false,
    revokedBefore: false,
    pairedRole: null,
    errorText: null,
    voice: null,
  };
}

/** Phases that show the pairing card. */
export function showsPairingCard(phase: PairingPhase): boolean {
  return phase === 'unpaired' || phase === 'requesting' || phase === 'waiting' || phase === 'expired' || phase === 'revoked' || phase === 'error' || phase === 'wrong_role';
}

function startCheck(state: PairingState, effects: PairingEffect[]): PairingState {
  const next: PairingState = { ...state, phase: 'checking' };
  if (next.live && !next.checkInFlight) {
    effects.push({ type: 'check_voice' });
    next.checkInFlight = true;
  }
  return next;
}

/** No code on screen any more: unpaired or revoked. Station and speaker ask for a new one at once. */
function needCode(state: PairingState, phase: 'unpaired' | 'revoked', effects: PairingEffect[]): PairingState {
  const next: PairingState = { ...state, phase, code: null, expiresAt: null, resendPending: false, codeTakenRetried: false };
  if (next.autoRequest && next.label !== null) {
    if (next.live) effects.push({ type: 'send_request', fresh: true });
    else next.resendPending = true;
  }
  return next;
}

function revoke(state: PairingState, effects: PairingEffect[]): PairingState {
  return needCode({ ...state, revokedBefore: true, staleStamp: state.myRow?.stamp ?? null, checkInFlight: false }, 'revoked', effects);
}

export function pairingStep(state: PairingState, event: PairingEvent): PairingStep {
  const effects: PairingEffect[] = [];
  let next: PairingState = state;

  switch (event.type) {
    case 'connection': {
      const wasLive = state.live;
      next = { ...state, identityHex: event.identityHex ?? state.identityHex, live: event.live };
      if (!event.live) {
        // Rows are read again once the subscription applies on the next connection.
        next.rowsApplied = state.rowsApplied && event.live;
        break;
      }
      if (wasLive) break;
      if (next.phase === 'checking' && !next.checkInFlight) {
        effects.push({ type: 'check_voice' });
        next.checkInFlight = true;
      }
      if (next.resendPending && next.label !== null && next.phase !== 'paired' && next.phase !== 'checking' && next.phase !== 'wrong_role') {
        effects.push({ type: 'send_request', fresh: next.code === null });
        next.resendPending = false;
      }
      break;
    }

    case 'rows': {
      const id = state.identityHex;
      if (id === null) break;
      const mine = event.rows.find((row) => row.identityHex === id) ?? null;
      next = { ...state, rowsApplied: true, myRow: mine };
      if (mine && mine.role !== state.role) {
        next = { ...next, phase: 'wrong_role', pairedRole: mine.role, checkInFlight: false };
        break;
      }
      if (mine) {
        switch (state.phase) {
          case 'connecting':
          case 'unpaired':
            next = startCheck(next, effects);
            break;
          case 'requesting':
          case 'waiting':
          case 'expired':
          case 'revoked':
          case 'error':
            if (mine.stamp !== state.staleStamp) next = startCheck(next, effects);
            break;
          case 'wrong_role':
            // The row now has this page's role (the owner paired it again): check it.
            next = startCheck({ ...next, pairedRole: null }, effects);
            break;
          case 'checking':
          case 'paired':
            break;
        }
        break;
      }
      // No row for this identity.
      if (state.phase === 'connecting' || state.phase === 'paired' || state.phase === 'checking' || state.phase === 'wrong_role') {
        next = needCode({ ...next, checkInFlight: false, pairedRole: null }, 'unpaired', effects);
      }
      break;
    }

    case 'choose_label': {
      if (!isPairingLabel(state.role, event.label)) break;
      next = { ...state, label: event.label };
      break;
    }

    case 'request': {
      if (state.phase === 'paired' || state.phase === 'checking' || state.phase === 'wrong_role') break;
      if (!isPairingLabel(state.role, event.label)) {
        next = { ...state, phase: 'error', errorText: 'Pick a label from the list.' };
        break;
      }
      const sameCode = state.code === event.code;
      next = {
        ...state,
        phase: 'requesting',
        label: event.label,
        code: event.code,
        expiresAt: sameCode ? state.expiresAt : null,
        resendPending: false,
        errorText: null,
        // The row as it is now (a revoked one, or none) does not mean paired; only a rewrite of it does.
        staleStamp: state.myRow?.stamp ?? null,
      };
      break;
    }

    case 'request_ok': {
      if (event.code !== state.code || state.phase !== 'requesting') break;
      next = { ...state, phase: 'waiting', expiresAt: event.at + Math.max(0, event.ttlMs) };
      break;
    }

    case 'request_failed': {
      if (event.code !== state.code || state.phase !== 'requesting') break;
      if (event.kind === 'disconnected' || event.kind === 'unknown_result') {
        // A repeat of the same code by the same identity replaces the earlier request (spacetime/src/index.ts).
        next = { ...state, resendPending: !state.live };
        if (state.live) effects.push({ type: 'send_request', fresh: false, delayMs: PAIRING_RETRY_MS });
        break;
      }
      const message = event.message.trim();
      if (event.kind === 'sender' && message === SENDER_MESSAGES.alreadyPaired) {
        next = startCheck({ ...state, staleStamp: null }, effects);
        break;
      }
      if (event.kind === 'sender' && message.startsWith('code taken')) {
        if (!state.codeTakenRetried) {
          next = { ...state, codeTakenRetried: true };
          effects.push({ type: 'send_request', fresh: true });
        } else {
          next = { ...state, phase: 'error', errorText: 'Could not get a free code. Press New code.' };
        }
        break;
      }
      next = { ...state, phase: 'error', errorText: message === '' ? 'The request was refused.' : message };
      break;
    }

    case 'tick': {
      if (state.phase === 'waiting' && state.expiresAt !== null && event.at >= state.expiresAt) {
        next = { ...state, phase: 'expired' };
      }
      break;
    }

    case 'voice': {
      if (!state.checkInFlight) {
        if (event.outcome === 'not_paired' && state.phase === 'paired') next = revoke(state, effects);
        else if (event.outcome !== 'offline' && event.outcome !== 'not_paired') next = { ...state, voice: event.outcome };
        break;
      }
      next = { ...state, checkInFlight: false };
      if (event.outcome === 'offline') {
        // Try again once the connection is back; if it claims to be live, after a short wait.
        if (state.live) {
          effects.push({ type: 'check_voice', delayMs: PAIRING_RETRY_MS });
          next.checkInFlight = true;
        }
        break;
      }
      if (event.outcome === 'not_paired') {
        const codeStillGood = state.code !== null && state.expiresAt !== null && event.at < state.expiresAt;
        // A row is there but the module says this identity is not paired for this role: revoked. If a code is still
        // waiting for the owner, keep waiting for it instead.
        if (codeStillGood) next = { ...next, phase: 'waiting', staleStamp: state.myRow?.stamp ?? null };
        else next = revoke(next, effects);
        break;
      }
      // ok, key_missing, service or bug: the device row is live for this role.
      next = {
        ...next,
        phase: 'paired',
        voice: event.outcome,
        code: null,
        expiresAt: null,
        resendPending: false,
        codeTakenRetried: false,
        staleStamp: null,
        revokedBefore: false,
        errorText: null,
      };
      break;
    }

    case 'not_allowed': {
      if (state.phase === 'paired' || state.phase === 'checking') next = revoke(state, effects);
      break;
    }
  }

  // An automatic request goes out at once: show it as requesting, not as an empty card.
  if (effects.some((effect) => effect.type === 'send_request' && effect.fresh && effect.delayMs === undefined) && next.phase !== 'checking') {
    next = { ...next, phase: 'requesting' };
  }
  return { state: next, effects };
}
