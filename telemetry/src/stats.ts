// The numbers the dashboard shows, read from the continuous aggregates (and, only for exact percentiles, the raw
// picks). Two halves: `fetchRawStats` runs the SQL, `summarize` does the arithmetic, so the math is tested on
// fixtures without a database.
//
// The window is the `windowMinutes` one-minute buckets ending with the current one (the newest still filling), so
// it spans between windowMinutes - 1 and windowMinutes minutes. Numerators and denominators use the same buckets.
import type pg from 'pg';

import type { PercentileMode } from './migrate.js';
import { TEST_SESSION_RE } from './types.js';

export interface StatsOptions {
    /** Default 30. */
    readonly windowMinutes?: number;
    /** One exact session key (for example a `test-` session). Default: every real session, never test rows. */
    readonly sessionId?: string;
    /** Count `test-` sessions too when no sessionId is given. Default false. */
    readonly includeTest?: boolean;
    /** The rate stays null until the window holds this much rest. Default 1 minute. */
    readonly minIdleMinutes?: number;
}

export interface RawStats {
    readonly asOf: Date;
    readonly windowStart: Date;
    readonly falseActivations: number;
    readonly commands: number;
    readonly yesActedAtRest: number;
    readonly idleMs: number;
    readonly timedPicks: number;
    readonly p50: number | null;
    readonly p95: number | null;
    readonly percentiles: PercentileMode;
    readonly rowsWritten: number;
    readonly lastWriteAt: Date | null;
}

export interface DashboardStats {
    readonly windowMinutes: number;
    readonly windowStart: string;
    readonly asOf: string;
    /** False activations per minute of rest, or null until the window holds `minIdleMinutes` of rest. */
    readonly falseActivationsPerIdleMinute: number | null;
    readonly falseActivations: number;
    readonly idleMinutes: number;
    /** YES at rest that did something (opened the menu or lifted a pause): shown beside, never inside, the rate. */
    readonly yesActedAtRest: number;
    readonly timeToPick: {
        readonly p50Ms: number | null;
        readonly p95Ms: number | null;
        readonly picks: number;
        readonly method: 'toolkit-uddsketch' | 'exact';
    };
    readonly commandsPerMinute: number;
    readonly commands: number;
    readonly rowsWritten: number;
    readonly lastWriteAt: string | null;
}

function round(n: number, places: number): number {
    const f = 10 ** places;
    return Math.round(n * f) / f;
}

/** The arithmetic behind every dashboard number. */
export function summarize(raw: RawStats, options: Pick<StatsOptions, 'windowMinutes' | 'minIdleMinutes'> = {}): DashboardStats {
    const windowMinutes = options.windowMinutes ?? 30;
    const minIdle = options.minIdleMinutes ?? 1;
    const idleMinutes = raw.idleMs / 60_000;
    const elapsedMinutes = Math.max((raw.asOf.getTime() - raw.windowStart.getTime()) / 60_000, 1 / 60);
    return {
        windowMinutes,
        windowStart: raw.windowStart.toISOString(),
        asOf: raw.asOf.toISOString(),
        falseActivationsPerIdleMinute: idleMinutes >= minIdle && idleMinutes > 0 ? round(raw.falseActivations / idleMinutes, 3) : null,
        falseActivations: raw.falseActivations,
        idleMinutes: round(idleMinutes, 2),
        yesActedAtRest: raw.yesActedAtRest,
        timeToPick: {
            p50Ms: raw.timedPicks > 0 && raw.p50 !== null ? Math.round(raw.p50) : null,
            p95Ms: raw.timedPicks > 0 && raw.p95 !== null ? Math.round(raw.p95) : null,
            picks: raw.timedPicks,
            method: raw.percentiles === 'toolkit' ? 'toolkit-uddsketch' : 'exact',
        },
        commandsPerMinute: round(raw.commands / elapsedMinutes, 2),
        commands: raw.commands,
        rowsWritten: raw.rowsWritten,
        lastWriteAt: raw.lastWriteAt ? raw.lastWriteAt.toISOString() : null,
    };
}

