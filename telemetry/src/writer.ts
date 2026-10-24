// The batching writer: a bounded in-memory queue in front of Tiger.
//
// - Batches go out once a second (and at once when the queue passes its high-water mark), at most `maxBatch` rows
//   per insert, at most one flush at a time.
// - A Tiger outage never crashes anything: the batch goes back to the front of the queue and the writer retries
//   with a doubling wait (1 s up to 30 s). The queue keeps filling up to `capacity`; past that the oldest rows are
//   dropped and counted per table, and their memory is released, so the queue stays bounded and the loss is visible.
// - Back-pressure: `pressure` is true above the high-water mark, and `whenWritable()` resolves once the queue has
//   drained below the low-water mark. A replay source waits on it; the live SpacetimeDB source cannot pause the
//   server, so it relies on drop-oldest instead.
// - Rest minutes with the same key coalesce in the queue with bitwise OR, as they do in Tiger.
// - Session metadata (SESSION_METADATA: one input row per session) is never queued, so a full queue cannot drop it.
//   The writer keeps each session's input row in memory (one small entry per session it follows) and sends the ones
//   not yet written at the start of every flush, those of the sessions in the batch first, up to maxBatch. If that
//   insert fails, the batch's rows are not sent and the whole flush is retried as one, so no row is ever written ahead
//   of its session's input when the input is known. Once an insert of an input succeeds it is not sent again. A flush
//   also runs with an empty queue while inputs are unwritten (an input can arrive after its session's rows went out),
//   on the same retry wait, and `stop()` counts unwritten inputs among the rows it could not write.
// - `stop()` waits for a batch already out (its rows have left the queue) and reports what it could not send.
import { safeMessage } from './credentials.js';
import type { Logger } from './log.js';
import type { RowSink } from './sink.js';
import { popcount, SESSION_METADATA, TABLE_NAMES, type RestMinuteRow, type TableName, type TelemetryRow } from './types.js';

export interface Timers {
    now(): number;
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
}

