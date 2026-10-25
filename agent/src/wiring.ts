// Builds the real pieces from apify/client, moss and cartesia for the ports in src/ports.ts. Each piece is optional
// and says at startup why it is off. Keys are read by the packages themselves from the environment and never pass
// through this file's logs.

import Anthropic from '@anthropic-ai/sdk';
import { classifyQuestion, FormErrandClient, loadConfig as loadApifyConfig, searchPlaces, searchWeb, type ApifyConfig, type FetchLike } from '@say-when/apify-client';
import { CallConfigError, dialerFromEnv, loadCallLists, type CallSnapshot } from '@say-when/cartesia/server';
import { MemoryStore, MossRun, rankOptions, WebIndex, type MemoryItem } from '@say-when/moss';

import type { AgentConfig } from './config.js';
import { loadForms } from './forms.js';
import type { Logger } from './log.js';
import { ClaudePlanner } from './planner/claude.js';
import type { DialerPort, ErrandPort, MemoryPort, SearchPort, WebIndexPort } from './ports.js';
import { SAMPLE_NOTES } from './sandbox.js';
import { errorTag, StartupError } from './startup.js';
import type { AllowedForm, CallContact } from './types.js';

export interface Wired {
    planner: ClaudePlanner;
    search: SearchPort | null;
    errands: ErrandPort | null;
    memory: MemoryPort | null;
    web: WebIndexPort | null;
    dialer: DialerPort | null;
    contacts: CallContact[];
    forms: AllowedForm[];
    moss: MossRun | null;
}

/** The search port over the Apify client. `fetchFn` is for tests; the sidecar uses the global fetch. */
export function searchPort(config: ApifyConfig, timeoutMs: number, fetchFn?: FetchLike): SearchPort {
    const http = fetchFn ? { fetch: fetchFn } : {};
    return {
        // No retries inside the client: each send of the question is the sidecar's own decision, made right after it
        // read the web search consent (src/retrieval.ts searchStep). A retry after a backoff would send it again
        // without that check. (Place search never retries starting a run.)
        web: (question, { signal }) => searchWeb(question, { config, signal, timeoutMs, maxResults: 3, retries: 0, ...http }),
        // Three places: direct select offers at most three replies, and a run asked for fewer places ends sooner (a
        // run for 6 hit its 20 s limit on Oct 25). A run that reaches its limit still returns what it found (partial).
        places: (query, { signal, near }) =>
            searchPlaces(query, { config, signal, ...(near ? { near } : {}), maxPlaces: 3, timeoutSecs: Math.max(10, Math.floor(timeoutMs / 1000) - 5), ...http }),
    };
}

/**
 * Adds the sandbox's sample notes (src/sandbox.ts) to an open Moss run. Ids come from the text, so adding them again
 * after a reopen updates the same documents. A failure only means the try runs without them.
 */
export async function seedNotes(store: Pick<MemoryStore, 'add'>, notes: readonly MemoryItem[], log: Logger): Promise<void> {
    if (notes.length === 0) return;
    try {
        const { added, updated } = await store.add(notes);
        log.info('sample notes are in memory', { added, updated });
    } catch (error) {
        log.warn('the sample notes could not be added; the try runs without them', { code: (error as { code?: string }).code ?? 'error' });
    }
}

function memoryPort(run: MossRun, store: MemoryStore, reopen: boolean, log: Logger, notes: readonly MemoryItem[]): MemoryPort {
    let reopening = false;
    return {
        isOpen() {
            if (!run.isOpen && reopen && !reopening) {
                reopening = true;
                log.info('reopening Moss after its idle close');
                run.start()
                    .then(
                        () => {
                            log.info('Moss is open again');
                            return seedNotes(store, notes, log);
                        },
                        (error: unknown) => log.warn('Moss could not reopen', { code: (error as { code?: string }).code ?? 'error' }),
                    )
                    .finally(() => (reopening = false));
            }
            return run.isOpen;
        },
        recall: (question, partnerId) => store.recall(question, partnerId),
        writeBack: (confirmed) => store.writeBack(confirmed),
        rank: (partnerId, options) => rankOptions(store, partnerId, options),
        // A preference for every partner ("any"): the person's own request, whoever asked about it.
        addNote: (note) =>
            store.add([{ type: 'pref', text: note.text, shareable: note.shareable }]).then((result) => ({ id: result.ids[0] ?? '', added: result.added, updated: result.updated })),
    };
}

/** Everything the sidecar runs with. `onSnapshot` receives the Dialer's call updates. */
export async function wire(config: AgentConfig, env: Readonly<Record<string, string | undefined>>, log: Logger, onSnapshot: (snapshot: CallSnapshot) => void): Promise<Wired> {
    const planner = new ClaudePlanner({
        api: new Anthropic({ maxRetries: 0 }).beta.messages,
        model: config.planner.model,
        effort: config.planner.effort,
        timeoutMs: config.planner.timeoutMs,
        log,
    });

    let search: SearchPort | null = null;
    let errands: ErrandPort | null = null;
    if (config.search.enabled) {
        const apify = loadApifyConfig(env);
        search = searchPort(apify, config.search.timeoutMs);
        // The module's job lease is 45 s and its submit lease 60 s (docs/spacetime.md 2.10), and the submit lease
        // must outlast the sidecar's own submit timeout. One preview attempt of up to 35 s fits inside the lease;
        // a submit gets 45 s and is never retried.
        if (config.errands.enabled) errands = FormErrandClient.fromConfig(apify, { timeoutsMs: { preview: 35_000, submit: 45_000 }, retries: 0 });
    }

    let moss: MossRun | null = null;
    let memory: MemoryPort | null = null;
    let web: WebIndexPort | null = null;
    if (config.moss.enabled) {
        moss = new MossRun({ env });
        const store = new MemoryStore(moss);
        const index = new WebIndex(moss);
        const notes = config.sandbox ? SAMPLE_NOTES : [];
        memory = memoryPort(moss, store, config.moss.reopen, log, notes);
        web = index;
        try {
            const started = await moss.start();
            log.info('Moss is open', { restored: started.restored, firstRun: started.firstRun, ms: Math.round(started.openMs) });
            await seedNotes(store, notes, log);
        } catch (error) {
            log.warn('Moss did not open; questions run without memory', { code: (error as { code?: string }).code ?? 'error' });
        }
    }

    let dialer: DialerPort | null = null;
    let contacts: CallContact[] = [];
    if (config.calls.enabled) {
        try {
            // Only ids and spoken names leave the consent list; the numbers stay inside the Dialer.
            contacts = loadCallLists(env).consent.map((entry) => ({ contactId: entry.id, name: entry.name }));
            dialer = dialerFromEnv(env, { onUpdate: onSnapshot });
        } catch (error) {
            // The Dialer's own configuration errors name settings and positions only. Anything else (a file that
            // cannot be read) would quote the file's path, which can hold a name or a number, so only its code goes on.
            if (error instanceof CallConfigError) throw error;
            throw new StartupError(
                `Calls could not start: a call list could not be read (${errorTag(error)}). Check CALL_CONSENT_FILE, CALL_DO_NOT_CALL_FILE and CALL_HOLD_FILE.`,
            );
        }
        log.info('calls are on', { contacts: contacts.length });
    }

    const forms = config.formsFile ? loadForms(config.formsFile) : [];
    return { planner, search, errands, memory, web, dialer, contacts, forms, moss };
}

export { classifyQuestion };
