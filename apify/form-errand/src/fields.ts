import type { Locator, Page } from 'playwright';

import type { FieldValue, QuestionInfo } from './types.js';

export type ControlKind = 'text' | 'paragraph' | 'select' | 'checkbox' | 'radio-group' | 'checkbox-group';

export interface LocatedField {
    kind: ControlKind;
    locator: Locator;
    /** How the question was found, for the read-back record. */
    matchedBy: string;
}

const clean = (text: string): string =>
    text
        .replace(/\*/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

/** How well an accessible name matches a requested label: 3 exact, 2 starts with, 1 contains, 0 no match. */
export function nameScore(name: string, label: string): number {
    const n = clean(name);
    const l = clean(label);
    if (!n || !l) return 0;
    if (n === l) return 3;
    if (n.startsWith(l)) return 2;
    if (n.includes(l)) return 1;
    return 0;
}

/** A simplified accessible name: aria-labelledby, aria-label, <label>, <legend>, then text. Runs in the page. */
async function accessibleName(locator: Locator): Promise<string> {
    return locator.evaluate((el) => {
        const text = (node: Element | null) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
        const element = el as HTMLElement & { labels?: NodeListOf<HTMLLabelElement> | null };
        const ids = (element.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
        const labelledBy = ids.map((id) => text(document.getElementById(id))).join(' ').trim();
        if (labelledBy) return labelledBy;
        const aria = element.getAttribute('aria-label');
        if (aria && aria.trim()) return aria.trim();
        if (element.labels && element.labels.length > 0) return Array.from(element.labels).map((l) => text(l)).join(' ');
        if (element.tagName === 'FIELDSET') return text(element.querySelector('legend'));
        return (
            element.getAttribute('data-value') ??
            element.getAttribute('placeholder') ??
            element.getAttribute('title') ??
            text(element)
        );
    });
}

interface ControlInfo {
    tag: string;
    type: string;
    role: string;
    visible: boolean;
    disabled: boolean;
    hasRadios: boolean;
    hasChecks: boolean;
}

async function controlInfo(locator: Locator): Promise<ControlInfo> {
    return locator.evaluate((el) => {
        const element = el as HTMLInputElement;
        return {
            tag: element.tagName,
            type: (element.getAttribute('type') ?? '').toLowerCase(),
            role: element.getAttribute('role') ?? '',
            visible: element.getClientRects().length > 0,
            disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true',
            hasRadios: !!element.querySelector('input[type=radio], [role=radio]'),
            hasChecks: !!element.querySelector('input[type=checkbox], [role=checkbox]'),
        };
    });
}

const TEXT_TYPES = new Set(['', 'text', 'email', 'tel', 'number', 'url', 'search', 'date', 'time', 'datetime-local', 'month', 'week']);

function classify(info: ControlInfo): ControlKind | null {
    if (info.tag === 'TEXTAREA') return 'paragraph';
    if (info.tag === 'SELECT') return 'select';
    if (info.tag === 'INPUT') {
        if (info.type === 'checkbox') return 'checkbox';
        if (TEXT_TYPES.has(info.type)) return 'text';
        return null;
    }
    if (info.role === 'textbox') return 'text';
    if (info.role === 'radiogroup' || info.hasRadios) return 'radio-group';
    if (info.hasChecks) return 'checkbox-group';
    return null;
}

interface Candidate {
    field: LocatedField;
    score: number;
    order: number;
}

async function collect(source: Locator, label: string, matchedBy: string, order: number, out: Candidate[]): Promise<void> {
    const count = Math.min(await source.count(), 10);
    for (let i = 0; i < count; i += 1) {
        const locator = source.nth(i);
        const info = await controlInfo(locator);
        if (!info.visible || info.disabled) continue;
        const kind = classify(info);
        if (!kind) continue;
        const score = nameScore(await accessibleName(locator), label);
        if (score > 0) out.push({ field: { kind, locator, matchedBy }, score, order });
    }
}

/**
 * Finds the control for a question label. Tries labelled inputs, ARIA radio groups (Google Forms style),
 * fieldsets with a legend, and list items with a heading, then keeps the best name match.
 */
export async function locateField(page: Page, label: string): Promise<LocatedField | null> {
    const candidates: Candidate[] = [];
    await collect(page.getByLabel(label), label, 'label', 0, candidates);
    await collect(page.getByRole('radiogroup', { name: label }), label, 'radiogroup', 1, candidates);
    await collect(page.getByRole('group', { name: label }), label, 'group', 2, candidates);

    if (candidates.length === 0) {
        // Question cards: a list item whose heading is the label, holding one text box or a set of choices.
        const items = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: label }) });
        const count = Math.min(await items.count(), 5);
        for (let i = 0; i < count; i += 1) {
            const item = items.nth(i);
            const heading = item.getByRole('heading').first();
            const score = nameScore(await accessibleName(heading), label);
            if (score === 0) continue;
            const box = item.locator('input:not([type=hidden]):not([type=radio]):not([type=checkbox]), textarea').first();
            if ((await box.count()) > 0) {
                const kind = classify(await controlInfo(box));
                if (kind) candidates.push({ field: { kind, locator: box, matchedBy: 'heading' }, score, order: 3 });
                continue;
            }
            const info = await controlInfo(item);
            const kind: ControlKind | null = info.hasRadios ? 'radio-group' : info.hasChecks ? 'checkbox-group' : null;
            if (kind) candidates.push({ field: { kind, locator: item, matchedBy: 'heading' }, score, order: 3 });
        }
    }

    candidates.sort((a, b) => b.score - a.score || a.order - b.order);
    return candidates[0]?.field ?? null;
}

