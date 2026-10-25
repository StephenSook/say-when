// Settings from the environment. Every check reports the variable's NAME and whether it is set or usable, never
// its value. Missing optional pieces turn a feature off (no web search, no memory, no errands, no calls) and say
// so at startup; a malformed value stops the sidecar before it connects.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';

import { isEmailAddress, maskEmail } from './email.js';
import { DEFAULT_PLANNER_EFFORT, DEFAULT_PLANNER_MODEL, DEFAULT_PLANNER_TIMEOUT_MS, type Effort } from './planner/claude.js';
import { loadPreload, PRELOAD_DEFAULTS, PreloadFileError, type PreloadSearch } from './preload.js';
import { isSandboxDatabase, SANDBOX_LIMIT_DEFAULTS, type SandboxLimits } from './sandbox.js';

export interface AgentConfig {
    /** `token`: the identity token from AGENT_TOKEN (a host with no lasting disk), used instead of the token file. */
    spacetime: { uri: string; database: string; tokenFile: string; token: string | null };
    /** The judge try sandbox's caps (AGENT_TRY=on), or null when it is off. */
    sandbox: SandboxLimits | null;
    /** PORT: the health endpoint's port (a web service host sets it), or null for none. */
    port: number | null;
    /** AGENT_HEALTH_HOST: the address the health endpoint listens on (`127.0.0.1` on a laptop), or null for every address. */
    healthHost: string | null;
    planner: { model: string; effort: Effort; timeoutMs: number };
    search: { enabled: boolean; timeoutMs: number; placesNear: { lat: number; lng: number } | null };
    /**
     * PLAN D26: the preloaded search results (src/preload.ts). `searches` is the list from AGENT_PRELOAD_FILE (maps
     * searches only when AGENT_PLACES_NEAR is set); off (empty) with AGENT_PRELOAD=off, an empty list or no Apify.
     */
    preload: { searches: PreloadSearch[]; refreshMs: number; timeoutMs: number };
    /**
     * AGENT_PINNED_PLACE (PLAN D26): a place always offered as one reply to a place question (the demo venue), or null.
     * Only its name: it is cited when the maps search found it, and is never given an address, hours or a rating.
     */
    pinnedPlace: string | null;
    errands: { enabled: boolean };
    /** ERRAND_EMAIL_TO (PLAN D25): the care team email after a sent form, or null when it is off. Private: never logged. */
    email: { to: string | null };
    moss: { enabled: boolean; reopen: boolean };
    calls: { enabled: boolean };
    formsFile: string | null;
    memoryShareable: boolean;
    timeZone: string;
    maxJobs: number;
    maxOptions: number;
    /** AGENT_YES_NO_FAST (on by default), AGENT_DRAFT_FIRST (off by default) and AGENT_SEARCH_PREFETCH (on by default). */
    speed: { yesNoFast: boolean; draftFirst: boolean; prefetch: boolean };
    /**
     * AGENT_INPUT_MODE: `direct` (the default on this branch, docs/direct-select.md) offers a Search option and searches
     * only after the person asks; `scan` keeps the scan path, which searches inside the options job.
     */
    inputMode: 'direct' | 'scan';
}

export interface EnvCheck {
    name: string;
    state: 'set' | 'not set' | 'invalid';
    /** What the variable is for, or what happens without it. Never the value. */
    note: string;
}

export interface ConfigResult {
    config: AgentConfig;
    checks: EnvCheck[];
    /** Fatal: the sidecar does not start. */
    problems: string[];
}

type Env = Readonly<Record<string, string | undefined>>;

const has = (env: Env, name: string) => (env[name] ?? '').trim() !== '';

function flag(env: Env, name: string, fallback: boolean, checks: EnvCheck[], problems: string[], note: string): boolean {
    const raw = (env[name] ?? '').trim().toLowerCase();
    if (raw === '') return fallback;
    if (['on', 'true', '1', 'yes'].includes(raw)) {
        checks.push({ name, state: 'set', note });
        return true;
    }
    if (['off', 'false', '0', 'no'].includes(raw)) {
        checks.push({ name, state: 'set', note });
        return false;
    }
    checks.push({ name, state: 'invalid', note: 'use on or off' });
    problems.push(`${name} must be on or off.`);
    return fallback;
}

