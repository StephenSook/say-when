// The SpacetimeDB adapter: the AgentDb interface over a live connection to the module.
//
// Written against the spacetimedb 2.13.0 client API (checked in node_modules/spacetimedb/dist/sdk/*.d.ts):
//   DbConnection.builder().withUri().withDatabaseName().withToken().withAutomaticReconnect()
//     .onConnect().onAutomaticReconnect().onConnectError().onDisconnect().build()
//   conn.subscriptionBuilder().onApplied().onError().subscribe(queries)
//   conn.db.<view>.iter() / onInsert() / onDelete() / onUpdate()
//   conn.reducers.<reducer>({ camelCaseArgs }) returns Promise<void>, rejecting with SenderError,
//     DisconnectedError or UnknownCallResultError (lib/errors.d.ts)
//
// The connection type below is structural, so this file compiles before the generated bindings exist. The
// bindings plug in at one place, src/db/bindings.ts. Every view, reducer and field name comes from
// src/contract.ts, which test/contract.test.ts checks against docs/spacetime.md and the generated bindings.

import { camel, DEVICE_STATUS, DIRECT, REDUCERS, VIEWS, type ViewName } from '../contract.js';
import type { Logger } from '../log.js';
import type {
    AgentConsent,
    AgentQueueRow,
    CallQueueRow,
    CallStatus,
    ErrandQueueRow,
    ErrandStatus,
    JobKind,
    JobStatus,
    MenuItem,
    Origin,
    ReducerArgs,
    ReducerName,
} from '../types.js';
import { DbCallError, toDbError, type AgentDb } from './db.js';

/** What the sidecar needs from a generated `DbConnection`. */
export interface ConnectionLike {
    db: Record<string, unknown>;
    reducers: Record<string, unknown>;
    identity?: { toHexString(): string };
    subscriptionBuilder(): SubscriptionBuilderLike;
    disconnect(): void;
}

export interface SubscriptionBuilderLike {
    onApplied(callback: (ctx: unknown) => void): SubscriptionBuilderLike;
    onError(callback: (ctx: unknown, error?: unknown) => void): SubscriptionBuilderLike;
    subscribe(queries: string[]): unknown;
}

export interface BuilderLike {
    withUri(uri: string): BuilderLike;
    withDatabaseName(name: string): BuilderLike;
    withToken(token?: string): BuilderLike;
    withAutomaticReconnect(options?: { minDelayMs?: number; maxDelayMs?: number }): BuilderLike;
    onConnect(callback: (conn: ConnectionLike, identity: { toHexString(): string }, token: string) => void): BuilderLike;
    onAutomaticReconnect(callback: (conn: ConnectionLike, identity: { toHexString(): string }, token: string) => void): BuilderLike;
    onConnectError(callback: (ctx: unknown, error: Error) => void): BuilderLike;
    onDisconnect(callback: (ctx: unknown, error?: Error) => void): BuilderLike;
    build(): ConnectionLike;
}

interface TableLike {
    iter(): Iterable<unknown>;
    onInsert(callback: (...args: unknown[]) => void): void;
    removeOnInsert(callback: (...args: unknown[]) => void): void;
    onDelete?(callback: (...args: unknown[]) => void): void;
    removeOnDelete?(callback: (...args: unknown[]) => void): void;
    onUpdate?(callback: (...args: unknown[]) => void): void;
    removeOnUpdate?(callback: (...args: unknown[]) => void): void;
}

export interface SpacetimeOptions {
    /** The generated `DbConnection.builder` (src/db/bindings.ts). */
    builder: () => BuilderLike;
    /** For example https://maincloud.spacetimedb.com. */
    uri: string;
    /** For example say-when-dev. */
    database: string;
    /** The saved `.agent-token`, or undefined on the first run. */
    token?: string;
    /** Called with a new token (first run, or a refreshed one). The caller writes it with mode 600. */
    saveToken?: (token: string) => void;
    log: Logger;
}

/** Thrown when a row the module sent lacks a field the contract names: the bindings and the contract drifted. */
export class ContractError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ContractError';
    }
}

