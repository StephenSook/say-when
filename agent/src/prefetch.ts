// Search prefetch for direct select (docs/direct-select.md section 3, AGENT_SEARCH_PREFETCH). A Category pick used to
// start its Apify run only then, and a Google Maps run takes 11 to 16 s whatever its settings (container start plus
// map segments, measured Oct 24; 3 places or 6 made no difference). The person has already confirmed the search when
// the categories are offered, so the search for each category starts as soon as the categories are published, and
// the category search job takes over the run for the category that was picked instead of starting its own.
// - Consent: each search goes out only after web search consent is read again from the module (`agent_consent`, the
//   views current) right before it, and only while the categories job is still this attempt's. A prefetched run is
//   handed over only while that consent has held in the same session with no reload of the views, and a revocation
//   the views show empties the book. The category search job checks its own consent before and after it waits.
// - Nothing is written to the person's question for a prefetch: the job that uses it writes the search events, with
//   the run's own time and `prefetched: true`. A prefetch nobody picks is dropped once its time to live is up, and
//   only counted in the log (about $0.02 each).
// - In this process only, and content-light: search words and public result rows, never memory, never logged.

import type { SearchResult } from '@say-when/apify-client';

import type { AgentDb } from './db/db.js';
import type { Logger } from './log.js';
import { wholeMs } from './pipeline.js';
import type { PlannedSearch, PrefetchedRun, PrefetchOutcome } from './retrieval.js';

export interface PrefetchLimits {
    /** Searches started for one question's categories (the three a gesture can pick). */
    perQuestion: number;
    /** How long a prefetched run may wait for its pick. */
    ttlMs: number;
    /** Runs kept at once, across questions; the oldest goes first. */
    maxEntries: number;
}

export const PREFETCH_LIMITS: PrefetchLimits = { perQuestion: 3, ttlMs: 3 * 60_000, maxEntries: 12 };

export type SendSearch = (planned: PlannedSearch, signal: AbortSignal) => Promise<SearchResult>;

interface ConsentMark {
    sessionId: bigint;
    syncs: number;
}

interface Entry {
    kind: 'web' | 'maps';
    startedAt: number;
    mark: ConsentMark;
    controller: AbortController;
    outcome: Promise<PrefetchOutcome>;
    settled: PrefetchOutcome | null;
    used: boolean;
}

const norm = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();
const keyOf = (questionId: bigint, planned: PlannedSearch): string => `${questionId}|${planned.kind}|${norm(planned.query)}`;

export class SearchPrefetch {
    private readonly entries = new Map<string, Entry>();
    private readonly unsubscribe: () => void;

    constructor(
        private readonly db: AgentDb,
        private readonly log: Logger,
        /** Monotonic clock, ms (JobDeps.clock). */
        private readonly clock: () => number,
        private readonly limits: PrefetchLimits = PREFETCH_LIMITS,
    ) {
        // A revocation the views show ends every prefetch, whatever is granted again later.
        this.unsubscribe = db.onChange(() => {
            if (this.entries.size > 0 && this.consentMark() === null) this.dropAll('consent');
        });
    }

    /**
     * Starts the searches for one question's categories, in their order, at most `perQuestion` of them, each with its
     * own deadline (`timeoutMs`, the search deadline searchStep uses). `allowed` says the categories job is still
     * live; it and web search consent are read again right before each search goes out. A search already prefetched
     * for the same question and words (a second attempt of the same categories job) is not sent again. Returns how
     * many searches went out.
     */
    start(questionId: bigint, searches: readonly PlannedSearch[], timeoutMs: number, allowed: () => boolean, send: SendSearch): number {
        this.prune();
        const keys = new Set<string>();
        let sent = 0;
        for (const planned of searches) {
            const key = keyOf(questionId, planned);
            if (keys.has(key)) continue;
            if (keys.size >= this.limits.perQuestion) break;
            keys.add(key);
            if (this.entries.has(key)) continue;
            const mark = this.consentMark();
            if (!mark || !allowed()) break;
            this.entries.set(key, this.launch(planned, mark, timeoutMs, send));
            sent += 1;
        }
        this.cap();
        if (sent > 0) this.log.info('search prefetch started', { searches: sent, kind: searches[0]?.kind ?? 'web' });
        return sent;
    }

