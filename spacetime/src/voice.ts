// Short-lived Cartesia access tokens for paired browsers (docs/spacetime.md 6.1, D12 item 5).
//
// `buildMintRequest` and `parseMintResponse` are copies of the pure functions in `cartesia/src/token.ts`, so the
// module bundle has no file dependency on another package. `src/tests/voice.test.ts` compares the request this
// file builds with the one `cartesia` builds, so the two cannot drift apart silently.
import { TimeDuration } from 'spacetimedb';
import type { ProcedureCtx } from 'spacetimedb/server';
import type { Schema } from './ctx';
import type { VoiceToken } from './schema';

export const CARTESIA_API_BASE = 'https://api.cartesia.ai';
export const CARTESIA_VERSION = '2026-08-14';
export const TOKEN_SECONDS = 60;
const MAX_TOKEN_SECONDS = 3600;

export type TokenPurpose = 'tts' | 'stt';

export interface MintRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  purpose: TokenPurpose;
  expiresInSeconds: number;
}

/** POST /access-token with exactly one grant; nothing ever gets the agent grant. Throws on bad input. */
export function buildMintRequest(apiKey: string, purpose: TokenPurpose, expiresInSeconds: number = TOKEN_SECONDS): MintRequest {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') throw new Error('CARTESIA_API_KEY is not set.');
  if (purpose !== 'tts' && purpose !== 'stt') throw new Error('A token is for tts or stt.');
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > MAX_TOKEN_SECONDS) {
    throw new Error(`expiresInSeconds must be a whole number from 1 to ${MAX_TOKEN_SECONDS}.`);
  }
  return {
    url: `${CARTESIA_API_BASE}/access-token`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      'Cartesia-Version': CARTESIA_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grants: { tts: purpose === 'tts', stt: purpose === 'stt', agent: false },
      expires_in: expiresInSeconds,
    }),
    purpose,
    expiresInSeconds,
  };
}

/** Reads `{ token }` from a 2xx answer. Errors are codes: never the key, the token or the body. */
export function parseMintResponse(
  request: Pick<MintRequest, 'purpose' | 'expiresInSeconds'>,
  status: number,
  bodyText: string,
  requestedAtMs: number,
): { token: string; purpose: TokenPurpose; expiresAt: number } {
  if (status < 200 || status >= 300) throw new Error(`voice_service_${status}`);
  let data: unknown;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error('voice_bad_response');
  }
  const token = data && typeof data === 'object' ? (data as { token?: unknown }).token : undefined;
  if (typeof token !== 'string' || token === '') throw new Error('voice_bad_response');
  return { token, purpose: request.purpose, expiresAt: requestedAtMs + request.expiresInSeconds * 1000 };
}

export function tokenError(code: string): VoiceToken {
  return { token: '', expiresAtMs: 0n, error: code };
}

/**
 * Sends one mint request with the procedure's synchronous `ctx.http.fetch` (outside any transaction) and returns
 * a token or an error code. Never throws.
 */
export function mintWithKey(ctx: ProcedureCtx<Schema>, apiKey: string, purpose: TokenPurpose): VoiceToken {
  let request: MintRequest;
  try {
    request = buildMintRequest(apiKey, purpose, TOKEN_SECONDS);
  } catch {
    return tokenError('voice_key_missing');
  }
  const requestedAtMs = Number(ctx.timestamp.toMillis());
  let status: number;
  let text: string;
  try {
    const res = ctx.http.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      timeout: TimeDuration.fromMillis(5000),
    });
    status = res.status;
    text = res.text();
  } catch {
    return tokenError('voice_service_unreachable');
  }
  try {
    const minted = parseMintResponse(request, status, text, requestedAtMs);
    return { token: minted.token, expiresAtMs: BigInt(minted.expiresAt), error: '' };
  } catch (e) {
    const code = e instanceof Error && /^voice_[a-z0-9_]+$/.test(e.message) ? e.message : 'voice_bad_response';
    return tokenError(code);
  }
}
