// Checks a parsed planner reply against the rules the schema cannot express, and resolves it against the input
// (context refs, allowed forms, consented contacts). Strict: any broken rule fails the whole reply with a list of
// rule names, so a bad reply never reaches the person's earpiece. Messages never quote the reply.

import type { FieldInput } from '@say-when/apify-client';

import { LIMITS } from '../contract.js';
import type { AllowedForm, FormField, OptionKind, Tone } from '../types.js';
import type { PlanReply } from './schema.js';
import { PlannerError, type Plan, type PlanInput, type PlannedOption } from './types.js';

const MARKUP = /[<>[\]{}]/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const FIELD_VALUE_MAX = 500;

const clean = (text: string): string => text.replace(/\s+/g, ' ').trim();
const key = (text: string): string => clean(text).toLowerCase();

function firstWord(text: string): string {
    return key(text).replace(/^[^a-z]+/, '').split(/[^a-z']+/)[0] ?? '';
}

const NO_WORDS = new Set(['no', 'nope', 'nah', 'not']);
const YES_WORDS = new Set(['yes', 'yeah', 'yep', 'sure', 'yup']);

/** Resolves the errand fields: the form's fixed values plus the planner's values, in the form's own order. */
function errandFields(form: AllowedForm, given: { label: string; value: string }[], problems: Set<string>): FieldInput[] {
    const byLabel = new Map<string, FormField>(form.fields.map((f) => [key(f.label), f]));
    const values = new Map<string, string>();
    for (const item of given) {
        const field = byLabel.get(key(item.label));
        if (!field) {
            problems.add('unknown_field');
            continue;
        }
        // A fixed field is the app's to fill; whatever the planner wrote there is ignored.
        if (field.fixedValue !== undefined) continue;
        if (values.has(field.label)) {
            problems.add('duplicate_field');
            continue;
        }
        const value = clean(item.value);
        if (value === '' || value.length > FIELD_VALUE_MAX || CONTROL.test(item.value)) {
            problems.add('bad_field_value');
            continue;
        }
        if (field.choices && field.choices.length > 0) {
            const choice = field.choices.find((c) => key(c) === key(value));
            if (!choice) {
                problems.add('bad_choice');
                continue;
            }
            values.set(field.label, choice);
        } else {
            values.set(field.label, value);
        }
    }
    const out: FieldInput[] = [];
    for (const field of form.fields) {
        if (field.fixedValue !== undefined) {
            out.push({ label: field.label, value: field.fixedValue, source: 'profile' });
            continue;
        }
        const value = values.get(field.label);
        if (value !== undefined) out.push({ label: field.label, value, source: 'conversation' });
        else if (field.required) problems.add('missing_required_field');
    }
    if (out.length === 0) problems.add('empty_errand');
    if (out.length > LIMITS.actionFields) problems.add('too_many_fields');
    return out;
}

/** Validates a reply and resolves it into a Plan. Throws PlannerError('invalid_reply') listing every broken rule. */
export function validatePlan(reply: PlanReply, input: PlanInput): Plan {
    const problems = new Set<string>();
    const max = Math.min(Math.max(1, input.maxOptions), LIMITS.maxOptions);
    const count = reply.options.length;
    if (reply.answer_mode === 'yes_no' && count !== 2) problems.add('yes_no_needs_two');
    if (reply.answer_mode === 'pick' && (count < 1 || count > max)) problems.add('option_count');

    const refs = new Set<string>([...input.memory.map((m) => m.ref), ...input.web.map((w) => w.ref)]);
    const texts = new Set<string>();
    const tones = new Set<Tone>();
    let laughs = 0;
    let replies = 0;
    const options: PlannedOption[] = [];

    for (const raw of reply.options) {
        const text = clean(raw.text);
        if (text === '') problems.add('empty_text');
        if (text.length > LIMITS.optionText) problems.add('text_too_long');
        if (CONTROL.test(raw.text)) problems.add('control_characters');
        if (MARKUP.test(text)) problems.add('markup_in_text');
        if (texts.has(key(text))) problems.add('duplicate_text');
        texts.add(key(text));

        if (tones.has(raw.tone)) problems.add('duplicate_tone');
        tones.add(raw.tone);
        if (raw.laugh) laughs += 1;

        const sources: string[] = [];
        for (const ref of raw.sources) {
            if (!refs.has(ref)) problems.add('unknown_source');
            else if (!sources.includes(ref)) sources.push(ref);
        }

        const kind: OptionKind = raw.kind;
        let errand: PlannedOption['errand'] = null;
        let call: PlannedOption['call'] = null;
        if (kind === 'reply') {
            replies += 1;
            if (raw.errand !== null || raw.call !== null) problems.add('reply_with_action');
        } else if (kind === 'errand') {
            if (reply.answer_mode === 'yes_no') problems.add('action_in_yes_no');
            if (raw.call !== null) problems.add('errand_with_call');
            const form = raw.errand ? input.forms.find((f) => f.formKey === raw.errand?.form_key) : undefined;
            if (!raw.errand) problems.add('errand_without_form');
            else if (!form) problems.add('unknown_form');
            else errand = { form, fields: errandFields(form, raw.errand.fields, problems) };
        } else {
            if (reply.answer_mode === 'yes_no') problems.add('action_in_yes_no');
            if (raw.errand !== null) problems.add('call_with_errand');
            const contact = raw.call ? input.contacts.find((c) => c.contactId === raw.call?.contact_id) : undefined;
            if (!raw.call) problems.add('call_without_contact');
            else if (!contact) problems.add('unknown_contact');
            else if (!input.recentErrand) problems.add('call_without_recent_errand');
            else call = { contact };
        }
        options.push({ kind, text, tone: raw.tone, laugh: raw.laugh, refs: sources, errand, call });
    }

    if (laughs > 1) problems.add('more_than_one_laugh');
    if (count > 0 && replies === 0) problems.add('only_actions');
    if (reply.answer_mode === 'yes_no' && count === 2) {
        if (NO_WORDS.has(firstWord(reply.options[0]?.text ?? ''))) problems.add('yes_answer_starts_with_no');
        if (YES_WORDS.has(firstWord(reply.options[1]?.text ?? ''))) problems.add('no_answer_starts_with_yes');
    }

    if (problems.size > 0) throw new PlannerError('invalid_reply', [...problems].sort());
    return { answerMode: reply.answer_mode, options };
}
