// Server side, CALL stretch: one consented outbound call through a Cartesia Managed Agent, after a read-back and a
// fresh CONFIRM (single jaw clench), the only command that releases the dial. STOP (held jaw clench), HEADSET-OFF and
// the idle auto-pause cancel or hang up. The model never dials. Numbers come only from a private consent list and
// never reach events, errors or logs.

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';

import { checkAgentScript, END_CALL_TOOL, firstDifference, heardOptOut, loadAgentScript, renderTemplate, type AgentScript } from './call-script.js';
import { emit, redact, type OnEvent } from './events.js';
import { buildRequest, send, type FetchLike, type HttpResponse } from './http.js';
import { isEmergencyNumber, toUsE164 } from './phone.js';
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
    /** The recipient's own IANA time zone, for example "America/New_York". The call says when the request was sent in it. */
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
    /**
     * E.164 numbers on hold. A 'pending' hold is written before every dial and released only after a call that was
     * fully observed with nothing heard; a 'hold' marks something said that may be a refusal. Both block calls, like
     * the do-not-call list, until released or cleared by a person with a reason.
     */
    holds: Map<string, HoldEntry>;
}

/** The hold on one number: the contact it was placed for, the record that placed it, and its kind. */
export interface HoldEntry {
    contact: string;
    id: string;
    kind: 'pending' | 'hold';
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

/**
 * One line of the private hold file (JSON lines). 'pending' is written before every dial and 'release' ends it after
 * a call fully observed with nothing heard; 'hold' marks something said that may be a refusal; 'clear' is a person
 * ending a hold with a reason. A release or clear names the record it ends in target, so a stale one can never end a
 * newer hold.
 */
export interface HoldRecord {
    action: 'pending' | 'release' | 'hold' | 'clear';
    /** Unique per record. */
    id: string;
    /** For a release or clear: the id of the pending or hold record it ends. */
    target?: string;
    contact: string;
    number: string;
    at: string;
    /** What wrote it. For a clear, the person's own short reason. */
    reason: string;
}

const RECORD_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A fresh id for a hold record. */
export function holdRecordId(): string {
    return randomUUID();
}

/**
 * Replays the hold file into the holds now in place. A refusal hold replaces whatever is there; a pending hold only
 * fills an empty slot, so when two dialers race for one number only the first pending in the file may dial; a release
 * ends only the pending hold it names; a clear ends only the hold it names. An unreadable line stops startup rather
 * than being skipped; errors name the line only.
 */
export function parseHolds(source: string): Map<string, HoldEntry> {
    const holds = new Map<string, HoldEntry>();
    source.split('\n').forEach((line, index) => {
        if (!line.trim()) return;
        let record: unknown;
        try {
            record = JSON.parse(line);
        } catch {
            record = null;
        }
        const r = record && typeof record === 'object' ? (record as Record<string, unknown>) : {};
        const number = toUsE164(text(r.number));
        const contact = text(r.contact);
        const id = text(r.id);
        const target = text(r.target);
        const action = r.action;
        const places = action === 'pending' || action === 'hold';
        const ends = action === 'release' || action === 'clear';
        if (!number || !CONTACT_ID.test(contact) || !RECORD_ID.test(id) || !(places || ends) || (ends && !RECORD_ID.test(target))) {
            throw new CallConfigError(`Hold file line ${index + 1} is not readable.`);
        }
        const current = holds.get(number);
        if (action === 'hold') holds.set(number, { contact, id, kind: 'hold' });
        else if (action === 'pending') {
            if (!current) holds.set(number, { contact, id, kind: 'pending' });
        } else if (current?.id === target && (action === 'clear' || current.kind === 'pending')) {
            holds.delete(number);
        }
    });
    return holds;
}

/** A file that does not exist yet reads as empty; any other read error is thrown. */
function readOptional(read: (path: string) => string, path: string): string {
    try {
        return read(path);
    } catch (error) {
        if ((error as { code?: unknown }).code === 'ENOENT') return '';
        throw error;
    }
}

const readText = (path: string): string => readFileSync(path, 'utf8');

/** The holds now in place, read from a hold file. */
export function readHoldFile(path: string, read: (path: string) => string = readText): Map<string, HoldEntry> {
    return parseHolds(readOptional(read, path));
}

/**
 * Reads CALL_CONSENT_FILE or CALL_CONSENT, CALL_DO_NOT_CALL_FILE plus CALL_DO_NOT_CALL, and CALL_HOLD_FILE (trimmed,
 * the same path dialerFromEnv writes to). No consent list means no calls.
 */
export function loadCallLists(
    env: Readonly<Record<string, string | undefined>>,
    read: (path: string) => string = readText,
    now: number = Date.now(),
): CallLists {
    const consentJson = env.CALL_CONSENT_FILE ? read(env.CALL_CONSENT_FILE) : (env.CALL_CONSENT ?? '[]');
    const doNotCall = [env.CALL_DO_NOT_CALL_FILE ? read(env.CALL_DO_NOT_CALL_FILE) : '', env.CALL_DO_NOT_CALL ?? ''].join('\n');
    const holdFile = env.CALL_HOLD_FILE?.trim();
    const holds = holdFile ? readHoldFile(holdFile, read) : new Map<string, HoldEntry>();
    return { consent: parseConsentList(consentJson, now), doNotCall: parseDoNotCall(doNotCall), holds };
}

/** Records a number in the private do-not-call file. */
export function appendToDoNotCallFile(path: string, e164: string): void {
    appendFileSync(path, `${e164}\n`, 'utf8');
}

/** Adds one record to the private hold file, readable by its owner only. */
export function appendHoldRecord(path: string, record: HoldRecord): void {
    appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}

/** A clear needs a short reason in words, so every cleared hold says why. */
export function holdClearReason(reason: unknown): string {
    const clean = text(reason).replace(/\s+/g, ' ');
    if (clean.length < 3 || clean.length > 200 || !/\p{L}/u.test(clean)) {
        throw new CallConfigError('Clearing a hold needs a short reason in words, 3 to 200 characters.');
    }
    return clean;
}

/** A contact id from outside, checked the way the consent list checks it. Errors never repeat what was given. */
function checkedContactId(value: unknown): string {
    const contact = text(value);
    if (!CONTACT_ID.test(contact) || /\d{3}/.test(contact)) {
        throw new CallConfigError('A contact id starts with a letter and uses lowercase letters, digits, - or _.');
    }
    return contact;
}

/**
 * Clears every hold now in place for a contact in the hold file, with a reason, for npm run call:clear-hold. Each
 * clear is a new line naming the exact hold it ends, so a hold placed after this read is never cleared by it, and the
 * file is also the log. Returns how many holds were cleared; 0 means there was none.
 */
export function clearHoldInFile(options: { file: string; contactId: string; reason: string; now?: number; read?: (path: string) => string }): number {
    const reason = holdClearReason(options.reason);
    const contact = checkedContactId(options.contactId);
    const holds = readHoldFile(options.file, options.read);
    const at = new Date(options.now ?? Date.now()).toISOString();
    let cleared = 0;
    for (const [number, entry] of holds) {
        if (entry.contact !== contact) continue;
        appendHoldRecord(options.file, { action: 'clear', id: holdRecordId(), target: entry.id, contact, number, at, reason });
        cleared++;
    }
    return cleared;
}

// There is no time-of-day limit on calls (PLAN D20, Oct 24): consent, the AI disclosure, the read-back and a fresh
// CONFIRM still apply to every call. The recipient's time zone only sets the time the call says.

function clockTime(ms: number, timeZone: string): string {
    return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(ms)).replace(/\s+/g, ' ');
}

