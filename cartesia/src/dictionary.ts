// Server side: one private pronunciation dictionary for the household, built from place and household names.
// The same names become Ink-2 keyterms, so a hard name is heard right and said right.

import { emit, type OnEvent } from './events.js';
import { buildRequest, okJson, send, type FetchLike } from './http.js';
import { buildKeyterms } from './keyterms.js';

export interface LexiconEntry {
    /** The text as written, for example a family name or a street. */
    text: string;
    /** What Sonic says instead: IPA between << and >>, or a sounds-like spelling such as "shi-VAWN". */
    pronunciation: string;
    /** Default false: match every capitalization (Sonic 3.6). */
    caseSensitive?: boolean;
}

export interface NameEntry {
    name: string;
    /** How the family says it. Without one, the name is only a keyterm. Never guess this. */
    sayAs?: string;
    caseSensitive?: boolean;
}

/**
 * The 2026-08-14 reference names the item field `pronunciation`. SDK 4.2.0 types it `alias`, and the older reference
 * calls `alias` deprecated but accepted. We send `pronunciation` and check the echo; switch only if the echo says so.
 */
export type ItemField = 'pronunciation' | 'alias';

export interface DictItem {
    text: string;
    pronunciation?: string;
    alias?: string;
    case_sensitive: boolean;
}

export class LexiconError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LexiconError';
    }
}

export class DictionaryEchoError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DictionaryEchoError';
    }
}

// Our own sanity limits. Cartesia publishes no limits for dictionaries.
const MAX_ENTRIES = 500;
const MAX_TEXT = 100;
const MAX_PRONUNCIATION = 200;

function sentenceStartOf(lower: string, other: string): boolean {
    return lower === lower.toLowerCase() && other === lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** The custom pronunciations guide's collision rules; the API rejects entries that would collide. */
export function collides(a: LexiconEntry, b: LexiconEntry): boolean {
    if (a.text.toLowerCase() !== b.text.toLowerCase()) return false;
    if (!a.caseSensitive || !b.caseSensitive) return true;
    if (a.text === b.text) return true;
    // A lowercase case-sensitive key still matches sentence-start capitalization: cat and Cat collide.
    return sentenceStartOf(a.text, b.text) || sentenceStartOf(b.text, a.text);
}

/** Trims and checks entries. Errors refer to entries by position, never by name. */
export function checkLexicon(entries: readonly LexiconEntry[]): LexiconEntry[] {
    if (entries.length > MAX_ENTRIES) throw new LexiconError(`At most ${MAX_ENTRIES} entries.`);
    const clean = entries.map((entry, i) => {
        const text = String(entry.text ?? '').replace(/\s+/g, ' ').trim();
        const pronunciation = String(entry.pronunciation ?? '').trim();
        if (!text || text.length > MAX_TEXT) throw new LexiconError(`Entry ${i} needs text of 1 to ${MAX_TEXT} characters.`);
        if (!pronunciation || pronunciation.length > MAX_PRONUNCIATION) {
            throw new LexiconError(`Entry ${i} needs a pronunciation of 1 to ${MAX_PRONUNCIATION} characters.`);
        }
        if (pronunciation.startsWith('<<') !== pronunciation.endsWith('>>')) {
            throw new LexiconError(`Entry ${i}: IPA goes between << and >>, with | between symbols.`);
        }
        return { text, pronunciation, caseSensitive: entry.caseSensitive === true };
    });
    for (let i = 0; i < clean.length; i++) {
        for (let j = i + 1; j < clean.length; j++) {
            if (collides(clean[i]!, clean[j]!)) throw new LexiconError(`Entries ${i} and ${j} would collide.`);
        }
    }
    return clean;
}

export function dictionaryItems(entries: readonly LexiconEntry[], field: ItemField = 'pronunciation'): DictItem[] {
    return entries.map((entry) => ({ text: entry.text, [field]: entry.pronunciation, case_sensitive: entry.caseSensitive === true }));
}

/**
 * Turns place names and household names into dictionary entries (only where someone wrote down how to say them)
 * and keyterms (every name). Household names go first, since they matter most.
 */
export function lexiconFromNames(input: { household?: readonly NameEntry[]; places?: readonly NameEntry[] }): {
    entries: LexiconEntry[];
    keyterms: string[];
    droppedKeyterms: number;
} {
    const all = [...(input.household ?? []), ...(input.places ?? [])];
    const entries: LexiconEntry[] = [];
    for (const name of all) {
        if (name.sayAs && name.sayAs.trim()) {
            entries.push({ text: name.name, pronunciation: name.sayAs, caseSensitive: name.caseSensitive === true });
        }
    }
    const { keyterms, dropped } = buildKeyterms(all.map((name) => name.name));
    return { entries, keyterms, droppedKeyterms: dropped };
}

function checkEcho(sent: readonly LexiconEntry[], echoed: unknown, field: ItemField): void {
    if (!Array.isArray(echoed)) throw new DictionaryEchoError('The dictionary response did not list its items.');
    const said = new Map<string, Set<string>>();
    for (const item of echoed) {
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        if (typeof record.text !== 'string') continue;
        const value = typeof record.pronunciation === 'string' ? record.pronunciation : typeof record.alias === 'string' ? record.alias : null;
        if (value === null) continue;
        const set = said.get(record.text) ?? new Set<string>();
        set.add(value);
        said.set(record.text, set);
    }
    const missing = sent.filter((entry) => !said.get(entry.text)?.has(entry.pronunciation)).length;
    if (missing > 0) {
        const other = field === 'pronunciation' ? 'alias' : 'pronunciation';
        throw new DictionaryEchoError(`${missing} of ${sent.length} entries came back without their pronunciation. Try field "${other}".`);
    }
}

/**
 * Creates the private dictionary (POST /pronunciation-dicts/) or replaces its items (PATCH /pronunciation-dicts/{id}).
 * The docs do not say whether PATCH merges or replaces, so the full list is always sent. Returns the id to pass as
 * pronunciation_dict_id on every TTS request.
 */
export async function syncPronunciationDictionary(options: {
    apiKey: string;
    name: string;
    entries: readonly LexiconEntry[];
    dictionaryId?: string;
    field?: ItemField;
    fetch?: FetchLike;
    onEvent?: OnEvent;
    now?: () => number;
}): Promise<{ id: string; created: boolean; itemCount: number }> {
    const field = options.field ?? 'pronunciation';
    const entries = checkLexicon(options.entries);
    const items = dictionaryItems(entries, field);
    const name = options.name.trim();
    if (!options.dictionaryId && !name) throw new LexiconError('A new dictionary needs a name.');
    const request = options.dictionaryId
        ? buildRequest(options.apiKey, 'PATCH', `/pronunciation-dicts/${encodeURIComponent(options.dictionaryId)}`, { body: { items } })
        : buildRequest(options.apiKey, 'POST', '/pronunciation-dicts/', { body: { name, items, access: 'private' } });
    const now = options.now ?? Date.now;
    const started = now();
    const data = okJson<{ id?: unknown; items?: unknown }>(await send(request, options.fetch));
    if (typeof data.id !== 'string' || data.id === '') throw new DictionaryEchoError('The dictionary response had no id.');
    checkEcho(entries, data.items, field);
    emit(options.onEvent, {
        stage: 'speak',
        status: 'ok',
        detail: options.dictionaryId ? 'dictionary updated' : 'dictionary created',
        ms: now() - started,
        counts: { entries: items.length },
    });
    return { id: data.id, created: !options.dictionaryId, itemCount: items.length };
}
