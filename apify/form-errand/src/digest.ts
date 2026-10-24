import { createHash } from 'node:crypto';

import type { ReadBackItem } from './types.js';

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export const normalizeText = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * The URL identity used for digests and the duplicate ledger. Query strings and fragments are dropped,
 * so "?usp=sf_link" and similar tracking suffixes do not change the digest. "demo" stays "demo".
 */
export function canonicalFormUrl(formUrl: string): string {
    if (formUrl === 'demo') return 'demo';
    try {
        const url = new URL(formUrl);
        return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    } catch {
        return formUrl.trim();
    }
}

/**
 * 16 hex characters over the form identity and the label and value pairs read back off the page.
 * Order of fields does not matter; whitespace differences do not matter; any change to a value does.
 */
export function computeDigest(formUrl: string, items: ReadBackItem[]): string {
    const pairs = items
        .map((item) => [normalizeText(item.label), normalizeText(item.value)] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    return sha256(JSON.stringify([canonicalFormUrl(formUrl), pairs])).slice(0, 16);
}

const MAX_SPOKEN_WORDS = 25;

/** Shortens a long answer for speech. The dashboard shows the full value. */
export function spokenValue(value: string): string {
    const words = normalizeText(value).split(' ').filter(Boolean);
    if (words.length === 0) return 'blank';
    if (words.length <= MAX_SPOKEN_WORDS) return words.join(' ');
    const rest = words.length - MAX_SPOKEN_WORDS;
    return `${words.slice(0, MAX_SPOKEN_WORDS).join(' ')}, and ${rest} more words on screen`;
}

/**
 * The sentence the earpiece reads before the person confirms. Built from values read back off the page,
 * so the person hears what the page holds. A disclosure suffix is announced, not read word for word.
 */
export function buildReadBackText(
    formTitle: string | null,
    items: ReadBackItem[],
    options: { disclosureLabel?: string; disclosureText?: string } = {},
): string {
    const parts = items.map((item) => {
        let value = item.value;
        let note = '';
        if (options.disclosureText && item.label === options.disclosureLabel && value.endsWith(options.disclosureText)) {
            value = value.slice(0, value.length - options.disclosureText.length);
            note = ', plus a note saying how it was sent';
        }
        const spoken = spokenValue(value).replace(/[\s.,;:!?]+$/, '');
        return `${normalizeText(item.label).replace(/[\s*:?]+$/, '')}: ${spoken}${note}.`;
    });
    const to = formTitle ? `To ${normalizeText(formTitle)}.` : 'To the form.';
    return [to, ...parts, 'Confirm to send.'].join(' ');
}