/**
 * The errand titles a call may report, set by the team, never taken from a web page. A form's own title is only used
 * to pick one of these, so nothing a form says can reach the agent's prompt.
 */
/** The approved title whose call passes on the day's plan in its own words (errandMessage). */
export const PLAN_TITLE = "Today's plan";
export const DEFAULT_ERRAND_TITLES = ['Care team request', PLAN_TITLE] as const;
const ERRAND_TITLE = /^[A-Za-z0-9][A-Za-z0-9 ,.'&()-]{0,39}$/;
const titleKey = (title: string): string => title.replace(/\s+/g, ' ').trim().toLowerCase();

export type RefusalCode =
    | 'bad_request'
    | 'errand_not_allowed'
    | 'not_consented'
    | 'consent_expired'
    | 'do_not_call'
    | 'opt_out_hold'
    | 'hold_file_error'
    | 'emergency_number'
    | 'bad_number'
    | 'errand_stale'
    | 'expired'
    | 'digest_mismatch'
    | 'already_used'
    | 'line_busy'
    | 'agent_mismatch'
    | 'agent_unverified'
    | 'confirm_time_unknown';

/** Sentences written for the earpiece. None of them contains a number. */
export const REFUSALS: Readonly<Record<RefusalCode, string>> = {
    bad_request: 'The call request was not valid, so I did not call.',
    errand_not_allowed: 'I can only call about the errands on the approved list, so I did not call.',
    not_consented: 'That person has not agreed to calls, so I did not call.',
    consent_expired: 'Their agreement to calls has expired, so I did not call.',
    do_not_call: 'That person asked not to be called, so I did not call.',
    opt_out_hold: 'Calls to that person are on hold until someone checks, so I did not call.',
    hold_file_error: 'I could not read or write the hold file, so I did not call.',
    emergency_number: 'I never call emergency numbers. This is not an emergency tool.',
    bad_number: 'That is not a number I can call.',
    errand_stale: 'There is no request sent in the last ten minutes to call about.',
    expired: 'That call request expired. Ask again.',
    digest_mismatch: 'The call changed after it was read back, so I did not call.',
    already_used: 'That confirm was already used, so I did not call again.',
    line_busy: 'A call is already in progress.',
    agent_mismatch: 'The calling agent does not match the reviewed script, so I did not call.',
    agent_unverified: 'I could not check the calling agent, so I did not call.',
    confirm_time_unknown: 'I could not check when you confirmed, so I did not call.',
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
    /**
     * The errand this call reports. `values` are the field values of that sent errand that its form allows to be
     * spoken, in form order. Each is checked again here (spokenValue); the ones that pass make the message
     * "<person> sent you today's plan: <values>" for PLAN_TITLE, or "<person> sent a <approved title>: <values>. It was
     * sent at <time>" for any other title. With none left, the message is "<person>'s <approved title> was sent at
     * <time>". Nothing else is ever said about the errand. Left out for a check-in.
     */
    errand?: { title: string; sentAt: string | number | Date; values?: readonly string[] };
    /**
     * PLAN D28: the partner asked to call this contact by name and no request was sent recently, so the call reports no
     * errand. The message is only "<person> asked me to check in with you". Exactly one of `errand` and `checkIn` is set;
     * every other guard (consent, do-not-call, holds, emergency numbers, the read-back and a fresh CONFIRM) still applies.
     */
    checkIn?: true;
}

/** PLAN D28: what a check-in call says, and its read-back. Fixed words: nothing from the conversation reaches the call. */
function checkInMessage(personName: string, recipientName: string): { text: string; readBack: string } {
    return { text: `${personName} asked me to check in with you`, readBack: `Call ${recipientName} to check in for you.` };
}

/**
 * Limits on what a call says about the sent errand's fields: each value, the whole message, and how many values are
 * looked at. A value over its limit, or one that would take the message over its limit, is left out, never cut: a cut
 * phrase can say the opposite ("no sugar" cut to "no").
 */
/**
 * `maxDigits` bounds the digits in all the values together, so no phone number (7 digits at least) can be spelled out
 * across values or around filler words: "1", "11:30" and "12" each pass, and the plan's "1" and "11:30" fit together.
 */
export const SUMMARY_LIMITS = { valueChars: 180, messageChars: 240, values: 10, maxDigits: 6, numberTokenRun: 3 } as const;

/** Letters (any language), digits, spaces and , . ' & ( ) - : / only. */
const SPOKEN_VALUE = /^[\p{L}0-9 ,.'&()\-:/]+$/u;
/** Edge punctuation trimmed so values join cleanly: "Today." reads "Today". */
const EDGE_MARKS = /^[ ,.:\-/!?]+|[ ,.:\-/!?]+$/g;
/** Digits said as words. Each counts as a digit toward SUMMARY_LIMITS.maxDigits. */
const DIGIT_WORDS: ReadonlySet<string> = new Set(['zero', 'oh', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'double', 'triple']);
/**
 * Every word that can be heard as a digit: DIGIT_WORDS and the words that sound like them ("for", "to", "too", "ate",
 * "won", "fore", "o"). Too common to count toward the total, so they count only inside a run of number tokens.
 */
const NUMBER_WORDS: ReadonlySet<string> = new Set([...DIGIT_WORDS, 'o', 'won', 'to', 'too', 'for', 'fore', 'ate']);

/**
 * The words and digit groups of a text, lower case. A time or decimal ("11:30", "2.5") is one digit group, so "ride
 * for 11:30" is two number tokens, not three.
 */
function numberTokens(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/([0-9])[:.](?=[0-9])/g, '$1')
        .split(/[^\p{L}0-9]+/u)
        .filter((token) => token !== '');
}

/**
 * True when the text could carry a phone number, a link, an email or a template, in any form the character check lets
 * through: more than SUMMARY_LIMITS.maxDigits digits and digit words in all ("five one, uh, six four, uh, six nine, uh,
 * one" counts eight); SUMMARY_LIMITS.numberTokenRun or more number tokens in a
 * row (digit groups and number words together, "five one six", "5 one 6", "to two four"); 7 or more digits in one run
 * of number tokens; a scheme, "www", a domain name or "dot com" in any spacing; "@"; "{{" or "}}". Run on each value and
 * again on all the values joined, so pieces that pass alone cannot join into one.
 */
function unsafeText(text: string): boolean {
    const all = numberTokens(text);
    const digitWords = all.filter((token) => DIGIT_WORDS.has(token)).length;
    if ((text.match(/[0-9]/g)?.length ?? 0) + digitWords > SUMMARY_LIMITS.maxDigits) return true;
    let tokens = 0;
    let digits = 0;
    for (const token of all) {
        const isDigits = /^[0-9]+$/.test(token);
        if (isDigits || NUMBER_WORDS.has(token)) {
            tokens += 1;
            digits += isDigits ? token.length : 1;
        } else {
            tokens = 0;
            digits = 0;
        }
        if (tokens >= SUMMARY_LIMITS.numberTokenRun || digits >= 7) return true;
    }
    return LINK_LIKE.test(text) || text.includes('{{') || text.includes('}}') || text.includes('@');
}

/** A link in any form the character check lets through: a scheme, "www", a domain name, "dot com" in any spacing. */
const LINK_LIKE =
    /:\/\/|\bwww\b|\bhttps?\b|[\p{L}0-9]\.[\p{L}]{2,}|[\p{L}0-9]\s*\.\s*(?:com|net|org|edu|gov|io|co|us|ai|app)\b|\bdot\W+(?:com|net|org|edu|gov|io|co|us|ai|app)\b|\bat\W+[\p{L}0-9]+\W+dot\b/iu;

/**
 * A field value as a call may say it, or null when it must not be said. The value ends up inside the agent's prompt
 * ({{message}} in the instructions), so it is treated as untrusted: one line with normal spaces (NFC, curly
 * apostrophes and dashes made plain), edge punctuation trimmed, at most SUMMARY_LIMITS.valueChars characters, only
 * letters, digits, spaces and basic punctuation with at least one letter or digit, and nothing unsafeText flags (a
 * phone number in digits, words or a mix, a link, an email, a template). Empty and non-text values are null.
 */
export function spokenValue(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const clean = value
        .normalize('NFC')
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u2013\u2014]/g, '-')
        .replace(/\s+/g, ' ')
        .replace(EDGE_MARKS, '');
    if (clean === '' || clean.length > SUMMARY_LIMITS.valueChars) return null;
    if (!SPOKEN_VALUE.test(clean) || !/[\p{L}0-9]/u.test(clean)) return null;
    return unsafeText(clean) ? null : clean;
}

