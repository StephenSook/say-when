// From SpacetimeDB rows to content-free Tiger rows. Pure: no clock, no network, no I/O, so tests drive it directly.
//
// What it decides (definitions in telemetry/README.md):
// - Resting: the session is live, nothing is on offer and nothing is in flight, and the decoder is reading the
//   person. The scan clock is `idle`, or `paused` on purpose (stop, idle auto-pause, operator; not a lost or removed
//   headset); no errand or call is open; and a station is online with a healthy decoder (device_status). The
//   timeline is built from server timestamps only (scan_state.updated_at, errand and call update times, the
//   ledger's session_start and session_end, device_status.last_seen_at), never from this laptop's clock.
// - Rest time is kept per second: a second counts when its midpoint falls inside a rest period. Each minute's
//   seconds are a 60-bit mask, merged with OR in Tiger, so restarts and overlapping writers add up to the union.
// - A false activation: a YES, NO, CONFIRM or STOP the module recorded as having nothing to act on (`ignored:idle`,
//   `ignored:nothing_to_confirm`, `ignored:paused`, `ignored:already_paused`) while the session was resting.
//   Commands the writer cannot place in observed time never count, and neither does rest time it did not observe,
//   so a gap can only leave the rate unknown, never inflate it.
// - Latency and time to pick: from the moment the option a command was matched to began playing (the ledger's
//   `step` row for the reading the station reported hearing, on the server clock) to the module's decision.
import {
    ANSWER_MODES,
    CALL_RESULTS,
    CALL_STATUSES,
    codeOf,
    COMMANDS,
    ERRAND_STATUSES,
    GESTURE_ID_RE,
    NOTHING_TO_ACT_ON,
    oneOf,
    OPEN_CALL,
    OPEN_ERRAND,
    PAUSE_REASONS,
    PERSON_COMMANDS,
    PHASES,
    PICK_CODES,
    PICK_KINDS,
    popcount,
    RESTING_PAUSES,
    SCAN_MODES,
    SCAN_OUTCOMES,
    sessionKey,
    type ActionIn,
    type CommandName,
    type DeviceIn,
    type LedgerIn,
    type Micros,
    type ScanIn,
    type TelemetryRow,
} from './types.js';

export type RestState = 'rest' | 'busy' | 'off' | 'unknown';

interface Segment {
    start: Micros;
    state: RestState;
}

interface StepMark {
    readonly stepSeq: bigint;
    readonly at: Micros;
    readonly cursor: number;
    readonly questionId: bigint;
}

interface StationState {
    readonly online: boolean;
    readonly healthy: boolean;
    readonly lastSeenAt: Micros;
}

interface SessionTrack {
    readonly id: bigint;
    readonly key: string;
    started: Micros | null;
    ended: Micros | null;
    scan: ScanIn | null;
    readonly actions: Map<string, ActionIn>;
    readonly emittedStatuses: Set<string>;
    readonly segments: Segment[];
    /** Rest has been emitted for all time before this server time. */
    emittedTo: Micros | null;
    readonly steps: StepMark[];
}

export interface TrackerCounters {
    ledgerRows: number;
    switchEvents: number;
    picks: number;
    stepMarks: number;
    scanSteps: number;
    actionOutcomes: number;
    restMinutes: number;
    /** Rows that did not match the contract (unknown command, bad id): dropped, never stored. */
    contractSkips: number;
    /** Picks whose reading step was never seen, so time to pick is unknown. */
    untimedPicks: number;
    /** Picks timed without their gesture row (it never arrived), from the readings of the question instead. */
    unpairedPicks: number;
    /** Commands the module called `ignored:idle` while this writer's timeline said the session was not resting. */
    restDisagreements: number;
    /** Timestamps that arrived older than the timeline's last change (clamped). */
    clampedTransitions: number;
    /** Rows older than MAX_ROW_AGE behind the latest server time: dropped (raw retention would remove them anyway). */
    tooOld: number;
}

