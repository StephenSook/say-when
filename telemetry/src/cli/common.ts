// Shared CLI plumbing: open the pinned Tiger connection, run, print only safe text, set the exit code.
import { connectTiger, type TigerConnection } from '../db.js';
import { consoleLogger } from '../log.js';

export async function withTiger(name: string, body: (conn: TigerConnection) => Promise<number>, options: { max?: number; readOnly?: boolean } = {}): Promise<void> {
    let conn: TigerConnection | null = null;
    let code = 1;
    try {
        conn = await connectTiger({ log: consoleLogger, max: options.max ?? 1, applicationName: `neurolingo-telemetry-${name}`, readOnly: options.readOnly });
        code = await body(conn);
    } catch (error) {
        // connectTiger and every error after it are redacted; this is the last line of defence.
        const text = conn ? conn.describe(error) : error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        console.error(`telemetry ${name}: ${text.replace(/(postgres(?:ql)?:\/\/[^:/?#@\s]*):[^@\s]*@/gi, '$1:[redacted]@')}`);
        code = 1;
    } finally {
        await conn?.close();
    }
    process.exitCode = code;
}