/**
 * True when `value` has a digit and already appears, as whole words, inside a value kept so far: the plan's "11:30"
 * again as When. A value with no digit is never left out this way, so "Today" still follows "not today".
 */
function alreadySaid(kept: readonly string[], value: string): boolean {
    if (!/[0-9]/.test(value)) return false;
    const words = ` ${value.toLowerCase().replace(/[^\p{L}0-9]+/gu, ' ').trim()} `;
    return kept.some((k) => ` ${k.toLowerCase().replace(/[^\p{L}0-9]+/gu, ' ').trim()} `.includes(words));
}

/**
 * What the call says about the errand: the values that pass spokenValue, in order, leaving out one already said inside
 * an earlier value (alreadySaid), one that would make all the values joined fail unsafeText (two short digit runs that
 * join into one, more than SUMMARY_LIMITS.maxDigits digits in all), and one that would take the whole message past
 * SUMMARY_LIMITS.messageChars. For PLAN_TITLE: "<person> sent you today's plan: <values, as sentences>", and the
 * read-back "Call <recipient> to pass on today's plan: <values>." For any other title: "<person> sent a <title>:
 * <values>. It was sent at <time>", and the read-back "Call <recipient> to say: <message>." With no value left, the
 * plain "<person>'s <title> was sent at <time>" and the plain read-back. The digest covers the message either way.
 */
