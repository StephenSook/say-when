// Where the Tiger connection string comes from, and how it never leaks.
//
// The rule (strict): a password, or a connection string that contains one, is never printed, logged, written to
// disk or committed. At run time the string comes from TIGER_DATABASE_URL if that is set, otherwise from
// `tiger db connection-string <service> --with-password`, run as a child process whose output stays in memory.
// Every error that could carry it goes through `redact` first.
import { execFile } from 'node:child_process';

/** The free Tiger Cloud service created for Eleven telemetry (an id, not a secret). */
export const DEFAULT_SERVICE_ID = 'ipx9051gbc';

/** What the pg client needs. Holds the password: never log or serialize this object. */
export interface PgTarget {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly password: string;
    readonly database: string;
    /**
     * The URL's `options` startup parameter, kept because Tiger's read-only connection strings carry their
     * read-only switch there (`-c tsdb_admin.read_only_connection=true`). Null when the URL has none.
     */
    readonly options: string | null;
}

export interface LoadedTarget {
    readonly target: PgTarget;
    /** Everything `redact` must remove: the password, its encoded form and the whole connection string. */
    readonly secrets: readonly string[];
    readonly source: 'env' | 'tiger-cli';
}

export class CredentialError extends Error {
    override readonly name = 'CredentialError';
}