const asText = (value: FieldValue): string =>
    Array.isArray(value) ? value.join(', ') : typeof value === 'boolean' ? (value ? 'yes' : 'no') : value;

async function bestOption(group: Locator, role: 'radio' | 'checkbox', wanted: string): Promise<Locator | null> {
    const options = group.getByRole(role);
    const count = Math.min(await options.count(), 50);
    let best: { locator: Locator; score: number } | null = null;
    for (let i = 0; i < count; i += 1) {
        const option = options.nth(i);
        const score = nameScore(await accessibleName(option), wanted);
        if (score > 0 && (!best || score > best.score)) best = { locator: option, score };
    }
    return best?.locator ?? null;
}

/** Fills one question. Returns an error sentence, or null when it worked. */
export async function fillField(field: LocatedField, value: FieldValue): Promise<string | null> {
    switch (field.kind) {
        case 'text':
        case 'paragraph':
            await field.locator.fill(asText(value));
            return null;
        case 'select':
            try {
                await field.locator.selectOption({ label: asText(value) });
            } catch {
                await field.locator.selectOption(asText(value));
            }
            return null;
        case 'checkbox': {
            const on = value === true || /^(yes|true|on|checked)$/i.test(asText(value).trim());
            if (on) await field.locator.check();
            else await field.locator.uncheck();
            return null;
        }
        case 'radio-group': {
            const wanted = asText(value);
            const option = await bestOption(field.locator, 'radio', wanted);
            if (!option) return `no choice named "${wanted}"`;
            await option.check();
            return null;
        }
        case 'checkbox-group': {
            const wanted = Array.isArray(value) ? value : asText(value).split(',').map((v) => v.trim()).filter(Boolean);
            for (const name of wanted) {
                const option = await bestOption(field.locator, 'checkbox', name);
                if (!option) return `no choice named "${name}"`;
                await option.check();
            }
            return null;
        }
        default:
            return 'unsupported question type';
    }
}

/** Reads the value the page now holds for a question. */
export async function readField(field: LocatedField): Promise<string> {
    switch (field.kind) {
        case 'text':
        case 'paragraph': {
            const info = await controlInfo(field.locator);
            if (info.tag === 'INPUT' || info.tag === 'TEXTAREA') return field.locator.inputValue();
            return (await field.locator.innerText()).trim();
        }
        case 'select':
            return field.locator.evaluate((el) =>
                Array.from((el as HTMLSelectElement).selectedOptions)
                    .map((o) => o.text.trim())
                    .join(', '),
            );
        case 'checkbox':
            return (await field.locator.isChecked()) ? 'yes' : 'no';
        case 'radio-group':
        case 'checkbox-group': {
            const role = field.kind === 'radio-group' ? 'radio' : 'checkbox';
            const options = field.locator.getByRole(role, { checked: true });
            const count = Math.min(await options.count(), 50);
            const names: string[] = [];
            for (let i = 0; i < count; i += 1) names.push(await accessibleName(options.nth(i)));
            return names.join(', ');
        }
        default:
            return '';
    }
}