function errandMessage(personName: string, recipientName: string, title: string, sentClock: string, values: unknown): { text: string; readBack: string } {
    const plain = { text: `${personName}'s ${title} was sent at ${sentClock}`, readBack: `Call ${recipientName} to say your ${title} was sent.` };
    if (!Array.isArray(values)) return plain;
    const plan = titleKey(title) === titleKey(PLAN_TITLE);
    const article = /^[aeiou]/i.test(title) ? 'an' : 'a';
    const separator = plan ? '. ' : ', ';
    const say = (summary: string) => (plan ? `${personName} sent you today's plan: ${summary}` : `${personName} sent ${article} ${title}: ${summary}. It was sent at ${sentClock}`);
    const kept: string[] = [];
    for (const value of values.slice(0, SUMMARY_LIMITS.values)) {
        const clean = spokenValue(value);
        if (clean === null || alreadySaid(kept, clean)) continue;
        // The values are untrusted together too: the joined text is checked again exactly as it will be said.
        const summary = [...kept, clean].join(separator);
        if (!unsafeText(summary) && say(summary).length <= SUMMARY_LIMITS.messageChars) kept.push(clean);
    }
    if (kept.length === 0) return plain;
    const summary = kept.join(separator);
    const text = say(summary);
    return { text, readBack: plan ? `Call ${recipientName} to pass on today's plan: ${summary}.` : `Call ${recipientName} to say: ${text}.` };
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
    /** Null for a check-in (PLAN D28), which reports no errand, so there is no errand age to check. */
    errandSentAt: number | null;
    /**
     * Null until place(). Then the start of the confirm-to-dial window: the CONFIRM's own time, or the time of
     * place() if that is earlier (the CONFIRM's clock may run a little ahead of this one).
     */
    confirmedAt: number | null;
}

