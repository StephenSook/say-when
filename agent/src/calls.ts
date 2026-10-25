// The call path (stretch; PLAN D4 and D11, docs/spacetime.md 4.4 and 7.4 step 7).
//
// - A call option was prepared by the Dialer when the planner offered it, so its read-back and digest exist.
// - The module shows the call Confirmed in `call_queue` after the read-back and a fresh CONFIRM, with the CONFIRM's
//   time (`confirmed_at`, module v2). The sidecar claims it with the digest, then calls
//   `dialer.place(requestId, digest, confirmedAtMs)`. The Dialer re-checks consent, the do-not-call list and the
//   holds before it dials. There is no calling-hours limit (PLAN D20).
// - Freshness, in three places:
//   1. The module: `claim_call` refuses a CONFIRM CALL_CLAIM_MS (12 s) old or older with `confirm expired`, and its
//      ConfirmWindow timer then stops the call itself (`confirm_expired`). That refusal is final here: the call is
//      never claimed again, never dialed, and the module, not the sidecar, reports it.
//   2. This sidecar, right before the dial, after the claim: it dials only if two clocks say the CONFIRM is recent.
//      a. The module's: the CONFIRM's time from `call_queue`, at most CONFIRM_MAX_AGE_MS old by this laptop's
//         clock. Unknown, or ahead of this clock by more than CLOCK_SKEW_MS (the clocks disagree), counts as not
//         recent.
//      b. This sidecar's: at most CONFIRM_TO_PLACE_MS since it first saw the call Confirmed. A Confirmed call that
//         was already there when the views were loaded (startup or a reconnect) is of unknown age.
//      A call that is not recent is claimed and reported refused, never dialed; the person hears why and can ask
//      again. A placed call that has not dialed by CONFIRM_TO_DIAL_MS after the CONFIRM is cancelled
//      (watchDialDeadline).
//   3. The Dialer, which is given the CONFIRM's time with `place()` for its own window.
// - Ringing, connected and the end are reported in order; transcript lines (numbers already masked by the Dialer)
//   go to the private `call_line` table. The final report carries the Dialer's sentence for how the call ended, and
//   a held contact's hold sentence with its code (finalReport), which the module keeps since v2 and shows as
//   `board_calls.held`.
// - STOP, HEADSET_OFF, the idle pause or an operator set `cancel_requested`: the sidecar calls
//   `dialer.cancelActive(reason)`, or never dials if the call was not placed yet. One CONFIRM, one call, no retries.
// - A claim that provably never reached the module (the connection was down for every try) is tried again on a
//   later look, at most MAX_CLAIM_TRIES rounds. The freshness rule still applies to it.

import type { CancelReason } from '@say-when/cartesia/server';

import { LIMITS } from './contract.js';
import type { AgentDb } from './db/db.js';
import { callReducer, MAX_CLAIM_TRIES, neverSent, type Verified } from './db/retry.js';
import type { Logger } from './log.js';
import type { CallOutcome, CallSnapshot, DialerPort } from './ports.js';
import type { CallQueueRow, ReducerArgs } from './types.js';

type Report = Omit<ReducerArgs['reportCallStatus'], 'callId' | 'attempt'>;

const CANCEL_REASONS: readonly CancelReason[] = ['stop', 'headset_off', 'auto_pause', 'operator'];

/** How long after this sidecar first sees a Confirmed call it may still place it (see the header). */
export const CONFIRM_TO_PLACE_MS = 10_000;

/**
 * The oldest a CONFIRM may be when the call is placed, by the module's clock: the module's own claim window
 * (`CALL_CLAIM_MS` in spacetime/src/consent.ts, checked by test/contract.test.ts). After `place()` the Dialer still
 * checks its Cartesia agent and voice (two requests, with 10 s and 15 s timeouts) and writes its hold file before it
 * dials. So a placed call is also watched: if it has not dialed by CONFIRM_TO_DIAL_MS after the CONFIRM (less
 * CLOCK_SKEW_MS), the sidecar cancels it, and the Dialer's last check before its outbound request stops it.
 */
export const CONFIRM_MAX_AGE_MS = 12_000;

