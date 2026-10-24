/**
 * Cartesia access tokens for a paired role page, from the module's `mint_voice_token(purpose)` procedure
 * (docs/station.md 1.3 and 1.4, docs/spacetime.md 6.1, 7.2 C4).
 *
 * - `tts` for a station or speaker, `stt` for a partner phone. One grant per token; the agent grant is never asked for.
 * - A token lives 60 s and opens one Cartesia socket. It stays in memory only: never stored, logged, shown, or put in
 *   an error message. `getToken` is what `TtsPlayer({ getToken })` and `listen({ getToken })` call, once per socket.
 * - The voice check (`check`) mints once after pairing and after every load. Its token is kept as a spare for the
 *   first socket while it still has at least `minLifeMs` to live, so that first socket does not mint twice.
 * - A token's end of life is the earlier of the module's `expires_at_ms` and 60 s after it arrived here, so a laptop
 *   clock that runs behind the server's cannot keep a dead token.
 *
 * The answers (spacetime/src/index.ts `mintVoiceToken`, voice.ts), and the words the page shows for each:
 *   a token                                   Voice ready
 *   not_paired_for_purpose                    the pairing card again: "This device is not paired anymore."
 *   voice_key_missing                         "Voice off: the database has no Cartesia key."
 *   voice_service_unreachable, voice_service_<status>, voice_bad_response
 *                                             "Voice service problem (<code>)." with a Retry
 *   bad_purpose                               a bug in the page, shown as is
 */
import { callErrorKind, notConnectedError } from '../role/calls';
import type { DeviceRole } from '../role/storage';

export type VoicePurpose = 'tts' | 'stt';

export function voicePurposeFor(role: DeviceRole): VoicePurpose {
  return role === 'partner' ? 'stt' : 'tts';
}

export type VoiceProblem = 'not_paired' | 'key_missing' | 'service' | 'bug' | 'offline';

/** The code for a mint that never reached the module (no live connection). Ours, not the module's. */
export const VOICE_OFFLINE = 'voice_offline';

/** A token's longest life, in case the module's expiry is missing or the clocks disagree. */
export const VOICE_TOKEN_TTL_MS = 60_000;

/** A spare token is handed out only with at least this much life left. */
export const VOICE_TOKEN_MIN_LIFE_MS = 15_000;

/** The module's codes (spacetime/src/index.ts, voice.ts) and ours: nothing else is ever shown. */
const CODE_RE = /^(not_paired_for_purpose|bad_purpose|voice_[a-z0-9_]{1,48})$/;

/** A code safe to show: one of the known shapes, or `voice_bad_response` in its place. */
export function safeVoiceCode(code: unknown): string {
  return typeof code === 'string' && CODE_RE.test(code) ? code : 'voice_bad_response';
}

export function voiceProblemOf(code: string): VoiceProblem {
  if (code === 'not_paired_for_purpose') return 'not_paired';
  if (code === 'voice_key_missing') return 'key_missing';
  if (code === 'bad_purpose') return 'bug';
  if (code === VOICE_OFFLINE) return 'offline';
  return 'service';
}

/** The sentence the page shows for a mint error code. */
export function voiceWords(code: string): string {
  const safe = safeVoiceCode(code);
  switch (voiceProblemOf(safe)) {
    case 'not_paired':
      return 'This device is not paired anymore.';
    case 'key_missing':
      return 'Voice off: the database has no Cartesia key.';
    case 'bug':
      return `Voice check failed (${safe}).`;
    case 'offline':
      return 'Voice check is waiting for the connection.';
    case 'service':
      return `Voice service problem (${safe}).`;
  }
}

/** Thrown by getToken. Its message is the page's sentence and never holds a token. */
export class VoiceTokenError extends Error {
  readonly code: string;
  readonly problem: VoiceProblem;
  constructor(code: string) {
    const safe = safeVoiceCode(code);
    super(voiceWords(safe));
    this.name = 'VoiceTokenError';
    this.code = safe;
    this.problem = voiceProblemOf(safe);
  }
}

/** What the procedure returns (the generated `VoiceToken` type). */
export interface VoiceTokenRow {
  token: string;
  expiresAtMs: bigint | number;
  error: string;
}

export type MintFn = (purpose: VoicePurpose) => Promise<VoiceTokenRow>;

