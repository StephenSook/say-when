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
import { randomBytes } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync, type Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';

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

/** A pid or status file was not written: its folder or its path is not safe. The message is a fixed phrase. */
export class WarmFileError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WarmFileError';
    }
}

/**
 * Writes a small private file next to the token file. Refused when the folder belongs to someone else or others can
 * write to it, or when a symlink stands at the path (it could point at the token file). The text goes to a new temp
 * file in the same folder (created exclusively, never through a symlink, mode 600) and is renamed into place, so a
 * reader never sees half a file and a planted link is replaced, not followed.
 */
export function writePrivate(path: string, text: string): void {
    const folder = dirname(path);
    const info = statSync(folder);
    if ((info.mode & 0o022) !== 0) throw new WarmFileError('the folder can be written by others');
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new WarmFileError('the folder belongs to another user');
    if (lstatOrNull(path)?.isSymbolicLink()) throw new WarmFileError('a symlink stands where the file goes');
    const temp = join(folder, `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
        writeSync(fd, text);
    } finally {
        closeSync(fd);
    }
    try {
        renameSync(temp, path);
    } catch (error) {
        removeQuietly(temp);
        throw error;
    }
}

/** A private file's text, or null when it is missing, a symlink or not a plain file. */
export function readPrivate(path: string): string | null {
    const info = lstatOrNull(path);
    if (!info || !info.isFile()) return null;
    let fd: number;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
        return null;
    }
    try {
        return readFileSync(fd, 'utf8');
    } finally {
        closeSync(fd);
    }
}

function lstatOrNull(path: string): Stats | null {
    try {
        return lstatSync(path);
    } catch {
        return null;
    }
}

export function removeQuietly(path: string): void {
    try {
        rmSync(path, { force: true });
    } catch {
        // Nothing to clean up.
    }
}

const NONCE = /^[0-9a-f]{32}$/;

/** A fresh nonce for one sidecar run: `warm` trusts only a status that carries it. */
export function newNonce(): string {
    return randomBytes(16).toString('hex');
}

/** The sidecar writes its pid and its run's nonce once it can answer SIGUSR2. */
export function writePidFile(path: string, pid: number, nonce: string): void {
    writePrivate(path, `${JSON.stringify({ pid, nonce })}\n`);
}

/** The pid and nonce in a pid file, or null when it is missing, a symlink or not in that shape. */
export function readPidFile(path: string): { pid: number; nonce: string } | null {
    const text = readPrivate(path);
    if (text === null) return null;
    try {
        const parsed = JSON.parse(text) as { pid?: unknown; nonce?: unknown };
        if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 1 && typeof parsed.nonce === 'string' && NONCE.test(parsed.nonce)) {
            return { pid: parsed.pid, nonce: parsed.nonce };
        }
    } catch {
        // Not a pid file this sidecar wrote.
    }
    return null;
}

/** The sidecar's answer to a warm, tagged with its run's nonce. */
export function writeWarmStatus(path: string, line: WarmLine, nonce: string): void {
    writePrivate(path, JSON.stringify({ ...line, nonce }));
}

/** What `warm` checks about the process a pid file names, before it sends anything. */
export interface ProcessInfo {
    command: string;
    /** The process's working folder. The sidecar runs in this package's folder (run-with-keychain.sh, npm start). */
    cwd: string;
    /** When it started (epoch ms, to the second). */
    startedAtMs: number;
}

function firstWorking(paths: readonly string[], args: readonly string[]): string | null {
    for (const path of paths) {
        try {
            return execFileSync(path, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 });
        } catch {
            // Try the next location, then give up.
        }
    }
    return null;
}

/** `[[dd-]hh:]mm:ss` from `ps -o etime=` in milliseconds, or null. */
export function elapsedMs(etime: string): number | null {
    const match = /^(?:(\d+)-)?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(etime.trim());
    if (!match) return null;
    const [, days, hours, minutes, seconds] = match;
    return (((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

/** The command, working folder and start of a process, from `ps` and `lsof`. Null when either cannot say. */
export function probeProcess(pid: number): ProcessInfo | null {
    const ps = firstWorking(['/bin/ps', '/usr/bin/ps'], ['-p', String(pid), '-o', 'etime=,command=']);
    const lsof = firstWorking(['/usr/sbin/lsof', '/usr/bin/lsof'], ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    if (!ps || !lsof) return null;
    const line = ps.trim();
    const space = line.indexOf(' ');
    if (space < 0) return null;
    const elapsed = elapsedMs(line.slice(0, space));
    const cwd = lsof.split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? '';
    if (elapsed === null || cwd === '') return null;
    return { command: line.slice(space + 1).trim(), cwd, startedAtMs: Date.now() - elapsed };
}

function sameFolder(a: string, b: string): boolean {
    const norm = (path: string) => {
        let real = path;
        try {
            real = realpathSync(path);
        } catch {
            // Compared as written.
        }
        return real.replace(/\/+$/, '');
    };
    return norm(a) === norm(b);
}

export type FoundSidecar = { pid: number; nonce: string } | { skip: 'none' | 'unconfirmed' };

/**
 * The pid in the pid file, only when that process is alive, runs `src/main.ts run`, works in this package's folder
 * and started before the pid file was written. A pid file left behind by a crash can name a process that reused the
 * pid, and SIGUSR2 would end it, so anything that cannot be confirmed is `unconfirmed` and is never signalled.
 */
export function runningSidecar(pidFile: string, expectedCwd: string, probe: (pid: number) => ProcessInfo | null = probeProcess): FoundSidecar {
    const found = readPidFile(pidFile);
    if (!found) return { skip: 'none' };
    try {
        process.kill(found.pid, 0);
    } catch {
        return { skip: 'none' };
    }
    const info = probe(found.pid);
    const written = lstatOrNull(pidFile)?.mtimeMs ?? 0;
    if (!info) return { skip: 'unconfirmed' };
    if (!/src\/main\.ts run\b/.test(info.command)) return { skip: 'unconfirmed' };
    if (!sameFolder(info.cwd, expectedCwd)) return { skip: 'unconfirmed' };
    // `ps` gives the start to the second, so one second of slack; a process that reused the pid started later.
    if (info.startedAtMs > written + 1_000) return { skip: 'unconfirmed' };
    return found;
}

/**
 * Asks the running sidecar to warm Moss (SIGUSR2) and waits, at most `timeoutMs`, for a status that carries the nonce
 * from its pid file. A finite wait: it ends when that status arrives or the time is up.
 */
export async function askSidecar(
    files: { pid: string; status: string },
    options: {
        expectedCwd: string;
        timeoutMs?: number;
        pollMs?: number;
        clock?: () => number;
        signal?: (pid: number) => void;
        probe?: (pid: number) => ProcessInfo | null;
    },
): Promise<WarmLine> {
    const clock = options.clock ?? (() => performance.now());
    const started = clock();
    const found = runningSidecar(files.pid, options.expectedCwd, options.probe);
    if ('skip' in found) {
        return found.skip === 'none'
            ? { step: 'moss', ok: false, ms: 0, note: 'no running sidecar found; Moss opens when the sidecar starts' }
            : { step: 'moss', ok: false, ms: 0, note: 'skipped: could not confirm that the pid file names this sidecar, so nothing was signalled' };
    }
    const before = lstatOrNull(files.status)?.mtimeMs ?? 0;
    const send = options.signal ?? ((target: number) => process.kill(target, 'SIGUSR2'));
    send(found.pid);
    const deadline = Date.now() + (options.timeoutMs ?? 40_000);
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 200));
        if ((lstatOrNull(files.status)?.mtimeMs ?? 0) <= before) continue;
        const text = readPrivate(files.status);
        if (text === null) continue;
        try {
            const line = JSON.parse(text) as Partial<WarmLine> & { nonce?: unknown };
            if (line.nonce !== found.nonce) continue;
            if (line.step === 'moss' && typeof line.ok === 'boolean' && typeof line.ms === 'number' && typeof line.note === 'string') {
                return { step: 'moss', ok: line.ok, ms: line.ms, note: line.note };
            }
        } catch {
            // Not an answer: read again on the next turn.
        }
    }
    return { step: 'moss', ok: false, ms: clock() - started, note: 'the sidecar did not answer in time' };
}
