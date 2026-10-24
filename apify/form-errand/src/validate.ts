import type { ErrandInput, FieldInput, FieldValue, Mode } from './types.js';

export class InputError extends Error {}

export const DEFAULT_CONFIRMATION_PHRASES = ['recorded', 'received', 'thank', 'submitted', 'sent'];
export const DEFAULT_DISCLOSURE = 'Sent with an assistive switch after a spoken read-back and a confirm.';

const MODES: Mode[] = ['inspect', 'preview', 'submit'];

function text(value: unknown, name: string, max: number): string {
    if (typeof value !== 'string') throw new InputError(`${name} must be a string.`);
    if (value.length > max) throw new InputError(`${name} must be at most ${max} characters.`);
    return value;
}

function fieldValue(value: unknown, name: string): FieldValue {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return text(value, name, 4000);
    if (Array.isArray(value)) {
        if (value.length > 20) throw new InputError(`${name} can list at most 20 choices.`);
        return value.map((v, i) => text(v, `${name}[${i}]`, 200));
    }
    throw new InputError(`${name} must be a string, a list of strings, or true/false.`);
}

/**
 * Checks every input field again in code, so API callers that skip the input schema cannot raise limits
 * or reach submit without the explicit mode, confirm and digest.
 */
export function parseInput(raw: unknown): ErrandInput {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InputError('Input must be a JSON object.');
    const r = raw as Record<string, unknown>;

    const formUrl = text(r.formUrl, 'formUrl', 2048).trim();
    if (!formUrl) throw new InputError('formUrl is required.');

    const mode = (r.mode ?? 'preview') as Mode;
    if (!MODES.includes(mode)) throw new InputError('mode must be inspect, preview or submit.');

    const rawFields = r.fields ?? [];
    if (!Array.isArray(rawFields)) throw new InputError('fields must be a list.');
    if (rawFields.length > 40) throw new InputError('fields can list at most 40 answers.');
    const fields: FieldInput[] = rawFields.map((f, i) => {
        if (!f || typeof f !== 'object') throw new InputError(`fields[${i}] must be an object.`);
        const item = f as Record<string, unknown>;
        const label = text(item.label, `fields[${i}].label`, 200).trim();
        if (!label) throw new InputError(`fields[${i}].label is empty.`);
        const out: FieldInput = { label, value: fieldValue(item.value, `fields[${i}].value`) };
        if (item.source !== undefined) out.source = text(item.source, `fields[${i}].source`, 200);
        return out;
    });
    if (mode !== 'inspect' && fields.length === 0) throw new InputError('fields must list at least one answer.');

    let confirmDigest: string | undefined;
    if (r.confirmDigest !== undefined && r.confirmDigest !== '') {
        confirmDigest = text(r.confirmDigest, 'confirmDigest', 16);
        if (!/^[0-9a-f]{16}$/.test(confirmDigest)) throw new InputError('confirmDigest must be the 16 hex characters from a preview.');
    }

    // Plain phrases only: a caller-supplied regular expression could stall the shared Standby server.
    let confirmationPhrases = DEFAULT_CONFIRMATION_PHRASES;
    if (r.confirmationPhrases !== undefined) {
        if (!Array.isArray(r.confirmationPhrases)) throw new InputError('confirmationPhrases must be a list of phrases.');
        if (r.confirmationPhrases.length > 10) throw new InputError('confirmationPhrases can list at most 10 phrases.');
        const phrases = r.confirmationPhrases.map((p, i) => text(p, `confirmationPhrases[${i}]`, 80).trim()).filter(Boolean);
        if (phrases.length > 0) confirmationPhrases = phrases;
    }

    return {
        formUrl,
        fields,
        mode,
        confirm: r.confirm === true,
        ...(confirmDigest ? { confirmDigest } : {}),
        submitButtonText:
            r.submitButtonText === undefined || r.submitButtonText === '' ? 'Submit' : text(r.submitButtonText, 'submitButtonText', 60),
        confirmationPhrases,
        disclosureText: r.disclosureText === undefined ? DEFAULT_DISCLOSURE : text(r.disclosureText, 'disclosureText', 300),
        ...(r.disclosureField ? { disclosureField: text(r.disclosureField, 'disclosureField', 200) } : {}),
        includeScreenshot: r.includeScreenshot !== false,
    };
}
