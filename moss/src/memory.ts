import { createHash } from 'node:crypto';

import { roundMs } from './events.js';
import { KIND, MossInputError, type MossDoc, type MossFilter, type MossHit, type MossRun } from './session.js';

export type MemoryType = 'reply' | 'pref';

/** The person value for items that hold for every partner. */
export const ANY_PARTNER = 'any';

/**
 * A consented memory item. A reply belongs to the partner who asked; a preference can hold for everyone. shareable
 * is true only when the person agreed that its text may be shown on screens; it defaults to false.
 */
export type MemoryItem =
    | { type: 'reply'; question: string; reply: string; partnerId: string; at?: number; shareable?: boolean }
    | { type: 'pref'; text: string; partnerId?: string; at?: number; shareable?: boolean };

export interface MemoryHit {
    id: string;
    type: MemoryType;
    /** The partner the item belongs to, or "any". Null if a hit came back without metadata. */
    partnerId: string | null;
    /** When it was confirmed or added, epoch milliseconds. */
    at: number | null;
    score: number;
    /** Memory text, for the planner on this laptop only: never in pipeline events, logs, SpacetimeDB or a screen. */
    text: string;
    /** The reply as it was spoken, for reply items. */
    reply: string | null;
    /** True only when the person marked this memory shareable. A hit without metadata counts as private. */
    shareable: boolean;
    /**
     * What a screen may show (the reply, or the preference text), set only for a shareable memory. Anything else is
     * shown as "Private memory" with its type (docs/ui.md).
     */
    sharedText: string | null;
}

export interface Recall {
    /** Memory hits at or above the score floor, in Moss's hybrid order. */
    hits: MemoryHit[];
    /** This partner's past replies, unique, in the same order: ready to read before any web search. */
    instant: string[];
    /** Moss's own timeTakenInMs for the query. */
    mossMs: number | null;
    wallMs: number;
}

export interface Affinity {
    optionId: string;
    /** The highest memory score at or above the floor, else 0. */
    score: number;
    /** Ids of the memory items behind the score. Content-free, fine for SpacetimeDB. */
    evidence: string[];
    mossMs: number | null;
}

export interface MemoryOptions {
    /** Hits below it are dropped. Sessions ignore minScore, so the floor is applied here. A starting guess: tune it. */
    scoreFloor?: number;
    recallTopK?: number;
    /** Moss hybrid weight: 1 is pure semantic, 0 pure keyword. Keyword-only scores every hit 0, so it is refused. */
    recallAlpha?: number;
    affinityTopK?: number;
    affinityAlpha?: number;
    now?: () => number;
}

export const MEMORY_DEFAULTS = {
    scoreFloor: 0.5,
    recallTopK: 8,
    recallAlpha: 0.7,
    affinityTopK: 3,
    affinityAlpha: 0.8,
} as const;

const LIMITS = { question: 600, reply: 400, text: 1000, partner: 100, query: 1000 };

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

function field(value: unknown, name: string, max: number): string {
    const clean = typeof value === 'string' ? oneLine(value) : '';
    if (!clean || clean.length > max) throw new MossInputError(`${name} must be 1 to ${max} characters of text.`);
    return clean;
}

function partner(value: unknown): string {
    const clean = typeof value === 'string' ? value.trim() : '';
    if (!clean || clean.length > LIMITS.partner || /[\u0000-\u001f]/.test(clean)) {
        throw new MossInputError(`partnerId must be 1 to ${LIMITS.partner} characters.`);
    }
    return clean;
}

function queryText(value: unknown): string {
    if (typeof value !== 'string') throw new MossInputError('The query must be text.');
    return oneLine(value).slice(0, LIMITS.query);
}

/** A stable id from the item itself, hashed so no memory text ends up in an id. */
function memoryId(type: MemoryType, person: string, body: string): string {
    return `mem:${type}:${sha256(JSON.stringify([type, person, body])).slice(0, 16)}`;
}

/**
 * The Moss document for one memory item. Every value in metadata is a string, as Moss requires, and every memory
 * document carries kind, type and person, since a filter condition never matches a document that lacks its field.
 * ts is epoch seconds, so Moss range filters compare it as a number.
 */