export const realTimers: Timers = {
    now: () => Date.now(),
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface WriterOptions {
    readonly sink: RowSink;
    readonly log: Logger;
    readonly flushEveryMs?: number;
    readonly maxBatch?: number;
    readonly capacity?: number;
    readonly retryMinMs?: number;
    readonly retryMaxMs?: number;
    /** Most batches sent in one tick while the queue has a backlog. */
    readonly maxBatchesPerTick?: number;
    /** Turns an error into one safe line (the connection's redactor). */
    readonly describeError?: (error: unknown) => string;
    /** Runs before each flush tick, for example the tracker's rest checkpoint. */
    readonly beforeFlush?: () => void;
    readonly timers?: Timers;
}

export interface WriterStats {
    readonly queued: number;
    /** Rows in a batch that is out and not yet resolved. */
    readonly inFlight: number;
    readonly pressure: boolean;
    readonly written: Readonly<Record<TableName, number>>;
    readonly dropped: Readonly<Record<TableName, number>>;
    readonly failedFlushes: number;
    readonly consecutiveFailures: number;
    /** Local clock of the last successful insert; the database's own `ingested_at` is the number to show. */
    readonly lastWriteAtMs: number | null;
    readonly lastError: string | null;
    readonly retryAtMs: number | null;
    /** Rows not written when `stop()` returned (queued, in flight, and unwritten session inputs); null until stopped. */
    readonly unsentAtStop: number | null;
    /** Of `unsentAtStop`, the session input rows; null until stopped. */
    readonly inputsUnsentAtStop: number | null;
}

interface Entry {
    readonly table: TableName;
    row: TelemetryRow['row'];
    /** For rest minutes: `<session>|<minute>`, so later copies of the minute merge into the queued one. */
    readonly slot: string | null;
}

function zero(): Record<TableName, number> {
    return Object.fromEntries(TABLE_NAMES.map((t) => [t, 0])) as Record<TableName, number>;
}

function slotOf(item: TelemetryRow): string | null {
    return item.table === 'rest_minutes' ? `${item.row.sessionId}|${item.row.time}` : null;
}

/** The union of two copies of one rest minute. */
function mergeRest(a: RestMinuteRow, b: RestMinuteRow): RestMinuteRow {
    const restMask = a.restMask | b.restMask;
    return { ...a, restMask, idleMs: popcount(restMask) * 1000 };
}

export class TelemetryWriter {
    private queue: Array<Entry | undefined> = [];
    private head = 0;
    private readonly slots = new Map<string, Entry>();
    /** Each session's metadata row, by `<table>|<session>`, kept for the writer's life; never queued. */
    private readonly metadata = new Map<string, { readonly table: TableName; readonly row: TelemetryRow['row'] }>();
    /** The keys of `metadata` not yet written (an insert of them has not succeeded). */
    private readonly unwritten = new Set<string>();
    private readonly written = zero();
    private readonly dropped = zero();
    private failedFlushes = 0;
    private consecutiveFailures = 0;
    private lastWriteAtMs: number | null = null;
    private lastError: string | null = null;
    private retryAtMs: number | null = null;
    private flushing: Promise<boolean> | null = null;
    private inFlight = 0;
    private unsentAtStop: number | null = null;
    private inputsUnsentAtStop: number | null = null;
    private timer: unknown = null;
    private running = false;
    private waiters: Array<() => void> = [];

    private readonly flushEveryMs: number;
    private readonly maxBatch: number;
    private readonly capacity: number;
    private readonly highWater: number;
    private readonly lowWater: number;
    private readonly retryMinMs: number;
    private readonly retryMaxMs: number;
    private readonly maxBatchesPerTick: number;
    private readonly timers: Timers;

    constructor(private readonly options: WriterOptions) {
        this.flushEveryMs = options.flushEveryMs ?? 1_000;
        this.maxBatch = options.maxBatch ?? 500;
        this.capacity = options.capacity ?? 20_000;
        this.highWater = Math.max(1, Math.floor(this.capacity * 0.8));
        this.lowWater = Math.floor(this.capacity * 0.5);
        this.retryMinMs = options.retryMinMs ?? 1_000;
        this.retryMaxMs = options.retryMaxMs ?? 30_000;
        this.maxBatchesPerTick = options.maxBatchesPerTick ?? 20;
        this.timers = options.timers ?? realTimers;
    }

    get size(): number {
        return this.queue.length - this.head;
    }

    /** The backing array's length, which drop-oldest keeps near `capacity` (tests read it). */
    get retained(): number {
        return this.queue.length;
    }

    get pressure(): boolean {
        return this.size >= this.highWater;
    }

    stats(): WriterStats {
        return {
            queued: this.size,
            inFlight: this.inFlight,
            pressure: this.pressure,
            written: { ...this.written },
            dropped: { ...this.dropped },
            failedFlushes: this.failedFlushes,
            consecutiveFailures: this.consecutiveFailures,
            lastWriteAtMs: this.lastWriteAtMs,
            lastError: this.lastError,
            retryAtMs: this.retryAtMs,
            unsentAtStop: this.unsentAtStop,
            inputsUnsentAtStop: this.inputsUnsentAtStop,
        };
    }

    /** Something to send: queued rows, or session inputs not yet written (an input can arrive after its rows went out). */
    private get due(): boolean {
        return this.size > 0 || this.unwritten.size > 0;
    }

    /** Queues one row. Never throws and never blocks; past capacity the oldest queued row is dropped and counted. */
    push(item: TelemetryRow): void {
        if (SESSION_METADATA.has(item.table)) {
            // Not queued: kept, and sent at the start of the next flushes until an insert of it succeeds.
            const key = `${item.table}|${item.row.sessionId}`;
            if (!this.metadata.has(key)) {
                this.metadata.set(key, { table: item.table, row: item.row });
                this.unwritten.add(key);
            }
            return;
        }
        const slot = slotOf(item);
        if (slot !== null) {
            const queued = this.slots.get(slot);
            if (queued) {
                queued.row = mergeRest(queued.row as RestMinuteRow, item.row as RestMinuteRow);
                return;
            }
        }
        if (this.size >= this.capacity) this.dropOldest();
        const entry: Entry = { table: item.table, row: item.row, slot };
        this.queue.push(entry);
        if (slot !== null) this.slots.set(slot, entry);
        if (this.pressure && this.running) this.kick();
    }

    /** Resolves when the queue is below the high-water mark, or once it drains to the low-water mark. */
    whenWritable(): Promise<void> {
        if (!this.pressure || !this.running) return Promise.resolve();
        return new Promise((resolve) => this.waiters.push(resolve));
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.schedule(this.flushEveryMs);
    }

    /**
     * Stops the timer, waits for a batch already out, and sends what is left, giving up after `deadlineMs`.
     * Resolves either way, and records (and logs) how many rows were not written.
     */
    async stop(deadlineMs = 5_000): Promise<void> {
        this.running = false;
        if (this.timer !== null) {
            this.timers.clear(this.timer);
            this.timer = null;
        }
        try {
            this.options.beforeFlush?.();
        } catch (error) {
            this.options.log.error('the pre-flush hook failed', { error: this.describe(error) });
        }
        this.retryAtMs = null;
        const giveUpAt = this.timers.now() + deadlineMs;
        const left = () => giveUpAt - this.timers.now();
        // A batch already out has left the queue: wait for it, or its rows could come back after this returned.
        if (this.flushing) await this.within(this.flushing, left());
        while (this.due && left() > 0) {
            const ok = await this.within(this.flush(), left());
            if (ok !== true) break;
        }
        this.inputsUnsentAtStop = this.unwritten.size;
        this.unsentAtStop = this.size + this.inFlight + this.unwritten.size;
        if (this.unsentAtStop > 0) {
            this.options.log.warn('stopped before every row was written; these rows are lost', { queued: this.size, inFlight: this.inFlight, inputsNotWritten: this.unwritten.size });
        }
        this.release(true);
    }

    /** Sends one batch now. Resolves true if it landed (or there was nothing to send), false if Tiger refused it. */
    flush(): Promise<boolean> {
        if (this.flushing) return this.flushing;
        this.flushing = this.flushOnce().finally(() => {
            this.flushing = null;
        });
        return this.flushing;
    }

    // ---------- Internals ----------

    /** `p`, or 'timeout' after `ms`. */
    private within<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
        if (ms <= 0) return Promise.resolve('timeout');
        return new Promise((resolve) => {
            const handle = this.timers.set(() => resolve('timeout'), ms);
            p.then(
                (v) => {
                    this.timers.clear(handle);
                    resolve(v);
                },
                () => {
                    this.timers.clear(handle);
                    resolve('timeout');
                },
            );
        });
    }

    private schedule(ms: number): void {
        if (!this.running) return;
        if (this.timer !== null) this.timers.clear(this.timer);
        this.timer = this.timers.set(() => {
            this.timer = null;
            void this.tick();
        }, ms);
    }

    /** Pressure: flush now instead of waiting for the tick, unless a retry wait is in force. */
    private kick(): void {
        if (this.flushing || (this.retryAtMs !== null && this.timers.now() < this.retryAtMs)) return;
        this.schedule(0);
    }

    private async tick(): Promise<void> {
        try {
            try {
                this.options.beforeFlush?.();
            } catch (error) {
                this.options.log.error('the pre-flush hook failed', { error: this.describe(error) });
            }
            const waiting = this.retryAtMs !== null && this.timers.now() < this.retryAtMs;
            if (!waiting) {
                for (let i = 0; i < this.maxBatchesPerTick && this.due; i++) {
                    const ok = await this.flush();
                    if (!ok) break;
                }
            }
        } catch (error) {
            // flushOnce already turns sink errors into a retry; anything here is a bug, and it must not end the process.
            this.options.log.error('the flush loop failed', { error: this.describe(error) });
        } finally {
            const untilRetry = this.retryAtMs !== null ? this.retryAtMs - this.timers.now() : this.flushEveryMs;
            this.schedule(Math.max(0, Math.min(this.flushEveryMs, untilRetry)));
        }
    }

    /** Releases the slots before `head` once they are a large share of the array. */
    private compact(): void {
        if (this.head > 0 && (this.head >= 1_024 || this.head * 2 >= this.queue.length)) {
            this.queue = this.queue.slice(this.head);
            this.head = 0;
        }
    }

    private take(n: number): Entry[] {
        const batch = this.queue.slice(this.head, this.head + n) as Entry[];
        for (let i = this.head; i < this.head + batch.length; i++) this.queue[i] = undefined;
        this.head += batch.length;
        for (const e of batch) if (e.slot !== null && this.slots.get(e.slot) === e) this.slots.delete(e.slot);
        this.compact();
        return batch;
    }

    /** Puts a failed batch back in front, keeping the order and the capacity bound. */
    private putBack(batch: Entry[]): void {
        const keep: Entry[] = [];
        for (const e of batch) {
            if (e.slot !== null) {
                const newer = this.slots.get(e.slot);
                // A copy of the same minute was queued meanwhile: merge into it rather than send two.
                if (newer && newer !== e) {
                    newer.row = mergeRest(newer.row as RestMinuteRow, e.row as RestMinuteRow);
                    continue;
                }
                this.slots.set(e.slot, e);
            }
            keep.push(e);
        }
        this.queue = [...keep, ...this.queue.slice(this.head)];
        this.head = 0;
        while (this.size > this.capacity) this.dropOldest();
    }

    private dropOldest(): void {
        const e = this.queue[this.head];
        if (!e) return;
        this.queue[this.head] = undefined;
        this.head += 1;
        if (e.slot !== null && this.slots.get(e.slot) === e) this.slots.delete(e.slot);
        this.dropped[e.table] += 1;
        this.compact();
        const total = Object.values(this.dropped).reduce((a, b) => a + b, 0);
        if (total === 1 || total % 1_000 === 0) {
            this.options.log.warn('the telemetry queue is full; dropping the oldest rows', { dropped: { ...this.dropped } });
        }
    }

    /**
     * The metadata to send with a batch: every unwritten row of a session in the batch (a batch of at most maxBatch rows
     * has at most maxBatch sessions), then other unwritten rows (an input that became known after its session's rows
     * were written), at most maxBatch in all.
     */
    private metadataFor(batch: readonly Entry[]): string[] {
        if (this.unwritten.size === 0) return [];
        const sessions = new Set(batch.map((e) => e.row.sessionId));
        const first: string[] = [];
        const rest: string[] = [];
        for (const key of this.unwritten) (sessions.has(this.metadata.get(key)!.row.sessionId) ? first : rest).push(key);
        return [...first, ...rest].slice(0, this.maxBatch);
    }

    private async flushOnce(): Promise<boolean> {
        // An empty queue with unwritten inputs still flushes: an input can become known after its rows were written.
        if (!this.due) return true;
        const batch = this.take(this.maxBatch);
        this.inFlight = batch.length;
        const byTable = new Map<TableName, Entry[]>();
        for (const e of batch) byTable.set(e.table, [...(byTable.get(e.table) ?? []), e]);
        const failed: Entry[] = [];
        let firstError: unknown = null;
        // Set when the metadata insert fails, which also fails a flush whose batch is empty (inputs only).
        let metaFailed = false;
        // Session metadata first, in the same flush: if it fails, none of the batch is sent, and the whole flush is
        // retried as one (the batch goes back to the queue, the metadata stays unwritten).
        const metaKeys = this.metadataFor(batch);
        const metaByTable = new Map<TableName, string[]>();
        for (const k of metaKeys) metaByTable.set(this.metadata.get(k)!.table, [...(metaByTable.get(this.metadata.get(k)!.table) ?? []), k]);
        try {
            for (const [table, keys] of metaByTable) {
                await this.options.sink.insert(table, keys.map((k) => this.metadata.get(k)!.row) as never);
                this.written[table] += keys.length;
                for (const k of keys) this.unwritten.delete(k);
            }
        } catch (error) {
            metaFailed = true;
            failed.push(...batch);
            firstError = error;
        }
        for (const table of metaFailed ? [] : TABLE_NAMES) {
            const entries = byTable.get(table);
            if (!entries || entries.length === 0) continue;
            try {
                await this.options.sink.insert(table, entries.map((e) => e.row) as never);
                this.written[table] += entries.length;
            } catch (error) {
                failed.push(...entries);
                firstError ??= error;
            }
        }
        if (failed.length === 0 && !metaFailed) {
            this.inFlight = 0;
            if (this.consecutiveFailures > 0) {
                this.options.log.info('Tiger is writable again', { afterFailures: this.consecutiveFailures, queued: this.size });
            }
            this.consecutiveFailures = 0;
            this.retryAtMs = null;
            this.lastWriteAtMs = this.timers.now();
            this.release(false);
            return true;
        }
        // Keep the original order among the failed rows.
        failed.sort((a, b) => batch.indexOf(a) - batch.indexOf(b));
        this.putBack(failed);
        this.inFlight = 0;
        this.failedFlushes += 1;
        this.consecutiveFailures += 1;
        this.lastError = this.describe(firstError);
        const wait = Math.min(this.retryMaxMs, this.retryMinMs * 2 ** Math.min(this.consecutiveFailures - 1, 16));
        this.retryAtMs = this.timers.now() + wait;
        if (this.consecutiveFailures === 1 || this.consecutiveFailures % 10 === 0) {
            this.options.log.warn('Tiger write failed; keeping the rows and retrying', {
                error: this.lastError,
                retryInMs: wait,
                queued: this.size,
                failures: this.consecutiveFailures,
            });
        }
        return false;
    }

    private release(all: boolean): void {
        if (!all && this.size > this.lowWater) return;
        const waiting = this.waiters;
        this.waiters = [];
        for (const w of waiting) w();
    }

    private describe(error: unknown): string {
        // The caller's redactor knows the real secrets; the fallback still strips any postgres URL's password.
        return this.options.describeError ? this.options.describeError(error) : safeMessage(error);
    }
}
