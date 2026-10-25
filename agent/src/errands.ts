// The errand submit path (PLAN D4 and D12.3, docs/spacetime.md 4.3 and 7.4 step 6).
//
// A form leaves the room only like this:
// 1. The module shows the errand Confirmed in `errand_queue`: the person heard the read-back and gave a fresh
//    CONFIRM (double jaw clench) carrying its digest, inside the window.
// 2. This sidecar previewed that errand itself and the confirmed digest, form address and fields are exactly the
//    ones it previewed. A different digest is refused: claimed, then completed as `refused`, nothing sent.
//    An errand this sidecar did not preview is left alone.
// 3. `claim_errand(errand_id, digest)` moves it to Submitting under a lease. Only then the Actor's submit runs,
//    once, never retried. A lost or unclear result becomes `unknown`: "it may have been sent, check before
//    trying again". The module's lease turns a sidecar that dies here into unknown_outcome too.
// 4. A claim that provably never reached the module (the connection was down for every try) is tried again on a
//    later look, at most MAX_CLAIM_TRIES rounds. A claim that may have landed is never sent again.
// 5. Only after the Actor reports it submitted, and only when memory consent held without a break from before the
//    CONFIRM (the preview's mark) to right before the write, in one session, one private past request note goes into
//    Moss (src/requests.ts MemoryWatch), so the
//    next time the same form comes up it can be filled from last time. Never in the try sandbox. The note never
//    changes the errand's result, and it never sends anything: a repeat still needs its own read-back and CONFIRM.

import { ApifyHttpError, ConfigError, UnknownOutcomeError, type ErrandResult, type FieldInput } from '@say-when/apify-client';

import { LIMITS } from './contract.js';
import type { AgentDb } from './db/db.js';
import { callReducer, MAX_CLAIM_TRIES, neverSent, type Verified } from './db/retry.js';
import { withDeadline } from './deadline.js';
import { parseFields, type PreviewBook, type SentBook } from './jobs.js';
import type { Logger } from './log.js';
import type { ErrandPort, MemoryPort } from './ports.js';
import { pastRequestNote, type MemoryWatch } from './requests.js';
import { MOSS_DEADLINES } from './retrieval.js';
import type { AllowedForm, ErrandQueueRow, ReducerArgs } from './types.js';

type Completion = Omit<ReducerArgs['completeErrand'], 'errandId' | 'attempt' | 'submitMs'>;

export const SAY = {
    mismatch: 'The form changed after it was read back, so nothing was sent.',
    unknown: 'It may have been sent. Check before trying again.',
    notSent: 'The form service turned the request away, so nothing was sent.',
    refused: 'The form refused the request, so nothing was sent.',
    badFields: 'The request was not complete, so nothing was sent.',
} as const;

/** What a submit result means for `complete_errand`. */
export function fromSubmitResult(result: ErrandResult): Completion {
    const confirmationText = (result.confirmationText ?? '').slice(0, LIMITS.confirmationText);
    const screenshotUrl = result.screenshotUrl && result.screenshotUrl.length <= LIMITS.screenshotUrl ? result.screenshotUrl : '';
    switch (result.status) {
        case 'submitted':
        case 'duplicate':
            return { status: result.status, confirmationText, screenshotUrl, reasonCode: '', reason: '' };
        case 'refused':
            return {
                status: 'refused',
                confirmationText: '',
                screenshotUrl,
                reasonCode: (result.refusal?.code ?? 'refused').slice(0, LIMITS.reasonCode),
                reason: (result.refusal?.reason ?? SAY.refused).slice(0, LIMITS.reason),
            };
        default:
            // The client never resolves a submit with any other status; if one appears, it proves nothing.
            return { status: 'unknown', confirmationText: '', screenshotUrl: '', reasonCode: 'bad_result', reason: SAY.unknown };
    }
}

/**
 * What a submit error means. Only errors that prove nothing left this process (or that the server turned the
 * request away before any errand ran) count as `failed`; everything else is `unknown`, never "not sent".
 */