/** Required questions still empty after filling. Native `required` and `aria-required` both count. */
export async function findMissingRequired(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const text = (node: Element | null) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
        const nameOf = (el: Element): string => {
            const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
            const labelledBy = ids.map((id) => text(document.getElementById(id))).join(' ').trim();
            if (labelledBy) return labelledBy;
            const aria = el.getAttribute('aria-label');
            if (aria) return aria.trim();
            const labels = (el as HTMLInputElement).labels;
            if (labels && labels.length) return text(labels[0]);
            if (el.tagName === 'FIELDSET') return text(el.querySelector('legend'));
            return el.getAttribute('name') ?? '';
        };
        const clean = (s: string) => s.replace(/\*/g, '').replace(/\s+/g, ' ').trim();
        const missing: string[] = [];
        for (const group of Array.from(document.querySelectorAll('fieldset, [role=radiogroup]'))) {
            const radios = Array.from(group.querySelectorAll('input[type=radio], [role=radio]'));
            if (radios.length === 0) continue;
            const required =
                group.getAttribute('aria-required') === 'true' || radios.some((r) => (r as HTMLInputElement).required);
            if (!required) continue;
            const chosen = radios.some(
                (r) => (r as HTMLInputElement).checked === true || r.getAttribute('aria-checked') === 'true',
            );
            if (!chosen) missing.push(clean(nameOf(group)));
        }
        for (const el of Array.from(document.querySelectorAll('input, textarea, select'))) {
            const input = el as HTMLInputElement;
            if (['hidden', 'submit', 'button', 'image', 'reset', 'radio'].includes(input.type)) continue;
            const required = input.required || el.getAttribute('aria-required') === 'true';
            if (!required) continue;
            const empty = input.type === 'checkbox' ? !input.checked : !String(input.value ?? '').trim();
            if (empty) missing.push(clean(nameOf(el)));
        }
        return Array.from(new Set(missing)).filter(Boolean);
    });
}

/** Lists the form's questions for the inspect mode, so a planner knows what to fill. */
export async function listQuestions(page: Page): Promise<QuestionInfo[]> {
    return page.evaluate(() => {
        const text = (node: Element | null) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
        const clean = (s: string) => s.replace(/\*/g, '').replace(/\s+/g, ' ').trim();
        const nameOf = (el: Element): string => {
            const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
            const labelledBy = ids.map((id) => text(document.getElementById(id))).join(' ').trim();
            if (labelledBy) return labelledBy;
            const aria = el.getAttribute('aria-label');
            if (aria) return aria.trim();
            const labels = (el as HTMLInputElement).labels;
            if (labels && labels.length) return text(labels[0]);
            if (el.tagName === 'FIELDSET') return text(el.querySelector('legend'));
            return el.getAttribute('data-value') ?? el.getAttribute('name') ?? '';
        };
        const out: Array<{ label: string; kind: string; required: boolean; options?: string[] }> = [];
        const seen = new Set<Element>();
        const GROUPS = 'fieldset, [role=radiogroup], [role=group], [role=list]';
        for (const group of Array.from(document.querySelectorAll(GROUPS))) {
            // Only options whose nearest group is this one, so a page-wide list does not swallow every question.
            const own = (selector: string) => Array.from(group.querySelectorAll(selector)).filter((o) => o.closest(GROUPS) === group);
            const radios = own('input[type=radio], [role=radio]');
            const checks = own('input[type=checkbox], [role=checkbox]');
            if (radios.length === 0 && checks.length === 0) continue;
            const options = radios.length > 0 ? radios : checks;
            options.forEach((o) => seen.add(o));
            out.push({
                label: clean(nameOf(group)),
                kind: radios.length > 0 ? 'choice' : 'checkboxes',
                required:
                    group.getAttribute('aria-required') === 'true' || options.some((o) => (o as HTMLInputElement).required),
                options: options.map((o) => clean(nameOf(o) || text(o))),
            });
        }
        for (const el of Array.from(document.querySelectorAll('input, textarea, select, [role=textbox]'))) {
            if (seen.has(el)) continue;
            const input = el as HTMLInputElement;
            if (['hidden', 'submit', 'button', 'image', 'reset', 'radio'].includes(input.type)) continue;
            if (input.type === 'checkbox' && el.closest('fieldset, [role=group], [role=list]')) continue;
            const kind =
                el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'paragraph' : input.type === 'checkbox' ? 'checkbox' : 'text';
            out.push({
                label: clean(nameOf(el)),
                kind,
                required: input.required === true || el.getAttribute('aria-required') === 'true',
            });
        }
        return out.filter((q) => q.label).slice(0, 60);
    }) as Promise<QuestionInfo[]>;
}

/** The form's title: the first level-one heading, else the document title. */
export async function formTitle(page: Page): Promise<string | null> {
    return page.evaluate(() => {
        const heading = document.querySelector('h1, [role=heading][aria-level="1"]');
        const fromHeading = (heading?.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (fromHeading) return fromHeading;
        return document.title.trim() || null;
    });
}