export interface TrackerOptions {
    /** The SpacetimeDB database name; part of every session key (sessionKey). */
    readonly database: string;
    readonly emit: (row: TelemetryRow) => void;
    /** How much history to keep for classification and the step index. Default 3 hours. */
    readonly historyMicros?: bigint;
}

const SECOND = 1_000_000n;
const HALF_SECOND = 500_000n;
const MINUTE = 60n * SECOND;
const MAX_MS = 3_600_000;
const MAX_STEP_MARKS = 4_000;
/** How long a pick waits for its gesture row (and the other way round) before it is timed without it. */
const PAIRING_WAIT = 5n * SECOND;
/**
 * A station counts as reading the person only if it was seen this recently, and two sightings further apart than this
 * leave the time between them unobserved. A live station's device_status row is refreshed about every 2 s; if its
 * heartbeats stall, the module's dead-man lease (at most 5 s, docs/spacetime.md 2.10) marks it offline, so a live
 * station is always seen again within about 7 s. `end_session` never marks the station offline, so without this a
 * station from an ended session would stay "online" forever.
 */
export const STATION_FRESH = 8n * SECOND;
/** Rows older than this behind the latest server time are dropped: raw retention is 7 days (sql/030_retention.sql). */
export const MAX_ROW_AGE = 6n * 24n * 3600n * SECOND;

/** Codes whose gesture row carries the step the person heard, resolved by the module (docs/spacetime.md 3.4). */
const HEARD_CODES: ReadonlySet<string> = new Set([...PICK_CODES, 'skip', 'already_passed']);

function minMicros(a: Micros, b: Micros): Micros {
    return a < b ? a : b;
}
function maxMicros(a: Micros, b: Micros): Micros {
    return a > b ? a : b;
}
function floorDiv(a: bigint, b: bigint): bigint {
    const q = a / b;
    return a % b !== 0n && a < 0n ? q - 1n : q;
}
function ceilDiv(a: bigint, b: bigint): bigint {
    return -floorDiv(-a, b);
}
/** Start of the UTC minute holding `t` (epoch-aligned, like time_bucket('1 minute')). */
export function minuteStart(t: Micros): Micros {
    return floorDiv(t, MINUTE) * MINUTE;
}
/** Whole milliseconds between two server timestamps, clamped to the schema's range; null if negative. */
function msBetween(later: Micros, earlier: Micros): number | null {
    const diff = later - earlier;
    if (diff < 0n) return null;
    return Math.min(MAX_MS, Number(diff / 1000n));
}
function clampMs(ms: number): number {
    return Number.isFinite(ms) ? Math.min(MAX_MS, Math.max(0, Math.round(ms))) : 0;
}
function clampSmall(n: number): number {
    return Number.isInteger(n) ? Math.min(255, Math.max(0, n)) : 0;
}

/**
 * Rest seconds of one session in [from, to), as one 60-bit mask per UTC minute. Second k (epoch seconds) counts
 * when its midpoint, k + 0.5 s, falls inside a rest period, so a period of length L counts about L seconds.
 */
export function restMasks(segments: readonly Segment[], from: Micros, to: Micros): Map<Micros, bigint> {
    const out = new Map<Micros, bigint>();
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]!;
        if (seg.state !== 'rest') continue;
        const segEnd = i + 1 < segments.length ? segments[i + 1]!.start : to;
        const a = maxMicros(seg.start, from);
        const b = minMicros(segEnd, to);
        if (b <= a) continue;
        for (let k = ceilDiv(a - HALF_SECOND, SECOND), end = ceilDiv(b - HALF_SECOND, SECOND); k < end; k++) {
            const minuteIndex = floorDiv(k, 60n);
            const minute = minuteIndex * MINUTE;
            out.set(minute, (out.get(minute) ?? 0n) | (1n << (k - minuteIndex * 60n)));
        }
    }
    return out;
}

