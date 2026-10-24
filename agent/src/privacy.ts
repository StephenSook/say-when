// What content may leave the sidecar, and in what shape. Payloads go only to the private `pipeline_payload`
// table (docs/spacetime.md 2.9); the board shows them only while the room's sharing toggle is on. Even there:
//
// - A memory hit carries its id, category, score and saved time. Its text goes out only as `sharedText`, and only
//   when the person marked that memory shareable (moss/README.md). Private memory text never leaves this process
//   except inside the planner prompt (the Anthropic API call that writes the options).
// - Web and place excerpts are cut to 300 characters, with anything that looks like a phone number (seven digits or
//   more), key or token masked. A place's phone number is dropped. The Cartesia package masks every number in call
//   transcripts, since a phone number can be spoken in any shape there; page facts are different, and opening
//   hours, prices and street numbers stay readable here because the planner needs them.
// - The question, option texts, read-back values, form values and contact names never go into a pipeline event.

import type { MemoryHit, WebHit } from '@say-when/moss';
import type { SearchRow } from '@say-when/apify-client';

import type { SourceRef } from './types.js';

export const EXCERPT_CHARS = 300;

const API_KEY = /\b(?:sk-ant-|sk_car_|apify_api_)[A-Za-z0-9_-]+/g;
const TOKEN_PARAM = /\b(access_token|api_key|apikey|token|key)=[^&\s"']+/gi;
const JWT_LIKE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
/** Invisible characters (zero-width spaces and joiners, soft hyphens, direction marks): removed before matching. */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
/**
 * A run of digits in any script with the separators phone numbers use: spaces of every kind, every character with the
 * Unicode Dash property (minus and swung dash included), dots, slashes, parentheses and a middle dot. Masked when it
 * holds seven digits or more.
 */
const DIGIT_RUN = /[+\uFF0B]?[(\uFF08]?\p{Nd}[\p{Nd}\p{Zs}\p{Dash}\s().\/\u00B7\uFF08\uFF09\uFF0E\uFF0F]{5,}\p{Nd}/gu;
const DIGIT = /\p{Nd}/gu;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Masks phone numbers, keys and tokens in page text; everything else stays as written. */
export function maskPageText(text: string): string {
    return String(text)
        .normalize('NFKC')
        .replace(INVISIBLE, '')
        .replace(API_KEY, '[key]')
        .replace(TOKEN_PARAM, '$1=[token]')
        .replace(JWT_LIKE, '[token]')
        .replace(DIGIT_RUN, (run) => {
            const trimmed = run.trim();
            if ((trimmed.match(DIGIT) ?? []).length < 7 || ISO_DATE.test(trimmed)) return run;
            // Keep the spacing around the number so the sentence still reads.
            return run.replace(trimmed, '[number]');
        });
}

/** Cuts text to `max` characters at a word when it can, and masks phone numbers, keys and tokens. */
export function excerpt(text: string, max = EXCERPT_CHARS): string {
    const masked = maskPageText(text).replace(/\s+/g, ' ').trim();
    if (masked.length <= max) return masked;
    const cut = masked.slice(0, max);
    const space = cut.lastIndexOf(' ');
    return (space > max - 60 ? cut.slice(0, space) : cut).trimEnd();
}

/** A search row for the Live data screen (web/lib/data/types.ts SearchRow), without the place phone number. */
export interface PayloadSearchRow {
    id: string;
    source: 'web' | 'maps';
    title: string;
    text: string;
    url?: string;
    placeId?: string;
    fetchedAt: string;
    rank?: number;
    facts?: {
        rating?: number;
        reviews?: number;
        openNow?: boolean;
        wheelchairEntrance?: true;
        address?: string;
        category?: string;
    };
}

export function searchRowPayload(row: SearchRow): PayloadSearchRow {
    const out: PayloadSearchRow = {
        id: row.id,
        source: row.source,
        title: excerpt(row.title, 200),
        text: excerpt(row.text),
        fetchedAt: row.fetchedAt,
    };
    if (row.url) out.url = row.url;
    if (row.placeId) out.placeId = row.placeId;
    if (typeof row.rank === 'number') out.rank = row.rank;
    if (row.facts) {
        const { rating, reviews, openNow, wheelchairEntrance, address, category } = row.facts;
        const facts: NonNullable<PayloadSearchRow['facts']> = {};
        if (rating !== undefined) facts.rating = rating;
        if (reviews !== undefined) facts.reviews = reviews;
        if (openNow !== undefined) facts.openNow = openNow;
        if (wheelchairEntrance === true) facts.wheelchairEntrance = true;
        if (address) facts.address = excerpt(address, 200);
        if (category) facts.category = category;
        out.facts = facts;
    }
    return out;
}

/** A Moss hit for the Live data screen (web/lib/data/types.ts MossHit). */
export interface PayloadHit {
    id: string;
    origin: 'memory' | 'web';
    memoryType?: 'reply' | 'pref';
    sharedText?: string;
    score: number;
    text?: string;
    source?: SourceRef;
    savedAt?: number;
}

const score = (value: number): number => Math.round(value * 1000) / 1000;

/** Never the memory's text: only `sharedText`, and only for a memory the person marked shareable. */
export function memoryHitPayload(hit: MemoryHit): PayloadHit {
    const out: PayloadHit = { id: hit.id, origin: 'memory', memoryType: hit.type, score: score(hit.score) };
    if (hit.at !== null) out.savedAt = hit.at;
    if (hit.shareable && typeof hit.sharedText === 'string' && hit.sharedText !== '') out.sharedText = excerpt(hit.sharedText);
    return out;
}

export function webHitPayload(hit: WebHit): PayloadHit {
    const out: PayloadHit = { id: hit.id, origin: 'web', score: score(hit.score), text: excerpt(hit.text) };
    const source = sourceRefOf(hit.row);
    if (source) out.source = source;
    return out;
}

/** The Option row's source entry for a search row: `{ source, url or placeId, fetchedAt }`. No page text. */
export function sourceRefOf(row: Pick<SearchRow, 'source' | 'url' | 'placeId' | 'fetchedAt'> | null): SourceRef | null {
    if (!row) return null;
    return {
        source: row.source,
        url: row.url ? row.url : undefined,
        placeId: row.placeId ? row.placeId : undefined,
        fetchedAt: String(row.fetchedAt),
    };
}
