// The Eleven agent sidecar's command line.
//
//   npm start         run the sidecar (loads agent/.env.local, then the repo's .env.local, without overriding
//                     variables already set)
//   npm run pair      pair this laptop's identity with the module as the Agent role
//   npm run check     print which settings are present (names only) and exit
//   npm run warm      before a judge arrives: wake the form-errand Actor, check a voice token can be minted, and
//                     ask the running sidecar to open Moss (src/warm.ts). One line per step on stdout.
//
// Startup prints every setting by NAME with whether it is set; values are never printed.

import { randomInt, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadConfig as loadApifyConfig } from '@say-when/apify-client';
import { mintAccessToken } from '@say-when/cartesia/server';

import { CallRunner } from './calls.js';
import { loadEnvFiles, readConfig, type ConfigResult } from './config.js';
import { BINDINGS_DIR, BINDINGS_SDK, loadBuilder } from './db/bindings.js';
import { SpacetimeAgentDb, TokenSaveError } from './db/spacetime-db.js';
import { ErrandRunner } from './errands.js';
import { ConversationLog, PreviewBook, type JobDeps } from './jobs.js';
import { consoleLogger, type Logger } from './log.js';
import { Orchestrator } from './orchestrator.js';
import { errorTag, startupFailureLine, StartupError } from './startup.js';
import { askSidecar, checkVoiceToken, formatWarm, removeQuietly, wakeStandby, warmFiles, warmMoss, writePrivate } from './warm.js';
import { classifyQuestion, wire } from './wiring.js';

const AGENT_DIR = fileURLToPath(new URL('../', import.meta.url));
const REPO_DIR = fileURLToPath(new URL('../../', import.meta.url));

function printChecks(result: ConfigResult, log: Logger): void {
    for (const check of result.checks) log.info('setting', { name: check.name, state: check.state, note: check.note });
    for (const problem of result.problems) log.error(problem);
}

function readToken(path: string): string | undefined {
    if (!existsSync(path)) return undefined;
    const token = readFileSync(path, 'utf8').trim();
    return token === '' ? undefined : token;
}

function saveToken(path: string, log: Logger): (token: string) => void {
    return (token) => {
        writeFileSync(path, `${token}\n`, { mode: 0o600 });
        chmodSync(path, 0o600);
        log.info('saved the SpacetimeDB identity token', { file: 'AGENT_TOKEN_FILE' });
    };
}

async function connect(result: ConfigResult, log: Logger): Promise<SpacetimeAgentDb> {
    const builder = await loadBuilder();
    if (!builder) throw new StartupError('The generated SpacetimeDB bindings are not in spacetime/bindings/agent. Generate them (docs/spacetime.md 7.1) and start again.');
    const { uri, database, tokenFile } = result.config.spacetime;
    let token: string | undefined;
    try {
        token = readToken(tokenFile);
    } catch (error) {
        throw new StartupError(`Could not read AGENT_TOKEN_FILE (${errorTag(error)}).`);
    }
    const db = new SpacetimeAgentDb({ builder, uri, database, token, saveToken: saveToken(tokenFile, log), log });
    try {
        await db.connect();
    } catch (error) {
        if (error instanceof TokenSaveError) {
            throw new StartupError(`Could not save the SpacetimeDB identity token in AGENT_TOKEN_FILE (${error.code}). Check that its folder exists and can be written.`);
        }
        throw new StartupError('Could not connect to SpacetimeDB. Check SPACETIMEDB_URI, SPACETIMEDB_DB and the token file.');
    }
    if (!(await db.ready(15_000))) {
        db.close();
        throw new StartupError('Connected, but the agent subscription did not apply within 15 s. Check that this identity is paired as Agent.');
    }
    return db;
}

async function pair(result: ConfigResult, log: Logger): Promise<number> {
    const db = await connect(result, log);
    try {
        if (db.isPairedAgent()) {
            process.stdout.write('This sidecar is already paired as Agent. Start it with: npm start\n');
            return 0;
        }
        let code = 0;
        for (let tries = 0; tries < 5; tries++) {
            code = randomInt(100000, 1000000);
            try {
                await db.call('requestPairing', { code, role: 'agent', label: 'agent sidecar' });
                break;
            } catch (error) {
                const message = error instanceof Error ? error.message : '';
                if (message.includes('already paired')) {
                    process.stdout.write('This identity is already paired. Start it with: npm start\n');
                    return 0;
                }
                if (!message.includes('code taken') || tries === 4) {
                    // The module's refusals are short fixed phrases (spacetime/src); anything else goes by its code.
                    const why = /^[a-z0-9 _:-]{1,60}$/.test(message) ? message : errorTag(error);
                    throw new StartupError(`The pairing request failed (${why}).`);
                }
            }
        }
        process.stdout.write(
            `Pairing requested. On the owner's laptop run:\n\n  spacetime call ${result.config.spacetime.database} approve_pairing ${code} false\n\nWaiting up to 5 minutes for the approval...\n`,
        );
        const deadline = Date.now() + 5 * 60_000;
        while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 2_000));
            if (db.isPairedAgent()) {
                process.stdout.write('Paired as Agent. Start the sidecar with: npm start\n');
                return 0;
            }
        }
        process.stdout.write('No approval within 5 minutes. Run npm run pair again for a new code.\n');
        return 1;
    } finally {
        db.close();
    }
}

