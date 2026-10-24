import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import type { DocumentInfo, MossClient, QueryResultDocumentInfo, SessionIndex, SnapshotInfo } from '@moss-js/moss';

import { emit, errorCode, failureDetail, isUsageLimitError, roundMs, type EventSink, type MossOp, type RetrieveCounts } from './events.js';

export type { SnapshotInfo } from '@moss-js/moss';

/** Every document carries kind, so one filter separates the person's memory from this run's web passages. */
export const KIND = { memory: 'memory', web: 'web' } as const;

/** A document as this package writes it. Field names from DocumentInfo in @moss-js/moss-core 0.36.0. */
export type MossDoc = Pick<DocumentInfo, 'id' | 'text' | 'metadata' | 'payload'>;

/**
 * A query hit. score is vector similarity from 0 to 1, and hits come back in Moss's hybrid order, which is not
 * score order (QueryResultDocumentInfo in @moss-js/moss-core 0.36.0).
 */
export type MossHit = Pick<QueryResultDocumentInfo, 'id' | 'text' | 'metadata' | 'score' | 'payload'>;

/** The conditions this package uses (docs.moss.dev, JS metadata filtering). The SDK itself types filter as any. */
export type MossCondition = { $eq: string } | { $in: string[] } | { $near: string };

export type MossFilter = { field: string; condition: MossCondition } | { $and: MossFilter[] } | { $or: MossFilter[] };

/** What a session query honors: the 1.21.0 wrapper forwards topK, alpha, filter and embedding, and drops minScore. */
export interface MossQueryOptions {
    topK?: number;
    alpha?: number;
    filter?: MossFilter;
}

export interface MossSearchResult {
    docs: MossHit[];
    /** Moss's own timing, when the SDK reports one. */
    timeTakenInMs?: number;
}

/**
 * The slice of SessionIndex this package calls, so tests can pass a fake. pushIndex and loadIndex are left out on
 * purpose: nothing here can upload the memory, load a cloud index, or start an auto-refresh poller.
 */
export interface MossSession {
    readonly name: string;
    addDocs(docs: MossDoc[]): Promise<{ added: number; updated: number }>;
    deleteDocs(docIds: string[]): Promise<number>;
    getDocs(): Promise<MossDoc[]>;
    query(text: string, options?: MossQueryOptions): Promise<MossSearchResult>;
    saveToDisk(cachePath: string): Promise<void>;
    loadFromDisk(cachePath: string): Promise<number>;
    inspectSnapshot(cachePath: string): Promise<SnapshotInfo>;
    close(): Promise<void>;
}

/** The slice of MossClient this package calls. */
export interface MossClientLike {
    session(indexName: string, modelId: 'moss-minilm'): Promise<MossSession>;
    close(): Promise<void>;
}

// Typecheck fails on these two lines if the pinned SDK stops fitting the slices above.
type Fits<T extends U, U> = T;
type SessionIndexFits = Fits<SessionIndex, MossSession>;
type MossClientFits = Fits<MossClient, MossClientLike>;

/** Timer functions, injectable so tests can fire the idle close by hand. */
export interface Timers {
    set(callback: () => void, ms: number): unknown;
    clear(handle: unknown): void;
}