/** percentile_cont semantics (linear interpolation), for tests and for checking the SQL on known rows. */
export function percentileCont(values: readonly number[], p: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const pos = (sorted.length - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

/** $1 session key or null, $2 include test sessions. Kept in one place so every query filters the same way. */
const SESSION_FILTER = `(($1::text IS NOT NULL AND session_id = $1::text) OR ($1::text IS NULL AND ($2::boolean OR session_id NOT LIKE 'test-%')))`;

const TABLES = ['switch_events', 'scan_steps', 'picks', 'action_outcomes', 'rest_minutes'] as const;

export async function readPercentileMode(pool: pg.Pool): Promise<PercentileMode> {
    const r = await pool.query("SELECT variant FROM telemetry.migrations WHERE id LIKE '022\\_%' LIMIT 1");
    const v = (r.rows[0] as { variant?: string } | undefined)?.variant;
    if (v !== 'toolkit' && v !== 'exact') throw new Error('telemetry.picks_1m is not migrated yet; run npm run migrate.');
    return v;
}

export async function fetchRawStats(pool: pg.Pool, options: StatsOptions = {}): Promise<RawStats> {
    const windowMinutes = options.windowMinutes ?? 30;
    if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 24 * 60) throw new RangeError('windowMinutes must be 1 to 1440');
    if (options.sessionId !== undefined && !(TEST_SESSION_RE.test(options.sessionId) || /^[a-z0-9]+(-[a-z0-9]+)*:[0-9]{1,20}$/.test(options.sessionId))) {
        throw new RangeError('sessionId must look like say-when-demo:3 or test-<id>');
    }
    const params = [options.sessionId ?? null, options.includeTest ?? false, windowMinutes];
    const percentiles = await readPercentileMode(pool);

    const counts = (
        await pool.query(
            `WITH w AS (SELECT now() AS as_of, time_bucket(INTERVAL '1 minute', now()) - make_interval(mins => $3::int - 1) AS start)
             SELECT w.as_of, w.start,
                (SELECT coalesce(sum(false_activations), 0) FROM telemetry.switch_1m WHERE bucket >= w.start AND ${SESSION_FILTER}) AS false_activations,
                (SELECT coalesce(sum(commands), 0) FROM telemetry.switch_1m WHERE bucket >= w.start AND ${SESSION_FILTER}) AS commands,
                (SELECT coalesce(sum(yes_acted_at_rest), 0) FROM telemetry.switch_1m WHERE bucket >= w.start AND ${SESSION_FILTER}) AS yes_acted,
                (SELECT coalesce(sum(idle_ms), 0) FROM telemetry.idle_1m WHERE bucket >= w.start AND ${SESSION_FILTER}) AS idle_ms
             FROM w`,
            params,
        )
    ).rows[0] as Record<string, unknown>;
    const windowStart = counts.start as Date;

    const pickSql =
        percentiles === 'toolkit'
            ? `SELECT coalesce(sum(timed_picks), 0) AS n,
                  CASE WHEN coalesce(sum(timed_picks), 0) > 0 THEN approx_percentile(0.5, rollup(time_to_pick)) END AS p50,
                  CASE WHEN coalesce(sum(timed_picks), 0) > 0 THEN approx_percentile(0.95, rollup(time_to_pick)) END AS p95
               FROM telemetry.picks_1m WHERE bucket >= $3 AND ${SESSION_FILTER}`
            : `SELECT count(time_to_pick_ms) AS n,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY time_to_pick_ms) AS p50,
                  percentile_cont(0.95) WITHIN GROUP (ORDER BY time_to_pick_ms) AS p95
               FROM telemetry.picks WHERE time >= $3 AND time_to_pick_ms IS NOT NULL AND ${SESSION_FILTER}`;
    // Every placeholder is referenced: Postgres cannot type a parameter the statement never uses.
    const picks = (await pool.query(pickSql, [params[0], params[1], windowStart])).rows[0] as Record<string, unknown>;

    const written = (
        await pool.query(
            `SELECT coalesce(sum(n), 0) AS n, max(last) AS last FROM (
                ${TABLES.map((t) => `SELECT count(*) AS n, max(ingested_at) AS last FROM telemetry.${t} WHERE ${SESSION_FILTER}`).join(' UNION ALL ')}
             ) t`,
            params.slice(0, 2),
        )
    ).rows[0] as Record<string, unknown>;

    return {
        asOf: counts.as_of as Date,
        windowStart,
        falseActivations: num(counts.false_activations),
        commands: num(counts.commands),
        yesActedAtRest: num(counts.yes_acted),
        idleMs: num(counts.idle_ms),
        timedPicks: num(picks.n),
        p50: numOrNull(picks.p50),
        p95: numOrNull(picks.p95),
        percentiles,
        rowsWritten: num(written.n),
        lastWriteAt: (written.last as Date | null) ?? null,
    };
}

/** One call for the dashboard: every number, from Tiger. */
export async function getStats(pool: pg.Pool, options: StatsOptions = {}): Promise<DashboardStats> {
    return summarize(await fetchRawStats(pool, options), options);
}