/** The latest a call may dial after its CONFIRM, by the module's clock: the Dialer's own 30 s window. */
export const CONFIRM_TO_DIAL_MS = 30_000;

/** How far the module's clock may run ahead of this laptop's before the CONFIRM's time is not trusted. */
export const CLOCK_SKEW_MS = 5_000;

/** Spoken when a confirmed call is refused because too much time passed. At most 300 characters. */
export const EXPIRED_SAY = 'Too much time passed after you confirmed, so I did not call. Ask again if you still want the call.';

/** Spoken when the time of the CONFIRM cannot be checked. At most 300 characters. */
export const UNCHECKED_SAY = 'I could not check when you confirmed, so I did not call. Ask again if you still want the call.';

/** Spoken when the connection to the module was down at the moment of the dial. At most 300 characters. */
export const OFFLINE_SAY = 'I lost the connection, so I did not call. Ask again if you still want the call.';

/** A STOP that arrived while the claim was out: the Dialer's own sentence for a call cancelled before it dialed. */
export const CANCELLED_SAY = 'Cancelled. No call was made.';

export function cancelReasonOf(value: string): CancelReason {
    return (CANCEL_REASONS as readonly string[]).includes(value) ? (value as CancelReason) : 'operator';
}

/**
 * The final report for a Dialer outcome. `reason` is the Dialer's sentence for how the call ended (the name in it
 * stays in the module's private call row). When the Dialer put the contact on hold (`held`: a possible refusal was
 * heard, the end is unknown, or the hold file could not be written), that sentence ends "Calls to <name> are on hold
 * until someone checks.", and an ended call also carries `opt_out_hold` or `hold_file_error`. The module keeps the
 * reason of every final report since v2, and shows the hold as `board_calls.held` (spacetime/src/consent.ts isHeld).
 */
export function finalReport(outcome: CallOutcome): Report {
    const endReason = (outcome.endReason ?? '').slice(0, LIMITS.endReason);
    const spoken = outcome.spoken.slice(0, LIMITS.reason);
    switch (outcome.result) {
        case 'refused':
            return {
                status: 'refused',
                result: 'refused',
                endReason,
                reasonCode: (outcome.refusal?.code ?? 'refused').slice(0, LIMITS.reasonCode),
                reason: outcome.held ? spoken : (outcome.refusal?.reason ?? outcome.spoken).slice(0, LIMITS.reason),
            };
        case 'failed':
            return { status: 'failed', result: 'failed', endReason, reasonCode: 'call_failed', reason: outcome.spoken.slice(0, LIMITS.reason) };
        case 'unknown':
            return {
                status: 'failed',
                result: 'unknown',
                endReason,
                reasonCode: outcome.dialed === 'unknown' ? 'dial_unknown' : 'end_unknown',
                reason: outcome.spoken.slice(0, LIMITS.reason),
            };
        default:
            return {
                status: 'ended',
                result: outcome.result,
                endReason,
                // On hold after a call that went through: a possible refusal was heard, or the hold file failed.
                reasonCode: outcome.held ? (outcome.optedOut ? 'opt_out_hold' : 'hold_file_error') : '',
                reason: spoken,
            };
    }
}

/** The sentence for a call cancelled for lateness, with the Dialer's hold sentence when it put the contact on hold. */
export function lateReason(outcome: CallOutcome): string {
    if (!outcome.held) return EXPIRED_SAY;
    const hold = /Calls to [^.]{1,80} are on hold until someone checks\./.exec(outcome.spoken)?.[0] ?? outcome.spoken;
    return `${EXPIRED_SAY} ${hold}`.slice(0, LIMITS.reason);
}

/** Cartesia's transcript roles: `assistant` is the agent; anything else is the person called. */
export function lineRole(role: string): 'assistant' | 'recipient' {
    return role === 'assistant' || role === 'agent' ? 'assistant' : 'recipient';
}

interface ActiveCall {
    callId: bigint;
    attempt: number;
    requestId: string;
    /** Reports go out one at a time, in order. */
    chain: Promise<void>;
    /** 0 dialing, 1 ringing reported, 2 connected reported. */
    phase: number;
    linesSent: number;
    placed: boolean;
    cancelled: boolean;
    /** The Dialer reported the call's id, so its outbound request went out. */
    dialed: boolean;
    /** The sidecar cancelled it because it had not dialed in time after the CONFIRM. */
    late: boolean;
}

