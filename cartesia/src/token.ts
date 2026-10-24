// Server side: mints short-lived access tokens so browsers never hold the API key.
// buildMintRequest and parseMintResponse are pure, so a SpacetimeDB procedure can send the request with its own
// ctx.http.fetch (which is synchronous) and the agent sidecar can use mintAccessToken with Node's fetch.

import { CARTESIA_API_BASE, CARTESIA_VERSION } from './constants.js';
import { httpError, send, type FetchLike, type HttpRequest } from './http.js';

export type TokenPurpose = 'tts' | 'stt';

export const DEFAULT_TOKEN_SECONDS = 60;
/** The access token reference: "The maximum is 1 hour (3600 seconds)." */
export const MAX_TOKEN_SECONDS = 3600;

export class TokenError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TokenError';
    }
}

export interface MintRequest extends HttpRequest {
    method: 'POST';
    body: string;
    purpose: TokenPurpose;
    expiresInSeconds: number;
}

export interface MintedToken {
    token: string;
    purpose: TokenPurpose;
    /** Epoch ms. Counted from just before the request, because the response holds only the token. */
    expiresAt: number;
}

/** POST /access-token with exactly one grant: a phone that only listens gets no TTS grant, and nothing gets the agent grant. */
export function buildMintRequest(apiKey: string, purpose: TokenPurpose, expiresInSeconds: number = DEFAULT_TOKEN_SECONDS): MintRequest {
    if (typeof apiKey !== 'string' || apiKey.trim() === '') throw new TokenError('CARTESIA_API_KEY is not set.');
    if (purpose !== 'tts' && purpose !== 'stt') throw new TokenError('A token is for tts or stt.');
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > MAX_TOKEN_SECONDS) {
        throw new TokenError(`expiresInSeconds must be a whole number from 1 to ${MAX_TOKEN_SECONDS}.`);
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

/** Reads `{ token }` from a 2xx answer. Errors never include the key or the token. */
export function parseMintResponse(
    request: Pick<MintRequest, 'purpose' | 'expiresInSeconds'>,
    status: number,
    bodyText: string,
    requestedAtMs: number,
): MintedToken {
    if (status < 200 || status >= 300) throw httpError(status, bodyText);
    let data: unknown;
    try {
        data = JSON.parse(bodyText);
    } catch {
        throw new TokenError('The token response was not JSON.');
    }
    const token = data && typeof data === 'object' ? (data as { token?: unknown }).token : undefined;
    if (typeof token !== 'string' || token === '') throw new TokenError('The token response had no token.');
    return { token, purpose: request.purpose, expiresAt: requestedAtMs + request.expiresInSeconds * 1000 };
}

/** Builds, sends and reads one mint request. Uses the runtime's fetch unless one is passed in. */
export async function mintAccessToken(
    apiKey: string,
    purpose: TokenPurpose,
    options: { expiresInSeconds?: number; fetch?: FetchLike; now?: () => number; timeoutMs?: number } = {},
): Promise<MintedToken> {
    const request = buildMintRequest(apiKey, purpose, options.expiresInSeconds);
    const requestedAt = (options.now ?? Date.now)();
    const response = await send(request, options.fetch, options.timeoutMs);
    return parseMintResponse(request, response.status, response.text, requestedAt);
}