export function fromSubmitError(error: unknown): Completion {
    if (error instanceof UnknownOutcomeError) {
        return { status: 'unknown', confirmationText: '', screenshotUrl: '', reasonCode: error.reason.slice(0, LIMITS.reasonCode), reason: SAY.unknown };
    }
    if (error instanceof ApifyHttpError) {
        // FormErrandClient lets an ApifyHttpError through only when the request was never sent or was refused
        // before any errand ran (apify/client README, "Submit outcomes").
        const code = error.kind === 'http' ? `http_${error.status ?? 0}` : `not_sent_${error.kind}`;
        return { status: 'failed', confirmationText: '', screenshotUrl: '', reasonCode: code.slice(0, LIMITS.reasonCode), reason: SAY.notSent };
    }
    if (error instanceof TypeError) return { status: 'failed', confirmationText: '', screenshotUrl: '', reasonCode: 'bad_request', reason: SAY.notSent };
    if (error instanceof ConfigError) return { status: 'failed', confirmationText: '', screenshotUrl: '', reasonCode: 'not_configured', reason: SAY.notSent };
    return { status: 'unknown', confirmationText: '', screenshotUrl: '', reasonCode: 'agent_error', reason: SAY.unknown };
}

export interface ErrandRunnerDeps {
    db: AgentDb;
    errands: ErrandPort | null;
    previews: PreviewBook;
    log: Logger;
    /** Monotonic clock for durations. */
    clock: () => number;
    /** How long to wait before looking again after a claim that never reached the module. Default 1 s. */
    retryMs?: number;
    /** Past requests (step 5, src/requests.ts). Unset: no note is ever written. */
    pastRequests?: PastRequestDeps;
    /**
     * Errands sent here, for a call about the recent errand (src/jobs.ts SentBook). Written only after the module took
     * a submitted or duplicate result. Unset: a call says only that the request was sent.
     */
    sent?: SentBook;
    /** Wall clock, epoch ms, for the SentBook window. Default Date.now. */
    now?: () => number;
}

export interface PastRequestDeps {
    memory: MemoryPort | null;
    /** The allowed forms (AGENT_FORMS_FILE): a note is kept only for a form on this list, under its title. */
    forms: readonly AllowedForm[];
    timeZone: string;
    /** Wall clock, epoch ms: when the form was sent. */
    now: () => number;
    /** The judge try sandbox (AGENT_TRY): no note is ever written, whatever the consent says. */
    sandbox: boolean;
    /** The same watch the preview job marks with (JobDeps.memoryWatch). Null: no note is ever written. */
    watch: MemoryWatch | null;
    /** How long the note write may take. Default MOSS_DEADLINES.writeBack. */
    deadlineMs?: number;
}

type Claimed = { ok: true; attempt: number } | { ok: false; final: boolean };

export class ErrandRunner {
    /** Errands handled for good: submitted, refused, or a claim that was refused or may have landed. Never looked at again. */
    private readonly decided = new Set<string>();
    /** Errands being claimed or submitted now. */
    private readonly inflight = new Set<string>();
    /** Claim rounds that never reached the module, by errand id. */
    private readonly tries = new Map<string, number>();
    private readonly logged = new Set<string>();
    private readonly running = new Set<Promise<void>>();
    private wake: (() => void) | null = null;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private stopped = false;

    constructor(private readonly deps: ErrandRunnerDeps) {}

    /** What to call to look at the views again (the orchestrator's tick). */
    setWake(wake: () => void): void {
        this.wake = wake;
    }

    /** Called on every change to the views. Starts the submit for each newly Confirmed errand. */
    reconcile(rows: readonly ErrandQueueRow[]): void {
        if (this.stopped) return;
        for (const row of rows) {
            const key = row.errandId.toString();
            if (row.status !== 'confirmed' || this.decided.has(key) || this.inflight.has(key)) continue;
            const decision = this.decide(row);
            if (decision === 'leave') continue;
            this.inflight.add(key);
            const work = (decision === 'submit' ? this.submit(row, key) : this.refuse(row, key, decision))
                .catch((error: unknown) => {
                    this.deps.log.error('errand handling crashed', { errand: row.errandId, why: error instanceof Error ? error.name : 'error' });
                    return true;
                })
                .then((final) => {
                    this.inflight.delete(key);
                    if (final) {
                        this.decided.add(key);
                        this.tries.delete(key);
                    } else this.retryLater();
                });
            this.running.add(work);
            void work.finally(() => this.running.delete(work));
        }
    }

