// The pg pool to Tiger: pinned TLS, short timeouts, one connection, and no crash on a dropped socket.
import pg from 'pg';

import { loadTarget, redact, safeMessage, type LoadTargetOptions, type PgTarget } from './credentials.js';
import type { Logger } from './log.js';
import { loadPin, pinnedSsl, type LoadedPin, type PinnedSslOptions } from './tls.js';

export interface TigerConnection {
    readonly pool: pg.Pool;
    /** Removes the password and connection string from any text. */
    redact(text: string): string;
    /** An error as one safe line. */
    describe(error: unknown): string;
    /** Whether the last handshake presented the leaf recorded in certs/tiger-pin.json (null before any handshake). */
    leafMatchesPin(): boolean | null;
    close(): Promise<void>;
}

export interface ConnectOptions extends LoadTargetOptions {
    log: Logger;
    /** Pool size. The free service has about 25 slots, most of them reserved; the writer needs one. */
    max?: number;
    statementTimeoutMs?: number;
    applicationName?: string;
    certDir?: URL;
    pinLeaf?: boolean;
}

export function poolConfig(target: PgTarget, ssl: pg.PoolConfig['ssl'], options: Pick<ConnectOptions, 'max' | 'statementTimeoutMs' | 'applicationName'>): pg.PoolConfig {
    const statementTimeout = options.statementTimeoutMs ?? 10_000;
    return {
        host: target.host,
        port: target.port,
        user: target.user,
        password: target.password,
        database: target.database,
        ssl,
        max: options.max ?? 1,
        connectionTimeoutMillis: 8_000,
        idleTimeoutMillis: 30_000,
        statement_timeout: statementTimeout,
        query_timeout: statementTimeout + 2_000,
        application_name: options.applicationName ?? 'neurolingo-telemetry',
        keepAlive: true,
        // Carries Tiger's server-enforced read-only switch when the target asks for it (credentials.ts).
        ...(target.options ? { options: target.options } : {}),
    };
}

/** Opens the pool lazily (no connection until the first query). Throws a safe error if the pin cannot be used. */
export async function connectTiger(options: ConnectOptions): Promise<TigerConnection> {
    const { target, secrets } = await loadTarget(options);
    const scrub = (text: string) => redact(text, secrets);
    let pin: LoadedPin;
    try {
        pin = loadPin(options.certDir);
    } catch (error) {
        throw new Error(scrub((error as Error).message));
    }
    let leafMatches: boolean | null = null;
    let warnedLeaf = false;
    const sslOptions: PinnedSslOptions = {
        pinLeaf: options.pinLeaf ?? process.env.TIGER_PIN_LEAF === '1',
        onLeaf: (_leaf, matches) => {
            leafMatches = matches;
            if (!matches && !warnedLeaf) {
                warnedLeaf = true;
                options.log.warn('the Tiger leaf certificate differs from the recorded one; the chain and host checks still passed', {});
            }
        },
    };
    let ssl: ReturnType<typeof pinnedSsl>;
    try {
        ssl = pinnedSsl(target, pin, sslOptions);
    } catch (error) {
        throw new Error(scrub((error as Error).message));
    }
    const pool = new pg.Pool(poolConfig(target, ssl, options));
    // An idle client that loses its socket emits 'error' on the pool; without a listener that would end the process.
    pool.on('error', (error) => {
        options.log.warn('an idle Tiger connection failed', { error: safeMessage(error, secrets) });
    });
    return {
        pool,
        redact: scrub,
        describe: (error) => safeMessage(error, secrets),
        leafMatchesPin: () => leafMatches,
        close: async () => {
            try {
                await pool.end();
            } catch {
                // Already closed.
            }
        },
    };
}