export interface CallRunnerDeps {
    db: AgentDb;
    dialer: DialerPort | null;
    log: Logger;
    /** Monotonic clock in milliseconds (performance.now in the sidecar). */
    clock: () => number;
    /** Wall clock, ms since the epoch (Date.now), compared with the module's CONFIRM time. */
    now: () => number;
    /** Default CONFIRM_TO_PLACE_MS. */
    confirmToPlaceMs?: number;
    /** Default CONFIRM_TO_DIAL_MS. */
    confirmToDialMs?: number;
    /** Default CLOCK_SKEW_MS. */
    clockSkewMs?: number;
    /** How long to wait before looking again after a claim that never reached the module. Default 1 s. */
    retryMs?: number;
}

type Claimed = { ok: true; attempt: number } | { ok: false; final: boolean };

export class CallRunner {
    /** Calls handled for good: dialed, refused, cancelled, or a claim that was refused or may have landed. */
    private readonly decided = new Set<string>();
    /** Calls being claimed or run now. */
    private readonly inflight = new Set<string>();
    /** When this sidecar first saw each call (monotonic ms), or null when it was already there at a (re)load. */
    private readonly firstSeen = new Map<string, number | null>();
    /** Claim rounds that never reached the module, by call id. */
    private readonly tries = new Map<string, number>();
    /** Calls whose claim met `line busy`: they wait for the next change to the views, not for a timer. */
    private readonly waitingForLine = new Set<string>();
    /** Confirmed calls skipped by a look at the views because their claim was out: that look is owed to them. */
    private readonly missedLook = new Set<string>();
    /** By request id, which is what the Dialer's snapshots carry. */
    private readonly active = new Map<string, ActiveCall>();
    private readonly running = new Set<Promise<void>>();
    /** The view load (`syncCount`) seen by the last look; null before the first look. */
    private sync: number | null = null;
    private wake: (() => void) | null = null;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private stopped = false;

    constructor(private readonly deps: CallRunnerDeps) {}

    /** What to call to look at the views again (the orchestrator's tick). */
    setWake(wake: () => void): void {
        this.wake = wake;
    }

    /** Called on every change to the views. */
    reconcile(rows: readonly CallQueueRow[]): void {
        const sync = this.deps.db.syncCount();
        // The first look after the views were (re)loaded: rows already there are of unknown age.
        const reloaded = sync !== this.sync;
        this.sync = sync;
        const now = this.deps.clock();
        const present = new Set<string>();
        for (const row of rows) {
            const key = row.callId.toString();
            present.add(key);
            if (!this.firstSeen.has(key)) this.firstSeen.set(key, reloaded ? null : now);
            if (row.status === 'confirmed' && !this.decided.has(key) && this.inflight.has(key)) this.missedLook.add(key);
            if (row.status === 'confirmed' && !this.decided.has(key) && !this.inflight.has(key)) {
                if (this.deps.dialer && !this.stopped) this.start(row, key);
                continue;
            }
            if (row.cancelRequested) this.cancel(row);
        }
        // A call never returns to Confirmed, so rows that left the view are forgotten.
        for (const key of [...this.firstSeen.keys()]) {
            if (!present.has(key) && !this.inflight.has(key)) {
                this.firstSeen.delete(key);
                this.tries.delete(key);
                this.waitingForLine.delete(key);
            }
        }
    }

