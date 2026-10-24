// Server side, CALL stretch: one consented outbound call through a Cartesia Managed Agent, after a read-back and a
// fresh CONFIRM (double jaw clench), the only command that releases the dial. STOP (long jaw clench), HEADSET-OFF and
// the idle auto-pause cancel or hang up. The model never dials. Numbers come only from a private consent list and
// never reach events, errors or logs.

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';

import { checkAgentScript, firstDifference, loadAgentScript, renderTemplate, type AgentScript } from './call-script.js';
import { emit, redact, type OnEvent } from './events.js';
import { buildRequest, send, type FetchLike, type HttpResponse } from './http.js';
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
    /** Short id the app uses, for example "leon". Starts with a letter; never the number. */
    id: string;
    /** The name the call uses, for example "Leon". */
    name: string;
    phone: string;
    /** The recipient's own IANA time zone, for example "America/New_York". Calling hours are checked in it. */
    timeZone: string;
    /** What they agreed to, word for word. */
    consentText: string;
    consentedAt: string;
    expiresAt?: string;
}

export interface CallLists {
    consent: ConsentEntry[];
    /** E.164 numbers that asked not to be called. Checked before every prepare, every confirm and every dial. */
    doNotCall: Set<string>;
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/** Letters (any language), spaces, apostrophes, hyphens and periods: a name, never markup or a number. */
const PLAIN_NAME = /^\p{L}[\p{L} .'-]{0,39}$/u;
/** Starts with a letter and has no run of three digits, so an id can never be shaped like a phone number. */
const CONTACT_ID = /^[a-z][a-z0-9_-]{0,39}$/;
// Calls only reach +1 numbers, whose zones are all IANA America/... or Pacific/... (Honolulu, Guam, Pago Pago).
const ZONE_SHAPE = /^(America|Pacific)(?:\/[A-Za-z0-9_+-]+){1,2}$/;

/**
 * An IANA zone name the runtime knows, in the America or Pacific areas: America/New_York or
 * America/Indiana/Indianapolis, never an alias like US/Eastern or an abbreviation like EST.
 */
export function isUsableTimeZone(zone: unknown): zone is string {
    if (typeof zone !== 'string' || !ZONE_SHAPE.test(zone)) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
        return true;
    } catch {
        return false;
    }
}

/** Parses the consent file. Errors name the entry's position only, never its id, name or number. */
export function parseConsentList(json: string, now: number = Date.now()): ConsentEntry[] {
    let raw: unknown;
    try {
        raw = JSON.parse(json);
    } catch {
        throw new CallConfigError('The consent list is not valid JSON.');
    }
    if (!Array.isArray(raw)) throw new CallConfigError('The consent list must be a JSON array.');
    const seen = new Map<string, number>();
    return raw.map((item: unknown, i) => {
        const where = `Consent entry ${i}`;
        if (!item || typeof item !== 'object') throw new CallConfigError(`${where} is not an object.`);
        const record = item as Record<string, unknown>;
        const id = text(record.id);
        if (!CONTACT_ID.test(id) || /\d{3}/.test(id)) {
            throw new CallConfigError(`${where} needs an id that starts with a letter, uses lowercase letters, digits, - or _, and has no run of three digits.`);
        }
        const first = seen.get(id);
        if (first !== undefined) throw new CallConfigError(`Consent entries ${first} and ${i} share an id.`);
        seen.set(id, i);
        const name = text(record.name);
        if (!PLAIN_NAME.test(name)) throw new CallConfigError(`${where} needs a plain name of letters, up to 40 characters.`);
        const phone = toUsE164(text(record.phone));
        if (!phone) throw new CallConfigError(`${where} does not have a US phone number.`);
        if (isEmergencyNumber(phone)) throw new CallConfigError(`${where} is an emergency number, which is never called.`);
        const timeZone = text(record.timeZone);
        if (!isUsableTimeZone(timeZone)) throw new CallConfigError(`${where} needs the recipient's time zone, an IANA name such as America/Los_Angeles.`);
        const consentText = text(record.consentText);
        if (consentText.length < 20) throw new CallConfigError(`${where} needs the consent text they agreed to.`);
        const consentedAt = text(record.consentedAt);
        const consentedMs = Date.parse(consentedAt);
        if (Number.isNaN(consentedMs) || consentedMs > now) throw new CallConfigError(`${where} needs a past consentedAt time.`);
        const entry: ConsentEntry = { id, name, phone, timeZone, consentText, consentedAt };
        if (record.expiresAt !== undefined) {
            const expiresAt = text(record.expiresAt);
            if (Number.isNaN(Date.parse(expiresAt))) throw new CallConfigError(`${where} has an unreadable expiresAt.`);
            entry.expiresAt = expiresAt;
        }
        return entry;
    });
}

/** One number per line or comma, # for comments. An unreadable line stops startup rather than being skipped. */
export function parseDoNotCall(source: string): Set<string> {
    const numbers = new Set<string>();
    source.split('\n').forEach((line, index) => {
        for (const part of line.replace(/#.*/, '').split(',')) {
            const value = part.trim();
            if (!value) continue;
            const number = toUsE164(value);
            if (!number) throw new CallConfigError(`Do-not-call line ${index + 1} is not a US phone number.`);
            numbers.add(number);
        }
    });
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

/** Calls only go out between 9 AM and 9 PM. */
export const CALL_WINDOW = { startMinute: 9 * 60, endMinute: 21 * 60 } as const;
/** The demo is in San Francisco, and California bars these calls from 9 PM to 9 AM (PUC 2872(c)). */
export const VENUE_TIME_ZONE = 'America/Los_Angeles';

function localClock(ms: number, timeZone: string): { day: string; minute: number } {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
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

function fitsWindow(startMs: number, spanMs: number, timeZone: string): boolean {
    const start = localClock(startMs, timeZone);
    const end = localClock(startMs + spanMs, timeZone);
    return start.day === end.day && start.minute >= CALL_WINDOW.startMinute && end.minute < CALL_WINDOW.endMinute;
}

/**
 * The whole call (ringing plus the duration cap) must fit inside 9 AM to 9 PM in the recipient's own time zone, and
 * also in Pacific time for the venue. A wrong zone can therefore only make the window smaller, never larger.
 */
export function insideCallingHours(startMs: number, spanMs: number, recipientTimeZone: string): boolean {
    return isUsableTimeZone(recipientTimeZone) && fitsWindow(startMs, spanMs, recipientTimeZone) && fitsWindow(startMs, spanMs, VENUE_TIME_ZONE);
}

function clockTime(ms: number, timeZone: string): string {
    return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(ms)).replace(/\s+/g, ' ');
}

/**
 * The errand titles a call may report, set by the team, never taken from a web page. A form's own title is only used
 * to pick one of these, so nothing a form says can reach the agent's prompt.
 */
export const DEFAULT_ERRAND_TITLES = ['Care team request'] as const;
const ERRAND_TITLE = /^[A-Za-z0-9][A-Za-z0-9 ,.'&()-]{0,39}$/;
const titleKey = (title: string): string => title.replace(/\s+/g, ' ').trim().toLowerCase();

export type RefusalCode =
    | 'bad_request'
    | 'errand_not_allowed'
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
    errand_not_allowed: 'I can only call about the errands on the approved list, so I did not call.',
    not_consented: 'That person has not agreed to calls, so I did not call.',
    consent_expired: 'Their agreement to calls has expired, so I did not call.',
    do_not_call: 'That person asked not to be called, so I did not call.',
    emergency_number: 'I never call emergency numbers. This is not an emergency tool.',
    bad_number: 'That is not a number I can call.',
    errand_stale: 'There is no request sent in the last ten minutes to call about.',
    outside_hours: 'It is too late or too early to call. Calls only go out between 9 AM and 9 PM their time.',
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
    /** Unique per CALL request, for example the call_request row id. */
    requestId: string;
    contactId: string;
    /** The errand this call reports. Only "<person>'s <approved title> was sent at <time>" is ever said. */
    errand: { title: string; sentAt: string | number | Date };
}

/** What the station needs for the read-back. The number stays inside the Dialer. */
export interface PreparedCall {
    requestId: string;
    contactId: string;
    recipientName: string;
    /** For the earpiece, before the confirm window opens. */
    readBack: string;
    /** 16 hex characters over who is called and every word of the script; the CONFIRM must carry it. */
    digest: string;
    expiresAt: number;
}

interface Prepared extends PreparedCall {
    toNumber: string;
    timeZone: string;
    variables: Record<string, string>;
    errandSentAt: number;
    confirmedAt: number;
}

export type CallPhase = 'checking' | 'dialing' | 'ringing' | 'connected' | 'ended';
export type CallResult = 'answered' | 'no_answer' | 'busy' | 'voicemail' | 'cancelled' | 'failed' | 'refused' | 'unknown';
/** STOP (long jaw clench), HEADSET-OFF, the 2-minute idle auto-pause, or a teammate at the dashboard. */
export type CancelReason = 'stop' | 'headset_off' | 'auto_pause' | 'operator';

export interface CallOutcome {
    requestId: string;
    result: CallResult;
    /** 'unknown' when the dial got no clear answer: it may or may not have gone out. It is never retried. */
    dialed: boolean | 'unknown';
    callId: string | null;
    endReason: string | null;
    cancelReason: CancelReason | null;
    refusal: CallRefusal | null;
    optedOut: boolean;
    /** One sentence for the earpiece, without numbers. */
    spoken: string;
    /** Cartesia's own call summary with phone numbers masked. Still content: keep it out of public rows unless agreed. */
    summary: string | null;
    ms: number;
}

/** For the dashboard row. Phone numbers are masked; the rest is content, shown only with the recipient's agreement. */
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
    /** A published Managed Agent whose welcome and instructions are exactly cartesia/agent/welcome.txt and instructions.txt. */
    agentId: string;
    /** The Cartesia phone number id (not the number) to call from. */
    fromNumberId: string;
    /** A consenting teammate's US number, read out near the start and at the end of every call. */
    callbackNumber: string;
    /** Who the call is for, as spoken. */
    personName: string;
    /** The errand titles a call may report. Defaults to DEFAULT_ERRAND_TITLES. */
    errandTitles?: readonly string[];
    /** 5 to 80 seconds (API range). Short, because a ringing call cannot be cancelled. */
    ringingTimeoutSeconds?: number;
    /** 1 to 10 minutes (our cap). */
    maxCallDurationMinutes?: number;
    pollIntervalMs?: number;
    preparedTtlMs?: number;
    maxErrandAgeMs?: number;
    /** A CONFIRM is only good for this long; the agent check must finish inside it. */
    maxConfirmToDialMs?: number;
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

function toMs(value: unknown): number | null {
    const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(ms) ? ms : null;
}

const enc = encodeURIComponent;

/** A placed (or about to be placed) call. STOP, HEADSET-OFF and the idle auto-pause all go through cancel(). */
export class CallHandle {
    phase: CallPhase = 'checking';
    status: string | null = null;
    callId: string | null = null;
    cancelReason: CancelReason | null = null;
    cancelConfirmed = false;
    cancelInFlight = false;
    optedOut = false;
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
 * Reads the published agent (GET /v1/agents/{id}) and confirms, against the canonical files in cartesia/agent/ and
 * nothing else, that it will say exactly the reviewed script: the same welcome and instructions character for
 * character, no voicemail message we have not reviewed, and a Cartesia library voice (never a clone).
 */
export async function verifyAgent(options: { apiKey: string; agentId: string; fetch?: FetchLike }): Promise<AgentCheck> {
    const script = loadAgentScript();
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
    for (const [key, expected, label] of [
        ['initial_message', script.welcome, 'welcome message'],
        ['instructions', script.instructions, 'instructions'],
    ] as const) {
        const live = field(config, key);
        if (typeof live !== 'string') return { ok: false, code: 'agent_mismatch', what: `${label} missing` };
        if (live !== expected) return { ok: false, code: 'agent_mismatch', what: `${label}: first difference at character ${firstDifference(live, expected)}` };
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
    agent: AgentCheck;
    /** True when every consented recipient is inside calling hours right now. */
    insideHoursNow: boolean;
}

/**
 * Holds the consent list, the do-not-call list and at most one call. prepare() builds the read-back and its digest;
 * place() needs that exact digest from a fresh CONFIRM, checks everything again right before dialing, dials once,
 * and never retries.
 */
export class Dialer {
    readonly callIds: string[] = [];
    private readonly prepared = new Map<string, Prepared>();
    private readonly usedDigests = new Set<string>();
    private active: CallHandle | null = null;
    private readonly script: AgentScript;
    private readonly titles: Map<string, string>;
    private readonly callback: string;
    private readonly personName: string;
    private readonly ringSeconds: number;
    private readonly durationMinutes: number;
    private readonly pollMs: number;
    private readonly preparedTtlMs: number;
    private readonly maxErrandAgeMs: number;
    private readonly maxConfirmToDialMs: number;
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
        this.personName = text(config.personName);
        if (!PLAIN_NAME.test(this.personName)) throw new CallConfigError('CALL_PERSON_NAME must be a plain name of letters, up to 40 characters.');
        // The baseline is always the canonical files, read here, never a script passed in.
        this.script = loadAgentScript();
        const problems = checkAgentScript(this.script);
        if (problems.length > 0) throw new CallConfigError(`The agent script is not ready: ${problems.join('; ')}.`);
        const titles = config.errandTitles ?? DEFAULT_ERRAND_TITLES;
        if (titles.length === 0) throw new CallConfigError('At least one errand title is needed.');
        this.titles = new Map();
        titles.forEach((title, i) => {
            const clean = text(title).replace(/\s+/g, ' ');
            if (!ERRAND_TITLE.test(clean) || /\d{3}/.test(clean)) {
                throw new CallConfigError(`Errand title ${i} must be up to 40 letters, digits, spaces or basic punctuation.`);
            }
            this.titles.set(titleKey(clean), clean);
        });
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
        this.maxConfirmToDialMs = config.maxConfirmToDialMs ?? 30_000;
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
        if (!insideCallingHours(now, this.spanMs(), contact.timeZone)) return refusal('outside_hours');
        return null;
    }

    /** Everything again, against the current lists and clock: used at the confirm and right before the dial. */
    private recheck(call: Prepared, now: number): CallRefusal | null {
        const contact = this.lists.consent.find((entry) => entry.id === call.contactId);
        const blocked = this.check(contact, call.errandSentAt, now);
        if (blocked) return blocked;
        if (!contact || toUsE164(contact.phone) !== call.toNumber || contact.timeZone !== call.timeZone || contact.name !== call.recipientName) {
            return refusal('digest_mismatch');
        }
        if (now > call.expiresAt || (call.confirmedAt > 0 && now - call.confirmedAt > this.maxConfirmToDialMs)) return refusal('expired');
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
        const sentAt = toMs(request.errand?.sentAt);
        if (sentAt === null) return this.refuse('bad_request');
        const title = typeof request.errand?.title === 'string' ? this.titles.get(titleKey(request.errand.title)) : undefined;
        if (!title) return this.refuse('errand_not_allowed');
        const contact = this.lists.consent.find((entry) => entry.id === request.contactId);
        const blocked = this.check(contact, sentAt, now);
        if (blocked || !contact) return this.refuse(blocked?.code ?? 'not_consented');
        const variables: Record<string, string> = {
            recipient_name: contact.name,
            person_name: this.personName,
            callback_number: spokenNumber(this.callback),
            message: `${this.personName}'s ${title} was sent at ${clockTime(sentAt, contact.timeZone)}`,
        };
        const toNumber = toUsE164(contact.phone) as string;
        const spoken = [renderTemplate(this.script.welcome, variables), renderTemplate(this.script.instructions, variables)];
        const digest = createHash('sha256')
            .update(JSON.stringify([contact.id, toNumber, contact.timeZone, ...spoken]))
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
            timeZone: contact.timeZone,
            variables,
            errandSentAt: sentAt,
            confirmedAt: 0,
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

    /**
     * Places the call for a fresh CONFIRM whose digest matches the read-back. One CONFIRM, one call, no retries.
     * Every guard runs here and again immediately before the dial request.
     */
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
        const blocked = this.recheck(call, now);
        if (blocked) return this.refuse(blocked.code);
        // Consume the confirm before anything can fail, so one confirm can never place two calls.
        this.usedDigests.add(call.digest);
        this.prepared.delete(requestId);
        call.confirmedAt = now;
        const handle = new CallHandle(requestId, (h) => this.onCancel(h));
        this.active = handle;
        void this.run(handle, call);
        return { ok: true, handle };
    }

    /** STOP, HEADSET-OFF or the idle auto-pause from the station. */
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
        const scriptProblems = checkAgentScript(this.script);
        const agent = await verifyAgent({ apiKey: this.config.apiKey, agentId: this.config.agentId, fetch: this.deps.fetch });
        const now = this.now();
        const insideHoursNow = this.lists.consent.length > 0 && this.lists.consent.every((entry) => insideCallingHours(now, this.spanMs(), entry.timeZone));
        return {
            ok: scriptProblems.length === 0 && this.lists.consent.length > 0 && agent.ok,
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
                // Phone numbers spoken on the call are masked before they leave the dialer.
                transcript: handle.transcript.map((turn) => ({ role: turn.role, text: redact(turn.text) })),
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
                optedOut: handle.optedOut,
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
            const check = await verifyAgent({ apiKey: this.config.apiKey, agentId: this.config.agentId, fetch: this.deps.fetch });
            if (!check.ok) return end('refused', { refusal: refusal(check.code ?? 'agent_unverified') });
            if (handle.cancelReason) return end('cancelled');
            // Every guard again, right before the request: consent, do-not-call, the number, the hours, a fresh confirm.
            const blocked = this.recheck(call, this.now());
            if (blocked) return end('refused', { refusal: blocked });
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
            let response: HttpResponse;
            try {
                // Sent exactly once. A timeout may still have dialed, so it is reported, never retried.
                response = await send(request, this.deps.fetch, 20_000);
            } catch {
                return end('unknown', { dialed: 'unknown' });
            }
            // A 4xx is an explicit refusal: nothing was dialed. A 5xx or anything else leaves it open.
            if (response.status >= 400 && response.status < 500) return end('failed', { dialed: false });
            if (response.status < 200 || response.status >= 300) return end('unknown', { dialed: 'unknown' });
            let first: Record<string, unknown> | null = null;
            try {
                const data = JSON.parse(response.text) as { calls?: unknown };
                const item: unknown = Array.isArray(data.calls) ? data.calls[0] : undefined;
                first = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
            } catch {
                first = null;
            }
            const callId = first && typeof first.agent_call_id === 'string' && first.agent_call_id !== '' ? first.agent_call_id : null;
            if (!callId) {
                // A per-destination error without a call id is an explicit refusal; anything else cannot be read.
                if (first && first.error !== undefined && first.error !== null) return end('failed', { dialed: false });
                return end('unknown', { dialed: 'unknown' });
            }
            handle.callId = callId;
            this.callIds.push(callId);
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
                // An opt-out counts the moment it is heard, so no later timeout or error can lose it.
                if (!handle.optedOut && hearsOptOut(handle.transcript)) {
                    handle.optedOut = true;
                    this.addDoNotCall(call.toNumber);
                    emit(this.deps.onEvent, { stage: 'call', status: 'ok', detail: 'opt-out recorded', ms: this.now() - started });
                }
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
        const masked = summary === null ? null : redact(summary);
        if (handle.status === null || !TERMINAL.has(handle.status)) {
            if (!handle.cancelConfirmed) await this.sendCancel(handle);
            return end('unknown', { dialed: true, endReason, summary: masked });
        }
        emit(this.deps.onEvent, { stage: 'call', status: 'ok', detail: 'polling done', ms: this.now() - started, counts: { polls } });
        end(resultFor(handle.status, endReason, sawConnected), { dialed: true, endReason, summary: masked });
    }

    private spokenOutcome(name: string, outcome: CallOutcome): string {
        const optedOut = outcome.optedOut ? ` ${name} asked not to be called again, so I will not call them.` : '';
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
                return (outcome.dialed === true ? 'The call was cancelled.' : 'Cancelled. No call was made.') + optedOut;
            case 'failed':
                return 'The call could not be placed.';
            case 'refused':
                return 'I did not call.';
            default:
                return (outcome.dialed === 'unknown' ? 'I could not tell if the call went out. Check before trying again.' : 'I could not tell how the call ended.') + optedOut;
        }
    }
}
