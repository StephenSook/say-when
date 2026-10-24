// The SpacetimeDB source: an anonymous, read-only subscription to the module's public tables and anonymous views.
//
// It reads exactly what any judge's browser can read, and nothing it reads is content:
//   board_ledger   every ledger row (content-free by design): gestures, picks, reading steps, session start and end
//   scan_state     the public scan clock
//   board_errands  errand status and times (the text columns, filled only while board sharing is on, are never read)
//   board_calls    call status, result and times (the name, read-back and transcript columns are never read)
//   device_status  role, online, decoder health and `last_seen_at` (a server clock tick); the label is never read,
//                  and the identity is held in memory only, to tell devices apart
// It calls no reducer. Telemetry never writes to SpacetimeDB. When the SDK reports it will not retry (a failed first
// connection, a terminal failure, a refused subscription), the source retires the connection and builds a new one.
//
// Written against the spacetimedb 2.13.0 client API (checked in node_modules/spacetimedb/dist/sdk/*.d.ts):
//   DbConnection.builder().withUri().withDatabaseName().withAutomaticReconnect()
//     .onConnect().onAutomaticReconnect().onConnectError().onDisconnect().build()
//   conn.subscriptionBuilder().onApplied().onError().subscribe(queries: string[])
//   conn.db.<accessor>.iter() / onInsert(cb(ctx, row)) / onUpdate(cb(ctx, oldRow, newRow)) / removeOn*()
// The connection type is structural so this library builds without the generated bindings; src/cli/bindings.ts
// passes the generated builder in and checks it, and the row types, against these shapes at compile time.
// test/contract.test.ts checks the names against docs/spacetime.md and the module source.
import type { Logger } from '../log.js';
import type { ActionIn, DeviceIn, LedgerIn, Micros, ScanIn } from '../types.js';
import type { SourceHandlers, TelemetrySource } from './source.js';

export interface ConnectionLike {
    db: Record<string, unknown>;
    subscriptionBuilder(): SubscriptionBuilderLike;
    disconnect(): void;
}

export interface SubscriptionBuilderLike {
    onApplied(callback: (ctx: unknown) => void): SubscriptionBuilderLike;
    onError(callback: (ctx: unknown) => void): SubscriptionBuilderLike;
    subscribe(queries: string[]): unknown;
}

export interface BuilderLike {
    withUri(uri: string): BuilderLike;
    withDatabaseName(name: string): BuilderLike;
    withAutomaticReconnect(options?: { minDelayMs?: number; maxDelayMs?: number }): BuilderLike;
    onConnect(callback: (conn: ConnectionLike, identity: unknown, token: string) => void): BuilderLike;
    onAutomaticReconnect(callback: (conn: ConnectionLike, identity: unknown, token: string) => void): BuilderLike;
    /** `nextReconnectAttempt` is undefined when the SDK will not retry (2.13.0 db_connection_builder.d.ts). */
    onConnectError(callback: (ctx: unknown, error: Error, nextReconnectAttempt?: number, nextReconnectDelayMs?: number) => void): BuilderLike;
    onDisconnect(callback: (ctx: unknown, error?: Error, nextReconnectAttempt?: number, nextReconnectDelayMs?: number) => void): BuilderLike;
    build(): ConnectionLike;
}

type RowCallback = (...args: unknown[]) => void;

interface TableLike {
    iter(): Iterable<unknown>;
    onInsert(callback: RowCallback): void;
    removeOnInsert(callback: RowCallback): void;
    onUpdate?(callback: RowCallback): void;
    removeOnUpdate?(callback: RowCallback): void;
}

/** The public tables and anonymous views telemetry reads (docs/spacetime.md 2.3 and 5), by wire name. */
export const SUBSCRIBED = {
    ledger: 'board_ledger',
    scan: 'scan_state',
    errands: 'board_errands',
    calls: 'board_calls',
    devices: 'device_status',
} as const;