/** Runs a program and returns its stdout. Injected in tests; the default is `execFile`. */
export type Runner = (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;

// Greedy to the last `@` of the token, so a raw `@` inside a password cannot leave a tail of it behind.
const PG_URL_PASSWORD = /(postgres(?:ql)?:\/\/[^:/?#@\s]*):\S*@/gi;
// `password=`, `PGPASSWORD=`, `"password": ` and the like. A quoted value is removed whole, through backslash or
// doubled-quote escapes; an unterminated quote runs to the end of the text, so a value can never be cut short.
const PASSWORD_SETTING = /(\b(?:pg)?pass(?:word|wd)?["']?\s*[=:]\s*)(?:'(?:[^'\\]|\\[\s\S]|'')*'?|"(?:[^"\\]|\\[\s\S]|"")*"?|\S+)/gi;

/**
 * Removes every secret from a piece of text: each known secret (and its URL-encoded form), the password part of any
 * postgres URL even when the secret is not known, and any `password=` or `password:` value. Use it on every error
 * message that leaves this package.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
    let out = text;
    // Longest first, so the whole connection string is replaced before its password inside it.
    const sorted = [...new Set(secrets.filter((s) => s.length > 0))].sort((a, b) => b.length - a.length);
    for (const secret of sorted) {
        out = out.split(secret).join('[redacted]');
        const encoded = encodeURIComponent(secret);
        if (encoded !== secret) out = out.split(encoded).join('[redacted]');
    }
    return out.replace(PG_URL_PASSWORD, '$1:[redacted]@').replace(PASSWORD_SETTING, '$1[redacted]');
}

/** An error's message, redacted, for logs and thrown errors. */
export function safeMessage(error: unknown, secrets: readonly string[] = []): string {
    const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return redact(raw, secrets).slice(0, 500);
}

function decode(part: string): string {
    try {
        return decodeURIComponent(part);
    } catch {
        return part;
    }
}

/** `-c name=value` settings only, such as Tiger's read-only switch. */
const OPTIONS_RE = /^(?:-c [a-z_][a-z0-9_.]*=[A-Za-z0-9_.:-]+)(?: -c [a-z_][a-z0-9_.]*=[A-Za-z0-9_.:-]+)*$/;

/**
 * Splits a postgres URL into the pg client's fields. `sslmode` is ignored on purpose: this package sets its own
 * TLS (src/tls.ts) and never lets the URL weaken it. `options` is kept (it is how a Tiger read-only string stays
 * read-only); any other query parameter is refused rather than silently dropped. Errors never echo the URL.
 */
export function parseConnectionString(url: string): PgTarget {
    let parsed: URL;
    try {
        parsed = new URL(url.trim());
    } catch {
        throw new CredentialError('The Tiger connection string could not be parsed (its text is not shown).');
    }
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
        throw new CredentialError('The Tiger connection string must start with postgres:// or postgresql://.');
    }
    const host = parsed.hostname;
    const user = decode(parsed.username);
    const password = decode(parsed.password);
    const database = decode(parsed.pathname.replace(/^\//, '')) || 'tsdb';
    const port = parsed.port ? Number(parsed.port) : 5432;
    if (!host) throw new CredentialError('The Tiger connection string has no host.');
    if (!user) throw new CredentialError('The Tiger connection string has no user.');
    if (!password) {
        throw new CredentialError(
            'The Tiger connection string has no password. Set TIGER_DATABASE_URL with one, or let this package ask the Tiger CLI (`tiger db connection-string --with-password`).',
        );
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CredentialError('The Tiger connection string has a bad port.');
    for (const key of parsed.searchParams.keys()) {
        if (key !== 'sslmode' && key !== 'options') {
            throw new CredentialError(`The Tiger connection string has a parameter this package does not apply (${key.replace(/[^a-z_]/gi, '').slice(0, 30)}).`);
        }
    }
    const options = parsed.searchParams.get('options');
    if (options !== null && !OPTIONS_RE.test(options)) {
        throw new CredentialError('The Tiger connection string has an options value this package does not accept (only -c name=value settings).');
    }
    return { host, port, user, password, database, options };
}

const defaultRunner: Runner = (file, args) =>
    new Promise((resolve, reject) => {
        execFile(file, [...args], { timeout: 20_000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout, stderr) => {
            if (error) {
                // Neither stdout (it may hold the connection string) nor stderr travels with the error; only the code.
                // A number is the exit code; a string such as ENOENT means the program could not start.
                const code = (error as { code?: unknown }).code;
                const exitCode = typeof code === 'number' || typeof code === 'string' ? code : null;
                reject(Object.assign(new Error('tiger CLI failed'), { exitCode }));
                return;
            }
            resolve({ stdout: String(stdout), stderr: String(stderr) });
        });
    });

export interface LoadTargetOptions {
    env?: NodeJS.ProcessEnv;
    serviceId?: string;
    run?: Runner;
    /**
     * Open the session in Tiger's server-enforced read-only mode (writes and DDL refused by the server). Used by
     * the stats path; also forced by TIGER_READ_ONLY=1.
     */
    readOnly?: boolean;
}

/** Tiger's read-only startup switch, as `tiger db connection-string --read-only` prints it. */
export const TIGER_READ_ONLY_OPTION = '-c tsdb_admin.read_only_connection=true';

function withReadOnly(target: PgTarget): PgTarget {
    if (target.options?.includes(TIGER_READ_ONLY_OPTION)) return target;
    return { ...target, options: target.options ? `${target.options} ${TIGER_READ_ONLY_OPTION}` : TIGER_READ_ONLY_OPTION };
}

/** The connection target, from TIGER_DATABASE_URL or the Tiger CLI. The string itself is dropped after parsing. */
export async function loadTarget(options: LoadTargetOptions = {}): Promise<LoadedTarget> {
    const env = options.env ?? process.env;
    const readOnly = options.readOnly === true || env.TIGER_READ_ONLY === '1';
    const fromEnv = env.TIGER_DATABASE_URL?.trim();
    if (fromEnv) {
        const parsed = parseConnectionString(fromEnv);
        return { target: readOnly ? withReadOnly(parsed) : parsed, secrets: [fromEnv, parsed.password], source: 'env' };
    }
    const serviceId = options.serviceId ?? env.TIGER_SERVICE_ID?.trim() ?? DEFAULT_SERVICE_ID;
    if (!/^[a-z0-9]{1,32}$/.test(serviceId)) throw new CredentialError('TIGER_SERVICE_ID must be a Tiger service id such as ipx9051gbc.');
    const cli = env.TIGER_CLI?.trim() || 'tiger';
    const run = options.run ?? defaultRunner;
    let stdout: string;
    try {
        const args = ['db', 'connection-string', serviceId, '--with-password', '--skip-update-check'];
        if (readOnly) args.push('--read-only');
        ({ stdout } = await run(cli, args));
    } catch (error) {
        // The CLI's own output is never repeated: at this point the secrets are not known, so nothing could be
        // redacted reliably. Only a checked exit code and fixed guidance leave this function.
        const code = (error as { exitCode?: unknown }).exitCode;
        const exit = typeof code === 'number' && Number.isInteger(code) ? String(code) : typeof code === 'string' && /^[A-Z_]{1,20}$/.test(code) ? code : 'unknown';
        throw new CredentialError(
            `Could not get the Tiger connection string from the Tiger CLI (${cli.replace(/[^\w./-]/g, '')}, exit ${exit}). ` +
                `Check \`tiger auth status\` and that service ${serviceId} exists, run the same command by hand to see its message, or set TIGER_DATABASE_URL.`,
        );
    }
    const line = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => /^postgres(ql)?:\/\//i.test(l));
    if (!line) throw new CredentialError('The Tiger CLI did not print a postgres connection string (its output is not shown).');
    const parsed = parseConnectionString(line);
    return { target: readOnly ? withReadOnly(parsed) : parsed, secrets: [line, parsed.password], source: 'tiger-cli' };
}