    /** Waits for submits under way (a submit is never cut short: that would make its outcome unknown). */
    async drain(timeoutMs: number): Promise<void> {
        if (this.running.size === 0) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([Promise.allSettled([...this.running]), new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
        clearTimeout(timer);
    }

    /** Starts no new submit (sidecar shutdown). A submit under way is never cut short. */
    stop(): void {
        this.stopped = true;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
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

    private decide(row: ErrandQueueRow): 'submit' | 'leave' | { code: string; reason: string } {
        const once = (why: string, message: string) => {
            if (this.logged.has(`${row.errandId}:${why}`)) return;
            this.logged.add(`${row.errandId}:${why}`);
            this.deps.log.warn(message, { errand: row.errandId });
        };
        if (!this.deps.errands) {
            once('no_client', 'an errand is confirmed but FORM_ERRAND_URL is not set; it cannot be sent from here');
            return 'leave';
        }
        const record = this.deps.previews.get(row.errandId);
        if (!record) {
            once('not_mine', 'an errand is confirmed that this sidecar did not preview; leaving it to the sidecar that did');
            return 'leave';
        }
        const same = record.digest === row.confirmedDigest && record.formUrl === row.formUrl && record.fieldsJson === row.fieldsJson;
        if (same) return parseFields(row.fieldsJson) ? 'submit' : { code: 'bad_fields', reason: SAY.badFields };
        if (!record.certain) {
            // This sidecar may not be the one whose preview is on the errand; the digest decides, so leave it.
            once('maybe_not_mine', 'a confirmed errand does not match an uncertain preview; leaving it');
            return 'leave';
        }
        return { code: 'digest_mismatch', reason: SAY.mismatch };
    }

    /**
     * Claims the Confirmed errand. A claim that never reached the module (every try failed before it was sent) is
     * not final: the errand is looked at again later, at most MAX_CLAIM_TRIES rounds. Anything else is final.
     */
    private async claim(row: ErrandQueueRow, key: string): Promise<Claimed> {
        const expected = row.claimAttempt + 1;
        const verify = (): Verified => {
            const now = this.deps.db.errandQueue().find((r) => r.errandId === row.errandId);
            if (now && now.status === 'submitting' && now.claimedByMe && now.claimAttempt === expected) return 'applied';
            if (now && now.status === 'confirmed' && now.claimAttempt === row.claimAttempt) return 'not_applied';
            return 'unclear';
        };
        const outcome = await callReducer(this.deps.db, 'claimErrand', { errandId: row.errandId, digest: row.confirmedDigest }, { onUnknown: 'verify', verify });
        if (outcome.ok) return { ok: true, attempt: expected };
        const tries = (this.tries.get(key) ?? 0) + 1;
        this.tries.set(key, tries);
        const again = neverSent(outcome) && tries < MAX_CLAIM_TRIES;
        this.deps.log.warn(again ? 'the errand claim never reached the module; it will be tried again' : 'the errand could not be claimed', {
            errand: row.errandId,
            why: outcome.kind,
            tries,
        });
        return { ok: false, final: !again };
    }

    /** True only when the module took this result (a reply said so); a stale reply after a lost one is not counted. */
    private async complete(row: ErrandQueueRow, attempt: number, completion: Completion, submitMs: number): Promise<boolean> {
        const outcome = await callReducer(
            this.deps.db,
            'completeErrand',
            { errandId: row.errandId, attempt, submitMs: Math.max(0, Math.round(submitMs)), ...completion },
            // Idempotent: a retry of a committed result is a no-op in the module.
            { onUnknown: 'repeat', attempts: 5, readyTimeoutMs: 30_000 },
        );
        if (outcome.ok) return true;
        if (outcome.kind === 'stale' && outcome.uncertain) return false;
        this.deps.log.error('the errand result was not recorded; the module lease will mark it unknown', { errand: row.errandId, status: completion.status, why: outcome.kind });
        return false;
    }

    /** Resolves true when the errand is handled for good. */
    private async refuse(row: ErrandQueueRow, key: string, refusal: { code: string; reason: string }): Promise<boolean> {
        this.deps.log.warn('refusing a confirmed errand; nothing is sent', { errand: row.errandId, code: refusal.code });
        const claimed = await this.claim(row, key);
        if (!claimed.ok) return claimed.final;
        await this.complete(row, claimed.attempt, { status: 'refused', confirmationText: '', screenshotUrl: '', reasonCode: refusal.code, reason: refusal.reason }, 0);
        return true;
    }

    /** Resolves true when the errand is handled for good. */
    private async submit(row: ErrandQueueRow, key: string): Promise<boolean> {
        const errands = this.deps.errands;
        const fields = parseFields(row.fieldsJson);
        if (!errands || !fields) return true;
        const claimed = await this.claim(row, key);
        if (!claimed.ok) return claimed.final;
        const started = this.deps.clock();
        let completion: Completion;
        try {
            // Sent once. Never retried, whatever happens next.
            const result = await errands.submit({ formUrl: row.formUrl, fields, confirm: true, confirmDigest: row.confirmedDigest });
            completion = fromSubmitResult(result);
        } catch (error) {
            completion = fromSubmitError(error);
        }
        const submitMs = this.deps.clock() - started;
        this.deps.log.info('errand submit finished', { errand: row.errandId, status: completion.status, code: completion.reasonCode || undefined, ms: Math.round(submitMs) });
        const now = this.deps.now ?? Date.now;
        const fromMs = now();
        const recorded = await this.complete(row, claimed.attempt, completion, submitMs);
        // The module stamps submitted_at inside complete_errand, so it falls between fromMs and toMs (src/jobs.ts).
        if (recorded && (completion.status === 'submitted' || completion.status === 'duplicate')) {
            const toMs = now();
            this.deps.sent?.record({ errandId: row.errandId, formKey: row.formKey, fields, fromMs, toMs }, toMs);
        }
        if (completion.status === 'submitted') await this.keepPastRequest(row, fields);
        return true;
    }

    /** Step 5: one private note about the sent form. Never throws; the errand's result is already recorded. */
    private async keepPastRequest(row: ErrandQueueRow, fields: FieldInput[]): Promise<void> {
        const deps = this.deps.pastRequests;
        if (!deps) return;
        const skip = (why: string) => this.deps.log.info('no past request kept', { errand: row.errandId, why });
        if (deps.sandbox) return skip('try_sandbox');
        const memory = deps.memory;
        if (!memory || !memory.isOpen()) return skip('moss_closed');
        const form = deps.forms.find((f) => f.formKey === row.formKey);
        if (!form) return skip('form_not_listed');
        const text = pastRequestNote(form, fields, deps.now(), deps.timeZone);
        if (!text) return skip('nothing_to_keep');
        // Memory consent from before the CONFIRM (taken when the preview was attached) to now, without a break, in one
        // session. A consent given only after the CONFIRM, or revoked and given again, does not reach back to this send.
        // Read right before the write, with nothing that waits in between, like a Remember job.
        const mark = this.deps.previews.get(row.errandId)?.memory ?? null;
        if (!deps.watch || !deps.watch.heldSince(mark)) return skip('memory_off');
        try {
            const written = await withDeadline(memory.addNote({ text, shareable: false }), deps.deadlineMs ?? MOSS_DEADLINES.writeBack, 'past request');
            this.deps.log.info('past request kept', { errand: row.errandId, added: written.added, updated: written.updated });
        } catch (error) {
            this.deps.log.warn('the past request could not be kept', { errand: row.errandId, why: error instanceof Error ? error.name : 'error' });
        }
    }
}