/** snake_case wire name to the generated camelCase accessor (`board_ledger` to `boardLedger`). */
export function camel(wire: string): string {
    return wire.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

// The generated bindings (spacetime/bindings/agent) plug in through `builder` (SpacetimeSourceOptions). They are
// imported statically in src/cli/bindings.ts, which also checks at compile time that the generated connection, the
// five accessors above and every field the normalizers read have the shapes this file expects.

// ---------- Row normalizers: generated rows (camelCase, bigint, Timestamp, { tag }) to telemetry inputs ----------
// Each reads only the fields telemetry uses; text columns are never touched. A missing or mistyped field throws a
// ContractError, which the source counts and logs once, so drift between the bindings and this file is visible.

export class ContractError extends Error {
    override readonly name = 'ContractError';
}

function field(row: Record<string, unknown>, name: string): unknown {
    const value = row[name];
    if (value === undefined) throw new ContractError(`missing field ${name}`);
    return value;
}

export function u64(value: unknown): bigint {
    if (typeof value === 'bigint' && value >= 0n) return value;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
    throw new ContractError('expected a u64');
}

function small(value: unknown): number {
    const n = typeof value === 'bigint' ? Number(value) : value;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0) return n;
    throw new ContractError('expected an unsigned integer');
}

function str(value: unknown): string {
    if (typeof value === 'string') return value;
    throw new ContractError('expected a string');
}

/** A SpacetimeDB Timestamp (2.13.0: `microsSinceUnixEpoch: bigint`) as microseconds. */
export function micros(value: unknown): Micros {
    if (value && typeof value === 'object') {
        const v = (value as { microsSinceUnixEpoch?: unknown }).microsSinceUnixEpoch;
        if (typeof v === 'bigint') return v;
    }
    throw new ContractError('expected a timestamp');
}

function optionalMicros(value: unknown): Micros | null {
    return value === undefined || value === null ? null : micros(value);
}