export class Tracker {
    private ready = false;
    private frontier: Micros | null = null;
    private readonly sessions = new Map<bigint, SessionTrack>();
    private readonly stations = new Map<string, StationState>();
    /** The latest time any station was seen online with a healthy decoder. A sighting vouches for STATION_FRESH. */
    private lastHealthySighting: Micros | null = null;
    /** The healthy sighting the last staleness cut was made for, so each silence is cut once (advance). */
    private staleCutFor: Micros | null = null;
    /**
     * Rest is settled up to here: the latest healthy sighting, or the point of a loss (after which every second is
     * busy). Rest minutes are never emitted past it, so a later row can still correct what follows.
     */
    private settledTo: Micros | null = null;
    private readonly seenLedger = new Set<bigint>();
    private buffered: LedgerIn[] = [];
    /** Pick rows waiting for their gesture row (same transaction, any order), by gesture id. */
    private readonly pendingPicks = new Map<string, { row: LedgerIn; session: SessionTrack }>();
    /** The reading an accepted pick gesture was matched to, waiting for its pick row, by gesture id. */
    private readonly heardByGesture = new Map<string, { mark: StepMark | null; at: Micros }>();
    readonly counters: TrackerCounters = {
        ledgerRows: 0,
        switchEvents: 0,
        picks: 0,
        stepMarks: 0,
        scanSteps: 0,
        actionOutcomes: 0,
        restMinutes: 0,
        contractSkips: 0,
        untimedPicks: 0,
        unpairedPicks: 0,
        restDisagreements: 0,
        clampedTransitions: 0,
        tooOld: 0,
    };
    private readonly history: bigint;

    constructor(private readonly options: TrackerOptions) {
        this.history = options.historyMicros ?? 3n * 3600n * SECOND;
    }

    /** The latest server time observed. */
    get knownUntil(): Micros | null {
        return this.frontier;
    }

    get isReady(): boolean {
        return this.ready;
    }

    /** The rest state of a session at a server time (strictly before it), for tests and diagnostics. */
    stateAt(sessionId: bigint, at: Micros): RestState {
        const s = this.sessions.get(sessionId);
        return s ? this.stateIn(s, at) : 'unknown';
    }

    // ---------- Input ----------

    ledger(row: LedgerIn): void {
        if (this.seenLedger.has(row.id)) return;
        this.seenLedger.add(row.id);
        this.counters.ledgerRows++;
        this.advance(row.at);
        if (!this.ready) {
            this.buffered.push(row);
            return;
        }
        this.applyLifecycle(row, true);
        this.processLedger(row);
    }

    scan(row: ScanIn): void {
        const s = this.track(row.sessionId);
        if (!s) return;
        const prev = s.scan;
        if (prev && (row.updatedAt < prev.updatedAt || (row.updatedAt === prev.updatedAt && row.stepSeq === prev.stepSeq))) return;
        s.scan = row;
        this.advance(row.updatedAt);
        const planned = row.stepEndsAt >= row.stepStartedAt ? msBetween(row.stepEndsAt, row.stepStartedAt) : null;
        this.emit({
            table: 'scan_steps',
            row: {
                time: row.updatedAt,
                sessionId: s.key,
                stepSeq: row.stepSeq,
                questionId: row.questionId,
                phase: oneOf(row.phase, PHASES),
                mode: oneOf(row.mode, SCAN_MODES),
                answerMode: oneOf(row.answerMode, ANSWER_MODES),
                cursor: clampSmall(row.cursor),
                optionCount: clampSmall(row.optionCount),
                pass: clampSmall(row.pass),
                plannedMs: planned,
                outcome: row.outcome ? oneOf(row.outcome, SCAN_OUTCOMES) : null,
                pauseReason: row.pauseReason ? oneOf(row.pauseReason, PAUSE_REASONS) : null,
            },
        });
        this.counters.scanSteps++;
        if (this.ready) this.transition(s, row.updatedAt);
    }