export type VoiceState =
  | { status: 'unknown' }
  | { status: 'checking' }
  | { status: 'ready'; at: number }
  | { status: 'problem'; problem: VoiceProblem; code: string; words: string; at: number };

export interface VoiceTokenClientOptions {
  purpose: VoicePurpose;
  /** Calls the procedure, for example `mintVia(connection)`. */
  mint: MintFn;
  /** Called when the module says this device is not paired for the purpose (revoked, or the wrong role). */
  onNotPaired?: () => void;
  minLifeMs?: number;
  now?: () => number;
}

export interface VoiceTokenClient {
  readonly purpose: VoicePurpose;
  getState(): VoiceState;
  subscribe(listener: () => void): () => void;
  /** The voice check. Resolves with the new state; never rejects. Calls in flight share one mint. */
  check(): Promise<VoiceState>;
  /** A token for one Cartesia socket. Rejects with VoiceTokenError. */
  getToken(): Promise<string>;
  /** Drops the spare token. */
  clear(): void;
}

interface Spare {
  token: string;
  endsAt: number;
}

function expiryOf(row: VoiceTokenRow, receivedAt: number): number {
  const fromModule = typeof row.expiresAtMs === 'bigint' ? Number(row.expiresAtMs) : row.expiresAtMs;
  const cap = receivedAt + VOICE_TOKEN_TTL_MS;
  return Number.isFinite(fromModule) && fromModule > 0 ? Math.min(fromModule, cap) : cap;
}

export function createVoiceTokenClient(options: VoiceTokenClientOptions): VoiceTokenClient {
  const now = options.now ?? Date.now;
  const minLife = options.minLifeMs ?? VOICE_TOKEN_MIN_LIFE_MS;
  let state: VoiceState = { status: 'unknown' };
  let spare: Spare | null = null;
  let checking: Promise<VoiceState> | null = null;
  const listeners = new Set<() => void>();

  const set = (next: VoiceState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const fail = (code: string): VoiceTokenError => {
    const error = new VoiceTokenError(code);
    // A connection problem says nothing about the voice; keep the last real answer on screen.
    if (error.problem !== 'offline' || state.status === 'unknown' || state.status === 'checking') {
      set({ status: 'problem', problem: error.problem, code: error.code, words: error.message, at: now() });
    }
    if (error.problem === 'not_paired') {
      spare = null;
      options.onNotPaired?.();
    }
    return error;
  };

  /** One mint: a token, or a VoiceTokenError. */
  const mintOnce = async (): Promise<{ token: string; endsAt: number }> => {
    let row: VoiceTokenRow;
    try {
      row = await options.mint(options.purpose);
    } catch (error) {
      const kind = callErrorKind(error);
      throw fail(kind === 'disconnected' || kind === 'unknown_result' ? VOICE_OFFLINE : 'voice_check_failed');
    }
    const receivedAt = now();
    if (row && typeof row.token === 'string' && row.token !== '' && (row.error === '' || row.error === undefined)) {
      set({ status: 'ready', at: receivedAt });
      return { token: row.token, endsAt: expiryOf(row, receivedAt) };
    }
    throw fail(row && typeof row.error === 'string' && row.error !== '' ? row.error : 'voice_bad_response');
  };

  return {
    purpose: options.purpose,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    check() {
      if (checking) return checking;
      set({ status: 'checking' });
      checking = mintOnce()
        .then(
          (minted) => {
            spare = { token: minted.token, endsAt: minted.endsAt };
            return state;
          },
          () => state,
        )
        .finally(() => {
          checking = null;
        });
      return checking;
    },
    async getToken() {
      const held = spare;
      spare = null;
      if (held && held.endsAt - now() >= minLife) return held.token;
      const minted = await mintOnce();
      // A token minted just now is used even if the clocks disagree about its expiry.
      return minted.token;
    },
    clear() {
      spare = null;
    },
  };
}

/** The mint through a role connection's current DbConnection; a DisconnectedError when there is none. */
export function mintVia(getConn: () => { procedures: { mintVoiceToken(args: { purpose: string }): Promise<VoiceTokenRow> } } | null): MintFn {
  return async (purpose) => {
    const conn = getConn();
    if (!conn) throw notConnectedError();
    return conn.procedures.mintVoiceToken({ purpose });
  };
}