/** The identity token could not be written to AGENT_TOKEN_FILE. `code` is the file error's code (ENOENT, EACCES). */
export class TokenSaveError extends Error {
    constructor(readonly code: string) {
        super('could not save the SpacetimeDB identity token');
        this.name = 'TokenSaveError';
    }
}

/** A file error's code, or the error's class name: never its message, which can quote a path. */
function codeOf(error: unknown): string {
    const code = error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    if (typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(code)) return code;
    return error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(error.name) ? error.name : 'error';
}

export class SpacetimeAgentDb implements AgentDb {
    private conn: ConnectionLike | null = null;
    private applied = false;
    private connected = false;
    private identityHex: string | null = null;
    private readonly listeners = new Set<() => void>();
    private readonly waiters = new Set<() => void>();
    private notifyQueued = false;
    private readonly contractWarned = new Set<string>();
    private readonly onRow = () => this.notify();
    private readonly memoryOffListeners = new Set<() => void>();
    // `agent_consent` rows are read as they arrive, not once per burst, so a revocation followed at once by a new
    // grant is still seen (onInsert passes (ctx, row), onUpdate (ctx, oldRow, row)).
    private readonly onConsentInsert = (...args: unknown[]) => this.consentRowArrived(args[1]);
    private readonly onConsentUpdate = (...args: unknown[]) => this.consentRowArrived(args[2]);
    /**
     * A removed `agent_consent` row (the Agent device revoked, for example) counts as memory off: until a row comes back
     * what it allowed is unknown, and a revocation and a new grant in the gap would otherwise never be heard.
     */
    private readonly onConsentDelete = () => this.memoryOff();
    private closed = false;
    private syncs = 0;

    constructor(private readonly options: SpacetimeOptions) {}