    action(row: ActionIn): void {
        const s = this.track(row.sessionId);
        if (!s) return;
        const id = `${row.kind}:${row.id}`;
        const prev = s.actions.get(id);
        if (prev && row.updatedAt < prev.updatedAt) return;
        s.actions.set(id, row);
        this.advance(row.updatedAt);
        const status = oneOf(row.status, row.kind === 'errand' ? ERRAND_STATUSES : CALL_STATUSES);
        const statusKey = `${id}:${status}`;
        if (!s.emittedStatuses.has(statusKey)) {
            s.emittedStatuses.add(statusKey);
            this.emit({
                table: 'action_outcomes',
                row: {
                    time: row.statusAt,
                    sessionId: s.key,
                    kind: row.kind,
                    actionId: row.id,
                    status,
                    result: row.kind === 'call' && row.result ? oneOf(row.result, CALL_RESULTS) : null,
                },
            });
            this.counters.actionOutcomes++;
        }
        if (this.ready) this.transition(s, row.updatedAt);
    }

    /**
     * A device_status row. Every row is a server clock tick; a station's rows also say whether the decoder is
     * reading the person. The module keeps a deliberate pause when the station drops (a signal pause never replaces
     * one), so this is the only public sign that a paused session stopped being observed.
     */
    device(row: DeviceIn): void {
        this.advance(row.lastSeenAt);
        const prev = this.stations.get(row.id);
        if (row.role !== 'station') {
            // An identity that was a station now holds another role (revoked, then paired again): it reads nobody, so
            // it is lost at its last sighting as a station, live or in a snapshot after a reconnect.
            if (prev) {
                this.stations.delete(row.id);
                if (prev.online && prev.healthy) this.lose(prev.lastSeenAt);
            }
            return;
        }
        if (prev && row.lastSeenAt < prev.lastSeenAt) return;
        // Health must be positively reported: a station that has not yet sent a heartbeat has none.
        const next: StationState = { online: row.online, healthy: row.decoderHealthy === true, lastSeenAt: row.lastSeenAt };
        this.stations.set(row.id, next);
        const at = row.lastSeenAt;
        const ok = next.online && next.healthy;
        if (ok) {
            if (this.lastHealthySighting === null || at > this.lastHealthySighting) this.lastHealthySighting = at;
            this.settle(at);
        }
        // A station that was reading the person is gone (offline, or an unhealthy decoder).
        if (prev && prev.online && prev.healthy && !ok) this.lose(at);
        if (!this.ready) return;
        const changed = !prev || prev.online !== next.online || prev.healthy !== next.healthy;
        for (const s of this.sessions.values()) {
            // Also re-judge on a plain heartbeat when the state would differ (a station that was stale is fresh again).
            if (changed || this.restStateOf(s, at) !== s.segments.at(-1)?.state) this.transition(s, at);
        }
    }

    /** The source's subscription is applied: the snapshot is complete. Builds or resumes every timeline. */
    markReady(): void {
        // Applied again without a loss in between: every change since arrived through the row callbacks already.
        if (this.ready) return;
        this.ready = true;
        const rows = this.buffered.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        this.buffered = [];
        for (const r of rows) this.applyLifecycle(r, false);
        for (const s of this.sessions.values()) this.resume(s);
        for (const r of rows) this.processLedger(r);
        // A pick and its gesture share a transaction, so both were in this snapshot; anything still unpaired is odd.
        this.flushPairs(true);
    }

    /** The source lost its connection: rest stops at the last server time seen, and later time is unknown. */
    markLost(): void {
        if (!this.ready) return;
        this.checkpoint();
        this.ready = false;
        for (const s of this.sessions.values()) {
            const last = s.segments.at(-1);
            if (last && last.state !== 'unknown') s.segments.push({ start: maxMicros(this.frontier ?? last.start, last.start), state: 'unknown' });
        }
    }

    /**
     * Emits rest minutes up to the settled time (the latest healthy sighting, or a loss), so a station that drops
     * between its 2-second updates is never counted past its last sighting. Safe to call as often as wanted: a
     * minute's mask only gains seconds.
     */
    checkpoint(): void {
        if (!this.ready || this.frontier === null) return;
        this.flushPairs(false);
        const bound = this.settledTo === null ? this.frontier : minMicros(this.frontier, this.settledTo);
        for (const s of this.sessions.values()) {
            const first = s.segments[0];
            if (!first) continue;
            // Nothing new since the last checkpoint: re-sending the same minutes would only cost writes.
            if (s.emittedTo !== null && bound <= s.emittedTo) continue;
            // Re-send the minute that was still filling, so it gains its new seconds; earlier minutes are final.
            const from = s.emittedTo === null ? first.start : minuteStart(s.emittedTo);
            for (const [minute, mask] of restMasks(s.segments, from, bound)) {
                this.emit({ table: 'rest_minutes', row: { time: minute, sessionId: s.key, restMask: mask, idleMs: popcount(mask) * 1000 } });
                this.counters.restMinutes++;
            }
            s.emittedTo = s.emittedTo === null ? bound : maxMicros(s.emittedTo, bound);
            this.trim(s, bound);
        }
    }