export type CallPhase = 'checking' | 'dialing' | 'ringing' | 'connected' | 'ended';
export type CallResult = 'answered' | 'no_answer' | 'busy' | 'voicemail' | 'cancelled' | 'failed' | 'refused' | 'unknown';
/** STOP (held jaw clench), HEADSET-OFF, the 2-minute idle auto-pause, or a teammate at the dashboard. */
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
    /** True when something said on the call may have been a refusal (heardOptOut). */
    optedOut: boolean;
    /**
     * True when the contact is on hold after this call: a possible refusal was heard, how the call ended is unknown,
     * or the hold file could not be updated. Only a person can clear it.
     */
    held: boolean;
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
    /** A consenting teammate's US number. The call no longer reads it out; the dialer still refuses to call it. */
    callbackNumber: string;
    /** Who sent the errand, as the message names them ("<person> sent you today's plan"). The script names no one. */
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
    /**
     * A CONFIRM is only good for this long after its own time (the time passed to place()), not after place() is
     * called; the agent check must finish inside it. More than 0 and at most 30000 (the default).
     */
    maxConfirmToDialMs?: number;
    /**
     * How far the CONFIRM's time may be ahead of this dialer's clock, since it comes from another clock (the
     * module's). A CONFIRM further ahead is refused as confirm_time_unknown. 0 to 5000; the default is 5000.
     */
    confirmClockSkewMs?: number;
}

