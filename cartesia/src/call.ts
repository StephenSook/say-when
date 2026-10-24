// Server side, CALL stretch: one consented outbound call through a Cartesia Managed Agent, after a read-back and a
// fresh confirm. The model never dials. Numbers come only from a private consent list and never reach events or logs.

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';

import { checkAgentScript, normalizeScript, renderTemplate, type AgentScript } from './call-script.js';
import { emit, type OnEvent } from './events.js';
import { buildRequest, send, type FetchLike } from './http.js';
import { isEmergencyNumber, spokenNumber, toUsE164 } from './phone.js';
import { checkLibraryVoices } from './voices.js';

export class CallConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CallConfigError';
    }
}

/** One person who agreed, in writing, to AI-voice calls and to recording. Lives in a private file, never in code. */
export interface ConsentEntry {
    /** Short id the app uses, for example "leon". Never the number. */
    id: string;
    /** The name the call uses, for example "Leon". */
    name: string;
    phone: string;
    /** What they agreed to, word for word. */
    consentText: string;
    consentedAt: string;
    expiresAt?: string;
}

export interface CallLists {
    consent: ConsentEntry[];
    /** E.164 numbers that asked not to be called. Checked before every prepare and every dial. */
    doNotCall: Set<string>;
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/** Parses the consent file. Errors name the entry id or position, never the number. */
export function parseConsentList(json: string, now: number = Date.now()): ConsentEntry[] {
    let raw: unknown;
    try {
        raw = JSON.parse(json);
    } catch {
        throw new CallConfigError('The consent list is not valid JSON.');
    }
    if (!Array.isArray(raw)) throw new CallConfigError('The consent list must be a JSON array.');
    const seen = new Set<string>();
    return raw.map((item: unknown, i) => {
        if (!item || typeof item !== 'object') throw new CallConfigError(`Consent entry ${i} is not an object.`);
        const record = item as Record<string, unknown>;
        const id = text(record.id);
        if (!/^[a-z0-9_-]{1,40}$/.test(id)) throw new CallConfigError(`Consent entry ${i} needs an id of lowercase letters, digits, - or _.`);
        if (seen.has(id)) throw new CallConfigError(`Consent id ${id} appears twice.`);
        seen.add(id);
        const name = text(record.name);
        if (!name || name.length > 60 || /[{}<>[\]\d]/.test(name)) throw new CallConfigError(`Consent entry ${id} needs a plain name.`);
        const phone = toUsE164(text(record.phone));
        if (!phone) throw new CallConfigError(`Consent entry ${id} does not have a US phone number.`);
        if (isEmergencyNumber(phone)) throw new CallConfigError(`Consent entry ${id} is an emergency number, which is never called.`);
        const consentText = text(record.consentText);
        if (consentText.length < 20) throw new CallConfigError(`Consent entry ${id} needs the consent text they agreed to.`);
        const consentedAt = text(record.consentedAt);
        const consentedMs = Date.parse(consentedAt);
        if (Number.isNaN(consentedMs) || consentedMs > now) throw new CallConfigError(`Consent entry ${id} needs a past consentedAt time.`);
        const entry: ConsentEntry = { id, name, phone, consentText, consentedAt };
        if (record.expiresAt !== undefined) {
            const expiresAt = text(record.expiresAt);
            if (Number.isNaN(Date.parse(expiresAt))) throw new CallConfigError(`Consent entry ${id} has an unreadable expiresAt.`);
            entry.expiresAt = expiresAt;
        }
        return entry;
    });
}

/** One number per line or comma, # for comments. An unreadable line stops startup rather than being skipped. */
export function parseDoNotCall(source: string): Set<string> {
    const numbers = new Set<string>();
    for (const line of source.split(/[\n,]/)) {
        const value = line.replace(/#.*/, '').trim();
        if (!value) continue;
        const number = toUsE164(value);
        if (!number) throw new CallConfigError('A do-not-call line is not a US phone number.');
        numbers.add(number);
    }
    return numbers;
}

/** Reads CALL_CONSENT_FILE or CALL_CONSENT, and CALL_DO_NOT_CALL_FILE plus CALL_DO_NOT_CALL. No list means no calls. */
export function loadCallLists(
    env: Readonly<Record<string, string | undefined>>,
    read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
    now: number = Date.now(),
): CallLists {
    const consentJson = env.CALL_CONSENT_FILE ? read(env.CALL_CONSENT_FILE) : (env.CALL_CONSENT ?? '[]');
    const doNotCall = [env.CALL_DO_NOT_CALL_FILE ? read(env.CALL_DO_NOT_CALL_FILE) : '', env.CALL_DO_NOT_CALL ?? ''].join('\n');
    return { consent: parseConsentList(consentJson, now), doNotCall: parseDoNotCall(doNotCall) };
}

/** Records an opt-out in the private do-not-call file. */
export function appendToDoNotCallFile(path: string, e164: string): void {
    appendFileSync(path, `${e164}\n`, 'utf8');
}

/** California bars these calls from 9 PM to 9 AM (PUC 2872(c)). The whole call must fit inside 9 AM to 9 PM Pacific. */
export const CALL_WINDOW = { startMinute: 9 * 60, endMinute: 21 * 60, timeZone: 'America/Los_Angeles' } as const;

function pacific(ms: number): { day: string; minute: number } {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: CALL_WINDOW.timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(new Date(ms));
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return { day: `${get('year')}-${get('month')}-${get('day')}`, minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

export function insideCallingHours(startMs: number, spanMs: number): boolean {
    const start = pacific(startMs);
    const end = pacific(startMs + spanMs);
    return start.day === end.day && start.minute >= CALL_WINDOW.startMinute && end.minute < CALL_WINDOW.endMinute;
}

function clockTime(ms: number): string {
    return new Intl.DateTimeFormat('en-US', { timeZone: CALL_WINDOW.timeZone, hour: 'numeric', minute: '2-digit' })
        .format(new Date(ms))
        .replace(/\s+/g, ' ');
}

export type RefusalCode =
    | 'bad_request'
    | 'not_consented'
    | 'consent_expired'
    | 'do_not_call'
    | 'emergency_number'
    | 'bad_number'
    | 'errand_stale'
    | 'outside_hours'
    | 'expired'
    | 'digest_mismatch'
    | 'already_used'
    | 'line_busy'
    | 'agent_mismatch'
    | 'agent_unverified';

/** Sentences written for the earpiece. None of them contains a number. */
export const REFUSALS: Readonly<Record<RefusalCode, string>> = {
    bad_request: 'The call request was not valid, so I did not call.',
    not_consented: 'That person has not agreed to calls, so I did not call.',
    consent_expired: 'Their agreement to calls has expired, so I did not call.',
    do_not_call: 'That person asked not to be called, so I did not call.',
    emergency_number: 'I never call emergency numbers. This is not an emergency tool.',
    bad_number: 'That is not a number I can call.',
    errand_stale: 'There is no request sent in the last ten minutes to call about.',
    outside_hours: 'It is too late or too early to call. Calls only go out between 9 AM and 9 PM.',
    expired: 'That call request expired. Ask again.',
    digest_mismatch: 'The call changed after it was read back, so I did not call.',
    already_used: 'That confirm was already used, so I did not call again.',
    line_busy: 'A call is already in progress.',
    agent_mismatch: 'The calling agent does not match the reviewed script, so I did not call.',
    agent_unverified: 'I could not check the calling agent, so I did not call.',
};

export interface CallRefusal {
    code: RefusalCode;
    reason: string;
}

const refusal = (code: RefusalCode): CallRefusal => ({ code, reason: REFUSALS[code] });

export interface CallRequest {
    /** Unique per CALL command, for example the call_request row id. */
    requestId: string;
    contactId: string;
    /** The errand this call reports. Only "your <title> was sent at <time>" is ever said; nothing new is promised. */
    errand: { title: string; sentAt: string | number | Date };
}

/** What the station needs for the read-back. The number stays inside the Dialer. */
export interface PreparedCall {
    requestId: string;
    contactId: string;
    recipientName: string;
    /** For the earpiece, before the confirm window opens. */
    readBack: string;
    /** 16 hex characters over who is called and every word of the script; the confirm must carry it. */
    digest: string;
    expiresAt: number;
}

interface Prepared extends PreparedCall {
    toNumber: string;
    variables: Record<string, string>;
    errandSentAt: number;
}

export type CallPhase = 'checking' | 'dialing' | 'ringing' | 'connected' | 'ended';
export type CallResult = 'answered' | 'no_answer' | 'busy' | 'voicemail' | 'cancelled' | 'failed' | 'refused' | 'unknown';
export type CancelReason = 'no' | 'pause' | 'headset_off' | 'operator';

export interface CallOutcome {
    requestId: string;
    result: CallResult;
    /** 'unknown' when the dial request got no answer: it may or may not have gone out. It is never retried. */
    dialed: boolean | 'unknown';
    callId: string | null;
    endReason: string | null;
    cancelReason: CancelReason | null;
    refusal: CallRefusal | null;
    optedOut: boolean;
    /** One sentence for the earpiece, without numbers. */
    spoken: string;
    /** Cartesia's own call summary, if any. Content: keep it out of public rows unless the recipient agreed. */
    summary: string | null;
    ms: number;
}

/** For the dashboard row. The transcript is content: show it only with the recipient's agreement. */
export interface CallSnapshot {
    requestId: string;
    phase: CallPhase;
    status: string | null;
    cancelPending: boolean;
    callId: string | null;
    transcript: { role: string; text: string }[];
}

export interface DialerConfig {
    apiKey: string;
    /** A published Managed Agent whose welcome and instructions match cartesia/agent/. */
    agentId: string;
    /** The Cartesia phone number id (not the number) to call from. */
    fromNumberId: string;
    /** A consenting teammate's US number, read out near the start and at the end of every call. */
    callbackNumber: string;
    /** Who the call is for, as spoken. */
    personName: string;
    script: AgentScript;
    /** 5 to 80 seconds (API range). Short, because a ringing call cannot be cancelled. */
    ringingTimeoutSeconds?: number;
    /** 1 to 10 minutes (our cap). */
    maxCallDurationMinutes?: number;
    pollIntervalMs?: number;
    preparedTtlMs?: number;
    maxErrandAgeMs?: number;
    /** "skip" only after someone has checked the published agent by eye. */
    agentCheck?: 'require' | 'skip';
}

export interface DialerDeps {
    fetch?: FetchLike;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    onEvent?: OnEvent;
    onUpdate?: (snapshot: CallSnapshot) => void;
    /** Persists an opt-out, for example appendToDoNotCallFile. */
    onDoNotCall?: (e164: string) => void;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
// The 2026-08-14 Get Call reference lists created, started, completed and failed. SDK 4.2.0 types active and
// cancelled instead, so both are read. Reading created as ringing and started as connected is our inference.
function phaseFor(status: string | null): CallPhase | null {
    if (status === 'created') return 'ringing';
    if (status === 'started' || status === 'active') return 'connected';
    if (status !== null && TERMINAL.has(status)) return 'ended';
    return null;
}

const ANSWERED_REASONS = new Set(['agent_hangup', 'client_hangup', 'max_duration', 'call_inactivity', 'client_inactivity', 'client_disconnected']);
const FAILED_REASONS = new Set(['dial_failed', 'concurrency_limit', 'agent_error', 'network_error', 'config_error', 'error']);

function resultFor(status: string | null, endReason: string | null, sawConnected: boolean): CallResult {
    if (endReason === 'voicemail_detected') return 'voicemail';
    if (endReason === 'api_cancelled' || status === 'cancelled') return 'cancelled';
    if (endReason === 'dial_no_answer' || endReason === 'dial_timeout') return 'no_answer';
    if (endReason === 'dial_busy') return 'busy';
    if ((endReason !== null && FAILED_REASONS.has(endReason)) || status === 'failed') return 'failed';
    if (status === 'completed') return sawConnected || (endReason !== null && ANSWERED_REASONS.has(endReason)) ? 'answered' : 'unknown';
    return 'unknown';
}

// Strict phrases only: a stray "stop" ("I'll stop by") must not block future calls by accident.
const OPT_OUT = /\b(stop calling|don't call|do not call|remove me|take me off|no more calls|unsubscribe|opt out)\b/i;

function readTranscript(raw: unknown): { role: string; text: string }[] | null {
    if (!Array.isArray(raw)) return null;
    return raw.flatMap((turn: unknown) => {
        if (!turn || typeof turn !== 'object') return [];
        const t = turn as Record<string, unknown>;
        return typeof t.role === 'string' && typeof t.text === 'string' ? [{ role: t.role, text: t.text }] : [];
    });
}

function hearsOptOut(transcript: readonly { role: string; text: string }[]): boolean {
    return transcript.some((turn) => turn.role === 'user' && OPT_OUT.test(turn.text.replace(/[\u2018\u2019]/g, "'")));
}

function cleanTitle(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const title = raw.replace(/[{}<>[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!title || title.length > 80 || /\d{7,}/.test(title.replace(/[\s().-]/g, ''))) return null;
    return title;
}

function toMs(value: unknown): number | null {
    const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(ms) ? ms : null;
}

const enc = encodeURIComponent;

/** A placed (or about to be placed) call. NO, PAUSE and HEADSET-OFF all go through cancel(). */
export class CallHandle {
    phase: CallPhase = 'checking';
    status: string | null = null;
    callId: string | null = null;
    cancelReason: CancelReason | null = null;
    cancelConfirmed = false;
    cancelInFlight = false;
    finished = false;
    transcript: { role: string; text: string }[] = [];
    readonly done: Promise<CallOutcome>;
    private resolveDone: (outcome: CallOutcome) => void = () => undefined;

    constructor(
        readonly requestId: string,
        private readonly onCancel: (handle: CallHandle) => void,
    ) {
        this.done = new Promise<CallOutcome>((resolve) => {
            this.resolveDone = resolve;
        });
    }

    get cancelPending(): boolean {
        return this.cancelReason !== null && !this.cancelConfirmed && !this.finished;
    }

    /**
     * Ends the call. Cartesia can only cancel a call that has started, so while it rings this marks it cancel-pending
     * and the dialer cancels the moment it connects; the short ring timeout bounds the rest.
     */
    cancel(reason: CancelReason): void {
        if (this.finished || this.cancelReason !== null) return;
        this.cancelReason = reason;
        this.onCancel(this);
    }

    /** @internal */
    finish(outcome: CallOutcome): void {
        if (this.finished) return;
        this.finished = true;
        this.phase = 'ended';
        this.resolveDone(outcome);
    }
}

export interface AgentCheck {
    ok: boolean;
    code?: 'agent_mismatch' | 'agent_unverified';
    what?: string;
}

/**
 * Reads the published agent (GET /v1/agents/{id}) and confirms it will say the reviewed script: the same welcome and
 * instructions, no voicemail message we have not reviewed, and a Cartesia library voice (never a clone).
 */
export async function verifyAgent(options: { apiKey: string; agentId: string; script: AgentScript; fetch?: FetchLike }): Promise<AgentCheck> {
    let config: Record<string, unknown>;
    try {
        const response = await send(buildRequest(options.apiKey, 'GET', `/v1/agents/${enc(options.agentId)}`), options.fetch, 10_000);
        if (response.status < 200 || response.status >= 300) return { ok: false, code: 'agent_unverified', what: `HTTP ${response.status}` };
        const data = JSON.parse(response.text) as Record<string, unknown>;
        config = data.config && typeof data.config === 'object' ? (data.config as Record<string, unknown>) : {};
    } catch {
        return { ok: false, code: 'agent_unverified', what: 'no readable answer' };
    }
    const field = (record: unknown, key: string): unknown =>
        record && typeof record === 'object' ? (record as Record<string, unknown>)[key] : undefined;
    const welcome = field(config, 'initial_message');
    if (typeof welcome !== 'string' || normalizeScript(welcome) !== normalizeScript(options.script.welcome)) {
        return { ok: false, code: 'agent_mismatch', what: 'welcome message' };
    }
    const instructions = field(config, 'instructions');
    if (typeof instructions !== 'string' || normalizeScript(instructions) !== normalizeScript(options.script.instructions)) {
        return { ok: false, code: 'agent_mismatch', what: 'instructions' };
    }
    // Whether variables are filled in a voicemail message is not documented, so none is allowed: hang up instead.
    const voicemail = field(field(config, 'system_tools'), 'voicemail_detection');
    const voicemailMessage = field(voicemail, 'message');
    if (voicemailMessage !== undefined && voicemailMessage !== null) return { ok: false, code: 'agent_mismatch', what: 'voicemail message' };
    const voiceId = field(field(field(config, 'audio'), 'output'), 'voice_id');
    if (typeof voiceId !== 'string' || voiceId === '') return { ok: false, code: 'agent_mismatch', what: 'voice' };
    try {
        const [voice] = await checkLibraryVoices({ apiKey: options.apiKey, ids: [voiceId], fetch: options.fetch });
        if (!voice?.ok) return { ok: false, code: 'agent_mismatch', what: 'voice is not a library voice' };
    } catch {
        return { ok: false, code: 'agent_unverified', what: 'voice lookup' };
    }
    return { ok: true };
}

export interface DeleteResult {
    callId: string;
    deleted: boolean;
    reason: 'deleted' | 'not_terminal' | 'not_found' | 'failed';
}

/** DELETE /agents/calls/{id}: removes the transcript, recording and logs. Only for completed or failed calls. */
export async function deleteCallData(options: {
    apiKey: string;
    callId: string;
    fetch?: FetchLike;
    sleep?: (ms: number) => Promise<void>;
}): Promise<DeleteResult> {
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 1; attempt <= 3; attempt++) {
        let status: number;
        try {
            status = (await send(buildRequest(options.apiKey, 'DELETE', `/agents/calls/${enc(options.callId)}`), options.fetch)).status;
        } catch {
            status = 0;
        }
        if (status >= 200 && status < 300) return { callId: options.callId, deleted: true, reason: 'deleted' };
        if (status === 400) return { callId: options.callId, deleted: false, reason: 'not_terminal' };
        if (status === 404) return { callId: options.callId, deleted: false, reason: 'not_found' };
        // The reference says deletion is idempotent and a 500 should be retried.
        if (attempt < 3 && (status === 0 || status >= 500)) {
            await sleep(1000);
            continue;
        }
        break;
    }
    return { callId: options.callId, deleted: false, reason: 'failed' };
}

export interface PreflightReport {
    ok: boolean;
    consentCount: number;
    doNotCallCount: number;
    scriptProblems: string[];
    agent: AgentCheck | 'skipped';
    insideHoursNow: boolean;
}

/**
 * Holds the consent list, the do-not-call list and at most one call. prepare() builds the read-back and its digest;
 * place() needs that exact digest from a fresh confirm, dials once, and never retries.
 */
export class Dialer {
    readonly callIds: string[] = [];
    private readonly prepared = new Map<string, Prepared>();
    private readonly usedDigests = new Set<string>();
    private active: CallHandle | null = null;
    private readonly callback: string;
    private readonly ringSeconds: number;
    private readonly durationMinutes: number;
    private readonly pollMs: number;
    private readonly preparedTtlMs: number;
    private readonly maxErrandAgeMs: number;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;

    constructor(
        private readonly config: DialerConfig,
        private readonly lists: CallLists,
        private readonly deps: DialerDeps = {},
    ) {
        if (!config.apiKey?.trim()) throw new CallConfigError('CARTESIA_API_KEY is not set.');
        if (!config.agentId?.trim() || !config.fromNumberId?.trim()) throw new CallConfigError('CARTESIA_AGENT_ID and CARTESIA_FROM_NUMBER_ID are needed.');
        const callback = toUsE164(config.callbackNumber ?? '');
        if (!callback || isEmergencyNumber(callback)) throw new CallConfigError('CALL_CALLBACK_NUMBER must be a US number in E.164.');
        this.callback = callback;
        if (!config.personName?.trim() || /[{}<>[\]\d]/.test(config.personName)) throw new CallConfigError('CALL_PERSON_NAME must be a plain name.');
        const problems = checkAgentScript(config.script);
        if (problems.length > 0) throw new CallConfigError(`The agent script is not ready: ${problems.join('; ')}.`);
        this.ringSeconds = config.ringingTimeoutSeconds ?? 25;
        if (!Number.isInteger(this.ringSeconds) || this.ringSeconds < 5 || this.ringSeconds > 80) {
            throw new CallConfigError('ringingTimeoutSeconds must be 5 to 80.');
        }
        this.durationMinutes = config.maxCallDurationMinutes ?? 2;
        if (!Number.isInteger(this.durationMinutes) || this.durationMinutes < 1 || this.durationMinutes > 10) {
            throw new CallConfigError('maxCallDurationMinutes must be 1 to 10.');
        }
        this.pollMs = config.pollIntervalMs ?? 1500;
        this.preparedTtlMs = config.preparedTtlMs ?? 2 * 60_000;
        this.maxErrandAgeMs = config.maxErrandAgeMs ?? 10 * 60_000;
        this.now = deps.now ?? Date.now;
        this.sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    }

    /** The longest a call can take: ringing, then the duration cap, plus a minute of slack. */
    private spanMs(): number {
        return this.ringSeconds * 1000 + this.durationMinutes * 60_000 + 60_000;
    }

    private check(contact: ConsentEntry | undefined, errandSentAt: number, now: number): CallRefusal | null {
        if (!contact) return refusal('not_consented');
        if (contact.expiresAt !== undefined && Date.parse(contact.expiresAt) <= now) return refusal('consent_expired');
        const number = toUsE164(contact.phone);
        if (!number || number === this.callback) return refusal('bad_number');
        if (isEmergencyNumber(number)) return refusal('emergency_number');
        if (this.lists.doNotCall.has(number)) return refusal('do_not_call');
        if (now - errandSentAt > this.maxErrandAgeMs || errandSentAt - now > 60_000) return refusal('errand_stale');
        if (!insideCallingHours(now, this.spanMs())) return refusal('outside_hours');
        return null;
    }

    private refuse(code: RefusalCode): { ok: false; refusal: CallRefusal } {
        emit(this.deps.onEvent, { stage: 'call', status: 'error', detail: `refused: ${code}`, ms: 0 });
        return { ok: false, refusal: refusal(code) };
    }

    /** Checks the guards and builds the read-back. Nothing is dialed. */
    prepare(request: CallRequest): { ok: true; call: PreparedCall } | { ok: false; refusal: CallRefusal } {
        const now = this.now();
        if (!request || typeof request.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(request.requestId)) return this.refuse('bad_request');
        const title = cleanTitle(request.errand?.title);
        const sentAt = toMs(request.errand?.sentAt);
        if (!title || sentAt === null) return this.refuse('bad_request');
        const contact = this.lists.consent.find((entry) => entry.id === request.contactId);
        const blocked = this.check(contact, sentAt, now);
        if (blocked || !contact) return this.refuse(blocked?.code ?? 'not_consented');
        const variables: Record<string, string> = {
            recipient_name: contact.name,
            person_name: this.config.personName.trim(),
            callback_number: spokenNumber(this.callback),
            message: `${this.config.personName.trim()}'s ${title} was sent at ${clockTime(sentAt)}`,
        };
        const toNumber = toUsE164(contact.phone) as string;
        const spoken = [renderTemplate(this.config.script.welcome, variables), renderTemplate(this.config.script.instructions, variables)];
        const digest = createHash('sha256')
            .update(JSON.stringify([contact.id, toNumber, ...spoken.map(normalizeScript)]))
            .digest('hex')
            .slice(0, 16);
        const call: Prepared = {
            requestId: request.requestId,
            contactId: contact.id,
            recipientName: contact.name,
            readBack: `Call ${contact.name} to say your ${title} was sent.`,
            digest,
            expiresAt: now + this.preparedTtlMs,
            toNumber,
            variables,
            errandSentAt: sentAt,
        };
        this.prepared.set(call.requestId, call);
        emit(this.deps.onEvent, { stage: 'call', status: 'ok', detail: 'read-back ready', ms: 0 });
        return {
            ok: true,
            call: {
                requestId: call.requestId,
                contactId: call.contactId,
                recipientName: call.recipientName,
                readBack: call.readBack,
                digest: call.digest,
                expiresAt: call.expiresAt,
            },
        };
    }

    /** Places the call for a fresh confirm whose digest matches the read-back. One confirm, one call, no retries. */
    place(requestId: string, confirmDigest: string): { ok: true; handle: CallHandle } | { ok: false; refusal: CallRefusal } {
        const now = this.now();
        const call = this.prepared.get(requestId);
        if (!call) return this.refuse('expired');
        if (now > call.expiresAt) {
            this.prepared.delete(requestId);
            return this.refuse('expired');
        }
        if (confirmDigest !== call.digest) return this.refuse('digest_mismatch');
        if (this.usedDigests.has(call.digest)) return this.refuse('already_used');
        if (this.active && !this.active.finished) return this.refuse('line_busy');
        const contact = this.lists.consent.find((entry) => entry.id === call.contactId);
        const blocked = this.check(contact, call.errandSentAt, now);
        if (blocked) return this.refuse(blocked.code);
        if (!contact || toUsE164(contact.phone) !== call.toNumber) return this.refuse('digest_mismatch');
        // Consume the confirm before anything can fail, so one confirm can never place two calls.
        this.usedDigests.add(call.digest);
        this.prepared.delete(requestId);
        const handle = new CallHandle(requestId, (h) => this.onCancel(h));
        this.active = handle;
        void this.run(handle, call);
        return { ok: true, handle };
    }

    /** NO, PAUSE or HEADSET-OFF from the station. */
    cancelActive(reason: CancelReason): void {
        this.active?.cancel(reason);
    }

    /** Adds a number to the do-not-call list by contact id, for an opt-out heard outside a call. */
    optOut(contactId: string): boolean {
        const contact = this.lists.consent.find((entry) => entry.id === contactId);
        const number = contact ? toUsE164(contact.phone) : null;
        if (!number) return false;
        this.addDoNotCall(number);
        return true;
    }

    async deleteCallData(callId: string): Promise<DeleteResult> {
        return deleteCallData({ apiKey: this.config.apiKey, callId, fetch: this.deps.fetch, sleep: this.sleep });
    }

    /** For after judging: deletes the stored data of every call this dialer placed. */
    async deleteAll(): Promise<DeleteResult[]> {
        const results: DeleteResult[] = [];
        for (const callId of this.callIds) results.push(await this.deleteCallData(callId));
        return results;
    }

    /** Checks everything except dialing. Reads the published agent; places no call. */
    async preflight(): Promise<PreflightReport> {
        const scriptProblems = checkAgentScript(this.config.script);
        const agent =
            this.config.agentCheck === 'skip'
                ? 'skipped'
                : await verifyAgent({ apiKey: this.config.apiKey, agentId: this.config.agentId, script: this.config.script, fetch: this.deps.fetch });
        const insideHoursNow = insideCallingHours(this.now(), this.spanMs());
        return {
            ok: scriptProblems.length === 0 && this.lists.consent.length > 0 && (agent === 'skipped' || agent.ok),
            consentCount: this.lists.consent.length,
            doNotCallCount: this.lists.doNotCall.size,
            scriptProblems,
            agent,
            insideHoursNow,
        };
    }

    private addDoNotCall(number: string): void {
        if (this.lists.doNotCall.has(number)) return;
        this.lists.doNotCall.add(number);
        try {
            this.deps.onDoNotCall?.(number);
        } catch {
            // The in-memory list still blocks the number for this run.
        }
    }

    private onCancel(handle: CallHandle): void {
        const connected = handle.phase === 'connected';
        emit(this.deps.onEvent, { stage: 'call', status: 'started', detail: connected ? 'cancelling' : 'cancel pending', ms: 0 });
        if (connected) void this.sendCancel(handle);
    }

    private update(handle: CallHandle): void {
        try {
            this.deps.onUpdate?.({
                requestId: handle.requestId,
                phase: handle.phase,
                status: handle.status,
                cancelPending: handle.cancelPending,
                callId: handle.callId,
                transcript: handle.transcript,
            });
        } catch {
            // A dashboard problem must not stop a cancel.
        }
    }

    private async sendCancel(handle: CallHandle): Promise<void> {
        if (!handle.callId || handle.cancelConfirmed || handle.cancelInFlight) return;
        handle.cancelInFlight = true;
        try {
            const response = await send(buildRequest(this.config.apiKey, 'POST', `/agents/calls/${enc(handle.callId)}/cancel`), this.deps.fetch, 10_000);
            // 200 means cancelled. 400 means not active (still ringing, or over). 502 means retry: the next poll does.
            if (response.status === 200) handle.cancelConfirmed = true;
        } catch {
            // The next poll tries again.
        } finally {
            handle.cancelInFlight = false;
        }
    }

    private async run(handle: CallHandle, call: Prepared): Promise<void> {
        const started = this.now();
        const end = (result: CallResult, extra: Partial<CallOutcome> = {}) => {
            if (handle.finished) return;
            const outcome: CallOutcome = {
                requestId: call.requestId,
                result,
                dialed: false,
                callId: handle.callId,
                endReason: null,
                cancelReason: handle.cancelReason,
                refusal: null,
                optedOut: false,
                spoken: '',
                summary: null,
                ms: this.now() - started,
                ...extra,
            };
            outcome.spoken = outcome.refusal ? outcome.refusal.reason : this.spokenOutcome(call.recipientName, outcome);
            handle.finish(outcome);
            if (this.active === handle) this.active = null;
            emit(this.deps.onEvent, {
                stage: 'call',
                status: result === 'failed' || result === 'unknown' || result === 'refused' ? 'error' : 'ok',
                detail: `ended: ${result}`,
                ms: outcome.ms,
            });
            this.update(handle);
        };
        try {
            if (this.config.agentCheck !== 'skip') {
                const check = await verifyAgent({ apiKey: this.config.apiKey, agentId: this.config.agentId, script: this.config.script, fetch: this.deps.fetch });
                if (!check.ok) return end('refused', { refusal: refusal(check.code ?? 'agent_unverified') });
            }
            if (handle.cancelReason) return end('cancelled');
            handle.phase = 'dialing';
            emit(this.deps.onEvent, { stage: 'call', status: 'started', detail: 'dialing', ms: 0 });
            this.update(handle);
            const request = buildRequest(this.config.apiKey, 'POST', '/agents/calls', {
                body: {
                    agent_id: this.config.agentId,
                    from_number_id: this.config.fromNumberId,
                    ringing_timeout_seconds: this.ringSeconds,
                    max_call_duration_minutes: this.durationMinutes,
                    outbound_calls: [{ to_number: call.toNumber, dynamic_variables: call.variables }],
                },
            });
            let response: { status: number; text: string };
            try {
                // Sent exactly once. A timeout may still have dialed, so it is reported, never retried.
                response = await send(request, this.deps.fetch, 20_000);
            } catch {
                return end('unknown', { dialed: 'unknown' });
            }
            if (response.status < 200 || response.status >= 300) return end('failed');
            let first: Record<string, unknown> | undefined;
            try {
                const data = JSON.parse(response.text) as { calls?: unknown };
                first = Array.isArray(data.calls) ? (data.calls[0] as Record<string, unknown> | undefined) : undefined;
            } catch {
                first = undefined;
            }
            if (!first || first.error !== undefined || typeof first.agent_call_id !== 'string' || first.agent_call_id === '') {
                // Cartesia reports a per-destination error with an HTTP 200; no call record exists then.
                return end(first ? 'failed' : 'unknown', { dialed: first ? false : 'unknown' });
            }
            handle.callId = first.agent_call_id;
            this.callIds.push(handle.callId);
            handle.phase = 'ringing';
            this.update(handle);
            await this.poll(handle, call, started, end);
        } catch {
            end('unknown', { dialed: handle.callId ? true : 'unknown' });
        }
    }

    private async poll(handle: CallHandle, call: Prepared, started: number, end: (result: CallResult, extra?: Partial<CallOutcome>) => void): Promise<void> {
        const callId = handle.callId as string;
        const deadline = started + this.spanMs();
        let endReason: string | null = null;
        let summary: string | null = null;
        let sawConnected = false;
        let polls = 0;
        // Lifecycle webhooks are "coming soon", so status comes from polling Get Call.
        while (this.now() < deadline) {
            await this.sleep(this.pollMs);
            polls++;
            let data: Record<string, unknown> | null = null;
            try {
                const response = await send(buildRequest(this.config.apiKey, 'GET', `/agents/calls/${enc(callId)}`), this.deps.fetch, 10_000);
                if (response.status >= 200 && response.status < 300) data = JSON.parse(response.text) as Record<string, unknown>;
            } catch {
                data = null;
            }
            if (data) {
                if (typeof data.status === 'string') handle.status = data.status;
                if (typeof data.end_reason === 'string') endReason = data.end_reason;
                if (typeof data.summary === 'string') summary = data.summary;
                handle.transcript = readTranscript(data.transcript) ?? handle.transcript;
                const phase = phaseFor(handle.status);
                if (phase === 'connected') sawConnected = true;
                if (phase && phase !== 'ended' && phase !== handle.phase) {
                    handle.phase = phase;
                    emit(this.deps.onEvent, { stage: 'call', status: 'started', detail: phase, ms: this.now() - started });
                }
                this.update(handle);
            }
            // Cancel-pending: cancel as soon as it connects. With no answer from Get Call, try anyway; a 400 is harmless.
            if (handle.cancelReason && !handle.cancelConfirmed && (data === null || handle.phase === 'connected')) await this.sendCancel(handle);
            if (handle.status !== null && TERMINAL.has(handle.status)) break;
        }
        if (handle.status === null || !TERMINAL.has(handle.status)) {
            if (!handle.cancelConfirmed) await this.sendCancel(handle);
            return end('unknown', { dialed: true, endReason, summary });
        }
        const result = resultFor(handle.status, endReason, sawConnected);
        const optedOut = hearsOptOut(handle.transcript);
        if (optedOut) this.addDoNotCall(call.toNumber);
        emit(this.deps.onEvent, { stage: 'call', status: 'ok', detail: 'polling done', ms: this.now() - started, counts: { polls } });
        end(result, { dialed: true, endReason, summary, optedOut });
    }

    private spokenOutcome(name: string, outcome: CallOutcome): string {
        switch (outcome.result) {
            case 'answered':
                return outcome.optedOut ? `${name} asked not to be called again. I will not call them.` : `${name} picked up. The call has ended.`;
            case 'no_answer':
                return `${name} did not answer.`;
            case 'busy':
                return `${name}'s line was busy.`;
            case 'voicemail':
                return 'The call went to voicemail. No message was left.';
            case 'cancelled':
                return outcome.dialed === true ? 'The call was cancelled.' : 'Cancelled. No call was made.';
            case 'failed':
                return 'The call could not be placed.';
            case 'refused':
                return 'I did not call.';
            default:
                return outcome.dialed === 'unknown' ? 'I could not tell if the call went out. Check before trying again.' : 'I could not tell how the call ended.';
        }
    }
}