    // ---------- Internals ----------

    private emit(row: TelemetryRow): void {
        // Rows far behind the latest server time would only be removed by raw retention, and refreshing an aggregate
        // over them could replace buckets whose raw rows are already gone.
        if (this.frontier !== null && row.row.time < this.frontier - MAX_ROW_AGE) {
            this.counters.tooOld++;
            return;
        }
        this.options.emit(row);
    }

    private advance(at: Micros): void {
        if (this.frontier === null || at > this.frontier) this.frontier = at;
        // Live only: the server clock has passed the latest healthy sighting by more than STATION_FRESH with no newer
        // one, so nothing was reading the person once that sighting's freshness ran out. Rest from there becomes busy
        // now, before any row stamped later is judged, so commands and rest seconds use the same boundary. (A
        // snapshot after a reconnect is judged by resume() instead: it shows only each station's latest sighting.)
        const seen = this.lastHealthySighting;
        if (this.ready && seen !== null && this.frontier - seen > STATION_FRESH && this.staleCutFor !== seen) {
            this.staleCutFor = seen;
            const from = seen + STATION_FRESH;
            for (const s of this.sessions.values()) this.cutRest(s, from);
            this.settle(from);
        }
    }

    private track(sessionId: bigint): SessionTrack | null {
        if (sessionId === 0n) return null;
        let s = this.sessions.get(sessionId);
        if (!s) {
            s = {
                id: sessionId,
                key: sessionKey(this.options.database, sessionId),
                started: null,
                ended: null,
                scan: null,
                actions: new Map(),
                emittedStatuses: new Set(),
                segments: [],
                emittedTo: null,
                steps: [],
            };
            this.sessions.set(sessionId, s);
        }
        return s;
    }

    /**
     * A station is reading this session's person at `at`: online, healthy, seen within STATION_FRESH of `at`, and
     * seen since the session started. The module runs one session at a time and only that session's station can
     * heartbeat (requireStation), and start_session stamps it with the start time, so a station left online by an
     * ended session (end_session never marks it offline) can never vouch for a later session.
     */
    private stationOkFor(s: SessionTrack, at: Micros): boolean {
        for (const st of this.stations.values()) {
            if (!st.online || !st.healthy || st.lastSeenAt + STATION_FRESH < at) continue;
            if (s.started === null || st.lastSeenAt >= s.started) return true;
        }
        return false;
    }

    private settle(at: Micros): void {
        if (this.settledTo === null || at > this.settledTo) this.settledTo = at;
    }

    /**
     * A station that was reading the person is gone, last seen at `at`: for each session no other station reads,
     * rest ends there, whichever row of the transaction (the station's, or a scan pause stamped later) arrived first.
     * This holds for a snapshot after a reconnect too, before the timeline resumes.
     */
    private lose(at: Micros): void {
        for (const s of this.sessions.values()) if (!this.stationOkFor(s, at)) this.cutRest(s, at);
        this.settle(at);
    }

