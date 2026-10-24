// Past requests: the errand memory. After a form was actually sent (the module recorded the matching CONFIRM and the
// Actor reported it submitted), src/errands.ts keeps one private note in Moss under memory consent, never in the try
// sandbox. The next time the conversation leads to the same form, src/retrieval.ts recalls the newest note of that
// form and the planner may fill the errand option from it, preferring what was said now. A note only fills an option:
// the pick still gets a preview, a read-back and a fresh CONFIRM before anything is sent.

import type { FieldInput } from '@say-when/apify-client';

import type { AllowedForm } from './types.js';

/** Every note starts with this, then the form title in brackets. */
export const PAST_REQUEST = 'Past request';

/** Moss keeps a preference note of at most 1000 characters (moss/src/memory.ts). A longer note is not kept. */
export const NOTE_MAX_CHARS = 1000;

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const key = (text: string): string => oneLine(text).toLowerCase();

/** The Moss query for a form's past requests, which is also the start of every note for that form. */
export function pastRequestQuery(formTitle: string): string {
    return `${PAST_REQUEST} (${oneLine(formTitle)})`;
}

/** True for a past request note, of the given form when a title is given. */
export function isPastRequest(text: string, formTitle?: string): boolean {
    return formTitle === undefined ? text.startsWith(`${PAST_REQUEST} (`) : text.startsWith(`${pastRequestQuery(formTitle)}, sent `);
}

/**
 * The note for one sent form: the form title, when it was sent, and the field values as JSON, for example
 * `Past request (Care team request), sent Sat, Oct 24, 2:10 PM. Fields: {"What do you need?":"Meal or drink"}`.
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
    const note = `${pastRequestQuery(form.formTitle)}, sent ${when}. Fields: ${JSON.stringify(Object.fromEntries(kept))}`;
    return note.length <= NOTE_MAX_CHARS ? note : null;
}