    /**
     * The prefetched run for these search words, or null when there is none, it expired, it failed, or web search
     * consent has not held since it went out (same session, no reload of the views). A run handed over stays in the
     * book until it expires, so another attempt of the same category search job can take it too.
     */
    take(questionId: bigint, planned: PlannedSearch): PrefetchedRun | null {
        this.prune();
        const key = keyOf(questionId, planned);
        const entry = this.entries.get(key);
        if (!entry) return null;
        const now = this.consentMark();
        if (!now || now.sessionId !== entry.mark.sessionId || now.syncs !== entry.mark.syncs) {
            this.drop([key], 'consent');
            return null;
        }
        if (entry.settled && !entry.settled.ok) {
            this.drop([key], 'failed');
            return null;
        }
        entry.used = true;
        return { kind: entry.kind, outcome: entry.outcome };
    }

    /** How many runs are kept now (for tests and the log). */
    get size(): number {
        return this.entries.size;
    }

    /** Stops listening to the views and drops every run. */
    close(): void {
        this.unsubscribe();
        this.dropAll('closed');
    }

    private launch(planned: PlannedSearch, mark: ConsentMark, timeoutMs: number, send: SendSearch): Entry {
        const controller = new AbortController();
        const deadline = AbortSignal.timeout(timeoutMs);
        const startedAt = this.clock();
        let running: Promise<SearchResult>;
        try {
            running = send(planned, AbortSignal.any([controller.signal, deadline]));
        } catch (error) {
            running = Promise.reject(error);
        }
        // Never rejects, so a run nobody waits for cannot become an unhandled rejection.
        const outcome = running.then(
            (result): PrefetchOutcome => ({ ok: true, result, ms: wholeMs(this.clock() - startedAt) }),
            (error: unknown): PrefetchOutcome => ({ ok: false, error, ms: wholeMs(this.clock() - startedAt), timedOut: deadline.aborted }),
        );
        const entry: Entry = { kind: planned.kind, startedAt, mark, controller, outcome, settled: null, used: false };
        void outcome.then((done) => {
            entry.settled = done;
            this.log.info('search prefetch done', { kind: planned.kind, ok: done.ok, ms: done.ms, rows: done.ok ? done.result.rows.length : 0 });
        });
        return entry;
    }

    /** Web search consent as the module shows it now, or null: off, unknown, between sessions, or the views not current. */
    private consentMark(): ConsentMark | null {
        if (!this.db.isCurrent()) return null;
        const consent = this.db.agentConsent();
        if (!consent || !consent.webSearchAllowed || consent.sessionId === 0n) return null;
        return { sessionId: consent.sessionId, syncs: this.db.syncCount() };
    }

    private prune(): void {
        const now = this.clock();
        const expired = [...this.entries].filter(([, entry]) => now - entry.startedAt > this.limits.ttlMs).map(([key]) => key);
        if (expired.length > 0) this.drop(expired, 'expired');
    }

    private cap(): void {
        const over = this.entries.size - this.limits.maxEntries;
        if (over > 0) this.drop([...this.entries.keys()].slice(0, over), 'full');
    }

    private dropAll(why: string): void {
        this.drop([...this.entries.keys()], why);
    }

    /** Drops runs; one still going is stopped. Counts the ones nobody took, which were paid for and never used. */
    private drop(keys: readonly string[], why: string): void {
        let unused = 0;
        for (const key of keys) {
            const entry = this.entries.get(key);
            if (!entry) continue;
            this.entries.delete(key);
            if (!entry.settled) entry.controller.abort();
            if (!entry.used) unused += 1;
        }
        if (unused > 0) this.log.info('search prefetch dropped unused', { why, unused });
    }
}
