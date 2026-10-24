// Server side: list Cartesia library voices to audition and swap ids. Owned voices (clones) are never returned.

import { buildRequest, okJson, send, type FetchLike } from './http.js';

export type Gender = 'masculine' | 'feminine' | 'gender_neutral';

export interface LibraryVoice {
    id: string;
    name: string;
    tagline: string;
    description: string;
    gender: string | null;
    accents: { accent: string; locale: string; isNative: boolean }[];
    /** Listen in the Playground before switching. */
    playgroundUrl: string;
}

interface RawVoice {
    id?: unknown;
    name?: unknown;
    tagline?: unknown;
    description?: unknown;
    gender?: unknown;
    accents?: unknown;
    is_owner?: unknown;
    is_pro?: unknown;
    status?: unknown;
}

/** A Cartesia library voice: not owned by our organization, not a Pro clone, and active. */
export function isLibraryVoice(raw: RawVoice): boolean {
    return raw.is_owner === false && raw.is_pro !== true && (raw.status === undefined || raw.status === 'active');
}

function toVoice(raw: RawVoice): LibraryVoice | null {
    if (typeof raw.id !== 'string' || typeof raw.name !== 'string') return null;
    const accents = Array.isArray(raw.accents)
        ? raw.accents.flatMap((item: unknown) => {
              if (!item || typeof item !== 'object') return [];
              const a = item as Record<string, unknown>;
              return typeof a.accent === 'string' && typeof a.locale === 'string'
                  ? [{ accent: a.accent, locale: a.locale, isNative: a.is_native === true }]
                  : [];
          })
        : [];
    return {
        id: raw.id,
        name: raw.name,
        tagline: typeof raw.tagline === 'string' ? raw.tagline : '',
        description: typeof raw.description === 'string' ? raw.description : '',
        gender: typeof raw.gender === 'string' ? raw.gender : null,
        accents,
        playgroundUrl: `https://play.cartesia.ai/voices/${encodeURIComponent(raw.id)}`,
    };
}

/** GET /voices, following `next_page` as `starting_after`, keeping library voices only. */
export async function listLibraryVoices(options: {
    apiKey: string;
    q?: string;
    language?: string;
    gender?: Gender;
    limit?: number;
    maxPages?: number;
    fetch?: FetchLike;
}): Promise<LibraryVoice[]> {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('limit is 1 to 100.');
    const maxPages = options.maxPages ?? 3;
    const voices: LibraryVoice[] = [];
    let after: string | null = null;
    for (let page = 0; page < maxPages; page++) {
        const query: [string, string][] = [['limit', String(limit)]];
        if (options.q) query.push(['q', options.q]);
        if (options.language) query.push(['language', options.language]);
        if (options.gender) query.push(['gender', options.gender]);
        if (after) query.push(['starting_after', after]);
        const data = okJson<{ data?: unknown; has_more?: unknown; next_page?: unknown }>(
            await send(buildRequest(options.apiKey, 'GET', '/voices', { query }), options.fetch),
        );
        const rows = Array.isArray(data.data) ? (data.data as RawVoice[]) : [];
        for (const raw of rows) {
            if (!raw || typeof raw !== 'object' || !isLibraryVoice(raw)) continue;
            const voice = toVoice(raw);
            if (voice) voices.push(voice);
        }
        if (data.has_more !== true || typeof data.next_page !== 'string') break;
        after = data.next_page;
    }
    return voices;
}

/** Confirms each id is a library voice, using the search that matches voice ids. */
export async function checkLibraryVoices(options: {
    apiKey: string;
    ids: readonly string[];
    fetch?: FetchLike;
}): Promise<{ id: string; ok: boolean; name?: string; reason?: string }[]> {
    const results: { id: string; ok: boolean; name?: string; reason?: string }[] = [];
    for (const id of options.ids) {
        const data = okJson<{ data?: unknown }>(
            await send(buildRequest(options.apiKey, 'GET', '/voices', { query: [['q', id], ['limit', '10']] }), options.fetch),
        );
        const rows = Array.isArray(data.data) ? (data.data as RawVoice[]) : [];
        const match = rows.find((raw) => raw && typeof raw === 'object' && raw.id === id);
        if (!match) results.push({ id, ok: false, reason: 'not found' });
        else if (!isLibraryVoice(match)) results.push({ id, ok: false, reason: 'not a library voice' });
        else results.push({ id, ok: true, name: typeof match.name === 'string' ? match.name : '' });
    }
    return results;
}