    /** The Dialer's onUpdate: phase changes and transcript lines for the call it is running. */
    onSnapshot(snapshot: CallSnapshot): void {
        const call = this.active.get(snapshot.requestId);
        if (!call) return;
        if (snapshot.callId || snapshot.phase === 'ringing' || snapshot.phase === 'connected') call.dialed = true;
        if (snapshot.phase === 'ringing' && call.phase < 1) {
            call.phase = 1;
            this.enqueue(call, { status: 'ringing', result: '', endReason: '', reasonCode: '', reason: '' });
        }
        if (snapshot.phase === 'connected' && call.phase < 2) {
            call.phase = 2;
            this.enqueue(call, { status: 'connected', result: '', endReason: '', reasonCode: '', reason: '' });
        }
        for (let i = call.linesSent; i < snapshot.transcript.length; i++) {
            const line = snapshot.transcript[i];
            if (!line) continue;
            const text = line.text.replace(/\s+/g, ' ').trim().slice(0, LIMITS.callLineText);
            call.linesSent = i + 1;
            if (!text) continue;
            const args = { callId: call.callId, attempt: call.attempt, lineKey: `${call.callId}:${call.attempt}:${i}`, role: lineRole(line.role), text };
            call.chain = call.chain.then(async () => {
                const outcome = await callReducer(this.deps.db, 'addCallLine', args, { onUnknown: 'repeat' });
                if (!outcome.ok) this.deps.log.warn('a call transcript line was not written', { call: call.callId, why: outcome.kind });
            });
        }
    }

    async drain(timeoutMs: number): Promise<void> {
        if (this.running.size === 0) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([Promise.allSettled([...this.running]), new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
        clearTimeout(timer);
    }

    /** Hangs up whatever is live (sidecar shutdown). */
    hangUpAll(reason: CancelReason): void {
        if (this.active.size > 0) this.deps.dialer?.cancelActive(reason);
    }

    /** Starts no new call (sidecar shutdown). A call under way goes on until it ends or is hung up. */
    stop(): void {
        this.stopped = true;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
    }

    private cancel(row: CallQueueRow): void {
        for (const call of this.active.values()) {
            if (call.callId !== row.callId || call.cancelled) continue;
            call.cancelled = true;
            if (call.placed) {
                this.deps.log.info('cancelling the call', { call: row.callId, reason: cancelReasonOf(row.cancelReason) });
                this.deps.dialer?.cancelActive(cancelReasonOf(row.cancelReason));
            }
        }
    }

    private enqueue(call: ActiveCall, report: Report): void {
        call.chain = call.chain.then(async () => {
            const outcome = await callReducer(this.deps.db, 'reportCallStatus', { callId: call.callId, attempt: call.attempt, ...report }, { onUnknown: 'repeat' });
            if (!outcome.ok && !(outcome.kind === 'stale' && outcome.uncertain)) {
                this.deps.log.warn('a call status was not recorded', { call: call.callId, status: report.status, why: outcome.kind });
            }
        });
    }

    private start(row: CallQueueRow, key: string): void {
        this.inflight.add(key);
        const work = this.run(row, key)
            .catch((error: unknown) => {
                this.deps.log.error('call handling crashed', { call: row.callId, why: error instanceof Error ? error.name : 'error' });
                return true;
            })
            .then((final) => {
                this.inflight.delete(key);
                const missed = this.missedLook.delete(key);
                if (final) {
                    this.decided.add(key);
                    this.tries.delete(key);
                    this.waitingForLine.delete(key);
                } else if (!this.waitingForLine.has(key)) this.retryLater();
                // The views changed while the claim was out (the line may be free now): look again at once.
                else if (missed && !this.stopped) this.wake?.();
            });
        this.running.add(work);
        void work.finally(() => this.running.delete(work));
    }

    /** Looks at the views again shortly. While the connection is down, the reconnect itself brings the next look. */
    private retryLater(): void {
        if (this.stopped || this.retryTimer) return;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            void this.deps.db.ready(0).then((up) => {
                if (up && !this.stopped) this.wake?.();
            });
        }, this.deps.retryMs ?? 1_000);
        this.retryTimer.unref?.();
    }