    /**
     * The last healthy station was lost at `at` (its last sighting). Rest is never emitted past a sighting, so the
     * timeline after `at` was not sent yet and can be corrected: rest there becomes busy. Never rewrites what was sent.
     */
    private cutRest(s: SessionTrack, at: Micros): void {
        const from = s.emittedTo !== null && s.emittedTo > at ? s.emittedTo : at;
        let covering = -1;
        for (let i = 0; i < s.segments.length; i++) {
            const seg = s.segments[i]!;
            if (seg.start < from) covering = i;
            else if (seg.state === 'rest') seg.state = 'busy';
        }
        const following = s.segments[covering + 1];
        if (covering >= 0 && s.segments[covering]!.state === 'rest' && (!following || following.start > from)) {
            s.segments.splice(covering + 1, 0, { start: from, state: 'busy' });
        }
        // Merge neighbours that now hold the same state.
        for (let i = s.segments.length - 1; i > 0; i--) {
            if (s.segments[i]!.state === s.segments[i - 1]!.state) s.segments.splice(i, 1);
        }
    }

    /** The session's rest state, with station freshness judged at `at`. */
    private restStateOf(s: SessionTrack, at: Micros): RestState {
        if (s.started === null || s.ended !== null) return 'off';
        if (!s.scan) return 'unknown';
        const quiet = s.scan.phase === 'idle' || (s.scan.phase === 'paused' && s.scan.pauseReason !== null && RESTING_PAUSES.has(s.scan.pauseReason));
        if (!quiet) return 'busy';
        for (const a of s.actions.values()) {
            if (a.kind === 'errand' ? OPEN_ERRAND.has(a.status) : OPEN_CALL.has(a.status)) return 'busy';
        }
        return this.stationOkFor(s, at) ? 'rest' : 'busy';
    }

    /** The newest server time at which the session's own state (lifecycle, scan, errands, calls) changed. */
    private latestChange(s: SessionTrack): Micros | null {
        let t: Micros | null = null;
        const take = (v: Micros | null | undefined) => {
            if (v !== null && v !== undefined && (t === null || v > t)) t = v;
        };
        take(s.started);
        take(s.ended);
        take(s.scan?.updatedAt);
        for (const a of s.actions.values()) take(a.updatedAt);
        return t;
    }

    private stateIn(s: SessionTrack, at: Micros): RestState {
        // Strictly before: a change made by the same transaction as `at` must not decide what happened at `at`.
        for (let i = s.segments.length - 1; i >= 0; i--) {
            if (s.segments[i]!.start < at) return s.segments[i]!.state;
        }
        return 'unknown';
    }

    private transition(s: SessionTrack, at: Micros): void {
        const state = this.restStateOf(s, at);
        const last = s.segments.at(-1);
        if (!last) {
            s.segments.push({ start: at, state });
            return;
        }
        let when = at;
        if (when < last.start) {
            this.counters.clampedTransitions++;
            when = last.start;
        }
        if (when === last.start) {
            // Several rows of one transaction: the last one decides the state from this time on.
            last.state = state;
            const before = s.segments.at(-2);
            if (before && before.state === state) s.segments.pop();
            return;
        }
        if (last.state !== state) s.segments.push({ start: when, state });
    }

    /**
     * After the first snapshot or a reconnect: start, continue or restart the timeline from the last change. An
     * idle scan is provably unchanged since its last change (a station drop would have paused it), but a deliberate
     * pause is not (the module keeps it when the station drops), so rest in a pause is claimed only from now on.
     */
    private resume(s: SessionTrack): void {
        const lastChange = this.latestChange(s);
        if (lastChange === null) return;
        // The state now: the snapshot is current as of the latest server time seen.
        const state = this.restStateOf(s, this.frontier ?? lastChange);
        const unprovable = state === 'rest' && s.scan?.phase === 'paused';
        const t0 = unprovable ? maxMicros(lastChange, this.frontier ?? lastChange) : lastChange;
        const last = s.segments.at(-1);
        if (!last) {
            s.segments.push({ start: t0, state });
            return;
        }
        if (last.state === 'unknown') {
            const gapStart = last.start;
            if (t0 <= gapStart) {
                // Nothing the state depends on changed during the gap, so the state before it held throughout.
                s.segments.pop();
                const before = s.segments.at(-1);
                if (!before || before.state !== state) s.segments.push({ start: gapStart, state });
            } else {
                s.segments.push({ start: t0, state });
            }
            return;
        }
        this.transition(s, maxMicros(t0, last.start));
    }

