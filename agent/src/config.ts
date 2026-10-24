// Settings from the environment. Every check reports the variable's NAME and whether it is set or usable, never
// its value. Missing optional pieces turn a feature off (no web search, no memory, no errands, no calls) and say
// so at startup; a malformed value stops the sidecar before it connects.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';

import { DEFAULT_PLANNER_EFFORT, DEFAULT_PLANNER_MODEL, DEFAULT_PLANNER_TIMEOUT_MS, type Effort } from './planner/claude.js';

export interface AgentConfig {
    spacetime: { uri: string; database: string; tokenFile: string };
    planner: { model: string; effort: Effort; timeoutMs: number };
    search: { enabled: boolean; timeoutMs: number; placesNear: { lat: number; lng: number } | null };
    errands: { enabled: boolean };
    moss: { enabled: boolean; reopen: boolean };
    calls: { enabled: boolean };
    formsFile: string | null;
    memoryShareable: boolean;
    timeZone: string;
    maxJobs: number;
    maxOptions: number;
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
    searchTimeoutMs: 20_000,
    maxJobs: 3,
    maxOptions: 4,
} as const;

/** Where `ant auth login` keeps its profiles (the claude-api skill, shared/anthropic-cli.md). Existence only. */
export function defaultAnthropicProfile(): boolean {
    return existsSync(join(homedir(), '.config', 'anthropic'));
}

/** Reads every setting. `tokenFileDefault` is agent/.agent-token. */
export function readConfig(env: Env, tokenFileDefault: string, hasAnthropicProfile: () => boolean = defaultAnthropicProfile): ConfigResult {
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

    return {
        config: {
            spacetime: { uri, database, tokenFile },
            planner: { model, effort, timeoutMs: plannerTimeout },
            search: { enabled: apify, timeoutMs: searchTimeoutMs, placesNear },
            errands: { enabled: apify && formErrand },
            moss: { enabled: mossWanted && mossReady, reopen },
            calls: { enabled: calls },
            formsFile,
            memoryShareable,
            timeZone,
            maxJobs,
            maxOptions,
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