async function run(result: ConfigResult, log: Logger): Promise<number> {
    const { config } = result;
    const conversation = new ConversationLog();
    const previews = new PreviewBook();
    let calls: CallRunner | null = null;
    const wired = await wire(config, process.env, log, (snapshot) => calls?.onSnapshot(snapshot));
    log.info('features', {
        search: wired.search !== null,
        placesNear: config.search.placesNear !== null,
        memory: wired.memory !== null,
        errands: wired.errands !== null,
        forms: wired.forms.length,
        calls: wired.dialer !== null,
        model: config.planner.model,
        effort: config.planner.effort,
        yesNoFast: config.speed.yesNoFast,
        draftFirst: config.speed.draftFirst,
    });

    const db = await connect(result, log);
    if (db.isPairedAgent() === false) {
        db.close();
        await wired.moss?.close('stop');
        log.error('this identity is not paired as Agent; run npm run pair first');
        return 1;
    }

    const deps: JobDeps = {
        db,
        planner: wired.planner,
        retrieval: {
            classify: classifyQuestion,
            search: wired.search,
            memory: wired.memory,
            web: wired.web,
            placesNear: config.search.placesNear,
            searchTimeoutMs: config.search.timeoutMs,
            log,
        },
        errands: wired.errands,
        dialer: wired.dialer,
        forms: wired.forms,
        contacts: wired.contacts,
        previews,
        conversation,
        log,
        timeZone: config.timeZone,
        maxOptions: config.maxOptions,
        memoryShareable: config.memoryShareable,
        now: Date.now,
        clock: () => performance.now(),
        requestId: () => `call-${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        yesNoFast: config.speed.yesNoFast,
        draftFirst: config.speed.draftFirst,
    };
    calls = new CallRunner({ db, dialer: wired.dialer, log, clock: () => performance.now(), now: Date.now });
    const errands = new ErrandRunner({ db, errands: wired.errands, previews, log, clock: () => performance.now() });
    const orchestrator = new Orchestrator(deps, { errands, calls }, { maxJobs: config.maxJobs });
    orchestrator.start();
    log.info('the sidecar is running; press Ctrl-C to stop');

    // `npm run warm` finds this process by its pid file and sends SIGUSR2: Moss opens here (or its idle clock starts
    // again), and the result goes to the status file that `warm` prints. One warm at a time.
    const files = warmFiles(config.spacetime.tokenFile);
    let warming = false;
    const onWarm = () => {
        if (warming) return;
        warming = true;
        void warmMoss(wired.moss, wired.memory)
            .then((line) => {
                log.info(formatWarm(line));
                writePrivate(files.status, JSON.stringify(line));
            })
            .catch(() => log.warn('warm: the status could not be written'))
            .finally(() => (warming = false));
    };
    process.on('SIGUSR2', onWarm);
    try {
        writePrivate(files.pid, `${process.pid}\n`);
    } catch {
        log.warn('warm: the pid file could not be written; npm run warm will not find this sidecar');
    }

    return new Promise<number>((resolve) => {
        let stopping = false;
        const stop = (signal: NodeJS.Signals) => {
            if (stopping) {
                log.warn('second signal: exiting now');
                process.exit(130);
            }
            stopping = true;
            log.info('stopping', { signal });
            void (async () => {
                process.off('SIGUSR2', onWarm);
                removeQuietly(files.pid);
                removeQuietly(files.status);
                await orchestrator.stop(20_000);
                await wired.moss?.close('signal');
                db.close();
                resolve(0);
            })();
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
    });
}

/** `npm run warm`: the three steps at once, then one line each. Exit 0 only when all three are ok. */
async function warm(result: ConfigResult): Promise<number> {
    let apifyUrl: string | undefined;
    let apifyToken: string | undefined;
    try {
        const apify = loadApifyConfig(process.env);
        apifyUrl = apify.formErrandUrl;
        apifyToken = apify.token;
    } catch {
        // Reported by wakeStandby as a setting that is not set.
    }
    const lines = await Promise.all([
        askSidecar(warmFiles(result.config.spacetime.tokenFile)),
        wakeStandby(apifyUrl, apifyToken),
        checkVoiceToken(process.env.CARTESIA_API_KEY, (key) => mintAccessToken(key, 'tts', { expiresInSeconds: 60, timeoutMs: 15_000 })),
    ]);
    for (const line of lines) process.stdout.write(`${formatWarm(line)}\n`);
    return lines.every((line) => line.ok) ? 0 : 1;
}

async function main(): Promise<number> {
    const command = process.argv[2] ?? 'run';
    const log = consoleLogger();
    if ((process.env.AGENT_ENV_FILES ?? '').trim().toLowerCase() !== 'off') {
        const loaded = loadEnvFiles([`${AGENT_DIR}.env.local`, `${REPO_DIR}.env.local`]);
        log.info('settings files', { loaded: loaded.length });
    }
    const result = readConfig(process.env, `${AGENT_DIR}.agent-token`);
    printChecks(result, log);
    const bindings = existsSync(new URL('index.ts', BINDINGS_DIR));
    const sdk = existsSync(BINDINGS_SDK);
    log.info('generated bindings', { present: bindings, sdkInstalled: sdk });
    if (bindings && !sdk) log.error('the bindings import spacetimedb from spacetime/node_modules: run npm ci in spacetime/');

    if (command === 'check') return result.problems.length === 0 && bindings && sdk ? 0 : 1;
    // Warm needs only its own settings, so an unrelated problem does not stop it.
    if (command === 'warm') return warm(result);
    if (result.problems.length > 0) {
        log.error('fix the settings above and start again');
        return 1;
    }
    if (command === 'pair') return pair(result, log);
    if (command === 'run') return run(result, log);
    log.error('unknown command; use run, pair, check or warm');
    return 2;
}

main().then(
    (code) => process.exit(code),
    (error: unknown) => {
        // Only messages written to be shown are printed; anything else by its code or name (src/startup.ts).
        process.stderr.write(`${startupFailureLine(error)}\n`);
        process.exit(1);
    },
);
