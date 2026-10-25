// The errand forms the planner may offer, from AGENT_FORMS_FILE (a private JSON file). Each form also needs an
// Errand consent row in the module for its form_key, or the module refuses the errand at the pick.
// Errors name the entry by position, never its contents.

import { readFileSync } from 'node:fs';

import { ID_PATTERN, LIMITS } from './contract.js';
import type { AllowedForm, FormField } from './types.js';

export class FormsFileError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FormsFileError';
    }
}

const TITLE = /^[A-Za-z0-9][A-Za-z0-9 ,.'&()-]{0,119}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function text(value: unknown, max: number): string | null {
    if (typeof value !== 'string') return null;
    const clean = value.replace(/\s+/g, ' ').trim();
    return clean !== '' && clean.length <= max && !CONTROL.test(value) ? clean : null;
}

function parseField(raw: unknown, where: string): FormField {
    if (!raw || typeof raw !== 'object') throw new FormsFileError(`${where} is not an object.`);
    const f = raw as Record<string, unknown>;
    const label = text(f.label, 200);
    if (!label) throw new FormsFileError(`${where} needs a label of 1 to 200 characters.`);
    const field: FormField = { label };
    if (f.choices !== undefined) {
        if (!Array.isArray(f.choices) || f.choices.length === 0 || f.choices.length > 20) throw new FormsFileError(`${where} has a bad choices list.`);
        const choices = f.choices.map((c) => text(c, 100));
        if (choices.some((c) => c === null)) throw new FormsFileError(`${where} has a bad choice.`);
        field.choices = choices as string[];
    }
    if (f.required !== undefined) {
        if (typeof f.required !== 'boolean') throw new FormsFileError(`${where} has a required flag that is not true or false.`);
        field.required = f.required;
    }
    if (f.fixedValue !== undefined) {
        const value = text(f.fixedValue, 500);
        if (!value) throw new FormsFileError(`${where} has a bad fixedValue.`);
        field.fixedValue = value;
    }
    if (f.hint !== undefined) {
        const hint = text(f.hint, 120);
        if (!hint) throw new FormsFileError(`${where} has a bad hint.`);
        field.hint = hint;
    }
    if (f.speak !== undefined) {
        if (typeof f.speak !== 'boolean') throw new FormsFileError(`${where} has a speak flag that is not true or false.`);
        field.speak = f.speak;
    }
    return field;
}

/** Parses and checks the forms JSON: an array of `{ formKey, formUrl, formTitle, fields }`. */
export function parseForms(json: string): AllowedForm[] {
    let raw: unknown;
    try {
        raw = JSON.parse(json);
    } catch {
        throw new FormsFileError('The forms file is not valid JSON.');
    }
    if (!Array.isArray(raw)) throw new FormsFileError('The forms file must be a JSON array.');
    const keys = new Set<string>();
    return raw.map((item: unknown, i) => {
        const where = `Form ${i}`;
        if (!item || typeof item !== 'object') throw new FormsFileError(`${where} is not an object.`);
        const f = item as Record<string, unknown>;
        if (typeof f.formKey !== 'string' || !ID_PATTERN.test(f.formKey)) throw new FormsFileError(`${where} needs a formKey of letters, digits, - or _.`);
        if (keys.has(f.formKey)) throw new FormsFileError(`${where} repeats a formKey.`);
        keys.add(f.formKey);
        if (typeof f.formUrl !== 'string' || !(f.formUrl === 'demo' || f.formUrl.startsWith('https://')) || f.formUrl.length > LIMITS.formUrl) {
            throw new FormsFileError(`${where} needs a formUrl that is "demo" or an https address.`);
        }
        if (typeof f.formTitle !== 'string' || !TITLE.test(f.formTitle)) throw new FormsFileError(`${where} needs a plain formTitle of up to 120 characters.`);
        if (!Array.isArray(f.fields) || f.fields.length === 0 || f.fields.length > LIMITS.actionFields) {
            throw new FormsFileError(`${where} needs 1 to ${LIMITS.actionFields} fields.`);
        }
        const fields = f.fields.map((field, n) => parseField(field, `${where} field ${n}`));
        const labels = new Set(fields.map((field) => field.label.toLowerCase()));
        if (labels.size !== fields.length) throw new FormsFileError(`${where} repeats a field label.`);
        return { formKey: f.formKey, formUrl: f.formUrl, formTitle: f.formTitle, fields };
    });
}

export function loadForms(path: string): AllowedForm[] {
    let json: string;
    try {
        json = readFileSync(path, 'utf8');
    } catch {
        throw new FormsFileError('The forms file could not be read.');
    }
    return parseForms(json);
}
