// A small logger for the operator's terminal. Messages are fixed phrases written in this package; fields are
// ids, codes, counts and durations. Never pass question text, option text, memory text, form values, read-back
// text, names, phone numbers, URLs with secrets, tokens or keys. test/privacy.test.ts runs every flow with a
// recording logger and checks that none of that content shows up.

export type LogValue = string | number | boolean | bigint | null | undefined;
export type LogFields = Record<string, LogValue>;

export interface Logger {
    info(message: string, fields?: LogFields): void;
    warn(message: string, fields?: LogFields): void;
    error(message: string, fields?: LogFields): void;
}

function render(fields: LogFields | undefined): string {
    if (!fields) return '';
    const parts: string[] = [];
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        parts.push(`${key}=${typeof value === 'bigint' ? value.toString() : String(value)}`);
    }
    return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

/** Writes one line per entry to stderr, so stdout stays free for the `pair` and `check` commands. */
export function consoleLogger(prefix = 'neurolingo-agent'): Logger {
    const line = (level: string, message: string, fields?: LogFields) => {
        process.stderr.write(`${new Date().toISOString()} ${prefix} ${level} ${message}${render(fields)}\n`);
    };
    return {
        info: (message, fields) => line('info', message, fields),
        warn: (message, fields) => line('warn', message, fields),
        error: (message, fields) => line('error', message, fields),
    };
}

/** Keeps every entry in memory. Used by the tests. */
export interface RecordingLogger extends Logger {
    readonly entries: { level: 'info' | 'warn' | 'error'; message: string; fields: LogFields }[];
    text(): string;
}

export function recordingLogger(): RecordingLogger {
    const entries: RecordingLogger['entries'] = [];
    const add = (level: 'info' | 'warn' | 'error') => (message: string, fields: LogFields = {}) => {
        entries.push({ level, message, fields });
    };
    return {
        entries,
        info: add('info'),
        warn: add('warn'),
        error: add('error'),
        text: () => entries.map((entry) => `${entry.level} ${entry.message}${render(entry.fields)}`).join('\n'),
    };
}

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
