// A tiny structured logger. Callers pass only content-free fields; errors are redacted before they get here.
export interface Logger {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
}

function line(level: string, message: string, fields?: Record<string, unknown>): string {
    const extra = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}` : '';
    return `${new Date().toISOString()} ${level} telemetry: ${message}${extra}`;
}

export const consoleLogger: Logger = {
    info: (message, fields) => console.log(line('info', message, fields)),
    warn: (message, fields) => console.warn(line('warn', message, fields)),
    error: (message, fields) => console.error(line('error', message, fields)),
};

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** Collects log lines in memory, for tests. */
export function memoryLogger(): Logger & { lines: string[] } {
    const lines: string[] = [];
    const push = (level: string) => (message: string, fields?: Record<string, unknown>) => {
        lines.push(line(level, message, fields));
    };
    return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}
