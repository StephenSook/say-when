// Server entry: holds the API key. Token minting, the pronunciation dictionary, library voices and the CALL stretch.
// Never bundle this into a browser page.

import { appendToDoNotCallFile, DEFAULT_ERRAND_TITLES, Dialer, loadCallLists, type DialerDeps } from './call.js';
import { CartesiaConfigError } from './http.js';

export * from './index.js';
export * from './call.js';
export * from './call-script.js';
export * from './dictionary.js';
export * from './phone.js';
export * from './voices.js';

/** The API key from the environment. Never logged. */
export function apiKeyFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): string {
    const key = env.CARTESIA_API_KEY?.trim();
    if (!key) throw new CartesiaConfigError('CARTESIA_API_KEY is not set.');
    return key;
}

/**
 * A Dialer configured from the environment, with opt-outs written to CALL_DO_NOT_CALL_FILE when it is set.
 * The agent script always comes from cartesia/agent/; CALL_ERRAND_TITLES is a comma-separated list of approved titles.
 */
export function dialerFromEnv(env: Readonly<Record<string, string | undefined>> = process.env, deps: DialerDeps = {}): Dialer {
    const doNotCallFile = env.CALL_DO_NOT_CALL_FILE;
    const titles = (env.CALL_ERRAND_TITLES ?? '')
        .split(',')
        .map((title) => title.trim())
        .filter(Boolean);
    return new Dialer(
        {
            apiKey: apiKeyFromEnv(env),
            agentId: env.CARTESIA_AGENT_ID ?? '',
            fromNumberId: env.CARTESIA_FROM_NUMBER_ID ?? '',
            callbackNumber: env.CALL_CALLBACK_NUMBER ?? '',
            personName: env.CALL_PERSON_NAME ?? '',
            errandTitles: titles.length > 0 ? titles : DEFAULT_ERRAND_TITLES,
        },
        loadCallLists(env),
        {
            ...deps,
            onDoNotCall: deps.onDoNotCall ?? (doNotCallFile ? (number) => appendToDoNotCallFile(doNotCallFile, number) : undefined),
        },
    );
}
