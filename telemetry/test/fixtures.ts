// Scenario builder for tests: emits the rows the SpacetimeDB module writes (docs/spacetime.md 2.6, 2.7, 2.9, 3.4,
// 3.10), as FakeEvents with explicit server times, so every test is deterministic. `start` brings a live station;
// `tick` is the station's heartbeat refreshing its device_status row (about every 2 s in the module).
import type { FakeEvent } from '../src/sources/fake.js';
import { popcount, type ActionIn, type DeviceIn, type LedgerIn, type Micros, type ScanIn, type TelemetryRow } from '../src/types.js';

export const STATION = 'c0ffee';

/** A minute-aligned base time (1761300000 s is a multiple of 60), in microseconds. */
export const BASE: Micros = 1_761_300_000_000_000n;
/** BASE plus `s` seconds. */
export const sec = (s: number): Micros => BASE + BigInt(Math.round(s * 1_000_000));

export class Scenario {
    readonly events: FakeEvent[] = [];
    private ledgerId: bigint;
    private stepSeq = 0n;
    private scanState: ScanIn;
    private gestureN = 0;

    /**
     * `stationId` is the station this session's `start` and `tick` report; `ledgerBase` offsets ledger ids, which are
     * global in the module, so two scenarios played together never collide.
     */
    constructor(
        readonly sessionId: bigint = 1n,
        readonly stationId: string = STATION,
        ledgerBase = 0n,
    ) {
        this.ledgerId = ledgerBase;
        this.scanState = {
            sessionId,
            questionId: 0n,
            phase: 'idle',
            mode: 'answer',
            answerMode: 'pick',
            cursor: 0,
            optionCount: 0,
            pass: 0,
            stepSeq: 0n,
            stepStartedAt: 0n,
            stepEndsAt: 0n,
            outcome: null,
            pauseReason: null,
            updatedAt: 0n,
        };
    }

    get step(): bigint {
        return this.stepSeq;
    }

    ledger(at: Micros, kind: string, fields: Partial<LedgerIn> = {}): LedgerIn {
        this.ledgerId += 1n;
        const row: LedgerIn = {
            id: this.ledgerId,
            sessionId: this.sessionId,
            at,
            kind,
            questionId: 0n,
            optionId: 0n,
            errandId: 0n,
            callId: 0n,
            gestureId: '',
            command: '',
            stepSeq: 0n,
            cursor: 0,
            outcome: '',
            reason: '',
            ms: 0,
            ...fields,
        };
        this.events.push({ type: 'ledger', row });
        return row;
    }

    scan(at: Micros, patch: Partial<ScanIn>, bump = true): ScanIn {
        if (bump) this.stepSeq += 1n;
        this.scanState = { ...this.scanState, stepStartedAt: at, stepEndsAt: at, ...patch, stepSeq: this.stepSeq, updatedAt: at };
        this.events.push({ type: 'scan', row: this.scanState });
        return this.scanState;
    }

    /** `healthy: null` is a station that has not reported decoder health yet (before its first heartbeat). */
    start(at: Micros, healthy: boolean | null = true): this {
        this.station(at, true, healthy);
        this.ledger(at, 'session_start', { outcome: 'demo' });
        this.scanState = { ...this.scanState, stepStartedAt: at, stepEndsAt: at, updatedAt: at };
        this.events.push({ type: 'scan', row: this.scanState });
        return this;
    }

    /** The station's device_status row: online, decoder health, last seen. */
    station(at: Micros, online: boolean, healthy: boolean | null = true, id = this.stationId): this {
        const row: DeviceIn = { id, role: 'station', online, decoderHealthy: healthy, lastSeenAt: at };
        this.events.push({ type: 'device', row });
        return this;
    }

    /** Another device's row (a partner phone): a server clock tick with no station state. */
    partnerTick(at: Micros): this {
        this.events.push({ type: 'device', row: { id: 'beef01', role: 'partner', online: true, decoderHealthy: null, lastSeenAt: at } });
        return this;
    }

    preparing(at: Micros, questionId: bigint): this {
        this.scan(at, { phase: 'preparing', questionId, cursor: 0, pass: 0, outcome: null, pauseReason: null });
        return this;
    }

    /** enterReading: a `step` ledger row and the scan row, one transaction. */
    read(at: Micros, questionId: bigint, cursor: number, opts: { optionCount?: number; answerMode?: string; dwellS?: number } = {}): this {
        this.stepSeq += 1n;
        this.ledger(at, 'step', { questionId, stepSeq: this.stepSeq, cursor, outcome: 'reading', ms: Math.round((opts.dwellS ?? 2) * 1000) });
        this.scanState = {
            ...this.scanState,
            phase: 'reading',
            questionId,
            cursor,
            optionCount: opts.optionCount ?? 4,
            answerMode: opts.answerMode ?? this.scanState.answerMode,
            pass: Math.max(1, this.scanState.pass),
            stepSeq: this.stepSeq,
            stepStartedAt: at,
            stepEndsAt: at + BigInt(Math.round((opts.dwellS ?? 2) * 1_000_000)),
            outcome: null,
            pauseReason: null,
            updatedAt: at,
        };
        this.events.push({ type: 'scan', row: this.scanState });
        return this;
    }