export interface DialerDeps {
    fetch?: FetchLike;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    onEvent?: OnEvent;
    onUpdate?: (snapshot: CallSnapshot) => void;
    /** Persists a number added with optOut(), for example appendToDoNotCallFile. */
    onDoNotCall?: (e164: string) => void;
    /**
     * Saves a hold record, for example appendHoldRecord. If a pending record cannot be saved the call is not placed;
     * if a refusal hold cannot be saved every call is refused; if a release cannot be saved the contact stays on hold;
     * if a clear cannot be saved the hold stays.
     */
    saveHold?: (record: HoldRecord) => void;
    /** Reads the holds now in place, for example from the hold file, before every prepare, confirm, dial and clear. */
    readHolds?: () => Map<string, HoldEntry>;
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

function readTranscript(raw: unknown): { role: string; text: string }[] | null {
    if (!Array.isArray(raw)) return null;
    return raw.flatMap((turn: unknown) => {
        if (!turn || typeof turn !== 'object') return [];
        const t = turn as Record<string, unknown>;
        return typeof t.role === 'string' && typeof t.text === 'string' ? [{ role: t.role, text: t.text }] : [];
    });
}

/** The dashboard copy of the transcript: every line through redact(), so no digit or number word is shown. */
function maskedTranscript(turns: readonly { role: string; text: string }[]): { role: string; text: string }[] {
    return turns.map((turn) => ({ role: turn.role, text: redact(turn.text) }));
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
    /** The pending hold written before the dial, until the call is settled. */
    pendingId: string | null = null;
    held = false;
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
 * character, no voicemail message we have not reviewed, the end_call tool on so it can hang up as the script says,
 * and a Cartesia library voice (never a clone).
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
    // The script tells the agent to hang up with the end_call tool after its goodbye. With the tool off (null or
    // missing) it cannot, and stays on the line (Oct 24 live test), so that agent is refused too.
    // On means a tool object (as the agent PATCH sets it, not marked enabled: false) or true; anything else is off.
    const endCall = field(field(config, 'system_tools'), END_CALL_TOOL);
    const endCallOn = endCall === true || (endCall !== null && typeof endCall === 'object' && field(endCall, 'enabled') !== false);
    if (!endCallOn) return { ok: false, code: 'agent_mismatch', what: `${END_CALL_TOOL} tool off` };
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
    /** Numbers on hold until a person clears them. */
    holdCount: number;
    /** False when the hold file could not be read: then no call is placed. */
    holdsReadable: boolean;
    scriptProblems: string[];
    agent: AgentCheck;
    /** Contacts every call to would be refused right now, whatever the request (ids and codes only, never numbers). */
    unreachable: { contact: string; code: CallRefusal['code'] }[];
}

/**
 * Holds the consent list, the do-not-call list, the holds and at most one call. prepare() builds the read-back and
 * its digest; place() needs that exact digest and the time of the CONFIRM that carried it, checks everything again
 * (including that the CONFIRM is at most 30 seconds old) right before dialing, dials once, and never retries. Every
 * dial is on hold from just before the request until the call is settled, and anything heard on a call that may be
 * a refusal keeps the contact on hold until a person clears it.
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
    private readonly confirmClockSkewMs: number;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;
    /**
     * Set when a refusal hold could not be saved: then every call is refused until restart. The call's pending hold,
     * which is never released in that case, keeps the number on hold after the restart.
     */
    private holdUnsaved = false;

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
        // A window that is not a number would turn the freshness check off, so it is refused here.
        if (typeof this.maxConfirmToDialMs !== 'number' || !(this.maxConfirmToDialMs > 0 && this.maxConfirmToDialMs <= 30_000)) {
            throw new CallConfigError('maxConfirmToDialMs must be more than 0 and at most 30000.');
        }
        this.confirmClockSkewMs = config.confirmClockSkewMs ?? 5_000;
        if (typeof this.confirmClockSkewMs !== 'number' || !(this.confirmClockSkewMs >= 0 && this.confirmClockSkewMs <= 5_000)) {
            throw new CallConfigError('confirmClockSkewMs must be 0 to 5000.');
        }
        this.now = deps.now ?? Date.now;
        this.sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    }

    /** The longest a call can take: ringing, then the duration cap, plus a minute of slack. */
    private spanMs(): number {
        return this.ringSeconds * 1000 + this.durationMinutes * 60_000 + 60_000;
    }

    private check(contact: ConsentEntry | undefined, errandSentAt: number | null, now: number): CallRefusal | null {
        if (!contact) return refusal('not_consented');
        if (contact.expiresAt !== undefined && Date.parse(contact.expiresAt) <= now) return refusal('consent_expired');
        const number = toUsE164(contact.phone);
        if (!number || number === this.callback) return refusal('bad_number');
        if (isEmergencyNumber(number)) return refusal('emergency_number');
        if (this.lists.doNotCall.has(number)) return refusal('do_not_call');
        if (this.holdUnsaved || this.lists.holds.has(number)) return refusal('opt_out_hold');
        // A check-in (PLAN D28) reports no errand, so only an errand call has an age to check.
        if (errandSentAt !== null && (now - errandSentAt > this.maxErrandAgeMs || errandSentAt - now > 60_000)) return refusal('errand_stale');
        // No time-of-day check (PLAN D20). The zone still sets the time the call says, so one it cannot read refuses
        // here instead of failing while the message is built.
        if (!isUsableTimeZone(contact.timeZone)) return refusal('bad_request');
        return null;
    }

    /**
     * Whether a CONFIRM made at confirmedAt may still release a dial at now: a time that is not a finite number, or
     * that is further ahead of this clock than the allowed skew, cannot be checked; one more than maxConfirmToDialMs
     * old has expired.
     */
    private confirmBlock(confirmedAt: unknown, now: number): CallRefusal | null {
        if (typeof confirmedAt !== 'number' || !Number.isFinite(confirmedAt) || confirmedAt - now > this.confirmClockSkewMs) {
            return refusal('confirm_time_unknown');
        }
        if (now - confirmedAt > this.maxConfirmToDialMs) return refusal('expired');
        return null;
    }

    /**
     * Everything again, against the current lists and clock, including the age of the CONFIRM: used at the confirm
     * and right before the dial.
     */
    private recheck(call: Prepared, now: number, confirmedAt: unknown): CallRefusal | null {
        const contact = this.lists.consent.find((entry) => entry.id === call.contactId);
        const blocked = this.check(contact, call.errandSentAt, now);
        if (blocked) return blocked;
        if (!contact || toUsE164(contact.phone) !== call.toNumber || contact.timeZone !== call.timeZone || contact.name !== call.recipientName) {
            return refusal('digest_mismatch');
        }
        if (now > call.expiresAt) return refusal('expired');
        return this.confirmBlock(confirmedAt, now);
    }

    private refuse(code: RefusalCode): { ok: false; refusal: CallRefusal } {
        emit(this.deps.onEvent, { stage: 'call', status: 'error', detail: `refused: ${code}`, ms: 0 });
        return { ok: false, refusal: refusal(code) };
    }

    /**
     * Reloads the holds from the hold file, so a hold saved by another dialer or process counts here too. False when
     * the file cannot be read; then nothing is called.
     */
    private refreshHolds(): boolean {
        if (!this.deps.readHolds) return true;
        try {
            const fresh = this.deps.readHolds();
            this.lists.holds.clear();
            for (const [number, entry] of fresh) this.lists.holds.set(number, entry);
            return true;
        } catch {
            return false;
        }
    }

    /** Checks the guards and builds the read-back. Nothing is dialed. */
    prepare(request: CallRequest): { ok: true; call: PreparedCall } | { ok: false; refusal: CallRefusal } {
        const now = this.now();
        if (!request || typeof request.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(request.requestId)) return this.refuse('bad_request');
        // PLAN D28: a check-in carries no errand, and an errand call is not a check-in; anything else is not valid.
        const checkIn = request.checkIn === true;
        if (checkIn ? request.errand !== undefined : request.checkIn !== undefined) return this.refuse('bad_request');
        let sentAt: number | null = null;
        let title: string | undefined;
        if (!checkIn) {
            sentAt = toMs(request.errand?.sentAt);
            if (sentAt === null) return this.refuse('bad_request');
            title = typeof request.errand?.title === 'string' ? this.titles.get(titleKey(request.errand.title)) : undefined;
            if (!title) return this.refuse('errand_not_allowed');
        }
        if (!this.refreshHolds()) return this.refuse('hold_file_error');
        const contact = this.lists.consent.find((entry) => entry.id === request.contactId);
        const blocked = this.check(contact, sentAt, now);
        if (blocked || !contact) return this.refuse(blocked?.code ?? 'not_consented');
        // The values come from the agent, so they are checked again here; the digest below covers the message they make.
        const message =
            sentAt === null || title === undefined
                ? checkInMessage(this.personName, contact.name)
                : errandMessage(this.personName, contact.name, title, clockTime(sentAt, contact.timeZone), request.errand?.values);
        // The welcome ends with the message, so the message brings its own closing period.
        const variables: Record<string, string> = { recipient_name: contact.name, message: `${message.text}.` };
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
            // With values, the read-back carries every value the call will say, so the person hears what it will pass on.
            readBack: message.readBack,
            digest,
            expiresAt: now + this.preparedTtlMs,
            toNumber,
            timeZone: contact.timeZone,
            variables,
            errandSentAt: sentAt,
            confirmedAt: null,
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
     * `confirmedAtMs` is when the CONFIRM itself happened, in milliseconds since 1970 (for example the module's
     * `call_queue.confirmed_at`), never when it reached the caller. The CONFIRM must be at most 30 seconds old here
     * and again immediately before the dial request, measured from that time (or from this call, if that is
     * earlier), so a CONFIRM that arrives late can never ring a phone. Every other guard runs at both points too.
     */
    place(requestId: string, confirmDigest: string, confirmedAtMs: number): { ok: true; handle: CallHandle } | { ok: false; refusal: CallRefusal } {
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
        if (!this.refreshHolds()) return this.refuse('hold_file_error');
        const blocked = this.recheck(call, now, confirmedAtMs);
        if (blocked) return this.refuse(blocked.code);
        // Consume the confirm before anything can fail, so one confirm can never place two calls.
        this.usedDigests.add(call.digest);
        this.prepared.delete(requestId);
        // The window runs from the CONFIRM, or from now if the CONFIRM's clock reads a little ahead of this one.
        call.confirmedAt = Math.min(confirmedAtMs, now);
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

    /**
     * Clears a contact's holds after a person has checked, with a short reason (3 to 200 characters, in words). Not
     * while a call is in progress: whatever that call hears is settled first. Each clear names the exact hold it ends
     * and is saved before it takes effect; if it cannot be saved, the hold stays and this throws. Returns false when
     * the contact had no hold.
     */
    clearHold(contactId: string, reason: string): boolean {
        const why = holdClearReason(reason);
        if (this.active && !this.active.finished) throw new CallConfigError('A call is in progress. Clear the hold after it ends.');
        if (!this.refreshHolds()) throw new CallConfigError('The hold file could not be read, so the hold stays.');
        const entries = [...this.lists.holds].filter(([, entry]) => entry.contact === contactId);
        if (entries.length === 0) return false;
        const at = new Date(this.now()).toISOString();
        for (const [number, entry] of entries) {
            try {
                this.deps.saveHold?.({ action: 'clear', id: holdRecordId(), target: entry.id, contact: contactId, number, at, reason: why });
            } catch {
                throw new CallConfigError('The cleared hold could not be saved, so the hold stays.');
            }
            this.lists.holds.delete(number);
        }
        emit(this.deps.onEvent, { stage: 'call', status: 'ok', detail: 'hold cleared', ms: 0 });
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
        const holdsReadable = this.refreshHolds();
        // The same per-contact checks prepare() runs, minus the request, so a setup that refuses every call (a contact
        // whose number is the callback number, for one) cannot report ready.
        const unreachable = this.lists.consent.flatMap((entry) => {
            const number = toUsE164(entry.phone);
            const code: CallRefusal['code'] | null =
                entry.expiresAt !== undefined && Date.parse(entry.expiresAt) <= now ? 'consent_expired'
                : !number || number === this.callback ? 'bad_number'
                : isEmergencyNumber(number) ? 'emergency_number'
                : this.lists.doNotCall.has(number) ? 'do_not_call'
                : this.lists.holds.has(number) ? 'opt_out_hold'
                : !isUsableTimeZone(entry.timeZone) ? 'bad_request'
                : null;
            return code === null ? [] : [{ contact: entry.id, code }];
        });
        return {
            ok: holdsReadable && scriptProblems.length === 0 && this.lists.consent.length > unreachable.length && agent.ok,
            consentCount: this.lists.consent.length,
            doNotCallCount: this.lists.doNotCall.size,
            holdCount: this.lists.holds.size,
            holdsReadable,
            scriptProblems,
            agent,
            unreachable,
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

    /**
     * Puts a number on hold for a possible refusal, in memory at once and then in the hold file. If saving fails, every
     * call is refused; the call's pending hold, never released, still holds the number after a restart.
     */
    private addHold(number: string, contactId: string): void {
        const id = holdRecordId();
        this.lists.holds.set(number, { contact: contactId, id, kind: 'hold' });
        try {
            this.deps.saveHold?.({ action: 'hold', id, contact: contactId, number, at: new Date(this.now()).toISOString(), reason: 'heard on a call' });
        } catch {
            this.holdUnsaved = true;
            emit(this.deps.onEvent, { stage: 'call', status: 'error', detail: 'hold not saved: refusing all calls', ms: 0 });
        }
    }

    /**
     * Settles the pending hold written before the dial, once the call has ended. Anything heard that may be a refusal
     * holds the contact, written as the call's last record so a clear made during the call cannot outlast it. A call
     * whose end is unknown keeps its pending hold. Only a call with a known end and nothing heard releases it, and if
     * the release cannot be saved the contact stays on hold.
     */
    private settleHold(handle: CallHandle, call: Prepared, result: CallResult): void {
        const pendingId = handle.pendingId;
        if (pendingId === null) return;
        handle.pendingId = null;
        handle.held = true;
        if (handle.optedOut || heardOptOut(handle.transcript)) {
            handle.optedOut = true;
            this.addHold(call.toNumber, call.contactId);
            return;
        }
        if (result !== 'unknown') {
            try {
                this.deps.saveHold?.({
                    action: 'release',
                    id: holdRecordId(),
                    target: pendingId,
                    contact: call.contactId,
                    number: call.toNumber,
                    at: new Date(this.now()).toISOString(),
                    reason: 'call ended with nothing heard',
                });
                if (this.lists.holds.get(call.toNumber)?.id === pendingId) this.lists.holds.delete(call.toNumber);
                handle.held = false;
                return;
            } catch {
                // Not released: the pending hold stays in the file, and in memory below.
            }
        }
        if (!this.lists.holds.has(call.toNumber)) this.lists.holds.set(call.toNumber, { contact: call.contactId, id: pendingId, kind: 'pending' });
        emit(this.deps.onEvent, { stage: 'call', status: 'error', detail: result === 'unknown' ? 'held: call end unknown' : 'held: release not saved', ms: 0 });
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
                transcript: maskedTranscript(handle.transcript),
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
            this.settleHold(handle, call, result);
            const outcome: CallOutcome = {
                requestId: call.requestId,
                result,
                dialed: false,
                callId: handle.callId,
                endReason: null,
                cancelReason: handle.cancelReason,
                refusal: null,
                optedOut: handle.optedOut,
                held: handle.held,
                spoken: '',
                summary: null,
                ms: this.now() - started,
                ...extra,
            };
            const held = outcome.held ? ` Calls to ${call.recipientName} are on hold until someone checks.` : '';
            outcome.spoken = (outcome.refusal ? outcome.refusal.reason : this.spokenOutcome(call.recipientName, outcome)) + held;
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
            const blocked = this.recheck(call, this.now(), call.confirmedAt);
            if (blocked) return end('refused', { refusal: blocked });
            handle.phase = 'dialing';
            emit(this.deps.onEvent, { stage: 'call', status: 'started', detail: 'dialing', ms: 0 });
            this.update(handle);
            // The pending hold goes in the hold file before the dial, so a crash, a timeout or a lost answer leaves
            // the contact on hold, never free to call again. A pending hold that cannot be saved means no call.
            if (!this.refreshHolds()) return end('refused', { refusal: refusal('hold_file_error') });
            const pendingId = holdRecordId();
            try {
                this.deps.saveHold?.({
                    action: 'pending',
                    id: pendingId,
                    contact: call.contactId,
                    number: call.toNumber,
                    at: new Date(this.now()).toISOString(),
                    reason: 'call about to be placed',
                });
            } catch {
                return end('refused', { refusal: refusal('hold_file_error') });
            }
            handle.pendingId = pendingId;
            // Another dialer may have written its own pending hold for this number at the same moment: only the
            // first one in the file dials.
            if (this.deps.readHolds) {
                let owner: HoldEntry | undefined;
                try {
                    owner = this.deps.readHolds().get(call.toNumber);
                } catch {
                    return end('refused', { refusal: refusal('hold_file_error') });
                }
                if (owner?.id !== pendingId) {
                    return end('refused', { refusal: refusal(owner === undefined ? 'hold_file_error' : owner.kind === 'hold' ? 'opt_out_hold' : 'line_busy') });
                }
            }
            // The last check, after the last application callback above, with nothing between it and the request:
            // a STOP, HEADSET-OFF, opt-out or list change made from the dialing notice still stops the call.
            // Every guard runs again: consent, do-not-call, holds, the number and a CONFIRM at most 30 seconds
            // old by its own time, so a CONFIRM that went stale while the agent was checked never rings a phone.
            const at = this.now();
            if (handle.cancelReason) return end('cancelled');
            const lastBlocked = this.recheck(call, at, call.confirmedAt);
            if (lastBlocked) return end('refused', { refusal: lastBlocked });
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
            await this.poll(handle, started, end);
        } catch {
            end('unknown', { dialed: handle.callId ? true : 'unknown' });
        }
    }

    private async poll(handle: CallHandle, started: number, end: (result: CallResult, extra?: Partial<CallOutcome>) => void): Promise<void> {
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
                // The pending hold already covers this call; a possible refusal is noted here and written as a hold
                // when the call is settled, so no timeout or error in between can release the contact.
                if (!handle.optedOut && heardOptOut(handle.transcript)) {
                    handle.optedOut = true;
                    emit(this.deps.onEvent, { stage: 'call', status: 'ok', detail: 'opt-out hold', ms: this.now() - started });
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

    /** The sentence for how the call ended; end() adds the hold sentence when the contact is on hold. */
    private spokenOutcome(name: string, outcome: CallOutcome): string {
        switch (outcome.result) {
            case 'answered':
                return outcome.optedOut ? `${name} may not want more calls.` : `${name} picked up. The call has ended.`;
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