    /** Opens the connection. The first connection failure is final (the SDK retries only established connections). */
    connect(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            let settled = false;
            const { log } = this.options;
            const builder = this.options
                .builder()
                .withUri(this.options.uri)
                .withDatabaseName(this.options.database)
                .withToken(this.options.token)
                .withAutomaticReconnect({ minDelayMs: 1_000, maxDelayMs: 8_000 })
                .onConnect((conn, identity, token) => {
                    // This runs inside the SDK's message handler, so nothing may be thrown from here: a failure
                    // closes the connection and rejects connect() with a message that quotes no path or value.
                    const fail = (error: Error) => {
                        this.close();
                        if (!settled) {
                            settled = true;
                            reject(error);
                        }
                    };
                    this.conn = conn;
                    this.connected = true;
                    this.identityHex = identity.toHexString();
                    try {
                        if (token && token !== this.options.token) this.options.saveToken?.(token);
                    } catch (error) {
                        // An unsaved token means a new identity next time, which would need pairing again.
                        const failure = new TokenSaveError(codeOf(error));
                        log.error('could not save the SpacetimeDB identity token', { file: 'AGENT_TOKEN_FILE', code: failure.code });
                        return fail(failure);
                    }
                    try {
                        log.info('connected to SpacetimeDB', { database: this.options.database, identity: this.identityHex.slice(0, 12) });
                        this.watch(conn);
                        this.subscribe(conn);
                    } catch (error) {
                        log.error('could not set up the SpacetimeDB connection', { why: codeOf(error) });
                        return fail(new Error('could not set up the SpacetimeDB connection'));
                    }
                    if (!settled) {
                        settled = true;
                        resolve();
                    }
                })
                .onAutomaticReconnect((conn) => {
                    this.conn = conn;
                    this.connected = true;
                    log.info('reconnected to SpacetimeDB');
                    // The SDK replays subscriptions itself; the applied flag comes back with them.
                })
                .onConnectError((_ctx, error) => {
                    this.connected = false;
                    log.warn('SpacetimeDB connection failed', { error: error.name });
                    if (!settled) {
                        settled = true;
                        reject(new Error(`Could not connect to SpacetimeDB database ${this.options.database}. Check SPACETIMEDB_URI, SPACETIMEDB_DB and the token file.`));
                    }
                })
                .onDisconnect((_ctx, error) => {
                    this.connected = false;
                    this.applied = false;
                    if (!this.closed) log.warn('SpacetimeDB connection lost; reconnecting', { error: error?.name ?? 'none' });
                    // A revocation during the outage may never show (one given again before the reconnect leaves
                    // nothing behind in agent_consent), so losing the connection counts as memory off.
                    this.memoryOff();
                });
            builder.build();
        });
    }

    /** Hex identity of this sidecar once connected. Shown truncated in logs; it is not a secret. */
    get identity(): string | null {
        return this.identityHex;
    }

    /** True when the public `device_status` table lists this identity with the Agent role. */
    isPairedAgent(): boolean | null {
        const table = this.table(DEVICE_STATUS.wire);
        if (!table || !this.identityHex) return null;
        for (const row of table.iter()) {
            const r = row as Record<string, unknown>;
            if (hexOf(r.identity) === this.identityHex && tagOf(r.role) === 'agent') return true;
        }
        return false;
    }

    close(): void {
        this.closed = true;
        const conn = this.conn;
        this.conn = null;
        this.connected = false;
        this.applied = false;
        if (conn) {
            this.unwatch(conn);
            try {
                conn.disconnect();
            } catch {
                // Already closed.
            }
        }
    }

    // ---------- AgentDb ----------

    agentQueue(): readonly AgentQueueRow[] {
        return this.read('agentQueue', toAgentQueueRow);
    }

    errandQueue(): readonly ErrandQueueRow[] {
        return this.read('errandQueue', toErrandQueueRow);
    }

    callQueue(): readonly CallQueueRow[] {
        return this.read('callQueue', toCallQueueRow);
    }

    agentConsent(): AgentConsent | null {
        // One row for an Agent. Anything else (none, several, or one that does not match the contract) is unknown,
        // and unknown never counts as consent.
        const rows = this.read('agentConsent', toAgentConsent);
        return rows.length === 1 ? (rows[0] ?? null) : null;
    }

    onMemoryOff(listener: () => void): () => void {
        this.memoryOffListeners.add(listener);
        return () => this.memoryOffListeners.delete(listener);
    }

    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    syncCount(): number {
        return this.syncs;
    }

    isCurrent(): boolean {
        return this.connected && this.applied;
    }

    async ready(timeoutMs: number): Promise<boolean> {
        if (this.connected && this.applied) return true;
        return new Promise<boolean>((resolve) => {
            const done = (value: boolean) => {
                clearTimeout(timer);
                this.waiters.delete(wake);
                resolve(value);
            };
            const wake = () => done(true);
            const timer = setTimeout(() => done(false), timeoutMs);
            this.waiters.add(wake);
        });
    }

    async call<K extends ReducerName>(name: K, args: ReducerArgs[K]): Promise<void> {
        const conn = this.conn;
        if (!conn || !this.connected) throw new DbCallError('disconnected', name, 'not connected');
        const accessor = camel(REDUCERS[name].wire);
        const fn = conn.reducers[accessor];
        if (typeof fn !== 'function') {
            throw new DbCallError('internal', name, `reducer ${REDUCERS[name].wire} is missing from the generated bindings`);
        }
        try {
            await (fn as (params: object) => Promise<void>).call(conn.reducers, args);
        } catch (error) {
            throw toDbError(error, name);
        }
    }

    // ---------- Internals ----------

    private subscribe(conn: ConnectionLike): void {
        // Views appear like tables in subscriptions (docs/spacetime.md 7.1). Untested against Maincloud.
        const queries = [VIEWS.agentQueue.wire, VIEWS.errandQueue.wire, VIEWS.callQueue.wire, VIEWS.agentConsent.wire, DEVICE_STATUS.wire].map(
            (wire) => `SELECT * FROM ${wire}`,
        );
        conn.subscriptionBuilder()
            .onApplied(() => {
                this.applied = true;
                this.syncs += 1;
                this.options.log.info('subscribed to the agent views', { sync: this.syncs });
                for (const wake of [...this.waiters]) wake();
                this.notify();
            })
            .onError(() => {
                this.applied = false;
                this.options.log.error('the agent subscription was refused; check the view names and that this identity is paired as Agent');
                // Without the subscription a revocation cannot reach the sidecar: memory counts as off.
                this.memoryOff();
            })
            .subscribe(queries);
    }

    private watch(conn: ConnectionLike): void {
        for (const view of Object.values(VIEWS)) {
            const table = this.tableOf(conn, view.wire);
            if (!table) {
                this.options.log.error(
                    view.wire === VIEWS.agentConsent.wire
                        ? 'a view is missing from the generated bindings; memory and web search count as not allowed'
                        : 'a view is missing from the generated bindings',
                    { view: view.wire },
                );
                continue;
            }
            table.onInsert(this.onRow);
            table.onDelete?.(this.onRow);
            table.onUpdate?.(this.onRow);
            if (view.wire === VIEWS.agentConsent.wire) {
                table.onInsert(this.onConsentInsert);
                table.onUpdate?.(this.onConsentUpdate);
                table.onDelete?.(this.onConsentDelete);
            }
        }
    }

    private unwatch(conn: ConnectionLike): void {
        for (const view of Object.values(VIEWS)) {
            const table = this.tableOf(conn, view.wire);
            if (!table) continue;
            table.removeOnInsert(this.onRow);
            table.removeOnDelete?.(this.onRow);
            table.removeOnUpdate?.(this.onRow);
            if (view.wire === VIEWS.agentConsent.wire) {
                table.removeOnInsert(this.onConsentInsert);
                table.removeOnUpdate?.(this.onConsentUpdate);
                table.removeOnDelete?.(this.onConsentDelete);
            }
        }
    }

    /**
     * An `agent_consent` row as it arrives. Memory consent off, or a row that cannot be read, tells every onMemoryOff
     * listener at once: forgetting is the safe side. This runs inside the SDK's message handler, so nothing is thrown.
     */
    private consentRowArrived(row: unknown): void {
        let off = true;
        try {
            off = !toAgentConsent(row as Record<string, unknown>).memoryAllowed;
        } catch (error) {
            this.warnContract(VIEWS.agentConsent.wire, error);
        }
        if (off) this.memoryOff();
    }

    /** Tells every onMemoryOff listener. Called from SDK callbacks, so a listener's error goes no further. */
    private memoryOff(): void {
        for (const listener of [...this.memoryOffListeners]) {
            try {
                listener();
            } catch {
                // A listener's failure must not reach the SDK; forgetting is all the listeners do.
            }
        }
    }

    private notify(): void {
        // While a subscription is being (re)applied the cache is half replayed; onApplied notifies once it is whole.
        if (!this.applied || this.notifyQueued) return;
        this.notifyQueued = true;
        // One callback per row arrives; read the views once per burst.
        queueMicrotask(() => {
            this.notifyQueued = false;
            if (!this.applied) return;
            for (const listener of [...this.listeners]) listener();
        });
    }

    private table(wire: string): TableLike | null {
        return this.conn ? this.tableOf(this.conn, wire) : null;
    }

    private tableOf(conn: ConnectionLike, wire: string): TableLike | null {
        const table = conn.db[camel(wire)] ?? conn.db[wire];
        return table && typeof (table as TableLike).iter === 'function' ? (table as TableLike) : null;
    }

    private read<T>(view: ViewName, map: (row: Record<string, unknown>) => T): T[] {
        const table = this.table(VIEWS[view].wire);
        if (!table) return [];
        const rows: T[] = [];
        for (const row of table.iter()) {
            try {
                rows.push(map(row as Record<string, unknown>));
            } catch (error) {
                this.warnContract(VIEWS[view].wire, error);
            }
        }
        return rows;
    }

    /** Logs a row that does not match the contract, once per view and problem. Problems are fixed phrases (ContractError). */
    private warnContract(wire: string, error: unknown): void {
        const problem = error instanceof ContractError ? error.message : 'error';
        const key = `${wire}:${problem}`;
        if (this.contractWarned.has(key)) return;
        this.contractWarned.add(key);
        this.options.log.error('a view row does not match the contract; skipping it', { view: wire, problem });
    }
}

