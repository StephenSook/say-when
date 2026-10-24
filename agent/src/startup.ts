// What the sidecar prints when it cannot start. An error message from Node or a library can quote a file path
// (`ENOENT: no such file or directory, open '/path/Leonora-...json'`) or a piece of a file (`Unexpected token ...`
// from JSON.parse quotes the text), so only messages written to be shown are printed: this package's own, and the
// sibling packages' configuration errors, which name settings and positions only. Everything else is reported by
// its error code or class name.

import { ConfigError } from '@say-when/apify-client';
import { CallConfigError } from '@say-when/cartesia/server';
import { MossRunError } from '@say-when/moss';

import { FormsFileError } from './forms.js';

/** A startup failure whose message this package wrote: fixed words, setting names and error codes only. */
export class StartupError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'StartupError';
    }
}

const TAG = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** The error's code (ENOENT, EACCES) or its class name, never its message. */
export function errorTag(error: unknown): string {
    const code = error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    if (typeof code === 'string' && TAG.test(code)) return code;
    if (error instanceof Error && TAG.test(error.name)) return error.name;
    return 'Error';
}

/** True for errors whose messages were written to be shown (settings and positions, never values). */
export function hasShowableMessage(error: unknown): error is Error {
    return (
        error instanceof StartupError ||
        error instanceof FormsFileError ||
        error instanceof ConfigError ||
        error instanceof CallConfigError ||
        (error instanceof MossRunError && error.code === 'config')
    );
}

/** The one line printed to stderr when the sidecar cannot start. */
export function startupFailureLine(error: unknown): string {
    if (hasShowableMessage(error) && /^[\x20-\x7e]{1,300}$/.test(error.message)) {
        return `neurolingo-agent failed to start: ${error.message}`;
    }
    return `neurolingo-agent failed to start (${errorTag(error)}). Run npm run check, then see agent/README.md.`;
}