const systemTimers: Timers = {
    set: (callback, ms) => setTimeout(callback, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const DEFAULT_SESSION_NAME = 'say-when';
export const DEFAULT_IDLE_CLOSE_MS = 3 * 60 * 1000;
const MIN_IDLE_CLOSE_MS = 10 * 1000;
const MAX_IDLE_CLOSE_MS = 15 * 60 * 1000;
const SETTLE_MS = 10 * 1000;
const SESSION_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export type RunErrorCode = 'config' | 'not_open' | 'already_open' | 'cancelled' | 'restart_needed';

export class MossRunError extends Error {
    constructor(
        readonly code: RunErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'MossRunError';
    }
}

/** Bad input to a memory or web call. Messages name the field, never its text. */
export class MossInputError extends Error {}

/**
 * A Moss call failed. The message holds only the step and Moss's error code, so it is safe to log. The SDK's own error
 * stays reachable as the non-enumerable `original` for debugging; it may carry document text, so never log it.
 */
export class MossCallError extends Error {
    readonly code: string;
    readonly usageLimit: boolean;
    declare readonly original: unknown;

    constructor(
        readonly op: MossOp,
        original: unknown,
    ) {
        super(failureDetail(op, original));
        this.name = 'MossCallError';
        this.code = errorCode(original);
        this.usageLimit = isUsageLimitError(original);
        Object.defineProperty(this, 'original', { value: original, enumerable: false });
    }
}

/** Errors this package raises hold no content already; anything else is wrapped so its text cannot reach a log. */
function sanitized(op: MossOp, error: unknown): Error {
    if (error instanceof MossRunError || error instanceof MossInputError || error instanceof MossCallError) return error;
    return new MossCallError(op, error);
}

export type CloseReason = 'stop' | 'idle' | 'error' | 'signal';

export interface StartInfo {
    sessionName: string;
    /** Memory documents restored from the local snapshot; 0 on the first run. */
    restored: number;
    firstRun: boolean;
    /** Wall time to open: credential check, model load and snapshot restore. */
    openMs: number;
}

export interface CloseInfo {
    reason: CloseReason;
    /** How long this run held the session, by this laptop's clock. The Moss portal is the bill. */
    heldMs: number;
    /** Web passages and anything else that is not memory, removed before saving. */
    purged: number;
    /** True when the memory snapshot was written. */
    saved: boolean;
    /** True when everything but memory was removed before saving. If not, the next start removes the rest. */
    memoryOnly: boolean;
    /** False only when the SDK's own close failed. New starts are then refused until the process restarts. */
    clientClosed: boolean;
}

export interface RunMeter {
    open: boolean;
    /** This run so far. */
    heldMs: number;
    /** Every run in this process, this one included. An estimate: the Moss portal is the bill. */
    totalHeldMs: number;
    runs: number;
}

export interface RunOptions {
    /** Where the MOSS_* settings and credentials are read. Defaults to process.env. */
    env?: Record<string, string | undefined>;
    /** Opens the client. Defaults to the real SDK; tests pass a fake. */
    connect?: (projectId: string, projectKey: string) => Promise<MossClientLike>;
    onEvent?: EventSink;
    timers?: Timers;
    now?: () => number;
}

interface RunConfig {
    sessionName: string;
    snapshotDir: string;
    idleCloseMs: number;
}

interface OpenRun {
    client: MossClientLike;
    session: MossSession;
    config: RunConfig;
    openedAt: number;
}

export interface OpResult<T> {
    value: T;
    counts?: RetrieveCounts;
}

const notOpen = (): MossRunError => new MossRunError('not_open', 'Moss is not open. Press Start to open a run.');
const alreadyOpen = (): MossRunError => new MossRunError('already_open', 'A Moss run is already open. Close it before starting another.');
const restartNeeded = (): MossRunError =>
    new MossRunError('restart_needed', 'Moss may still hold a session it could not close. Restart the agent process before starting Moss again.');

/**
 * One demo run's Moss session. Moss bills session minutes for as long as a process holds a session, so nothing opens
 * until start(), every exit path closes, and the run closes by itself after idleCloseMs without a Moss call.
 */
export class MossRun {
    private current: OpenRun | null = null;
    private starting: Promise<StartInfo> | null = null;
    private closing: Promise<CloseInfo> | null = null;
    private stopWanted = false;
    private broken = false;
    private idle: unknown = null;
    private readonly inflight = new Set<Promise<unknown>>();
    private heldBefore = 0;
    private runs = 0;
    private readonly timers: Timers;
    private readonly now: () => number;

    constructor(private readonly options: RunOptions = {}) {
        this.timers = options.timers ?? systemTimers;
        this.now = options.now ?? Date.now;
    }

    get isOpen(): boolean {
        return this.current !== null && this.closing === null;
    }

    /** Counts successful starts, so callers can drop state that belonged to an earlier run. */
    get generation(): number {
        return this.runs;
    }

    /** Throws MossRunError not_open unless the run is open. */
    assertOpen(): void {
        if (!this.isOpen) throw notOpen();
    }

    /** Opens the session for one demo run. The only call in this package that starts billed session time. */
    start(): Promise<StartInfo> {
        if (this.starting) return Promise.reject(new MossRunError('already_open', 'Moss is already starting.'));
        if (this.current && !this.closing) return Promise.reject(alreadyOpen());
        this.stopWanted = false;
        // open() starts on the next tick, so this.starting is set before anything it calls can call back into the run.
        this.starting = Promise.resolve()
            .then(() => this.open())
            .finally(() => {
                this.starting = null;
                this.stopWanted = false;
            });
        return this.starting;
    }

    /**
     * Saves the memory and closes the session. Safe to call twice; resolves to null when nothing was open.
     * It never rejects: failures come back in CloseInfo and as an error event.
     */
    close(reason: CloseReason = 'stop'): Promise<CloseInfo | null> {
        if (this.starting) {
            // Stop wins over a start still under way: one that has not connected yet gives up, one that has is closed.
            // Either way Stop then closes whatever is open.
            this.stopWanted = true;
            const again = (): Promise<CloseInfo | null> => this.close(reason);
            return this.starting.then(again, again);
        }
        if (this.closing) return this.closing;
        const run = this.current;
        if (!run) return Promise.resolve(null);
        this.closing = this.shut(run, reason).finally(() => {
            this.closing = null;
        });
        return this.closing;
    }

    /** Runs one Moss call on the open session, with events, timing and the idle clock. Used by MemoryStore and WebIndex. */
    async op<T>(name: MossOp, work: (session: MossSession) => Promise<OpResult<T>>): Promise<T> {
        const run = this.current;
        if (!run || this.closing) throw notOpen();
        this.touch();
        this.event(name, 'started', null);
        const started = performance.now();
        const pending = Promise.resolve().then(() => work(run.session));
        this.inflight.add(pending);
        try {
            const { value, counts } = await pending;
            this.event(name, 'ok', roundMs(performance.now() - started), counts);
            return value;
        } catch (error) {
            this.event(name, 'error', roundMs(performance.now() - started), undefined, error);
            throw sanitized(name, error);
        } finally {
            this.inflight.delete(pending);
            if (this.isOpen) this.touch();
        }
    }

    /** This process's count of session time, for the operator console's Moss meter. */
    meter(): RunMeter {
        const heldMs = this.current ? this.now() - this.current.openedAt : 0;
        return { open: this.isOpen, heldMs, totalHeldMs: this.heldBefore + heldMs, runs: this.runs };
    }

    /** What the saved snapshot holds (doc count, vector size, model), for "the memory never leaves this laptop". */
    async snapshotInfo(): Promise<SnapshotInfo | null> {
        const config = this.current?.config;
        if (!config) throw notOpen();
        if (!existsSync(join(config.snapshotDir, config.sessionName))) return null;
        return this.op('inspect snapshot', async (session) => {
            const info = await session.inspectSnapshot(config.snapshotDir);
            return { value: info, counts: { docs: info.docCount } };
        });
    }

    private async open(): Promise<StartInfo> {
        if (this.closing) await this.closing;
        if (this.broken) throw restartNeeded();
        if (this.stopWanted) throw new MossRunError('cancelled', 'Stop came before Moss opened, so it did not open.');
        if (this.current) throw alreadyOpen();
        const { config, projectId, projectKey } = readConfig(this.options.env ?? process.env);
        const openedAt = this.now();
        const started = performance.now();
        this.event('open session', 'started', null);
        let client: MossClientLike | null = null;
        let opening = false;
        try {
            client = await (this.options.connect ?? connectMoss)(projectId, projectKey);
            // Checks the credentials with the Moss cloud and loads the embedding model. In 1.21.0 the session is
            // registered with the client only after the model loads (dist/index.esm.js, MossClient.session), so if the
            // load throws, client.close() cannot reach that session and it lives until garbage collection.
            opening = true;
            const session = await client.session(config.sessionName, 'moss-minilm');
            opening = false;
            // Moss reports a missing and a damaged snapshot with the same code, so a first run is told apart on disk.
            // A damaged snapshot then fails the start instead of being replaced by an empty memory at close.
            const firstRun = !existsSync(join(config.snapshotDir, config.sessionName));
            const loaded = firstRun ? 0 : await session.loadFromDisk(config.snapshotDir);
            // A close that could not remove its web passages saved them anyway; they go before anything reads memory.
            const purged = loaded > 0 ? await purgeNonMemory(session) : 0;
            const restored = loaded - purged;
            this.current = { client, session, config, openedAt };
            this.runs += 1;
            this.touch();
            const openMs = roundMs(performance.now() - started);
            this.event('open session', 'ok', openMs, purged > 0 ? { restored, purged } : { restored });
            return { sessionName: config.sessionName, restored, firstRun, openMs };
        } catch (error) {
            this.event('open session', 'error', roundMs(performance.now() - started), undefined, error);
            // From outside the SDK a failed credential check and a failed model load look the same, and the second can
            // leave a session nothing here can close, so a failed session open also asks for a process restart.
            if (opening) this.broken = true;
            if (client) {
                this.heldBefore += this.now() - openedAt;
                try {
                    await client.close();
                } catch {
                    this.broken = true;
                    console.warn('moss: closing the client after a failed start also failed');
                }
            }
            throw sanitized('open session', error);
        }
    }

    private async shut(run: OpenRun, reason: CloseReason): Promise<CloseInfo> {
        this.clearIdle();
        this.event('close session', 'started', null);
        const started = performance.now();
        let purged = 0;
        let saved = false;
        let memoryOnly = false;
        let clientClosed = false;
        let failure: { error: unknown } | null = null;
        try {
            await this.settle();
            try {
                purged = await purgeNonMemory(run.session);
                memoryOnly = true;
            } catch (error) {
                // Saving anyway keeps this run's confirmed replies. The leftover public passages go at the next start.
                failure = { error };
            }
            try {
                await run.session.saveToDisk(run.config.snapshotDir);
                saved = true;
            } catch (error) {
                failure ??= { error };
            }
        } finally {
            try {
                await run.client.close(); // also closes the session
                clientClosed = true;
            } catch (error) {
                failure ??= { error };
                // The SDK keeps a failed close's promise, so it cannot be retried, and a new client would hold a second
                // session beside whatever this one left open. Starts are refused until the process restarts.
                this.broken = true;
            }
            this.current = null;
        }
        const heldMs = this.now() - run.openedAt;
        this.heldBefore += heldMs;
        this.event('close session', failure ? 'error' : 'ok', roundMs(performance.now() - started), { purged, heldMs }, failure?.error);
        return { reason, heldMs, purged, saved, memoryOnly, clientClosed };
    }

    /** Waits for calls already under way, so a reply confirmed a moment ago is in the snapshot. Never waits forever. */
    private async settle(): Promise<void> {
        if (this.inflight.size === 0) return;
        let handle: unknown = null;
        const cap = new Promise<void>((resolve) => {
            handle = this.timers.set(resolve, SETTLE_MS);
        });
        await Promise.race([Promise.allSettled([...this.inflight]), cap]);
        this.timers.clear(handle);
    }

    private touch(): void {
        const run = this.current;
        if (!run) return;
        this.clearIdle();
        this.idle = this.timers.set(() => {
            this.idle = null;
            void this.close('idle');
        }, run.config.idleCloseMs);
    }

    private clearIdle(): void {
        if (this.idle === null) return;
        this.timers.clear(this.idle);
        this.idle = null;
    }

    private event(op: MossOp, status: 'started' | 'ok' | 'error', ms: number | null, counts?: RetrieveCounts, error?: unknown): void {
        emit(this.options.onEvent, {
            stage: 'retrieve',
            status,
            detail: status === 'error' ? failureDetail(op, error) : op,
            ms,
            ...(counts ? { counts } : {}),
        });
    }
}

/** Removes every document that is not memory, so the snapshot holds the person's memory and nothing else. */
async function purgeNonMemory(session: MossSession): Promise<number> {
    const docs = await session.getDocs();
    const ids = docs.filter((doc) => doc.metadata?.kind !== KIND.memory).map((doc) => doc.id);
    return ids.length > 0 ? session.deleteDocs(ids) : 0;
}

function readConfig(env: Record<string, string | undefined>): { config: RunConfig; projectId: string; projectKey: string } {
    const projectId = env.MOSS_PROJECT_ID?.trim() ?? '';
    const projectKey = env.MOSS_PROJECT_KEY?.trim() ?? '';
    if (!projectId || !projectKey) {
        throw new MossRunError('config', 'Set MOSS_PROJECT_ID and MOSS_PROJECT_KEY in the environment to start Moss.');
    }
    const snapshotDir = env.MOSS_SNAPSHOT_DIR?.trim() ?? '';
    if (!isAbsolute(snapshotDir)) {
        throw new MossRunError('config', 'Set MOSS_SNAPSHOT_DIR to an absolute folder on this laptop for the memory snapshot.');
    }
    // Moss telemetry sends the session name as typed, so it stays neutral, and it names a folder, so no paths.
    const sessionName = env.MOSS_SESSION_NAME?.trim() || DEFAULT_SESSION_NAME;
    if (!SESSION_NAME.test(sessionName)) {
        throw new MossRunError('config', 'MOSS_SESSION_NAME must be 1 to 40 lowercase letters, digits or dashes.');
    }
    const rawIdle = env.MOSS_IDLE_CLOSE_MS?.trim();
    const idleCloseMs = rawIdle ? Number(rawIdle) : DEFAULT_IDLE_CLOSE_MS;
    if (!Number.isInteger(idleCloseMs) || idleCloseMs < MIN_IDLE_CLOSE_MS || idleCloseMs > MAX_IDLE_CLOSE_MS) {
        throw new MossRunError('config', `MOSS_IDLE_CLOSE_MS must be a whole number from ${MIN_IDLE_CLOSE_MS} to ${MAX_IDLE_CLOSE_MS}.`);
    }
    return { config: { sessionName, snapshotDir, idleCloseMs }, projectId, projectKey };
}

/** The real SDK client. It is imported here, on start, so tests that pass a fake never load the native binding. */
export async function connectMoss(projectId: string, projectKey: string): Promise<MossClientLike> {
    const { MossClient } = await import('@moss-js/moss');
    return new MossClient(projectId, projectKey);
}

/** Opens a run, hands it to work, and always closes it, even when work throws. */
export async function withRun<T>(options: RunOptions, work: (run: MossRun) => Promise<T>): Promise<T> {
    const run = new MossRun(options);
    await run.start();
    let finished = false;
    try {
        const value = await work(run);
        finished = true;
        return value;
    } finally {
        await run.close(finished ? 'stop' : 'error');
    }
}

/** The parts of process that closeOnSignals uses, so tests can pass a stand-in. */
export interface SignalTarget {
    once(event: 'SIGINT' | 'SIGTERM', listener: (signal: NodeJS.Signals) => void): unknown;
    off(event: 'SIGINT' | 'SIGTERM', listener: (signal: NodeJS.Signals) => void): unknown;
    exit(code: number): void;
}

/**
 * Closes the run on Ctrl-C or SIGTERM, then exits; a second Ctrl-C exits at once. Returns a function that removes
 * the handlers. If the agent has its own shutdown, call run.close() from it instead.
 */
export function closeOnSignals(run: MossRun, target: SignalTarget = process): () => void {
    const onSignal = (signal: NodeJS.Signals): void => {
        void run.close('signal').finally(() => target.exit(signal === 'SIGINT' ? 130 : 143));
    };
    target.once('SIGINT', onSignal);
    target.once('SIGTERM', onSignal);
    return () => {
        target.off('SIGINT', onSignal);
        target.off('SIGTERM', onSignal);
    };
}
