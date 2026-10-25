// The errand submit path (PLAN D4 and D12.3, docs/spacetime.md 4.3 and 7.4 step 6).
//
// A form leaves the room only like this:
// 1. The module shows the errand Confirmed in `errand_queue`: the person heard the read-back and gave a fresh
//    CONFIRM (single jaw clench) carrying its digest, inside the window.
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
// 6. PLAN D25: only after the module took a `submitted` result, the care team email drafted at the preview goes out
//    once through Apify's Send Email Actor (src/email.ts), and its steps go to `agent_errand_email`. A form that was
//    not sent drops its draft; a duplicate sends no second email. The email never changes the errand's result.

import { ApifyHttpError, ConfigError, UnknownOutcomeError, type ErrandResult, type FieldInput } from '@say-when/apify-client';

import { LIMITS } from './contract.js';
import type { AgentDb } from './db/db.js';
import { callReducer, MAX_CLAIM_TRIES, neverSent, type Verified } from './db/retry.js';
import { withDeadline } from './deadline.js';
import { emailPayload, mailSentence, type ErrandEmailDeps, type MailOutcome } from './email.js';
import { parseFields, type PreviewBook, type SentBook } from './jobs.js';
import type { Logger } from './log.js';
import { countsJson, label, payloadJson, wholeMs, type Counts } from './pipeline.js';
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
    /**
     * PLAN D25 (src/email.ts): the care team email drafted at the preview, sent here once the module took the errand's
     * submitted result. Unset: no email.
     */
    email?: ErrandEmailDeps;
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
        this.dropEmail(row, 'refused');
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
        // PLAN D25: the care team email goes only after the module took this errand's submitted result.
        if (recorded && completion.status === 'submitted') await this.sendEmail(row, claimed.attempt);
        else if (recorded && completion.status === 'duplicate') await this.skipDuplicateEmail(row, claimed.attempt);
        else this.dropEmail(row, recorded ? completion.status : 'not_recorded');
        if (completion.status === 'submitted') await this.keepPastRequest(row, fields);
        return true;
    }

    /** A form that was not sent (or whose result the module did not take) never sends its email: the draft is dropped. */
    private dropEmail(row: ErrandQueueRow, why: string): void {
        if (this.deps.email?.book.take(row.errandId)) this.deps.log.info('no care team email: the form was not sent', { errand: row.errandId, why });
    }

    /** One email step through `agent_errand_email`. Never throws: the email's fate never changes the errand's. */
    private async reportEmail(row: ErrandQueueRow, attempt: number, status: 'started' | 'ok' | 'error', detail: string, end: { ms?: number; counts?: Counts; payload?: Record<string, unknown> }): Promise<void> {
        const outcome = await callReducer(
            this.deps.db,
            'agentErrandEmail',
            {
                errandId: row.errandId,
                attempt,
                status,
                detail: label(detail),
                ms: wholeMs(end.ms ?? 0),
                countsJson: countsJson(end.counts),
                payloadJson: payloadJson(end.payload).json,
            },
            // Idempotent: one step per status (e<errand>:email:<step>), so a lost reply is sent again.
            { onUnknown: 'repeat', attempts: 3, readyTimeoutMs: 5_000 },
        );
        if (outcome.ok) return;
        const missing = outcome.kind === 'internal';
        this.deps.log.warn(missing ? 'the module cannot show the email step (agent_errand_email is not published there)' : 'an email step was not recorded', {
            errand: row.errandId,
            step: status,
            why: outcome.kind,
        });
    }

    /** The form already had this request: its earlier send's email covers it, so no second email goes out. */
    private async skipDuplicateEmail(row: ErrandQueueRow, attempt: number): Promise<void> {
        const draft = this.deps.email?.book.take(row.errandId);
        if (!draft) return;
        this.deps.log.info('no care team email: the form already had this request', { errand: row.errandId });
        await this.reportEmail(row, attempt, 'error', 'email not sent: duplicate', {
            counts: { errandId: Number(row.errandId), notSent: true },
            payload: emailPayload(draft, { outcome: 'not_sent', reason: 'The form already had this request, so no second email was sent.' }),
        });
    }

    /** PLAN D25: the drafted email, once, right after the module took the submitted result. Never throws. */
    private async sendEmail(row: ErrandQueueRow, attempt: number): Promise<void> {
        const email = this.deps.email;
        const draft = email?.book.take(row.errandId);
        if (!email || !draft) return;
        // The read-back that announced the email is the one the person confirmed.
        if (draft.digest !== row.confirmedDigest) {
            this.deps.log.warn('the email draft does not match the confirmed read-back; no email is sent', { errand: row.errandId });
            return;
        }
        const errandId = Number(row.errandId);
        await this.reportEmail(row, attempt, 'started', 'email sending', { counts: { errandId }, payload: emailPayload(draft) });
        let outcome: MailOutcome;
        try {
            // Sent once. Never retried: a second try could send a second email.
            outcome = await email.mail.send({ to: draft.to, subject: draft.subject, text: draft.text });
        } catch {
            outcome = { status: 'unknown', code: 'agent_error', ms: 0 };
        }
        const sentAt = new Date(email.now()).toISOString();
        if (outcome.status === 'sent') {
            this.deps.log.info('care team email sent', { errand: row.errandId, ms: outcome.ms });
            await this.reportEmail(row, attempt, 'ok', 'email sent', { ms: outcome.ms, counts: { errandId, mailMs: outcome.ms }, payload: emailPayload(draft, { outcome: 'sent', sentAt }) });
            return;
        }
        this.deps.log.warn(outcome.status === 'unknown' ? 'the care team email may or may not have gone out; it is not sent again' : 'the care team email was not sent', {
            errand: row.errandId,
            code: outcome.code,
            ms: outcome.ms,
        });
        await this.reportEmail(row, attempt, 'error', `email ${outcome.status === 'unknown' ? 'unknown' : 'failed'}: ${outcome.code}`, {
            ms: outcome.ms,
            counts: { errandId, mailMs: outcome.ms, maybeSent: outcome.status === 'unknown' },
            payload: emailPayload(draft, { outcome: outcome.status, reason: mailSentence(outcome) }),
        });
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