/** `{ tag: 'AwaitingConfirm' }` to `awaiting_confirm`. */
export function tag(value: unknown): string {
    const raw = value && typeof value === 'object' && 'tag' in value ? (value as { tag: unknown }).tag : undefined;
    if (typeof raw !== 'string') throw new ContractError('expected an enum value');
    return raw.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function optionalTag(value: unknown): string | null {
    return value === undefined || value === null ? null : tag(value);
}

function record(row: unknown): Record<string, unknown> {
    if (!row || typeof row !== 'object') throw new ContractError('expected a row');
    return row as Record<string, unknown>;
}

export function toLedgerIn(raw: unknown): LedgerIn {
    const row = record(raw);
    return {
        id: u64(field(row, 'id')),
        sessionId: u64(field(row, 'sessionId')),
        at: micros(field(row, 'at')),
        kind: str(field(row, 'kind')),
        questionId: u64(field(row, 'questionId')),
        optionId: u64(field(row, 'optionId')),
        errandId: u64(field(row, 'errandId')),
        callId: u64(field(row, 'callId')),
        gestureId: str(field(row, 'gestureId')),
        command: str(field(row, 'command')),
        stepSeq: u64(field(row, 'stepSeq')),
        cursor: small(field(row, 'cursor')),
        outcome: str(field(row, 'outcome')),
        reason: str(field(row, 'reason')),
        ms: small(field(row, 'ms')),
    };
}

export function toScanIn(raw: unknown): ScanIn {
    const row = record(raw);
    return {
        sessionId: u64(field(row, 'sessionId')),
        questionId: u64(field(row, 'questionId')),
        phase: tag(field(row, 'phase')),
        mode: tag(field(row, 'mode')),
        answerMode: tag(field(row, 'answerMode')),
        cursor: small(field(row, 'cursor')),
        optionCount: small(field(row, 'optionCount')),
        pass: small(field(row, 'pass')),
        stepSeq: u64(field(row, 'stepSeq')),
        stepStartedAt: micros(field(row, 'stepStartedAt')),
        stepEndsAt: micros(field(row, 'stepEndsAt')),
        outcome: optionalTag(row.outcome),
        pauseReason: optionalTag(row.pauseReason),
        updatedAt: micros(field(row, 'updatedAt')),
    };
}

/** The column that records when an errand reached each status (docs/spacetime.md 2.8, `board_errands`). */
const ERRAND_STATUS_AT: Record<string, string> = {
    drafted: 'createdAt',
    previewed: 'previewedAt',
    awaiting_confirm: 'readbackDoneAt',
    confirmed: 'confirmedAt',
    submitting: 'claimedAt',
    submitted: 'submittedAt',
    refused: 'endedAt',
    failed: 'endedAt',
    unknown_outcome: 'endedAt',
    stopped: 'endedAt',
};

const CALL_STATUS_AT: Record<string, string> = {
    prepared: 'createdAt',
    confirmed: 'confirmedAt',
    dialing: 'dialedAt',
    ringing: 'ringingAt',
    connected: 'connectedAt',
    ended: 'endedAt',
    failed: 'endedAt',
    stopped: 'endedAt',
    refused: 'endedAt',
};

function statusAt(row: Record<string, unknown>, column: string | undefined, updatedAt: Micros): Micros {
    if (!column) return updatedAt;
    return optionalMicros(row[column]) ?? updatedAt;
}

export function toErrandIn(raw: unknown): ActionIn {
    const row = record(raw);
    const status = tag(field(row, 'status'));
    const updatedAt = micros(field(row, 'updatedAt'));
    return {
        kind: 'errand',
        id: u64(field(row, 'errandId')),
        sessionId: u64(field(row, 'sessionId')),
        status,
        result: '',
        updatedAt,
        statusAt: statusAt(row, ERRAND_STATUS_AT[status], updatedAt),
    };
}

export function toCallIn(raw: unknown): ActionIn {
    const row = record(raw);
    const status = tag(field(row, 'status'));
    const updatedAt = micros(field(row, 'updatedAt'));
    return {
        kind: 'call',
        id: u64(field(row, 'callId')),
        sessionId: u64(field(row, 'sessionId')),
        status,
        result: str(field(row, 'result')),
        updatedAt,
        statusAt: statusAt(row, CALL_STATUS_AT[status], updatedAt),
    };
}

/** An Identity (2.13.0: `toHexString()`), as hex. Held in memory to tell devices apart; never stored. */
function identityHex(value: unknown): string {
    if (value && typeof value === 'object' && typeof (value as { toHexString?: unknown }).toHexString === 'function') {
        return (value as { toHexString(): string }).toHexString();
    }
    throw new ContractError('expected an identity');
}

/** A device_status row: role, online, decoder health and the last-seen server time. The label is never read. */
export function toDeviceIn(raw: unknown): DeviceIn {
    const row = record(raw);
    const healthy = row.decoderHealthy;
    if (healthy !== undefined && healthy !== null && typeof healthy !== 'boolean') throw new ContractError('expected an optional bool');
    const online = field(row, 'online');
    if (typeof online !== 'boolean') throw new ContractError('expected a bool');
    return {
        id: identityHex(field(row, 'identity')),
        role: tag(field(row, 'role')),
        online,
        decoderHealthy: typeof healthy === 'boolean' ? healthy : null,
        lastSeenAt: micros(field(row, 'lastSeenAt')),
    };
}

// ---------- The source ----------

export interface SpacetimeSourceOptions {
    /** For example https://maincloud.spacetimedb.com. */
    readonly uri: string;
    /** For example say-when-demo. */
    readonly database: string;
    /** The generated `DbConnection.builder` (src/cli/bindings.ts). */
    readonly builder: () => BuilderLike;
    readonly log: Logger;
    /** Waits between attempts when a connection has to be rebuilt (the SDK only reconnects established ones). */
    readonly retryDelaysMs?: readonly number[];
}

export class SpacetimeSource implements TelemetrySource {
    readonly database: string;
    /** The connection whose callbacks count; bumped on every build, rebuild and stop. */
    private attempt = 0;
    private conn: ConnectionLike | null = null;
    /** Built but not yet connected: retired too on stop or rebuild. */
    private pending: ConnectionLike | null = null;
    private handlers: SourceHandlers | null = null;
    private stopped = false;
    private failures = 0;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly warned = new Set<string>();
    /** The row callbacks registered on each connection, so retiring one connection never touches another's. */
    private readonly callbacks = new Map<ConnectionLike, Array<[TableLike, 'removeOnInsert' | 'removeOnUpdate', RowCallback]>>();
    readonly counters = { rows: 0, contractErrors: 0, connects: 0, losses: 0 };

    constructor(private readonly options: SpacetimeSourceOptions) {
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(options.database)) throw new Error('SPACETIMEDB_DB must be a database name such as say-when-demo.');
        this.database = options.database;
    }

    async start(handlers: SourceHandlers): Promise<void> {
        this.handlers = handlers;
        this.stopped = false;
        this.connect();
    }

    stop(): void {
        this.stopped = true;
        this.attempt++;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.retireAll();
    }

    private connect(): void {
        if (this.stopped) return;
        const id = ++this.attempt;
        // Every callback of this connection checks it is still the one that counts.
        const current = () => !this.stopped && id === this.attempt;
        const { log } = this.options;
        try {
            const built = this.options
                .builder()
                .withUri(this.options.uri)
                .withDatabaseName(this.options.database)
                .withAutomaticReconnect({ minDelayMs: 1_000, maxDelayMs: 8_000 })
                .onConnect((conn) => {
                    if (!current()) {
                        this.retire(conn);
                        return;
                    }
                    this.conn = conn;
                    this.pending = null;
                    this.failures = 0;
                    this.counters.connects++;
                    log.info('connected to SpacetimeDB (anonymous, read-only)', { database: this.options.database });
                    this.watch(conn, current);
                    this.subscribe(conn, current);
                })
                .onAutomaticReconnect((conn) => {
                    if (!current()) {
                        this.retire(conn);
                        return;
                    }
                    this.conn = conn;
                    log.info('reconnected to SpacetimeDB; waiting for the subscription to replay');
                })
                .onConnectError((_ctx, error, nextAttempt) => {
                    if (!current()) return;
                    log.warn('SpacetimeDB connection failed', { error: error?.name ?? 'Error', sdkRetries: nextAttempt !== undefined });
                    this.lost('connect_error');
                    // Undefined means the SDK will not try again: a failed first connection, or a terminal failure.
                    if (nextAttempt === undefined) this.rebuild();
                })
                .onDisconnect((_ctx, error, nextAttempt) => {
                    if (!current()) return;
                    log.warn('SpacetimeDB connection lost', { error: error?.name ?? 'none', sdkRetries: nextAttempt !== undefined });
                    this.lost('disconnect');
                    if (nextAttempt === undefined) this.rebuild();
                })
                .build();
            if (current() && this.conn !== built) this.pending = built;
        } catch (error) {
            log.error('could not build the SpacetimeDB connection', { error: error instanceof Error ? error.name : 'Error' });
            this.rebuild();
        }
    }

    /** The SDK will not retry this connection: retire it and build a new one after a doubling wait. */
    private rebuild(): void {
        if (this.stopped) return;
        this.attempt++;
        this.retireAll();
        this.retry();
    }

    private retireAll(): void {
        const conn = this.conn;
        const pending = this.pending;
        this.conn = null;
        this.pending = null;
        if (conn) this.retire(conn);
        if (pending && pending !== conn) this.retire(pending);
    }

    private retire(conn: ConnectionLike): void {
        this.unwatch(conn);
        try {
            conn.disconnect();
        } catch {
            // Already closed, or never opened.
        }
    }

    private retry(): void {
        if (this.stopped || this.retryTimer) return;
        const delays = this.options.retryDelaysMs ?? [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
        const wait = delays[Math.min(this.failures, delays.length - 1)] ?? 30_000;
        this.failures++;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.connect();
        }, wait);
    }

    private lost(reason: string): void {
        this.counters.losses++;
        try {
            this.handlers?.lost(reason);
        } catch (error) {
            this.warnOnce(`lost:${(error as Error).message}`, 'the lost handler failed');
        }
    }

    private subscribe(conn: ConnectionLike, current: () => boolean): void {
        const queries = Object.values(SUBSCRIBED).map((wire) => `SELECT * FROM ${wire}`);
        conn.subscriptionBuilder()
            .onApplied(() => {
                if (!current()) return;
                // Replay what the cache holds, in case initial rows arrived before the callbacks or without them.
                // Every handler is idempotent, so rows seen twice are dropped downstream.
                this.replayCache(conn, current);
                try {
                    this.handlers?.ready();
                } catch (error) {
                    this.warnOnce(`ready:${(error as Error).message}`, 'the ready handler failed');
                }
                this.options.log.info('subscribed', { tables: Object.values(SUBSCRIBED).join(', ') });
            })
            .onError(() => {
                if (!current()) return;
                this.options.log.error('the SpacetimeDB subscription was refused; check the view and table names against docs/spacetime.md');
                this.lost('subscription_error');
                // Nothing would arrive on this connection again: start over, with the doubling wait.
                this.rebuild();
            })
            .subscribe(queries);
    }

    private table(conn: ConnectionLike, wire: string): TableLike | null {
        const t = conn.db[camel(wire)];
        return t && typeof (t as TableLike).iter === 'function' && typeof (t as TableLike).onInsert === 'function' ? (t as TableLike) : null;
    }

    private dispatch(kind: keyof typeof SUBSCRIBED, row: unknown, current: () => boolean): void {
        const h = this.handlers;
        if (!h || !current()) return;
        try {
            this.counters.rows++;
            switch (kind) {
                case 'ledger':
                    h.ledger(toLedgerIn(row));
                    break;
                case 'scan':
                    h.scan(toScanIn(row));
                    break;
                case 'errands':
                    h.action(toErrandIn(row));
                    break;
                case 'calls':
                    h.action(toCallIn(row));
                    break;
                case 'devices':
                    h.device(toDeviceIn(row));
                    break;
            }
        } catch (error) {
            if (error instanceof ContractError) this.counters.contractErrors++;
            this.warnOnce(`${kind}:${(error as Error).message}`, `a ${SUBSCRIBED[kind]} row was skipped`, (error as Error).message);
        }
    }

    private watch(conn: ConnectionLike, current: () => boolean): void {
        this.unwatch(conn);
        const registered: Array<[TableLike, 'removeOnInsert' | 'removeOnUpdate', RowCallback]> = [];
        for (const [kind, wire] of Object.entries(SUBSCRIBED) as Array<[keyof typeof SUBSCRIBED, string]>) {
            const t = this.table(conn, wire);
            if (!t) {
                this.options.log.error('a table or view is missing from the generated bindings', { name: wire });
                continue;
            }
            const onInsert: RowCallback = (_ctx, row) => this.dispatch(kind, row, current);
            const onUpdate: RowCallback = (_ctx, _old, row) => this.dispatch(kind, row, current);
            t.onInsert(onInsert);
            registered.push([t, 'removeOnInsert', onInsert]);
            if (typeof t.onUpdate === 'function') {
                t.onUpdate(onUpdate);
                registered.push([t, 'removeOnUpdate', onUpdate]);
            }
        }
        this.callbacks.set(conn, registered);
    }

    private unwatch(conn: ConnectionLike): void {
        const registered = this.callbacks.get(conn);
        this.callbacks.delete(conn);
        for (const [t, remove, cb] of registered ?? []) {
            const fn = t[remove];
            if (typeof fn === 'function') {
                try {
                    (fn as (cb: RowCallback) => void).call(t, cb);
                } catch {
                    // A closed connection may refuse; its callbacks are dead anyway (each checks its attempt).
                }
            }
        }
    }

    private replayCache(conn: ConnectionLike, current: () => boolean): void {
        for (const [kind, wire] of Object.entries(SUBSCRIBED) as Array<[keyof typeof SUBSCRIBED, string]>) {
            const t = this.table(conn, wire);
            if (!t) continue;
            for (const row of t.iter()) this.dispatch(kind, row, current);
        }
    }

    private warnOnce(key: string, message: string, problem?: string): void {
        if (this.warned.has(key)) return;
        this.warned.add(key);
        this.options.log.warn(message, problem ? { problem } : {});
    }
}
