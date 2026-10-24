// How the sidecar calls a reducer when the network is not perfect (docs/spacetime.md 7.4 step 8).
//
// - A call that was never sent (disconnected) is sent again once the connection is back. Always safe.
// - A call whose reply was lost (unknown result) may have run. Idempotent writes are sent again with the same
//   arguments. Claims are not idempotent, so for them the caller passes `verify`, which reads the views to see
//   whether the claim took effect, and the call is sent again only when it clearly did not.
// - A refusal (SenderError) is final and is returned to the caller, never retried.

import type { ReducerArgs, ReducerName } from '../types.js';
import { DbCallError, toDbError, type AgentDb, type DbErrorKind } from './db.js';

export type Verified = 'applied' | 'not_applied' | 'unclear';

export interface RetryOptions {
    /** What a lost reply means for this reducer: `repeat` for idempotent writes, `verify` for claims. */
    onUnknown: 'repeat' | 'verify';
    /** Required with `verify`: reads the views after the connection is back. */
    verify?: () => Verified;
    /** Total tries, the first included. Default 3. */
    attempts?: number;
    /** How long to wait for the connection to come back before giving up. Default 15 s. */
    readyTimeoutMs?: number;
    /** Wait after reconnecting before `verify` reads the views, so the replayed subscription can land. Default 250 ms. */
    settleMs?: number;
    /** Read before every try: false stops the call before it is sent, with kind `withdrawn`. */
    beforeTry?: () => boolean;
    sleep?: (ms: number) => Promise<void>;
}

export type CallOutcome =
    | { ok: true; /** A previous try's reply was lost before this one succeeded or was verified. */ uncertain: boolean }
    | { ok: false; kind: DbErrorKind | 'gave_up' | 'withdrawn'; message: string; uncertain: boolean };

/** How many rounds of `callReducer` an errand or call claim gets when no try of it ever reached the module. */
export const MAX_CLAIM_TRIES = 3;

/**
 * True only when no try of the call can have reached the module: every try failed before it was sent. Sending it
 * again later is then safe, even for a claim. A lost reply anywhere in the rounds makes this false.
 */
export function neverSent(outcome: CallOutcome): boolean {
    return !outcome.ok && (outcome.kind === 'disconnected' || outcome.kind === 'gave_up') && !outcome.uncertain;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Calls a reducer under the policy above. Never throws: every path comes back as a CallOutcome. */
export async function callReducer<K extends ReducerName>(db: AgentDb, name: K, args: ReducerArgs[K], options: RetryOptions): Promise<CallOutcome> {
    const attempts = Math.max(1, options.attempts ?? 3);
    const readyTimeoutMs = options.readyTimeoutMs ?? 15_000;
    const settleMs = options.settleMs ?? 250;
    const sleep = options.sleep ?? defaultSleep;
    let uncertain = false;
    let last: DbCallError | null = null;
    for (let tryNo = 1; tryNo <= attempts; tryNo++) {
        if (options.beforeTry && !options.beforeTry()) return { ok: false, kind: 'withdrawn', message: 'not sent: no longer allowed', uncertain };
        try {
            await db.call(name, args);
            return { ok: true, uncertain };
        } catch (thrown) {
            const error = toDbError(thrown, name);
            last = error;
            if (error.kind === 'stale' || error.kind === 'refused' || error.kind === 'internal') {
                return { ok: false, kind: error.kind, message: error.message, uncertain };
            }
            if (error.kind === 'unknown_result') uncertain = true;
            const up = await db.ready(readyTimeoutMs);
            if (!up) return { ok: false, kind: 'disconnected', message: 'no connection', uncertain };
            if (error.kind === 'unknown_result' && options.onUnknown === 'verify') {
                await sleep(settleMs);
                const verdict = options.verify?.() ?? 'unclear';
                if (verdict === 'applied') return { ok: true, uncertain };
                if (verdict === 'unclear') return { ok: false, kind: 'unknown_result', message: 'could not tell whether the call ran', uncertain };
                // Not applied: the lost call did not run, so sending it again is safe.
            }
        }
    }
    return { ok: false, kind: 'gave_up', message: last ? last.message : 'no attempts', uncertain };
}