    private applyLifecycle(row: LedgerIn, live: boolean): void {
        if (row.kind !== 'session_start' && row.kind !== 'session_end') return;
        const s = this.track(row.sessionId);
        if (!s) return;
        if (row.kind === 'session_start' && (s.started === null || row.at < s.started)) s.started = row.at;
        if (row.kind === 'session_end' && (s.ended === null || row.at > s.ended)) s.ended = row.at;
        if (live) this.transition(s, row.at);
    }

    private processLedger(row: LedgerIn): void {
        switch (row.kind) {
            case 'step':
                this.indexStep(row);
                return;
            case 'gesture':
                this.switchEvent(row);
                return;
            case 'pick':
                this.pick(row);
                return;
            default:
                return;
        }
    }

    private indexStep(row: LedgerIn): void {
        const s = this.track(row.sessionId);
        if (!s) return;
        const last = s.steps.at(-1);
        const mark: StepMark = { stepSeq: row.stepSeq, at: row.at, cursor: row.cursor, questionId: row.questionId };
        if (!last || row.stepSeq > last.stepSeq) {
            s.steps.push(mark);
        } else {
            // Out of order: insert in place, ignoring an exact repeat.
            const i = s.steps.findIndex((m) => m.stepSeq >= row.stepSeq);
            if (s.steps[i]?.stepSeq !== row.stepSeq) s.steps.splice(i, 0, mark);
        }
        if (s.steps.length > MAX_STEP_MARKS) s.steps.splice(0, s.steps.length - MAX_STEP_MARKS);
        this.counters.stepMarks++;
    }

    /** The reading the person heard: the last option start at or before the step the station reported. */
    private heardMark(s: SessionTrack, heardStepSeq: bigint, questionId: bigint): StepMark | null {
        for (let i = s.steps.length - 1; i >= 0; i--) {
            const m = s.steps[i]!;
            if (m.stepSeq <= heardStepSeq) return questionId === 0n || m.questionId === questionId ? m : null;
        }
        return null;
    }

    private switchEvent(row: LedgerIn): void {
        const command = (COMMANDS as readonly string[]).includes(row.command) ? (row.command as CommandName) : null;
        const sep = row.outcome.indexOf(':');
        const verdict = sep > 0 ? row.outcome.slice(0, sep) : '';
        if (!command || (verdict !== 'accepted' && verdict !== 'ignored') || !GESTURE_ID_RE.test(row.gestureId)) {
            this.counters.contractSkips++;
            return;
        }
        const code = codeOf(row.outcome.slice(sep + 1));
        const s = this.track(row.sessionId);
        // Judged on the same timeline as the rest seconds: a command past a sighting's freshness finds the staleness
        // cut already made (advance runs first), and a replayed one finds what resume() could prove.
        const state: RestState = s ? this.stateIn(s, row.at) : 'unknown';
        const resting = state === 'rest' ? true : state === 'unknown' ? null : false;
        const nothingToActOn = verdict === 'ignored' && NOTHING_TO_ACT_ON.has(code);
        const falseActivation = resting === true && nothingToActOn && PERSON_COMMANDS.includes(command);
        // `ignored:idle` means the module saw an idle scan with nothing pending; the timeline should agree.
        if (verdict === 'ignored' && code === 'idle' && resting === false) this.counters.restDisagreements++;

        let heardIn: 'reading' | 'window' | null = null;
        let latencyMs: number | null = null;
        let mark: StepMark | null = null;
        if (s && HEARD_CODES.has(code)) {
            mark = this.heardMark(s, row.stepSeq, row.questionId);
            if (mark) {
                heardIn = row.stepSeq === mark.stepSeq ? 'reading' : 'window';
                latencyMs = msBetween(row.at, mark.at);
            }
        }
        if (s && verdict === 'accepted' && PICK_CODES.has(code)) {
            const pending = this.pendingPicks.get(row.gestureId);
            if (pending) {
                this.pendingPicks.delete(row.gestureId);
                this.emitPick(pending.session, pending.row, mark ?? this.fallbackMark(pending.session, pending.row));
            } else {
                this.heardByGesture.set(row.gestureId, { mark, at: row.at });
            }
        }
        this.emit({
            table: 'switch_events',
            row: {
                time: row.at,
                sessionId: sessionKey(this.options.database, row.sessionId),
                ledgerId: row.id,
                command,
                outcome: verdict,
                code,
                resting,
                falseActivation,
                heardStepSeq: row.stepSeq,
                optionRank: row.cursor > 0 ? clampSmall(row.cursor) : null,
                heardIn,
                latencyMs,
                lateByMs: row.ms > 0 ? clampMs(row.ms) : verdict === 'accepted' && HEARD_CODES.has(code) ? 0 : null,
            },
        });
        this.counters.switchEvents++;
    }

