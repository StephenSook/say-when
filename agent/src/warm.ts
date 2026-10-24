// `npm run warm` (or `scripts/run-with-keychain.sh warm`): gets the slow first steps out of the way before a judge's
// first question. One line per step, with its time. No key, token, URL or content is ever printed.
//
// - moss: Moss runs inside the sidecar process and closes itself after 3 idle minutes (moss/README.md), so opening it
//   in this short-lived process would bill a second session and help nothing. Instead `warm` asks the running sidecar
//   (found by its pid file, next to AGENT_TOKEN_FILE) to open its own Moss, or, when it is open, to make one local
//   read so its idle clock starts again. The sidecar writes the result to a status file, which `warm` prints.
// - apify: one GET of the form-errand Actor's Standby root (`GET /` describes the Actor), which starts a container if
//   none is up. No preview, no submit, no form is touched.
// - cartesia: mints one 60-second TTS access token with CARTESIA_API_KEY and throws it away, to show the key and the
//   API answer.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';

import { withDeadline } from './deadline.js';
import type { MemoryPort } from './ports.js';

export type WarmStep = 'moss' | 'apify' | 'cartesia';

export interface WarmLine {
    step: WarmStep;
    ok: boolean;
    ms: number;
    /** A fixed phrase, sometimes with an HTTP status or an error name. Never a value. */
    note: string;
}

/** `warm apify ok 840 ms: the Actor answered`. */
export function formatWarm(line: WarmLine): string {
    return `warm ${line.step} ${line.ok ? 'ok' : 'not ok'} ${Math.round(line.ms)} ms: ${line.note}`;
}

type Fetch = (url: string, init: RequestInit) => Promise<{ status: number; body?: { cancel(): Promise<void> } | null }>;

/** An error's class name, never its message (which can quote a URL or a body). */
function nameOf(error: unknown): string {
    const name = error instanceof Error ? error.name : '';
    return /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) ? name : 'error';
}

/** One GET of a Standby Actor's root, with the token in the Authorization header only and no redirects. */
export async function wakeStandby(baseUrl: string | undefined, token: string | undefined, options: { fetch?: Fetch; timeoutMs?: number; clock?: () => number } = {}): Promise<WarmLine> {
    const clock = options.clock ?? (() => performance.now());
    const started = clock();
    if (!baseUrl) return { step: 'apify', ok: false, ms: 0, note: 'FORM_ERRAND_URL is not set' };
    if (!token) return { step: 'apify', ok: false, ms: 0, note: 'APIFY_TOKEN is not set' };
    const fetchFn = options.fetch ?? (fetch as unknown as Fetch);
    try {
        const response = await fetchFn(`${baseUrl.replace(/\/+$/, '')}/`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            redirect: 'error',
            signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
        });
        await response.body?.cancel().catch(() => undefined);
        const ok = response.status >= 200 && response.status < 300;
        return { step: 'apify', ok, ms: clock() - started, note: ok ? 'the form-errand Actor answered' : `the form-errand Actor answered http ${response.status}` };
    } catch (error) {
        return { step: 'apify', ok: false, ms: clock() - started, note: `no answer (${nameOf(error)})` };
    }
}

export type MintToken = (apiKey: string) => Promise<unknown>;

/** Mints one short TTS token and drops it. */
export async function checkVoiceToken(apiKey: string | undefined, mint: MintToken, clock: () => number = () => performance.now()): Promise<WarmLine> {
    const started = clock();
    if (!apiKey || apiKey.trim() === '') return { step: 'cartesia', ok: false, ms: 0, note: 'CARTESIA_API_KEY is not set' };
    try {
        await mint(apiKey);
        return { step: 'cartesia', ok: true, ms: clock() - started, note: 'a voice token was minted (and dropped)' };
    } catch (error) {
        return { step: 'cartesia', ok: false, ms: clock() - started, note: `no token (${nameOf(error)})` };
    }
}

/** What the sidecar's Moss warm needs: the run's open state and start, and a read on the memory. */
export interface MossLike {
    readonly isOpen: boolean;
    start(): Promise<unknown>;
}