    window(at: Micros, windowS = 3.5): this {
        this.scan(at, { phase: 'window', stepEndsAt: at + BigInt(Math.round(windowS * 1_000_000)) });
        return this;
    }

    idle(at: Micros, outcome: string | null = null): this {
        this.scan(at, { phase: 'idle', outcome, pauseReason: null });
        return this;
    }

    veto(at: Micros): this {
        this.scan(at, { phase: 'veto' });
        return this;
    }

    pause(at: Micros, reason: string): this {
        this.scan(at, { phase: 'paused', pauseReason: reason });
        return this;
    }

    gesture(
        at: Micros,
        command: string,
        outcome: string,
        opts: { heard?: bigint; questionId?: bigint; optionId?: bigint; cursor?: number; ms?: number; gestureId?: string } = {},
    ): LedgerIn {
        this.gestureN += 1;
        const sep = outcome.indexOf(':');
        return this.ledger(at, 'gesture', {
            gestureId: opts.gestureId ?? `g-${this.sessionId}-${this.gestureN}`,
            command,
            outcome,
            reason: outcome.startsWith('ignored:') ? outcome.slice(sep + 1) : '',
            stepSeq: opts.heard ?? this.stepSeq,
            questionId: opts.questionId ?? 0n,
            optionId: opts.optionId ?? 0n,
            cursor: opts.cursor ?? 0,
            ms: opts.ms ?? 0,
        });
    }

    /**
     * The module's `pick` ledger row. It shares its gesture id with the gesture row of the same transaction; by
     * default that is the id the next `gesture` call will get, since the module writes the pick row first.
     */
    pick(at: Micros, questionId: bigint, cursor: number, kind: string, lateMs = 0, gestureId?: string): LedgerIn {
        return this.ledger(at, 'pick', {
            questionId,
            optionId: 100n + BigInt(cursor),
            gestureId: gestureId ?? `g-${this.sessionId}-${this.gestureN + 1}`,
            stepSeq: this.stepSeq,
            cursor,
            outcome: kind,
            ms: lateMs,
        });
    }

    errand(at: Micros, id: bigint, status: string, statusAt: Micros = at): this {
        const row: ActionIn = { kind: 'errand', id, sessionId: this.sessionId, status, result: '', updatedAt: at, statusAt };
        this.events.push({ type: 'action', row });
        return this;
    }

    call(at: Micros, id: bigint, status: string, result = ''): this {
        const row: ActionIn = { kind: 'call', id, sessionId: this.sessionId, status, result, updatedAt: at, statusAt: at };
        this.events.push({ type: 'action', row });
        return this;
    }

    /** The station's heartbeat refreshing its device_status row. */
    tick(at: Micros): this {
        return this.station(at, true, true);
    }

    /**
     * A live, healthy station between two times (seconds from BASE): its device_status row every 2 s, as the module
     * refreshes it, ending exactly at `toS`. Interleave with other rows in time order.
     */
    beat(fromS: number, toS: number, everyS = 2): this {
        for (let t = fromS; t < toS; t += everyS) this.tick(sec(t));
        return this.tick(sec(toS));
    }

    ready(): this {
        this.events.push({ type: 'ready' });
        return this;
    }

    lost(): this {
        this.events.push({ type: 'lost' });
        return this;
    }

    end(at: Micros): this {
        this.ledger(at, 'session_end');
        this.scan(at, { phase: 'idle', questionId: this.scanState.questionId });
        return this;
    }
}

/** Rows of one table from a list of emitted rows. */
type RowByTable = { [K in TelemetryRow['table']]: Extract<TelemetryRow, { table: K }>['row'] };

export function rowsOf<T extends keyof RowByTable>(rows: readonly TelemetryRow[], table: T): Array<RowByTable[T]> {
    const out: Array<RowByTable[T]> = [];
    for (const r of rows) if (r.table === table) out.push(r.row as RowByTable[T]);
    return out;
}

/** Rest in ms, merging every emission of a minute with OR, as the database's upsert does. */
export function restTotalMs(rows: readonly TelemetryRow[]): number {
    const byMinute = new Map<string, bigint>();
    for (const r of rowsOf(rows, 'rest_minutes')) {
        const k = `${r.sessionId}|${r.time}`;
        byMinute.set(k, (byMinute.get(k) ?? 0n) | r.restMask);
    }
    return [...byMinute.values()].reduce((a, m) => a + popcount(m) * 1000, 0);
}

/** Rest seconds as offsets from BASE, from the merged masks (for exact assertions). */
export function restSeconds(rows: readonly TelemetryRow[]): number[] {
    const out = new Set<number>();
    for (const r of rowsOf(rows, 'rest_minutes')) {
        const minuteS = Number((r.time - BASE) / 1_000_000n);
        for (let k = 0; k < 60; k++) if ((r.restMask >> BigInt(k)) & 1n) out.add(minuteS + k);
    }
    return [...out].sort((a, b) => a - b);
}