    private async claim(row: CallQueueRow, key: string): Promise<Claimed> {
        const expected = row.claimAttempt + 1;
        const verify = (): Verified => {
            const now = this.deps.db.callQueue().find((r) => r.callId === row.callId);
            if (now && now.status === 'dialing' && now.claimedByMe && now.claimAttempt === expected) return 'applied';
            if (now && now.status === 'confirmed' && now.claimAttempt === row.claimAttempt) return 'not_applied';
            return 'unclear';
        };
        const outcome = await callReducer(this.deps.db, 'claimCall', { callId: row.callId, digest: row.scriptDigest }, { onUnknown: 'verify', verify });
        if (outcome.ok) {
            this.waitingForLine.delete(key);
            return { ok: true, attempt: expected };
        }
        if (outcome.kind === 'refused' && outcome.message === 'line busy') {
            // One call at a time (spacetime/src/consent.ts): while another call is live, the claim is refused and
            // nothing changes in the module. The call is looked at again at the next change to the views (the live
            // call ending is one); by then the freshness checks decide whether it may still be placed.
            if (!this.waitingForLine.has(key)) this.deps.log.info('another call is live; this one waits for the line', { call: row.callId });
            this.waitingForLine.add(key);
            return { ok: false, final: false };
        }
        this.waitingForLine.delete(key);
        if (outcome.kind === 'refused' && outcome.message === 'confirm expired') {
            // Module v2: the CONFIRM is CALL_CLAIM_MS old or older (checked before `line busy`). Final: the call is
            // never claimed again or dialed, and the module stops it itself (`confirm_expired`) when its timer runs.
            this.deps.log.info('the module refused the call claim because the confirm is too old; the module stops the call', {
                call: row.callId,
                code: 'confirm_expired',
            });
            return { ok: false, final: true };
        }
        const tries = (this.tries.get(key) ?? 0) + 1;
        this.tries.set(key, tries);
        const again = neverSent(outcome) && tries < MAX_CLAIM_TRIES;
        this.deps.log.warn(again ? 'the call claim never reached the module; it will be tried again' : 'the call could not be claimed', {
            call: row.callId,
            why: outcome.kind,
            tries,
        });
        return { ok: false, final: !again };
    }

    /**
     * Cancels a placed call that has not dialed by CONFIRM_TO_DIAL_MS after its CONFIRM (by the module's clock, less
     * the allowed clock difference). The Dialer still checks its agent and voice after `place()`; its own 30 s window
     * runs from the CONFIRM's time (or from `place()` when that is earlier) and is checked again right before its
     * outbound request. This timer is a second guard on the time from the CONFIRM to the dial.
     */
    private watchDialDeadline(call: ActiveCall, callId: bigint, confirmedAt: number): ReturnType<typeof setTimeout> {
        const age = this.deps.now() - confirmedAt;
        const left = (this.deps.confirmToDialMs ?? CONFIRM_TO_DIAL_MS) - age - (this.deps.clockSkewMs ?? CLOCK_SKEW_MS);
        const timer = setTimeout(
            () => {
                if (call.dialed || call.cancelled) return;
                call.late = true;
                call.cancelled = true;
                this.deps.log.warn('the Dialer had not dialed in time after the CONFIRM; cancelling the call', { call: callId });
                this.deps.dialer?.cancelActive('operator');
            },
            Number.isFinite(left) ? Math.max(0, left) : 0,
        );
        timer.unref?.();
        return timer;
    }

    /** How long ago this sidecar first saw the call, or null when its age is unknown. */
    private ageMs(key: string): number | null {
        const first = this.firstSeen.get(key);
        return first === undefined || first === null ? null : this.deps.clock() - first;
    }

    /**
     * The CONFIRM's time by the module's clock, from `call_queue`: the row as it is now (after the claim), else the
     * row the call was started from. Null when the view does not carry it.
     */
    private confirmedAtOf(row: CallQueueRow): number | null {
        const latest = this.deps.db.callQueue().find((r) => r.callId === row.callId);
        return latest ? latest.confirmedAtMs : row.confirmedAtMs;
    }