function integer(env: Env, name: string, fallback: number, min: number, max: number, checks: EnvCheck[], problems: string[], note: string): number {
    const raw = (env[name] ?? '').trim();
    if (raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
        checks.push({ name, state: 'invalid', note: `a whole number from ${min} to ${max}` });
        problems.push(`${name} must be a whole number from ${min} to ${max}.`);
        return fallback;
    }
    checks.push({ name, state: 'set', note });
    return value;
}

function validTimeZone(zone: string): boolean {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
        return true;
    } catch {
        return false;
    }
}

export const DEFAULTS = {
    uri: 'https://maincloud.spacetimedb.com',
    database: 'say-when-dev',
    timeZone: 'America/Los_Angeles',
    // PLAN D26 (Stephen, Oct 25): the whole wait for outside facts is at most 11 s.
    searchTimeoutMs: 11_000,
    maxJobs: 3,
    maxOptions: 4,
} as const;

/** Where `ant auth login` keeps its profiles (the claude-api skill, shared/anthropic-cli.md). Existence only. */
export function defaultAnthropicProfile(): boolean {
    return existsSync(join(homedir(), '.config', 'anthropic'));
}

/** Reads every setting. `tokenFileDefault` is agent/.agent-token. */
export function readConfig(
    env: Env,
    tokenFileDefault: string,
    hasAnthropicProfile: () => boolean = defaultAnthropicProfile,
    /** agent/preload.example.json: the preload list when AGENT_PRELOAD_FILE is not set. Null: no default list. */
    preloadFileDefault: string | null = null,
): ConfigResult {
    const checks: EnvCheck[] = [];
    const problems: string[] = [];

    // SpacetimeDB.
    const uri = (env.SPACETIMEDB_URI ?? '').trim() || DEFAULTS.uri;
    checks.push({ name: 'SPACETIMEDB_URI', state: has(env, 'SPACETIMEDB_URI') ? 'set' : 'not set', note: has(env, 'SPACETIMEDB_URI') ? 'SpacetimeDB host' : `using ${DEFAULTS.uri}` });
    if (!/^(https|wss|http|ws):\/\//.test(uri)) problems.push('SPACETIMEDB_URI must start with https://, wss://, http:// or ws://.');
    const database = (env.SPACETIMEDB_DB ?? '').trim() || DEFAULTS.database;
    const dbOk = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(database);
    checks.push({ name: 'SPACETIMEDB_DB', state: !dbOk ? 'invalid' : has(env, 'SPACETIMEDB_DB') ? 'set' : 'not set', note: has(env, 'SPACETIMEDB_DB') ? 'database name' : `using ${DEFAULTS.database}` });
    if (!dbOk) problems.push('SPACETIMEDB_DB must be lowercase letters, digits and dashes.');
    const tokenFile = (env.AGENT_TOKEN_FILE ?? '').trim() || tokenFileDefault;
    // The token is written on the first connection; a folder that does not exist would lose the identity.
    const tokenFolder = existsSync(dirname(tokenFile));
    checks.push({
        name: 'AGENT_TOKEN_FILE',
        state: tokenFolder ? (has(env, 'AGENT_TOKEN_FILE') ? 'set' : 'not set') : 'invalid',
        note: !tokenFolder ? 'its folder does not exist' : existsSync(tokenFile) ? 'token file found' : 'no token file yet: run npm run pair',
    });
    if (!tokenFolder) problems.push('AGENT_TOKEN_FILE is in a folder that does not exist.');

    // The planner (Anthropic). The SDK also reads ANTHROPIC_AUTH_TOKEN, ANTHROPIC_PROFILE or an `ant auth login`
    // profile on disk (only the folder's existence is checked here). Without any of them every question would fail,
    // so the sidecar does not start.
    const anthropicEnv = has(env, 'ANTHROPIC_API_KEY') || has(env, 'ANTHROPIC_AUTH_TOKEN') || has(env, 'ANTHROPIC_PROFILE');
    const anthropicProfile = !anthropicEnv && hasAnthropicProfile();
    checks.push({
        name: 'ANTHROPIC_API_KEY',
        state: has(env, 'ANTHROPIC_API_KEY') ? 'set' : 'not set',
        note: anthropicEnv ? 'Claude writes the options' : anthropicProfile ? 'using the ant auth login profile' : 'no Anthropic credentials',
    });
    if (!anthropicEnv && !anthropicProfile) {
        problems.push('No Anthropic credentials: set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN), or sign in with ant auth login.');
    }
    const model = (env.AGENT_PLANNER_MODEL ?? '').trim() || DEFAULT_PLANNER_MODEL;
    const modelOk = /^claude-[a-z0-9-]{1,60}$/.test(model);
    checks.push({ name: 'AGENT_PLANNER_MODEL', state: !modelOk ? 'invalid' : has(env, 'AGENT_PLANNER_MODEL') ? 'set' : 'not set', note: `planner model ${modelOk ? model : '(invalid)'}` });
    if (!modelOk) problems.push('AGENT_PLANNER_MODEL must be a Claude model id such as claude-haiku-5-5.');
    const rawEffort = (env.AGENT_PLANNER_EFFORT ?? '').trim();
    const effort = (rawEffort || DEFAULT_PLANNER_EFFORT) as Effort;
    if (!['low', 'medium', 'high'].includes(effort)) {
        checks.push({ name: 'AGENT_PLANNER_EFFORT', state: 'invalid', note: 'low, medium or high' });
        problems.push('AGENT_PLANNER_EFFORT must be low, medium or high.');
    } else if (rawEffort) {
        checks.push({ name: 'AGENT_PLANNER_EFFORT', state: 'set', note: `effort ${effort}` });
    }
    const plannerTimeout = integer(env, 'AGENT_PLANNER_TIMEOUT_MS', DEFAULT_PLANNER_TIMEOUT_MS, 1_000, 60_000, checks, problems, 'planner timeout per attempt');

    // Apify: search and errands.
    const apify = has(env, 'APIFY_TOKEN');
    checks.push({ name: 'APIFY_TOKEN', state: apify ? 'set' : 'not set', note: apify ? 'web and place search' : 'no web search and no errands' });
    const formErrand = has(env, 'FORM_ERRAND_URL');
    checks.push({ name: 'FORM_ERRAND_URL', state: formErrand ? 'set' : 'not set', note: formErrand ? 'form errands' : 'no form errands' });
    const searchTimeoutMs = integer(env, 'AGENT_SEARCH_TIMEOUT_MS', DEFAULTS.searchTimeoutMs, 5_000, 40_000, checks, problems, 'search deadline');
    let placesNear: { lat: number; lng: number } | null = null;
    const near = (env.AGENT_PLACES_NEAR ?? '').trim();
    if (near) {
        const [lat, lng] = near.split(',').map((part) => Number(part.trim()));
        if (lat === undefined || lng === undefined || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
            checks.push({ name: 'AGENT_PLACES_NEAR', state: 'invalid', note: 'use lat,lng' });
            problems.push('AGENT_PLACES_NEAR must be "lat,lng".');
        } else {
            placesNear = { lat, lng };
            checks.push({ name: 'AGENT_PLACES_NEAR', state: 'set', note: 'place questions use the maps search' });
        }
    } else {
        checks.push({ name: 'AGENT_PLACES_NEAR', state: 'not set', note: 'place questions use the web search' });
    }

    // PLAN D26: preloaded search results (src/preload.ts), used when a live search is slow or fails.
    const preloadWanted = flag(env, 'AGENT_PRELOAD', true, checks, problems, 'preloaded search results as the fallback');
    const preloadRefreshMs = integer(env, 'AGENT_PRELOAD_REFRESH_MS', PRELOAD_DEFAULTS.refreshMs, 0, 24 * 60 * 60_000, checks, problems, 'preload refresh, 0 for never');
    if (preloadRefreshMs > 0 && preloadRefreshMs < 60_000) problems.push('AGENT_PRELOAD_REFRESH_MS must be 0 or at least 60000.');
    const preloadTimeoutMs = integer(env, 'AGENT_PRELOAD_TIMEOUT_MS', PRELOAD_DEFAULTS.timeoutMs, 5_000, 60_000, checks, problems, 'each preload search deadline');
    const preloadFileSet = (env.AGENT_PRELOAD_FILE ?? '').trim();
    const preloadFile = preloadFileSet || preloadFileDefault;
    let preloadSearches: PreloadSearch[] = [];
    if (!preloadWanted || !apify) {
        checks.push({ name: 'AGENT_PRELOAD_FILE', state: preloadFileSet ? 'set' : 'not set', note: preloadWanted ? 'no preload: no APIFY_TOKEN' : 'no preload: AGENT_PRELOAD is off' });
    } else if (!preloadFile) {
        checks.push({ name: 'AGENT_PRELOAD_FILE', state: 'not set', note: 'no preload list' });
    } else if (!preloadFileSet && !existsSync(preloadFile)) {
        checks.push({ name: 'AGENT_PRELOAD_FILE', state: 'not set', note: 'no preload: the default list is missing' });
    } else {
        try {
            const all = loadPreload(preloadFile);
            preloadSearches = all.filter((search) => search.kind === 'web' || placesNear !== null);
            const skipped = all.length - preloadSearches.length;
            checks.push({
                name: 'AGENT_PRELOAD_FILE',
                state: preloadFileSet ? 'set' : 'not set',
                note: `${preloadSearches.length} preload searches${skipped > 0 ? `, ${skipped} maps searches skipped without AGENT_PLACES_NEAR` : ''}`,
            });
        } catch (error) {
            checks.push({ name: 'AGENT_PRELOAD_FILE', state: 'invalid', note: error instanceof PreloadFileError ? error.message : 'could not be read' });
            problems.push(`AGENT_PRELOAD_FILE: ${error instanceof PreloadFileError ? error.message : 'the preload file could not be read.'}`);
        }
    }
    const pinnedRaw = (env.AGENT_PINNED_PLACE ?? '').replace(/\s+/g, ' ').trim();
    let pinnedPlace: string | null = null;
    if (pinnedRaw === '') {
        checks.push({ name: 'AGENT_PINNED_PLACE', state: 'not set', note: 'no pinned place' });
    } else if (!/^[\p{L}\p{N} '&.,-]{2,60}$/u.test(pinnedRaw)) {
        checks.push({ name: 'AGENT_PINNED_PLACE', state: 'invalid', note: 'a place name of 2 to 60 letters, digits and spaces' });
        problems.push('AGENT_PINNED_PLACE must be a place name of 2 to 60 letters, digits and spaces.');
    } else {
        pinnedPlace = pinnedRaw;
        checks.push({ name: 'AGENT_PINNED_PLACE', state: 'set', note: 'offered as one reply to every place question' });
    }

    // Moss memory.
    const mossVars = ['MOSS_PROJECT_ID', 'MOSS_PROJECT_KEY', 'MOSS_SNAPSHOT_DIR'];
    for (const name of mossVars) checks.push({ name, state: has(env, name) ? 'set' : 'not set', note: 'Moss memory' });
    const mossReady = mossVars.every((name) => has(env, name));
    const mossWanted = flag(env, 'AGENT_MOSS', mossReady, checks, problems, 'Moss on or off');
    if (mossWanted && !mossReady) problems.push('AGENT_MOSS is on but MOSS_PROJECT_ID, MOSS_PROJECT_KEY or MOSS_SNAPSHOT_DIR is not set.');
    const reopen = flag(env, 'AGENT_MOSS_REOPEN', false, checks, problems, 'reopen Moss after its idle close');
    const memoryShareable = flag(env, 'AGENT_MEMORY_SHAREABLE', false, checks, problems, 'replies written to memory are marked shareable');

    // Calls (stretch).
    const calls = flag(env, 'AGENT_CALLS', false, checks, problems, 'outbound calls');
    if (calls) {
        // CALL_HOLD_FILE: the Dialer keeps holds on contacts there, so a hold survives a restart (cartesia/src/server.ts).
        for (const name of ['CARTESIA_API_KEY', 'CARTESIA_AGENT_ID', 'CARTESIA_FROM_NUMBER_ID', 'CALL_CALLBACK_NUMBER', 'CALL_PERSON_NAME', 'CALL_HOLD_FILE']) {
            checks.push({ name, state: has(env, name) ? 'set' : 'not set', note: 'outbound calls' });
            if (!has(env, name)) problems.push(`AGENT_CALLS is on but ${name} is not set.`);
        }
        const consent = has(env, 'CALL_CONSENT_FILE') || has(env, 'CALL_CONSENT');
        checks.push({ name: 'CALL_CONSENT_FILE', state: consent ? 'set' : 'not set', note: consent ? 'consent list' : 'no consent list: no calls' });
    }

    // Forms and the rest.
    const formsFile = (env.AGENT_FORMS_FILE ?? '').trim() || null;
    checks.push({ name: 'AGENT_FORMS_FILE', state: formsFile ? (existsSync(formsFile) ? 'set' : 'invalid') : 'not set', note: formsFile ? 'errand forms' : 'no errand options' });
    if (formsFile && !existsSync(formsFile)) problems.push('AGENT_FORMS_FILE names a file that does not exist.');
    const timeZone = (env.AGENT_TIME_ZONE ?? '').trim() || DEFAULTS.timeZone;
    if (!validTimeZone(timeZone)) {
        checks.push({ name: 'AGENT_TIME_ZONE', state: 'invalid', note: 'an IANA zone such as America/Los_Angeles' });
        problems.push('AGENT_TIME_ZONE must be an IANA time zone.');
    }
    const maxJobs = integer(env, 'AGENT_MAX_JOBS', DEFAULTS.maxJobs, 1, 8, checks, problems, 'jobs at once');
    const maxOptions = integer(env, 'AGENT_MAX_OPTIONS', DEFAULTS.maxOptions, 2, 4, checks, problems, 'options per question');
    // Speed (src/fastpath.ts). The fast path is on by default. Draft first is off: the module ends a question with no
    // pick when the draft's passes run out and cancels the job, even while the options with web results are still
    // coming (spacetime/src/clock.ts endPass, finishScan), so with a short draft and a slow search they can be lost.
    const yesNoFast = flag(env, 'AGENT_YES_NO_FAST', true, checks, problems, 'stock Yes and No at once for a clear yes or no question');
    const draftFirst = flag(env, 'AGENT_DRAFT_FIRST', false, checks, problems, 'options from memory while the web search runs');
    // Direct select (src/prefetch.ts): the search for each category starts as the categories are offered, after the
    // person confirmed the search, so a Category pick does not wait for an Apify run to start. Unused runs cost money.
    const prefetch = flag(env, 'AGENT_SEARCH_PREFETCH', true, checks, problems, 'each category search starts as the categories are offered');
    // Direct select (docs/direct-select.md): four gestures pick four options, and a search runs only when asked for.
    const rawMode = (env.AGENT_INPUT_MODE ?? '').trim().toLowerCase();
    let inputMode: 'direct' | 'scan' = 'direct';
    if (rawMode === 'direct' || rawMode === 'scan') {
        inputMode = rawMode;
        checks.push({ name: 'AGENT_INPUT_MODE', state: 'set', note: `${rawMode} input mode` });
    } else if (rawMode !== '') {
        checks.push({ name: 'AGENT_INPUT_MODE', state: 'invalid', note: 'use direct or scan' });
        problems.push('AGENT_INPUT_MODE must be direct or scan.');
    } else {
        checks.push({ name: 'AGENT_INPUT_MODE', state: 'not set', note: 'direct select: a Search option, and a search only when asked' });
    }

    // The judge try sandbox (src/sandbox.ts). It runs only against a try database, never with calls, and never in the
    // demo's Moss memory; and a try database never runs without its caps.
    const sandboxWanted = flag(env, 'AGENT_TRY', false, checks, problems, 'judge try sandbox: spending caps and sample notes');
    let sandbox: SandboxLimits | null = null;
    if (sandboxWanted) {
        if (!isSandboxDatabase(database)) problems.push('AGENT_TRY is on, so SPACETIMEDB_DB must be say-when-try or say-when-try-dev.');
        if (calls) problems.push('AGENT_TRY is on, so AGENT_CALLS must be off: the sandbox never places a call.');
        const session = (env.MOSS_SESSION_NAME ?? '').trim();
        if (mossWanted && mossReady && (session === '' || session === 'say-when')) {
            problems.push('AGENT_TRY is on, so MOSS_SESSION_NAME must be set and must not be say-when: the sandbox keeps its own memory.');
        }
        const dailyCents = integer(env, 'AGENT_TRY_DAILY_CENTS', SANDBOX_LIMIT_DEFAULTS.dailyUsd * 100, 10, 10_000, checks, problems, 'daily spending ceiling in cents');
        sandbox = {
            ...SANDBOX_LIMIT_DEFAULTS,
            dailyUsd: dailyCents / 100,
            questionsPerPartnerPerHour: integer(env, 'AGENT_TRY_QUESTIONS_PER_HOUR', SANDBOX_LIMIT_DEFAULTS.questionsPerPartnerPerHour, 1, 100, checks, problems, 'questions per judge page per hour'),
            partnersPerHour: integer(env, 'AGENT_TRY_PARTNERS_PER_HOUR', SANDBOX_LIMIT_DEFAULTS.partnersPerHour, 1, 200, checks, problems, 'judge pages per hour'),
        };
    } else if (isSandboxDatabase(database)) {
        problems.push('SPACETIMEDB_DB is a try database, so AGENT_TRY must be on: its caps bound the spending.');
    }
    const token = (env.AGENT_TOKEN ?? '').trim() || null;
    checks.push({ name: 'AGENT_TOKEN', state: token ? 'set' : 'not set', note: token ? 'identity token from the environment; the token file is not used' : 'identity token from AGENT_TOKEN_FILE' });
    const port = has(env, 'PORT') ? integer(env, 'PORT', 0, 1, 65_535, checks, problems, 'health endpoint port') : null;
    // A laptop run (scripts/demo-up.sh) keeps the endpoint on loopback, off the venue network; a host leaves it unset.
    const healthHost = (env.AGENT_HEALTH_HOST ?? '').trim() || null;
    if (healthHost !== null) {
        const loopback = healthHost === '127.0.0.1' || healthHost === '::1' || healthHost === 'localhost';
        checks.push({ name: 'AGENT_HEALTH_HOST', state: loopback ? 'set' : 'invalid', note: loopback ? 'health endpoint on this laptop only' : 'use 127.0.0.1, ::1 or localhost' });
        if (!loopback) problems.push('AGENT_HEALTH_HOST must be 127.0.0.1, ::1 or localhost (leave it unset to listen on every address).');
    }

    // PLAN D25: the care team email after a sent form (src/email.ts). The address is private: only its shape is
    // checked, and neither a check nor a problem ever prints it. Never in the try sandbox (judges run it).
    const emailRaw = (env.ERRAND_EMAIL_TO ?? '').trim();
    let emailTo: string | null = null;
    if (emailRaw === '') {
        checks.push({ name: 'ERRAND_EMAIL_TO', state: 'not set', note: 'no email after a form' });
    } else if (!isEmailAddress(emailRaw)) {
        checks.push({ name: 'ERRAND_EMAIL_TO', state: 'invalid', note: 'one email address' });
        problems.push('ERRAND_EMAIL_TO must be one email address.');
    } else if (sandboxWanted) {
        checks.push({ name: 'ERRAND_EMAIL_TO', state: 'set', note: 'off: the try sandbox never sends an email' });
    } else if (!(apify && formErrand)) {
        checks.push({ name: 'ERRAND_EMAIL_TO', state: 'set', note: 'off: it needs APIFY_TOKEN and FORM_ERRAND_URL' });
    } else {
        emailTo = emailRaw;
        checks.push({ name: 'ERRAND_EMAIL_TO', state: 'set', note: `the care team email after a sent form, to ${maskEmail(emailRaw)}` });
    }

    return {
        config: {
            spacetime: { uri, database, tokenFile, token },
            sandbox,
            port,
            healthHost,
            planner: { model, effort, timeoutMs: plannerTimeout },
            search: { enabled: apify, timeoutMs: searchTimeoutMs, placesNear },
            preload: { searches: preloadSearches, refreshMs: preloadRefreshMs, timeoutMs: preloadTimeoutMs },
            pinnedPlace,
            errands: { enabled: apify && formErrand },
            email: { to: emailTo },
            moss: { enabled: mossWanted && mossReady, reopen },
            calls: { enabled: calls },
            formsFile,
            memoryShareable,
            timeZone,
            maxJobs,
            maxOptions,
            speed: { yesNoFast, draftFirst, prefetch },
            inputMode,
        },
        checks,
        problems,
    };
}

/**
 * Loads `.env.local` files without overriding anything already in the environment. `paths` are tried in order;
 * an earlier file wins over a later one.
 */
export function loadEnvFiles(paths: readonly string[], env: Record<string, string | undefined> = process.env): string[] {
    const loaded: string[] = [];
    for (const path of paths) {
        if (!existsSync(path)) continue;
        const parsed = parseEnv(readFileSync(path, 'utf8'));
        for (const [name, value] of Object.entries(parsed)) {
            if (env[name] === undefined && typeof value === 'string') env[name] = value;
        }
        loaded.push(path);
    }
    return loaded;
}