export function memoryDoc(item: MemoryItem, nowMs: number): MossDoc {
    const at = item.at ?? nowMs;
    if (!Number.isFinite(at)) throw new MossInputError('at must be a time in epoch milliseconds.');
    const ts = String(Math.floor(at / 1000));
    // Not part of the id, so changing the person's consent updates the same document.
    const shareable = item.shareable === true ? 'true' : 'false';
    if (item.type === 'reply') {
        const question = field(item.question, 'question', LIMITS.question);
        const reply = field(item.reply, 'reply', LIMITS.reply);
        const person = partner(item.partnerId);
        if (person === ANY_PARTNER) throw new MossInputError('A reply belongs to the partner who asked, not "any".');
        const text = `Q: ${question}\nA: ${reply}`;
        return {
            id: memoryId('reply', person, text),
            text,
            metadata: { kind: KIND.memory, source: 'memory', type: 'reply', person, ts, shareable },
            payload: JSON.stringify({ reply }),
        };
    }
    if (item.type === 'pref') {
        const text = field(item.text, 'text', LIMITS.text);
        const person = item.partnerId === undefined ? ANY_PARTNER : partner(item.partnerId);
        return {
            id: memoryId('pref', person, text),
            text,
            metadata: { kind: KIND.memory, source: 'memory', type: 'pref', person, ts, shareable },
        };
    }
    throw new MossInputError('type must be reply or pref.');
}

/** This partner's memory plus items for everyone. */
export function memoryFilter(partnerId: string): MossFilter {
    return {
        $and: [
            { field: 'kind', condition: { $eq: KIND.memory } },
            { field: 'person', condition: { $in: [partnerId, ANY_PARTNER] } },
        ],
    };
}

function typeOf(hit: MossHit): MemoryType | null {
    const type = hit.metadata?.type;
    if (type === 'reply' || type === 'pref') return type;
    // Whether JS session hits carry metadata back is typed but not yet run here, so fall back to the id.
    const match = /^mem:(reply|pref):/.exec(hit.id);
    return match ? (match[1] as MemoryType) : null;
}

/** The spoken reply: from the payload, or from the text when a hit comes back without one. */
function replyOf(hit: MossHit): string | null {
    if (hit.payload) {
        try {
            const parsed = JSON.parse(hit.payload) as { reply?: unknown };
            if (typeof parsed.reply === 'string') return parsed.reply;
        } catch {
            // Not ours or not JSON: read the reply from the text below.
        }
    }
    const at = hit.text.lastIndexOf('\nA: ');
    return at >= 0 ? hit.text.slice(at + 4) : null;
}

function toMemoryHit(hit: MossHit): MemoryHit | null {
    const type = typeOf(hit);
    if (!type) return null;
    const ts = Number(hit.metadata?.ts);
    const reply = type === 'reply' ? replyOf(hit) : null;
    const shareable = hit.metadata?.shareable === 'true';
    return {
        id: hit.id,
        type,
        partnerId: hit.metadata?.person ?? null,
        at: hit.metadata?.ts !== undefined && Number.isFinite(ts) ? ts * 1000 : null,
        score: hit.score,
        text: hit.text,
        reply,
        shareable,
        sharedText: shareable ? (type === 'reply' ? reply : hit.text) : null,
    };
}

function instantReplies(hits: MemoryHit[], partnerId: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const hit of hits) {
        if (hit.type !== 'reply' || !hit.reply) continue;
        if (hit.partnerId !== null && hit.partnerId !== partnerId) continue;
        const key = hit.reply.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(hit.reply);
    }
    return out;
}