// ---------- Row mapping ----------
// Generated rows use camelCase keys, u64 as bigint, timestamps as Timestamp, identities as Identity and enums as
// `{ tag: 'Pending' }`. The view functions are not written yet, so each helper also accepts the plain form (a
// string tag, a number, a hex string) and the snake_case key. A missing field is a ContractError.

function field(row: Record<string, unknown>, wire: string): unknown {
    const value = row[camel(wire)] !== undefined ? row[camel(wire)] : row[wire];
    if (value === undefined) throw new ContractError(`missing field ${wire}`);
    return value;
}

/** Optional values are `undefined` (t.option) or absent. */
function optionalField(row: Record<string, unknown>, wire: string): unknown {
    return row[camel(wire)] !== undefined ? row[camel(wire)] : row[wire];
}

/** `{ tag: 'AwaitingConfirm' }`, `'AwaitingConfirm'` or `'awaiting_confirm'` to `awaiting_confirm`. */
export function tagOf(value: unknown): string {
    const raw = value && typeof value === 'object' && 'tag' in value ? (value as { tag: unknown }).tag : value;
    if (typeof raw !== 'string') throw new ContractError('expected an enum value');
    return raw.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

export function u64Of(value: unknown): bigint {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
    if (typeof value === 'string' && /^\d{1,20}$/.test(value)) return BigInt(value);
    throw new ContractError('expected a u64');
}

function u32Of(value: unknown): number {
    const n = typeof value === 'bigint' ? Number(value) : value;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0) return n;
    throw new ContractError('expected a u32');
}

