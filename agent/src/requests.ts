// Past requests: the errand memory. After a form was actually sent (the module recorded the matching CONFIRM and the
// Actor reported it submitted), src/errands.ts keeps one private note in Moss, never in the try sandbox, and only when
// memory consent held without a break from before the CONFIRM to the write (MemoryWatch). The next time the
// conversation leads to the same form, src/retrieval.ts recalls the newest note of that form and the planner may fill
// the errand option from it, preferring what was said now. A note only fills an option: the pick still gets a preview,
// a read-back and a fresh CONFIRM before anything is sent.

import type { FieldInput } from '@say-when/apify-client';

import type { AgentDb } from './db/db.js';
import type { AllowedForm } from './types.js';

/** Every note starts with this, then the form title and key in brackets. */
export const PAST_REQUEST = 'Past request';

/** What names a form in a note: the title the person hears and the key that is unique to the form. */
export type FormRef = Pick<AllowedForm, 'formKey' | 'formTitle'>;

/** Moss keeps a preference note of at most 1000 characters (moss/src/memory.ts). A longer note is not kept. */
export const NOTE_MAX_CHARS = 1000;

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const key = (text: string): string => oneLine(text).toLowerCase();

/**
 * The Moss query for a form's past requests, which is also the start of every note for that form. The key is in it
 * because two allowed forms may share a title; the key is unique (`^[A-Za-z0-9_-]{1,64}$`), so one form's values never
 * fill the other.
 */
export function pastRequestQuery(form: FormRef): string {
    return `${PAST_REQUEST} (${oneLine(form.formTitle)}, form ${form.formKey})`;
}

/** True for a past request note, of the given form (title and key) when one is given. */
export function isPastRequest(text: string, form?: FormRef): boolean {
    return form === undefined ? text.startsWith(`${PAST_REQUEST} (`) : text.startsWith(`${pastRequestQuery(form)}, sent `);
}

/**
 * The note for one sent form: the form title and key, when it was sent, and the field values as JSON, for example
 * `Past request (Care team request, form care_team_request), sent Sat, Oct 24, 2:10 PM. Fields: {"Details":"soup"}`.
 * Fixed fields (the app fills them, such as who the request is from) are left out. Null when nothing is left to keep
 * or the note would be too long for Moss.
 */
export function pastRequestNote(form: AllowedForm, fields: readonly FieldInput[], sentAtMs: number, timeZone: string): string | null {
    const fixed = new Set(form.fields.filter((f) => f.fixedValue !== undefined).map((f) => key(f.label)));
    const kept = fields.filter((f) => f.source !== 'profile' && !fixed.has(key(f.label))).map((f) => [oneLine(f.label), f.value] as const);
    if (kept.length === 0) return null;
    const when = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        .format(new Date(sentAtMs))
        .replace(/\s+/g, ' ');
    // Object.fromEntries defines each label as its own property, whatever the label says.
    const note = `${pastRequestQuery(form)}, sent ${when}. Fields: ${JSON.stringify(Object.fromEntries(kept))}`;
    return note.length <= NOTE_MAX_CHARS ? note : null;
}

/** A moment memory consent held: the session it held in, and the watch's counts at that moment. */
export interface ConsentMark {
    sessionId: bigint;
    breaks: number;
    syncs: number;
}

/**
 * Tells whether memory consent held without a break between two moments. The sidecar sees consent only as the module
 * shows it now, so a check at the write alone (or at the claim) cannot tell that consent also held at the CONFIRM: it
 * may have been given only after it, or revoked and given again. A mark is taken before the CONFIRM (when the preview
 * is attached, src/jobs.ts), and the note is kept only if consent still holds at the write in the same session, with
 * no memory-off report in between (a revocation, or a lost connection or subscription, AgentDb.onMemoryOff) and no
 * fresh snapshot of the views. Anything unsure counts as a break: no note.
 */
export class MemoryWatch {
    private breaks = 0;
    private readonly unsubscribe: () => void;

    constructor(private readonly db: AgentDb) {
        this.unsubscribe = db.onMemoryOff(() => {
            this.breaks += 1;
        });
    }

    /** The mark now, or null when memory consent is off, unknown, between sessions, or the views are not current. */
    mark(): ConsentMark | null {
        if (!this.db.isCurrent()) return null;
        const consent = this.db.agentConsent();
        if (!consent || !consent.memoryAllowed || consent.sessionId === 0n) return null;
        return { sessionId: consent.sessionId, breaks: this.breaks, syncs: this.db.syncCount() };
    }

    /** True only when memory consent holds now, in the same session, with no break since `then`. */
    heldSince(then: ConsentMark | null | undefined): boolean {
        if (!then) return false;
        const now = this.mark();
        return now !== null && now.sessionId === then.sessionId && now.breaks === then.breaks && now.syncs === then.syncs;
    }

    close(): void {
        this.unsubscribe();
    }
}