    /** Whether both clocks say the CONFIRM is recent (see the header), and why not when they do not. */
    private freshness(
        confirmedAt: number | null,
        key: string,
    ): { fresh: true; confirmedAt: number } | { fresh: false; code: string; say: string; confirmAgeMs: number | null; seenAgeMs: number | null } {
        const confirmAge = confirmedAt === null ? null : this.deps.now() - confirmedAt;
        const seenAge = this.ageMs(key);
        const ages = { confirmAgeMs: confirmAge === null ? null : Math.round(confirmAge), seenAgeMs: seenAge === null ? null : Math.round(seenAge) };
        if (confirmedAt === null || confirmAge === null || confirmAge < -CLOCK_SKEW_MS) return { fresh: false, code: 'confirm_time_unknown', say: UNCHECKED_SAY, ...ages };
        if (confirmAge > CONFIRM_MAX_AGE_MS || seenAge === null || seenAge > (this.deps.confirmToPlaceMs ?? CONFIRM_TO_PLACE_MS)) {
            return { fresh: false, code: 'confirm_expired', say: EXPIRED_SAY, ...ages };
        }
        return { fresh: true, confirmedAt };
    }

    /** Claims and runs one Confirmed call. Resolves true when the call is handled for good. */
    private async run(row: CallQueueRow, key: string): Promise<boolean> {
        const dialer = this.deps.dialer;
        if (!dialer) return true;
        const claimed = await this.claim(row, key);
        if (!claimed.ok) return claimed.final;
        const call: ActiveCall = {
            callId: row.callId,
            attempt: claimed.attempt,
            requestId: row.requestId,
            chain: Promise.resolve(),
            phase: 0,
            linesSent: 0,
            placed: false,
            cancelled: false,
            dialed: false,
            late: false,
        };
        this.active.set(row.requestId, call);
        try {
            // A STOP that arrived while the claim was out: never dial.
            const latest = this.deps.db.callQueue().find((r) => r.callId === row.callId);
            if (call.cancelled || latest?.cancelRequested) {
                this.enqueue(call, { status: 'ended', result: 'cancelled', endReason: 'cancelled_before_dial', reasonCode: '', reason: CANCELLED_SAY });
                return true;
            }
            // The views must be current at the dial: during an outage a STOP or a consent revocation could be
            // missing from them. The report waits for the connection to come back.
            if (!this.deps.db.isCurrent()) {
                this.deps.log.warn('the connection to the module is down; not placing the call', { call: row.callId });
                this.enqueue(call, { status: 'refused', result: 'refused', endReason: '', reasonCode: 'disconnected', reason: OFFLINE_SAY });
                return true;
            }
            // Checked after the claim, right before the dial, so a slow claim counts too.
            const fresh = this.freshness(this.confirmedAtOf(row), key);
            if (!fresh.fresh) {
                this.deps.log.warn('a confirmed call is not recent enough to place; refusing it, nothing dialed', {
                    call: row.callId,
                    code: fresh.code,
                    confirmAgeMs: fresh.confirmAgeMs,
                    seenAgeMs: fresh.seenAgeMs,
                });
                this.enqueue(call, { status: 'refused', result: 'refused', endReason: '', reasonCode: fresh.code, reason: fresh.say });
                return true;
            }
            // The Dialer gets the CONFIRM's time too, so its own window runs from the CONFIRM rather than from now.
            const placed = dialer.place(row.requestId, row.scriptDigest, fresh.confirmedAt);
            if (!placed.ok) {
                this.deps.log.warn('the Dialer refused the call', { call: row.callId, code: placed.refusal.code });
                this.enqueue(call, {
                    status: 'refused',
                    result: 'refused',
                    endReason: '',
                    reasonCode: placed.refusal.code.slice(0, LIMITS.reasonCode),
                    reason: placed.refusal.reason.slice(0, LIMITS.reason),
                });
                return true;
            }
            call.placed = true;
            this.deps.log.info('call placed', { call: row.callId });
            const guard = this.watchDialDeadline(call, row.callId, fresh.confirmedAt);
            let outcome: CallOutcome;
            try {
                outcome = await placed.handle.done;
            } finally {
                clearTimeout(guard);
            }
            // Cancelled for lateness before anything went out: the person hears why.
            const report: Report = call.late && outcome.dialed === false
                ? { status: 'refused', result: 'refused', endReason: '', reasonCode: 'confirm_expired', reason: lateReason(outcome) }
                : finalReport(outcome);
            this.enqueue(call, report);
            this.deps.log.info('call finished', { call: row.callId, result: outcome.result, held: outcome.held, late: call.late });
            return true;
        } finally {
            await call.chain;
            this.active.delete(row.requestId);
        }
    }
}