function strOf(value: unknown): string {
    if (typeof value === 'string') return value;
    throw new ContractError('expected a string');
}

function boolOf(value: unknown): boolean {
    if (typeof value === 'boolean') return value;
    throw new ContractError('expected a bool');
}

/** Timestamp (toMillis), `{ microsSinceUnixEpoch }`, epoch ms number, or unset. */
export function millisOf(value: unknown): number | null {
    if (value === undefined || value === null) return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'object') {
        const v = value as { toMillis?: () => bigint | number; microsSinceUnixEpoch?: bigint };
        if (typeof v.toMillis === 'function') return Number(v.toMillis());
        if (typeof v.microsSinceUnixEpoch === 'bigint') return Number(v.microsSinceUnixEpoch / 1000n);
    }
    throw new ContractError('expected a timestamp');
}

/** Identity (toHexString) or a hex string. */
export function hexOf(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && typeof (value as { toHexString?: unknown }).toHexString === 'function') {
        return (value as { toHexString(): string }).toHexString();
    }
    throw new ContractError('expected an identity');
}

function oneOf<T extends string>(value: string, allowed: readonly T[], what: string): T {
    if ((allowed as readonly string[]).includes(value)) return value as T;
    throw new ContractError(`unknown ${what} ${value}`);
}

/** The module's job kind, through the direct select name map (src/contract.ts DIRECT), so a rename is one edit. */
export function jobKindOf(value: unknown): JobKind {
    const tag = tagOf(value);
    const kinds: Readonly<Record<string, JobKind>> = DIRECT.jobKindTags;
    const kind = Object.hasOwn(kinds, tag) ? kinds[tag] : undefined;
    if (kind === undefined) throw new ContractError(`unknown job kind ${tag}`);
    return kind;
}
const JOB_STATUSES: readonly JobStatus[] = ['pending', 'claimed', 'done', 'failed', 'cancelled'];
const ORIGINS: readonly Origin[] = ['partner', 'menu'];
const MENU_ITEMS: readonly MenuItem[] = ['none', 'need', 'request', 'call', 'say'];
const ERRAND_STATUSES: readonly ErrandStatus[] = [
    'drafted',
    'previewed',
    'awaiting_confirm',
    'confirmed',
    'submitting',
    'submitted',
    'refused',
    'failed',
    'unknown_outcome',
    'stopped',
];
const CALL_STATUSES: readonly CallStatus[] = [
    'prepared',
    'awaiting_confirm',
    'confirmed',
    'dialing',
    'ringing',
    'connected',
    'ended',
    'failed',
    'stopped',
    'refused',
];

