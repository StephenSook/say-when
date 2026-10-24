// Server entry: holds the API key. Token minting, the pronunciation dictionary, library voices and the CALL stretch.
// Never bundle this into a browser page.

import { appendFileSync } from 'node:fs';

import {
    appendHoldRecord,
    appendToDoNotCallFile,
    CallConfigError,
    DEFAULT_ERRAND_TITLES,
    Dialer,
    loadCallLists,
    readHoldFile,
    type DialerDeps,
} from './call.js';
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
 * A Dialer configured from the environment. Holds are read from and written to CALL_HOLD_FILE (trimmed, the same path
 * for both), which is required and must be writable, so a hold survives a restart and counts for every dialer that
 * uses the same file. Numbers added with optOut() go to CALL_DO_NOT_CALL_FILE when it is set. The agent script always
 * comes from cartesia/agent/; CALL_ERRAND_TITLES is a comma-separated list of approved titles.
 */
export function dialerFromEnv(env: Readonly<Record<string, string | undefined>> = process.env, deps: DialerDeps = {}): Dialer {
    const doNotCallFile = env.CALL_DO_NOT_CALL_FILE;
    const holdFile = env.CALL_HOLD_FILE?.trim();
    if (!holdFile) throw new CallConfigError('CALL_HOLD_FILE is needed, so a hold on a contact survives a restart.');
    const apiKey = apiKeyFromEnv(env);
    try {
        // Creates the file, owner-only, if it is missing; appends nothing.
        appendFileSync(holdFile, '', { encoding: 'utf8', mode: 0o600 });
    } catch {
        throw new CallConfigError('CALL_HOLD_FILE cannot be written, so no call can be placed.');
    }
    const titles = (env.CALL_ERRAND_TITLES ?? '')
        .split(',')
        .map((title) => title.trim())
        .filter(Boolean);
    return new Dialer(
        {
            apiKey,
            agentId: env.CARTESIA_AGENT_ID ?? '',
            fromNumberId: env.CARTESIA_FROM_NUMBER_ID ?? '',
            callbackNumber: env.CALL_CALLBACK_NUMBER ?? '',
            personName: env.CALL_PERSON_NAME ?? '',
            errandTitles: titles.length > 0 ? titles : DEFAULT_ERRAND_TITLES,
        },
        loadCallLists({ ...env, CALL_HOLD_FILE: holdFile }),
        {
            ...deps,
            onDoNotCall: deps.onDoNotCall ?? (doNotCallFile ? (number) => appendToDoNotCallFile(doNotCallFile, number) : undefined),
            saveHold: deps.saveHold ?? ((record) => appendHoldRecord(holdFile, record)),
            readHolds: deps.readHolds ?? (() => readHoldFile(holdFile)),
        },
    );
}
