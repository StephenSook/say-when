// The judge try sandbox on the sidecar's side (PLAN 5.11, docs/spacetime.md 15). The module already caps questions
// per try, tries per hour and questions per day; these caps sit in front of the money the sidecar spends (Claude,
// Apify), so a mistake in the module's settings still cannot run up a bill.
//
// - A daily spend ceiling, counted with a fixed, conservative estimate per job (planner call, web search, errand
//   preview plus its one submit) before the job runs. A job that would go past it is refused.
// - Questions per partner device per hour, and new partner devices per hour (each judge's page is one partner).
// A refused job is failed with the code `try_limit`, which the module shows on the board and the try page puts in
// words. Remember jobs are never refused (no model call, and refusing one would only lose a saved reply).
//
// The counters live in this process: a restart resets them. The module's caps live in the database and still hold.
// The health endpoint (`GET /healthz` on PORT, for the host's checks and for anyone curious) answers with numbers
// only: no question, option, name, identity or key.

import { createServer, type Server } from 'node:http';

import type { MemoryItem } from '@say-when/moss';

import type { AgentQueueRow } from './types.js';

export interface SandboxLimits {
    /** The most the sidecar may spend in 24 hours, in US dollars, by the estimates below. */
    dailyUsd: number;
    /** Questions from one partner device in one hour. */
    questionsPerPartnerPerHour: number;
    /** Partner devices (judges) that may start asking in one hour. */
    partnersPerHour: number;
    /** Estimates per job, in US dollars. Conservative on purpose: the real bill should be lower. */
    usdPerPlan: number;
    usdPerSearch: number;
    /** A preview and its one submit together. */
    usdPerErrand: number;
}