export function toAgentQueueRow(row: Record<string, unknown>): AgentQueueRow {
    return {
        jobId: u64Of(field(row, 'job_id')),
        kind: jobKindOf(field(row, 'kind')),
        status: oneOf(tagOf(field(row, 'status')), JOB_STATUSES, 'job status'),
        attempt: u32Of(field(row, 'attempt')),
        claimedByMe: boolOf(field(row, 'claimed_by_me')),
        questionId: u64Of(field(row, 'question_id')),
        questionText: strOf(field(row, 'question_text')),
        origin: oneOf(tagOf(field(row, 'origin')), ORIGINS, 'origin'),
        menuItem: oneOf(tagOf(field(row, 'menu_item')), MENU_ITEMS, 'menu item'),
        askedBy: hexOf(field(row, 'asked_by')),
        webSearchAllowed: boolOf(field(row, 'web_search_allowed')),
        memoryAllowed: boolOf(field(row, 'memory_allowed')),
        errandId: u64Of(field(row, 'errand_id')),
        formKey: strOf(field(row, 'form_key')),
        formUrl: strOf(field(row, 'form_url')),
        formTitle: strOf(field(row, 'form_title')),
        fieldsJson: strOf(field(row, 'fields_json')),
        replyText: strOf(field(row, 'reply_text')),
        recentErrandTitle: strOf(field(row, 'recent_errand_title')),
        recentErrandSentAtMs: millisOf(optionalField(row, 'recent_errand_sent_at')),
        // Direct select (src/contract.ts DIRECT): the original question of a follow-up turn, and the picked category.
        parentQuestionId: u64Of(field(row, 'parent_question_id')),
        parentQuestionText: strOf(field(row, 'parent_question_text')),
        category: strOf(field(row, DIRECT.categoryField)),
        createdAtMs: millisOf(field(row, 'created_at')) ?? 0,
    };
}

export function toErrandQueueRow(row: Record<string, unknown>): ErrandQueueRow {
    return {
        errandId: u64Of(field(row, 'errand_id')),
        status: oneOf(tagOf(field(row, 'status')), ERRAND_STATUSES, 'errand status'),
        claimAttempt: u32Of(field(row, 'claim_attempt')),
        claimedByMe: boolOf(field(row, 'claimed_by_me')),
        formKey: strOf(field(row, 'form_key')),
        formUrl: strOf(field(row, 'form_url')),
        fieldsJson: strOf(field(row, 'fields_json')),
        confirmedDigest: strOf(field(row, 'confirmed_digest')),
        confirmedAtMs: millisOf(optionalField(row, 'confirmed_at')),
    };
}

export function toCallQueueRow(row: Record<string, unknown>): CallQueueRow {
    return {
        callId: u64Of(field(row, 'call_id')),
        status: oneOf(tagOf(field(row, 'status')), CALL_STATUSES, 'call status'),
        claimAttempt: u32Of(field(row, 'claim_attempt')),
        claimedByMe: boolOf(field(row, 'claimed_by_me')),
        requestId: strOf(field(row, 'request_id')),
        contactId: strOf(field(row, 'contact_id')),
        scriptDigest: strOf(field(row, 'script_digest')),
        cancelRequested: boolOf(field(row, 'cancel_requested')),
        cancelReason: strOf(field(row, 'cancel_reason')),
        // Optional: unset reads as unknown, and an unknown CONFIRM time never dials (src/calls.ts).
        confirmedAtMs: millisOf(optionalField(row, 'confirmed_at')),
    };
}

export function toAgentConsent(row: Record<string, unknown>): AgentConsent {
    return {
        sessionId: u64Of(field(row, 'session_id')),
        memoryAllowed: boolOf(field(row, 'memory_allowed')),
        webSearchAllowed: boolOf(field(row, 'web_search_allowed')),
    };
}