function unit(value: number, name: string): number {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${name} must be from 0 to 1.`);
    return value;
}

function count(value: number, name: string): number {
    if (!Number.isInteger(value) || value < 1 || value > 50) throw new RangeError(`${name} must be a whole number from 1 to 50.`);
    return value;
}

function alpha(value: number, name: string): number {
    if (!Number.isFinite(value) || value <= 0 || value > 1) throw new RangeError(`${name} must be above 0 and at most 1.`);
    return value;
}

/** The person's own memory: past confirmed replies and preferences, recalled locally, written back on every confirm. */
export class MemoryStore {
    private readonly floor: number;
    private readonly recallTopK: number;
    private readonly recallAlpha: number;
    private readonly affinityTopK: number;
    private readonly affinityAlpha: number;
    private readonly now: () => number;

    constructor(
        private readonly run: MossRun,
        options: MemoryOptions = {},
    ) {
        this.floor = unit(options.scoreFloor ?? MEMORY_DEFAULTS.scoreFloor, 'scoreFloor');
        this.recallTopK = count(options.recallTopK ?? MEMORY_DEFAULTS.recallTopK, 'recallTopK');
        this.recallAlpha = alpha(options.recallAlpha ?? MEMORY_DEFAULTS.recallAlpha, 'recallAlpha');
        this.affinityTopK = count(options.affinityTopK ?? MEMORY_DEFAULTS.affinityTopK, 'affinityTopK');
        this.affinityAlpha = alpha(options.affinityAlpha ?? MEMORY_DEFAULTS.affinityAlpha, 'affinityAlpha');
        this.now = options.now ?? Date.now;
    }

    /** Adds consented items, such as preferences or earlier replies. The same item added twice is stored once. */
    async add(items: readonly MemoryItem[]): Promise<{ ids: string[]; added: number; updated: number }> {
        const docs = new Map<string, MossDoc>();
        for (const item of items) {
            const doc = memoryDoc(item, this.now());
            docs.set(doc.id, doc);
        }
        return this.run.op('memory add', async (session) => {
            const { added, updated } = docs.size > 0 ? await session.addDocs([...docs.values()]) : { added: 0, updated: 0 };
            return { value: { ids: [...docs.keys()], added, updated }, counts: { added, updated } };
        });
    }

    /** Memory for a question, the moment its text lands and before any web search. Local, a few milliseconds. */
    async recall(question: string, partnerId: string): Promise<Recall> {
        const query = queryText(question);
        const person = partner(partnerId);
        return this.run.op('memory recall', async (session) => {
            const started = performance.now();
            const result = await session.query(query, { topK: this.recallTopK, alpha: this.recallAlpha, filter: memoryFilter(person) });
            const wallMs = roundMs(performance.now() - started);
            const hits = result.docs
                .map((hit) => toMemoryHit(hit))
                .filter((hit): hit is MemoryHit => hit !== null && hit.score >= this.floor);
            const instant = instantReplies(hits, person);
            const mossMs = result.timeTakenInMs ?? null;
            return {
                value: { hits, instant, mossMs, wallMs },
                counts: { hits: hits.length, instant: instant.length, ...(mossMs !== null ? { mossMs } : {}) },
            };
        });
    }

    /**
     * Stores a reply the person confirmed, so the next question from this partner already knows it. It stays private
     * on screens unless shareable is true.
     */
    async writeBack(confirmed: {
        question: string;
        reply: string;
        partnerId: string;
        shareable?: boolean;
    }): Promise<{ id: string; added: number; updated: number }> {
        const now = this.now();
        const doc = memoryDoc(
            { type: 'reply', question: confirmed.question, reply: confirmed.reply, partnerId: confirmed.partnerId, at: now, shareable: confirmed.shareable },
            now,
        );
        return this.run.op('memory write back', async (session) => {
            const { added, updated } = await session.addDocs([doc]);
            return { value: { id: doc.id, added, updated }, counts: { added, updated } };
        });
    }

    /** How strongly this partner's memory backs each option: one local query per option. */
    async affinity(options: ReadonlyArray<{ id: string; text: string }>, partnerId: string): Promise<Affinity[]> {
        const person = partner(partnerId);
        const queries = options.map((option) => ({ optionId: option.id, query: queryText(option.text) }));
        if (queries.length === 0) return [];
        return this.run.op('memory affinity', async (session) => {
            const out: Affinity[] = [];
            let mossTotal: number | null = 0;
            for (const { optionId, query } of queries) {
                const result = await session.query(query, { topK: this.affinityTopK, alpha: this.affinityAlpha, filter: memoryFilter(person) });
                // Hits come back in hybrid order and score is not the sort key, so take the highest score, not the first.
                const strong = result.docs.filter((hit) => hit.score >= this.floor);
                const mossMs = result.timeTakenInMs ?? null;
                out.push({ optionId, score: Math.max(0, ...strong.map((hit) => hit.score)), evidence: strong.map((hit) => hit.id), mossMs });
                mossTotal = mossTotal !== null && mossMs !== null ? mossTotal + mossMs : null;
            }
            const mossMs = mossTotal === null ? null : roundMs(mossTotal);
            return { value: out, counts: { options: out.length, ...(mossMs !== null ? { mossMs } : {}) } };
        });
    }
}
