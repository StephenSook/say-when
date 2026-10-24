// Test doubles: a manual clock for the writer, and an in-memory sink that can fail on demand.
import type { RowSink } from '../src/sink.js';
import { popcount, type SwitchEventRow, type TableName, type TelemetryRow } from '../src/types.js';
import type { Timers } from '../src/writer.js';
import { sec } from './fixtures.js';

/** Lets pending promise chains (an awaited insert, the flush that follows) run to completion. */
export async function settle(turns = 8): Promise<void> {
    for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
}

export class ManualTimers implements Timers {
    private t = 0;
    private n = 0;
    private queue: Array<{ at: number; fn: () => void; id: number }> = [];

    now(): number {
        return this.t;
    }

    set(fn: () => void, ms: number): unknown {
        const id = ++this.n;
        this.queue.push({ at: this.t + ms, fn, id });
        return id;
    }

    clear(handle: unknown): void {
        this.queue = this.queue.filter((x) => x.id !== handle);
    }

    get pending(): number {
        return this.queue.length;
    }

    /** Moves the clock forward, firing due timers in order and letting each one's async work finish. */
    async advance(ms: number): Promise<void> {
        const end = this.t + ms;
        for (;;) {
            this.queue.sort((a, b) => a.at - b.at || a.id - b.id);
            const next = this.queue[0];
            if (!next || next.at > end) break;
            this.queue.shift();
            this.t = next.at;
            next.fn();
            await settle();
        }
        this.t = end;
        await settle();
    }
}

/** The error a real outage could produce, with a password inside, to prove it never surfaces. */
export const LEAKY_ERROR_TEXT = 'connect ECONNREFUSED postgres://tsdbadmin:Sup3rSecretPw@ipx9051gbc.example:32869/tsdb';

export class MemorySink implements RowSink {
    readonly rows = new Map<TableName, unknown[]>();
    readonly calls: Array<{ table: TableName; count: number }> = [];
    failNext = 0;
    failAlways = false;
    /** When set, every insert into this one table fails (the others succeed). */
    failTable: TableName | null = null;
    /** When set, each insert waits for this before finishing. */
    gate: Promise<void> | null = null;

    async insert(table: TableName, rows: readonly unknown[]): Promise<void> {
        this.calls.push({ table, count: rows.length });
        if (this.gate) await this.gate;
        if (this.failTable === table) throw new Error(LEAKY_ERROR_TEXT);
        if (this.failAlways || this.failNext > 0) {
            if (this.failNext > 0) this.failNext--;
            throw new Error(LEAKY_ERROR_TEXT);
        }
        this.rows.set(table, [...(this.rows.get(table) ?? []), ...rows]);
    }

    count(table: TableName): number {
        return this.rows.get(table)?.length ?? 0;
    }
}

let ledger = 0n;
/** A minimal valid switch event row. */
export function switchRow(n?: number): TelemetryRow {
    ledger += 1n;
    const id = n !== undefined ? BigInt(n) : ledger;
    const row: SwitchEventRow = {
        time: sec(Number(id)),
        sessionId: 'test-unit:1',
        ledgerId: id,
        command: 'YES',
        outcome: 'accepted',
        code: 'pick',
        resting: false,
        falseActivation: false,
        heardStepSeq: 1n,
        optionRank: 1,
        heardIn: 'window',
        latencyMs: 1000,
        lateByMs: 0,
    };
    return { table: 'switch_events', row };
}

/** A rest minute at BASE + `minuteS` with the given seconds (0 to 59) set. */
export function restRow(minuteS: number, seconds: readonly number[], session = 'test-unit:1'): TelemetryRow {
    let restMask = 0n;
    for (const k of seconds) restMask |= 1n << BigInt(k);
    return { table: 'rest_minutes', row: { time: sec(minuteS), sessionId: session, restMask, idleMs: popcount(restMask) * 1000 } };
}
