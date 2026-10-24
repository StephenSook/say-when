// The sidecar's only door to SpacetimeDB. Two implementations: MemoryDb (test/fake and offline runs) and the
// SpacetimeDB adapter (src/db/spacetime-db.ts). Everything else in the package talks to this interface.

import type { AgentConsent, AgentQueueRow, CallQueueRow, ErrandQueueRow, ReducerArgs, ReducerName } from '../types.js';

export interface AgentDb {
    /** The `agent_queue` view as it is now: Pending jobs plus jobs Claimed by this sidecar. */
    agentQueue(): readonly AgentQueueRow[];
    /** The `errand_queue` view: Confirmed errands plus Submitting errands claimed by this sidecar. */
    errandQueue(): readonly ErrandQueueRow[];
    /** The `call_queue` view: Confirmed calls plus calls claimed by this sidecar, each with its CONFIRM's time. */
    callQueue(): readonly CallQueueRow[];
    /**
     * The `agent_consent` view (module v2): the memory and web search consent the agent works under now, or null
     * when it is not known (no row, or a row that does not match the contract). Unknown never counts as consent.
     */
    agentConsent(): AgentConsent | null;
    /**
     * Calls `listener` at once (inside the update that carried it) for every `agent_consent` row the module sends with
     * memory consent off, so a revocation followed at once by a new grant is still seen. Also whenever the connection
     * or the subscription is lost: a revocation during the gap, given again before the views come back, would leave
     * nothing behind. Returns a function that removes it.
     */
    onMemoryOff(listener: () => void): () => void;
    /**
     * Calls `listener` after any change to the agent views, and only while the subscription is applied, so a
     * listener never acts on a half-replayed cache. Returns a function that removes it.
     */
    onChange(listener: () => void): () => void;
    /**
     * How many times the subscription has been applied (the first connection, then each reconnect). A change means
     * the views now hold a fresh snapshot, whose rows may be of any age.
     */
    syncCount(): number;
    /**
     * True while connected with the subscription applied, so the views hold the module's current state. While it is
     * false a revocation could be missing from them, and anything that checks consent must fail closed.
     */
    isCurrent(): boolean;
    /**
     * Resolves true once the connection is up and the subscription has been applied (now, or within `timeoutMs`),
     * and false if that does not happen in time.
     */
    ready(timeoutMs: number): Promise<boolean>;
    /** Calls one reducer. Rejects with DbCallError. */
    call<K extends ReducerName>(name: K, args: ReducerArgs[K]): Promise<void>;
}

/**
 * - `stale`: `SenderError('stale attempt')`. Another attempt owns the work now; drop it.
 * - `refused`: any other `SenderError`, for example `not pending` (someone else claimed the job).
 * - `disconnected`: the call was never sent (DisconnectedError). Safe to send again once connected.
 * - `unknown_result`: the connection dropped before the reply (UnknownCallResultError). The call may have run.
 * - `internal`: the module failed, or the reducer is missing from the bindings.
 */
export type DbErrorKind = 'stale' | 'refused' | 'disconnected' | 'unknown_result' | 'internal';

export class DbCallError extends Error {
    constructor(
        readonly kind: DbErrorKind,
        readonly reducer: string,
        message: string,
    ) {
        super(message);
        this.name = 'DbCallError';
    }
}

/**
 * Maps whatever a reducer call threw onto DbCallError. The spacetimedb error classes are matched by name as well
 * as by class, because generated bindings can load their own copy of the SDK (spacetime/node_modules), and
 * `instanceof` fails across two copies.
 */
export function toDbError(error: unknown, reducer: string): DbCallError {
    if (error instanceof DbCallError) return error;
    const name = error instanceof Error ? error.name : '';
    // The module's SenderError messages are fixed codes it writes itself (spacetime/src), never content.
    const message = error instanceof Error ? error.message : String(error);
    switch (name) {
        case 'SenderError':
            return new DbCallError(message === 'stale attempt' ? 'stale' : 'refused', reducer, message);
        case 'DisconnectedError':
            return new DbCallError('disconnected', reducer, 'not connected');
        case 'UnknownCallResultError':
            return new DbCallError('unknown_result', reducer, 'connection dropped before the reply');
        case 'InternalError':
            return new DbCallError('internal', reducer, 'module error');
        default:
            return new DbCallError('internal', reducer, 'unexpected error');
    }
}