/**
 * In the sidecar: opens Moss when it is closed, or makes one local read when it is open, so the idle close is 3
 * minutes away again. Bounded: a stuck Moss call cannot hold the sidecar.
 */
export async function warmMoss(moss: MossLike | null, memory: MemoryPort | null, clock: () => number = () => performance.now(), timeoutMs = 30_000): Promise<WarmLine> {
    const started = clock();
    if (!moss || !memory) return { step: 'moss', ok: false, ms: 0, note: 'memory is off in this sidecar' };
    try {
        if (!moss.isOpen) {
            await withDeadline(moss.start(), timeoutMs, 'moss start');
            return { step: 'moss', ok: true, ms: clock() - started, note: 'opened in the sidecar; it closes after 3 idle minutes' };
        }
        // Read-only: a recall for a partner id no one has. Any Moss call restarts the idle clock.
        await withDeadline(memory.recall('warm up', 'warm'), timeoutMs, 'moss recall');
        return { step: 'moss', ok: true, ms: clock() - started, note: 'already open in the sidecar; its idle clock started again' };
    } catch (error) {
        return { step: 'moss', ok: false, ms: clock() - started, note: `not warmed (${nameOf(error)})` };
    }
}

// ---------- Between `warm` and the running sidecar ----------

/** The sidecar's pid file and warm status file, next to its token file (outside the repo with the Keychain script). */
export function warmFiles(tokenFile: string): { pid: string; status: string } {
    return { pid: `${tokenFile}.pid`, status: `${tokenFile}.warm` };
}

export function writePrivate(path: string, text: string): void {
    writeFileSync(path, text, { mode: 0o600 });
    chmodSync(path, 0o600);
}

export function removeQuietly(path: string): void {
    try {
        rmSync(path, { force: true });
    } catch {
        // Nothing to clean up.
    }
}

/** The pid in the pid file, only if that process is alive and is this sidecar's `main.ts run`. */
export function runningSidecar(pidFile: string, commandOf: (pid: number) => string = psCommand): number | null {
    if (!existsSync(pidFile)) return null;
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 1) return null;
    try {
        process.kill(pid, 0);
    } catch {
        return null;
    }
    // A pid file left behind by a crash can name an unrelated process now; SIGUSR2 would end it. Check the command.
    return /src\/main\.ts run\b/.test(commandOf(pid)) ? pid : null;
}

function psCommand(pid: number): string {
    try {
        return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
        return '';
    }
}

/**
 * Asks the running sidecar to warm Moss (SIGUSR2) and waits, at most `timeoutMs`, for its status file to change.
 * A finite wait: it ends when the status arrives or the time is up.
 */
export async function askSidecar(
    files: { pid: string; status: string },
    options: { timeoutMs?: number; pollMs?: number; clock?: () => number; signal?: (pid: number) => void; commandOf?: (pid: number) => string } = {},
): Promise<WarmLine> {
    const clock = options.clock ?? (() => performance.now());
    const started = clock();
    const pid = runningSidecar(files.pid, options.commandOf);
    if (pid === null) return { step: 'moss', ok: false, ms: 0, note: 'no running sidecar found; Moss opens when the sidecar starts' };
    const before = existsSync(files.status) ? statSync(files.status).mtimeMs : 0;
    const send = options.signal ?? ((target: number) => process.kill(target, 'SIGUSR2'));
    send(pid);
    const deadline = Date.now() + (options.timeoutMs ?? 40_000);
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 200));
        if (!existsSync(files.status) || statSync(files.status).mtimeMs <= before) continue;
        try {
            const line = JSON.parse(readFileSync(files.status, 'utf8')) as Partial<WarmLine>;
            if (line.step === 'moss' && typeof line.ok === 'boolean' && typeof line.ms === 'number' && typeof line.note === 'string') {
                return { step: 'moss', ok: line.ok, ms: line.ms, note: line.note };
            }
        } catch {
            // Half written: read it again on the next turn.
        }
    }
    return { step: 'moss', ok: false, ms: clock() - started, note: 'the sidecar did not answer in time' };
}