export const SANDBOX_LIMIT_DEFAULTS: SandboxLimits = {
    dailyUsd: 5,
    questionsPerPartnerPerHour: 10,
    partnersPerHour: 12,
    usdPerPlan: 0.02,
    usdPerSearch: 0.02,
    usdPerErrand: 0.02,
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const TRY_LIMIT_CODE = 'try_limit';

/** The sentences the person would hear; the try page shows its own words for the `try_limit` code. */
export const TRY_LIMIT_SAY = {
    spend: 'The try is closed for today: its spending limit is used up.',
    partner: 'This page has asked its questions for this hour. Try again later.',
    partners: 'Too many people are trying Eleven this hour. Try again later.',
} as const;

export type Admission = { ok: true; usd: number } | { ok: false; reasonCode: typeof TRY_LIMIT_CODE; reason: string; why: keyof typeof TRY_LIMIT_SAY };

export interface SandboxUsage {
    dailyUsd: number;
    spentUsd: number;
    jobsToday: number;
    refusedToday: number;
    partnersThisHour: number;
    questionsThisHour: number;
}

export class SandboxMeter {
    private dayStartedAt: number | null = null;
    private spentUsd = 0;
    private jobsToday = 0;
    private refusedToday = 0;
    /** Partner identity to the times of its questions in the last hour. */
    private readonly asks = new Map<string, number[]>();
    /** Partner identity to when it first asked in the current hour. */
    private readonly partners = new Map<string, number>();

    constructor(
        readonly limits: SandboxLimits,
        private readonly now: () => number = Date.now,
    ) {}

    /** The estimate for one job, before it runs. */
    estimate(row: AgentQueueRow): number {
        // The same rule jobs.ts uses: only a real menu item skips the classifier and so never searches.
        const isMenu = row.origin === 'menu' && row.menuItem !== 'none';
        if (row.kind === 'options') return this.limits.usdPerPlan + (row.webSearchAllowed && !isMenu ? this.limits.usdPerSearch : 0);
        if (row.kind === 'errand_preview') return this.limits.usdPerErrand;
        return 0;
    }

    /** Decides whether a claimed job may run, and counts it when it may. */
    admit(row: AgentQueueRow): Admission {
        const now = this.now();
        this.roll(now);
        if (row.kind === 'remember') return { ok: true, usd: 0 };
        const usd = this.estimate(row);
        if (this.spentUsd + usd > this.limits.dailyUsd + 1e-9) return this.refuse('spend');
        // Every options job counts against whoever asked (a menu turn's asker is the station), so no origin skips it.
        if (row.kind === 'options') {
            const who = row.askedBy || 'unknown';
            const recent = (this.asks.get(who) ?? []).filter((at) => now - at < HOUR_MS);
            if (recent.length >= this.limits.questionsPerPartnerPerHour) return this.refuse('partner');
            if (!this.partners.has(who) && this.partners.size >= this.limits.partnersPerHour) return this.refuse('partners');
            if (!this.partners.has(who)) this.partners.set(who, now);
            recent.push(now);
            this.asks.set(who, recent);
        }
        this.spentUsd += usd;
        this.jobsToday += 1;
        return { ok: true, usd };
    }

    usage(): SandboxUsage {
        const now = this.now();
        this.roll(now);
        let questions = 0;
        for (const times of this.asks.values()) questions += times.filter((at) => now - at < HOUR_MS).length;
        return {
            dailyUsd: this.limits.dailyUsd,
            spentUsd: Math.round(this.spentUsd * 100) / 100,
            jobsToday: this.jobsToday,
            refusedToday: this.refusedToday,
            partnersThisHour: this.partners.size,
            questionsThisHour: questions,
        };
    }

    private refuse(why: keyof typeof TRY_LIMIT_SAY): Admission {
        this.refusedToday += 1;
        return { ok: false, reasonCode: TRY_LIMIT_CODE, reason: TRY_LIMIT_SAY[why], why };
    }

    /** Starts a new day after 24 hours, and drops partners whose first question is an hour old. */
    private roll(now: number): void {
        if (this.dayStartedAt === null || now - this.dayStartedAt >= DAY_MS || now < this.dayStartedAt) {
            this.dayStartedAt = now;
            this.spentUsd = 0;
            this.jobsToday = 0;
            this.refusedToday = 0;
        }
        for (const [who, since] of this.partners) if (now - since >= HOUR_MS) this.partners.delete(who);
        for (const [who, times] of this.asks) {
            const kept = times.filter((at) => now - at < HOUR_MS);
            if (kept.length === 0) this.asks.delete(who);
            else this.asks.set(who, kept);
        }
    }
}

/**
 * Sample notes for the sandbox's Moss memory, so a judge sees memory at work on the first question. They are made up,
 * belong to no real person, and the try page labels every one "Sample note". Shareable, so their text may show.
 */
export const SAMPLE_NOTES: readonly MemoryItem[] = [
    { type: 'pref', text: 'Sample note: prefers tea to coffee, with a little honey.', shareable: true },
    { type: 'pref', text: 'Sample note: favorite food is Thai noodles; does not like very spicy food.', shareable: true },
    { type: 'pref', text: 'Sample note: likes quiet places with a window seat.', shareable: true },
    { type: 'pref', text: 'Sample note: gets tired after about two hours out.', shareable: true },
    { type: 'pref', text: 'Sample note: enjoys basketball and old movies.', shareable: true },
];

/** The database names the sandbox may run against: the try database and its keyless test twin. */
export function isSandboxDatabase(name: string): boolean {
    return name === 'say-when-try' || name === 'say-when-try-dev';
}

export interface HealthView {
    database: string;
    connected: () => boolean;
    paired: () => boolean | null;
    usage: () => SandboxUsage | null;
}

/** `GET /healthz` (and `/`) on `port`: numbers and yes or no only. Everything else is 404. */
export function startHealthServer(port: number, view: HealthView): Server {
    const server = createServer((req, res) => {
        const path = (req.url ?? '/').split('?')[0];
        if (req.method !== 'GET' || (path !== '/healthz' && path !== '/')) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end('{"ok":false}');
            return;
        }
        const body = {
            ok: true,
            service: 'eleven-agent',
            database: view.database,
            connected: view.connected(),
            paired: view.paired(),
            sandbox: view.usage(),
        };
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
        res.end(JSON.stringify(body));
    });
    server.listen(port);
    return server;
}