    /** A pick is timed from the reading its own gesture was matched to; the two rows meet by gesture id. */
    private pick(row: LedgerIn): void {
        const s = this.track(row.sessionId);
        if (!s) {
            this.counters.contractSkips++;
            return;
        }
        const heard = this.heardByGesture.get(row.gestureId);
        if (heard) {
            this.heardByGesture.delete(row.gestureId);
            this.emitPick(s, row, heard.mark ?? this.fallbackMark(s, row));
            return;
        }
        if (!GESTURE_ID_RE.test(row.gestureId)) {
            this.counters.unpairedPicks++;
            this.emitPick(s, row, this.fallbackMark(s, row));
            return;
        }
        this.pendingPicks.set(row.gestureId, { row, session: s });
    }

    /**
     * Without the gesture row: the newest reading of the question up to the pick, or for a late pick (grace window,
     * late_by_ms > 0) the reading before it (docs/spacetime.md 3.4 step 5). Off by one pass only for a late pick under
     * a millisecond, which the gesture row resolves whenever it is there.
     */
    private fallbackMark(s: SessionTrack, row: LedgerIn): StepMark | null {
        const marks = s.steps.filter((m) => m.questionId === row.questionId && m.at <= row.at);
        let heard = clampMs(row.ms) > 0 ? marks.at(-2) : marks.at(-1);
        const kind = oneOf(row.outcome, PICK_KINDS);
        if (heard && kind !== 'yes' && kind !== 'no' && heard.cursor !== row.cursor) {
            heard = [...marks].reverse().find((m) => m.cursor === row.cursor);
        }
        return heard ?? null;
    }

    private emitPick(s: SessionTrack, row: LedgerIn, mark: StepMark | null): void {
        const timeToPickMs = mark ? msBetween(row.at, mark.at) : null;
        if (timeToPickMs === null) this.counters.untimedPicks++;
        this.emit({
            table: 'picks',
            row: {
                time: row.at,
                sessionId: s.key,
                ledgerId: row.id,
                questionId: row.questionId,
                optionRank: clampSmall(row.cursor),
                pickKind: oneOf(row.outcome, PICK_KINDS),
                timeToPickMs,
                lateByMs: clampMs(row.ms),
            },
        });
        this.counters.picks++;
    }

    /** Times picks whose gesture row has not come within PAIRING_WAIT (or all of them), and forgets stale pairings. */
    private flushPairs(all: boolean): void {
        const cutoff = this.frontier === null ? null : this.frontier - PAIRING_WAIT;
        for (const [id, p] of this.pendingPicks) {
            if (all || (cutoff !== null && p.row.at < cutoff)) {
                this.pendingPicks.delete(id);
                this.counters.unpairedPicks++;
                this.emitPick(p.session, p.row, this.fallbackMark(p.session, p.row));
            }
        }
        for (const [id, h] of this.heardByGesture) {
            if (all || (cutoff !== null && h.at < cutoff)) this.heardByGesture.delete(id);
        }
    }

    /** Drops history the classifier can no longer need. */
    private trim(s: SessionTrack, now: Micros): void {
        const cutoff = now - this.history;
        while (s.segments.length > 1 && s.segments[1]!.start <= cutoff) s.segments.shift();
        while (s.steps.length > 0 && s.steps[0]!.at < cutoff) s.steps.shift();
    }
}
