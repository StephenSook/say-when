import { createHash } from 'node:crypto';

import { roundMs } from './events.js';
import { KIND, MossInputError, MossRunError, type MossDoc, type MossFilter, type MossRun } from './session.js';

/** Facts on a Google Maps row, as in apify/client. There wheelchairEntrance is only ever true; boolean here accepts it. */
export interface PlaceFacts {
    rating?: number;
    reviews?: number;
    openNow?: boolean;
    wheelchairEntrance?: boolean;
    address?: string;
    phone?: string;
    category?: string;
}

/** One search row. Structurally the same as SearchRow in apify/client, defined here so this package does not depend on it. */
export interface SearchRow {
    id: string;
    source: 'web' | 'maps';
    title: string;
    text: string;
    url?: string;
    placeId?: string;
    location?: { lat: number; lng: number };
    fetchedAt: string;
    rank?: number;
    facts?: PlaceFacts;
}

export interface ChunkOptions {
    /** Longest chunk, title included, 200 to 2,000. Moss's own tip: keep chunks under about 1,200 characters. */
    maxChars?: number;
    /** Each chunk repeats this much of the one before, so a fact cut at a boundary is still found. */
    overlapMin?: number;
    overlapMax?: number;
}

export const CHUNK_DEFAULTS = { maxChars: 1200, overlapMin: 150, overlapMax: 200 } as const;

export interface WebOptions extends ChunkOptions {
    /**
     * Chunks kept per row. 20 covers the roughly 20,000 characters apify/client keeps of a page. Embedding speed on
     * the laptop is not measured yet, so a longer page stops here.
     */
    maxChunksPerRow?: number;
    searchTopK?: number;
    searchAlpha?: number;
}

const DEFAULT_MAX_CHUNKS = 20;
const TITLE_MAX = 200;
const ID_MAX = 200;
const QUERY_MAX = 1000;
const FACT_KEYS = ['rating', 'reviews', 'openNow', 'wheelchairEntrance', 'address', 'phone', 'category'] as const satisfies readonly (keyof PlaceFacts)[];

const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Light cleanup for page markdown: images out, links keep their words, heading and list markers dropped. */
export function cleanMarkdown(text: string): string {
    return text
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
        .replace(/^[ \t]*[-*+][ \t]+/gm, '');
}

/** Cuts a sentence that is too long between words. A single word longer than max, such as a long link, is cut too. */
function betweenWords(sentence: string, max: number): string[] {
    if (!Number.isInteger(max) || max < 1) throw new RangeError('A piece must hold at least one character.');
    const pieces: string[] = [];
    let current = '';
    for (const word of sentence.split(' ')) {
        for (let i = 0; i < word.length; i += max) {
            const piece = word.slice(i, i + max);
            const next = current ? `${current} ${piece}` : piece;
            if (next.length <= max) {
                current = next;
            } else {
                pieces.push(current);
                current = piece;
            }
        }
    }
    if (current) pieces.push(current);
    return pieces;
}

/**
 * Sentences from the runtime's own sentence breaker, which also breaks at line ends. Only a sentence longer than a
 * whole chunk is cut, into pieces short enough to leave room for an overlap in front of them.
 */
function sentences(text: string, budget: number, piece: number): string[] {
    const out: string[] = [];
    for (const { segment } of segmenter.segment(text)) {
        const sentence = collapse(segment);
        if (!sentence) continue;
        if (sentence.length <= budget) out.push(sentence);
        else out.push(...betweenWords(sentence, piece));
    }
    return out;
}

/** The end of a chunk to repeat at the start of the next: whole sentences when they fit the window, else a cut at a space. */
function overlapTail(parts: string[], min: number, max: number): string {
    const body = parts.join(' ');
    if (body.length <= min) return '';
    let start = body.length;
    for (let i = parts.length - 1; i >= 0; i -= 1) {
        start -= parts[i].length;
        const length = body.length - start;
        if (length > max) break;
        if (length >= min) return body.slice(start);
        start -= 1; // the space before this part
    }
    const space = body.indexOf(' ', body.length - max - 1);
    if (space >= 0 && body.length - space - 1 >= min) return body.slice(space + 1);
    return body.slice(body.length - max);
}

/**
 * Splits a page for Moss, whose JS SDK has no chunker. Chunks end at sentence boundaries, stay at or under maxChars
 * with the page title on top, and repeat the last 150 to 200 characters of the chunk before. A sentence too long to
 * share a chunk with that overlap starts its chunk without one; only a sentence longer than a whole chunk is cut.
 */
export function chunkText(title: string, text: string, options: ChunkOptions = {}): string[] {
    const maxChars = options.maxChars ?? CHUNK_DEFAULTS.maxChars;
    const overlapMin = options.overlapMin ?? CHUNK_DEFAULTS.overlapMin;
    const overlapMax = options.overlapMax ?? CHUNK_DEFAULTS.overlapMax;
    // The same ranges as Moss's own parse pipeline: chunks of 200 to 2,000, overlap up to half a chunk.
    if (!Number.isInteger(maxChars) || maxChars < 200 || maxChars > 2000) throw new RangeError('maxChars must be a whole number from 200 to 2000.');
    if (!Number.isInteger(overlapMin) || !Number.isInteger(overlapMax) || overlapMin < 0 || overlapMax < overlapMin || overlapMax > maxChars / 2) {
        throw new RangeError('overlapMin and overlapMax must be whole numbers with 0 <= overlapMin <= overlapMax <= maxChars / 2.');
    }
    const head = collapse(title).slice(0, Math.min(TITLE_MAX, Math.floor(maxChars / 4)));
    const prefix = head ? `${head}\n\n` : '';
    const budget = maxChars - prefix.length;
    const piece = budget - overlapMax - 1;
    const units = sentences(cleanMarkdown(text), budget, piece);
    if (units.length === 0) return head ? [head] : [];
    const chunks: string[] = [];
    let parts: string[] = [];
    let size = 0;
    for (const unit of units) {
        const grown = size === 0 ? unit.length : size + 1 + unit.length;
        if (grown <= budget) {
            parts.push(unit);
            size = grown;
            continue;
        }
        chunks.push(prefix + parts.join(' '));
        const overlap = overlapTail(parts, overlapMin, overlapMax);
        const fits = overlap !== '' && overlap.length + 1 + unit.length <= budget;
        parts = fits ? [overlap, unit] : [unit];
        size = fits ? overlap.length + 1 + unit.length : unit.length;
    }
    chunks.push(prefix + parts.join(' '));
    return chunks;
}

const coord = (value: number): string => String(Number(value.toFixed(6)));

function latLng(location: { lat: number; lng: number } | null | undefined): string | null {
    if (!location) return null;
    const { lat, lng } = location;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return `${coord(lat)},${coord(lng)}`;
}

/** The $near value Moss expects, "lat,lng,radiusMeters" (docs.moss.dev, JS metadata filtering). */
export function nearValue(near: { lat: number; lng: number; radiusMeters: number }): string {
    const point = latLng(near);
    if (!point || !Number.isFinite(near.radiusMeters) || near.radiusMeters <= 0 || near.radiusMeters > 100_000) {
        throw new MossInputError('near needs a valid lat and lng and a radius from 1 to 100000 meters.');
    }
    return `${point},${Math.max(1, Math.round(near.radiusMeters))}`;
}

function checkQuestionId(value: unknown): string {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!id || id.length > 100 || /[\u0000-\u001f]/.test(id)) throw new MossInputError('questionId must be 1 to 100 characters.');
    return id;
}

function validRow(row: unknown): row is SearchRow {
    if (!row || typeof row !== 'object') return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.id === 'string' &&
        r.id.length > 0 &&
        r.id.length <= ID_MAX &&
        (r.source === 'web' || r.source === 'maps') &&
        typeof r.title === 'string' &&
        typeof r.text === 'string' &&
        // The client's fetchedAt type is not settled yet, so an epoch number is accepted and stored as text.
        (typeof r.fetchedAt === 'string' || (typeof r.fetchedAt === 'number' && Number.isFinite(r.fetchedAt)))
    );
}

/** Hashed, so caller ids never show up in document ids and no two question and row pairs can share one. */
const parentIdFor = (questionId: string, rowId: string): string => `web:${sha256(JSON.stringify([questionId, rowId])).slice(0, 16)}`;

/** Every value a string, as Moss metadata requires. Booleans become "true" or "false"; location becomes "lat,lng". */
export function rowMetadata(questionId: string, row: SearchRow): Record<string, string> {
    const meta: Record<string, string> = {
        kind: KIND.web,
        source: row.source,
        questionId,
        rowId: row.id,
        parentId: parentIdFor(questionId, row.id),
        title: collapse(row.title).slice(0, TITLE_MAX),
        fetchedAt: String(row.fetchedAt),
    };
    if (typeof row.url === 'string' && row.url) meta.url = row.url;
    if (typeof row.placeId === 'string' && row.placeId) meta.placeId = row.placeId;
    if (typeof row.rank === 'number' && Number.isFinite(row.rank)) meta.rank = String(row.rank);
    const location = latLng(row.location);
    if (location) meta.location = location;
    for (const key of FACT_KEYS) {
        const value = row.facts?.[key];
        if (value !== undefined && value !== null) meta[key] = String(value);
    }
    return meta;
}

const trimEnd = (text: string): string => collapse(text).replace(/[.\s]+$/, '');

/**
 * Place facts as plain sentences, worded like apify/client's own place summary. That client already writes them into
 * a maps row's text, so this only runs for a place row that arrives with no text.
 */
function placeSentence(facts: PlaceFacts | undefined): string {
    if (!facts) return '';
    const parts: string[] = [];
    if (facts.category) parts.push(`${trimEnd(facts.category)}.`);
    if (facts.address) parts.push(`${trimEnd(facts.address)}.`);
    if (typeof facts.rating === 'number') {
        parts.push(typeof facts.reviews === 'number' ? `Rated ${facts.rating} from ${facts.reviews} reviews.` : `Rated ${facts.rating}.`);
    }
    if (facts.openNow === true) parts.push('Open when checked.');
    else if (facts.openNow === false) parts.push('Closed when checked.');
    if (facts.wheelchairEntrance === true) parts.push('Wheelchair accessible entrance.');
    if (facts.phone) parts.push(`Phone ${trimEnd(facts.phone)}.`);
    return parts.join(' ');
}

/** The Moss documents for one row: its chunks, each with the row's metadata and its chunk number. */
export function webDocsFor(questionId: string, row: SearchRow, options: WebOptions = {}): { docs: MossDoc[]; truncated: boolean } {
    const maxChunks = options.maxChunksPerRow ?? DEFAULT_MAX_CHUNKS;
    const maxChars = options.maxChars ?? CHUNK_DEFAULTS.maxChars;
    const full = row.source === 'maps' && !collapse(row.text) ? placeSentence(row.facts) : row.text;
    // Bounds the sentence breaker's work on very long pages; whatever is past this would be dropped anyway.
    const limit = maxChunks * maxChars * 2;
    const chunks = chunkText(row.title, full.slice(0, limit), options);
    const metadata = rowMetadata(questionId, row);
    return {
        docs: chunks.slice(0, maxChunks).map((text, n) => ({ id: `${metadata.parentId}#${n}`, text, metadata: { ...metadata, chunk: String(n) } })),
        truncated: full.length > limit || chunks.length > maxChunks,
    };
}

export interface IndexResult {
    rows: number;
    chunks: number;
    added: number;
    updated: number;
    /** Chunks an earlier index of the same row had that this one no longer fills, deleted. */
    removed: number;
    /** Rows left out because they were malformed or repeated an id. */
    skipped: number;
    /** Rows cut at maxChunksPerRow. */
    truncated: number;
    /** Wall time of the add: local embedding, no network. */
    indexMs: number;
}

export interface WebHit {
    id: string;
    questionId: string;
    score: number;
    /** The chunk text, title first. Public web text. */
    text: string;
    /** The row this chunk came from, as it was indexed. */
    row: SearchRow | null;
}

export interface WebSearch {
    hits: WebHit[];
    /** Moss's own timeTakenInMs for the query. */
    mossMs: number | null;
    wallMs: number;
}

export interface WebSearchOptions {
    topK?: number;
    alpha?: number;
    source?: 'web' | 'maps';
    /** Only rows within radiusMeters of this point, by their location ($near). */
    near?: { lat: number; lng: number; radiusMeters: number };
}

/** The entry an option row's sources list wants, { source, url or placeId, fetchedAt } (PLAN.md). No page text. */
export function sourceOf(hit: WebHit): { source: 'web' | 'maps'; url?: string; placeId?: string; fetchedAt: string } | null {
    const row = hit.row;
    if (!row) return null;
    return {
        source: row.source,
        ...(typeof row.url === 'string' && row.url ? { url: row.url } : {}),
        ...(typeof row.placeId === 'string' && row.placeId ? { placeId: row.placeId } : {}),
        fetchedAt: String(row.fetchedAt),
    };
}

/** A copy of the fields this package reads, so a caller changing its row later cannot change what was recorded. */
function copyRow(row: SearchRow): SearchRow {
    const copy: SearchRow = { id: row.id, source: row.source, title: row.title, text: row.text, fetchedAt: row.fetchedAt };
    if (row.url !== undefined) copy.url = row.url;
    if (row.placeId !== undefined) copy.placeId = row.placeId;
    if (row.location) copy.location = { lat: row.location.lat, lng: row.location.lng };
    if (row.rank !== undefined) copy.rank = row.rank;
    if (row.facts) copy.facts = { ...row.facts };
    return copy;
}

interface Owner {
    questionId: string;
    parentId: string;
    row: SearchRow;
}

/** The current question's web passages and places, indexed on this laptop and deleted once the question is answered. */
export class WebIndex {
    private readonly owners = new Map<string, Owner>();
    private readonly byQuestion = new Map<string, Set<string>>();
    private readonly byParent = new Map<string, Set<string>>();
    private readonly queues = new Map<string, Promise<void>>();
    private generation = 0;

    constructor(
        private readonly run: MossRun,
        private readonly options: WebOptions = {},
    ) {
        // Bad options fail here rather than on the first question.
        chunkText('Check', 'Check.', options);
        const maxChunks = options.maxChunksPerRow ?? DEFAULT_MAX_CHUNKS;
        if (!Number.isInteger(maxChunks) || maxChunks < 1 || maxChunks > 100) throw new RangeError('maxChunksPerRow must be a whole number from 1 to 100.');
        const topK = options.searchTopK;
        if (topK !== undefined && (!Number.isInteger(topK) || topK < 1 || topK > 50)) throw new RangeError('searchTopK must be a whole number from 1 to 50.');
        const alpha = options.searchAlpha;
        if (alpha !== undefined && (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1)) throw new RangeError('searchAlpha must be above 0 and at most 1.');
    }

    /** Chunks the rows and adds them to the session under this question. Index and forget for one question run in turn. */
    async index(questionId: string, rows: readonly SearchRow[]): Promise<IndexResult> {
        const qid = checkQuestionId(questionId);
        this.run.assertOpen();
        this.sync();
        const generation = this.generation;
        return this.inTurn(qid, () => this.indexNow(qid, rows, generation));
    }

    private async indexNow(qid: string, rows: readonly SearchRow[], generation: number): Promise<IndexResult> {
        this.sync();
        // A call still queued when its run closed must not land in the next run, where the same question id may mean
        // another question.
        if (this.generation !== generation) throw new MossRunError('not_open', 'The Moss run this index call belonged to has closed.');
        const docs: MossDoc[] = [];
        const fresh = new Map<string, { row: SearchRow; ids: string[] }>();
        let skipped = 0;
        let truncated = 0;
        for (const row of rows) {
            const parentId = validRow(row) ? parentIdFor(qid, row.id) : null;
            if (!parentId || fresh.has(parentId)) {
                skipped += 1;
                continue;
            }
            const built = webDocsFor(qid, row, this.options);
            if (built.truncated) truncated += 1;
            fresh.set(parentId, { row: copyRow(row), ids: built.docs.map((doc) => doc.id) });
            docs.push(...built.docs);
        }
        // Chunks an earlier index of the same row had and this one does not, so a shorter page leaves nothing stale.
        const stale: string[] = [];
        for (const [parentId, { ids }] of fresh) {
            const keep = new Set(ids);
            for (const id of this.byParent.get(parentId) ?? []) if (!keep.has(id)) stale.push(id);
        }
        // New chunk ids are tracked before the add, so forget or close can clean up after a failed one. A chunk that
        // already has an owner keeps it until the add succeeds, so a failed replacement never pairs old text with a new row.
        for (const [parentId, { row, ids }] of fresh) {
            for (const id of ids) if (!this.owners.has(id)) this.track(id, { questionId: qid, parentId, row });
        }
        const result = await this.run.op('web index', async (session) => {
            const removed = stale.length > 0 ? await session.deleteDocs(stale) : 0;
            const started = performance.now();
            const { added, updated } = docs.length > 0 ? await session.addDocs(docs) : { added: 0, updated: 0 };
            const indexMs = roundMs(performance.now() - started);
            return {
                value: { rows: fresh.size, chunks: docs.length, added, updated, removed, skipped, truncated, indexMs },
                counts: { rows: fresh.size, chunks: docs.length, added, updated, deleted: removed, skippedRows: skipped },
            };
        });
        // A run that closed meanwhile took these chunks with its session; its tracking was already dropped.
        if (this.run.generation !== generation) return result;
        for (const [parentId, { row, ids }] of fresh) for (const id of ids) this.track(id, { questionId: qid, parentId, row });
        this.untrack(stale);
        return result;
    }

    /** Searches one or more questions' passages and places. */
    async search(questionIds: string | readonly string[], query: string, options: WebSearchOptions = {}): Promise<WebSearch> {
        const ids = (typeof questionIds === 'string' ? [questionIds] : [...questionIds]).map(checkQuestionId);
        if (ids.length === 0) throw new MossInputError('search needs at least one questionId.');
        if (typeof query !== 'string') throw new MossInputError('The query must be text.');
        const text = collapse(query).slice(0, QUERY_MAX);
        const filters: MossFilter[] = [
            { field: 'kind', condition: { $eq: KIND.web } },
            ids.length === 1 ? { field: 'questionId', condition: { $eq: ids[0] } } : { field: 'questionId', condition: { $in: ids } },
        ];
        if (options.source) filters.push({ field: 'source', condition: { $eq: options.source } });
        if (options.near) filters.push({ field: 'location', condition: { $near: nearValue(options.near) } });
        this.sync();
        const generation = this.generation;
        return this.run.op('web search', async (session) => {
            const started = performance.now();
            const result = await session.query(text, {
                topK: options.topK ?? this.options.searchTopK ?? 6,
                alpha: options.alpha ?? this.options.searchAlpha ?? 0.6,
                filter: { $and: filters },
            });
            const wallMs = roundMs(performance.now() - started);
            // Hits from a run that closed while the query was out must not be matched with the next run's rows.
            if (this.run.generation !== generation) throw new MossRunError('not_open', 'The Moss run this search belonged to has closed.');
            const hits = result.docs.map((hit) => {
                const owner = this.owners.get(hit.id);
                // Each hit gets its own copy, so a caller editing it cannot change the next search's sources.
                return { id: hit.id, questionId: owner?.questionId ?? hit.metadata?.questionId ?? '', score: hit.score, text: hit.text, row: owner ? copyRow(owner.row) : null };
            });
            const mossMs = result.timeTakenInMs ?? null;
            return { value: { hits, mossMs, wallMs }, counts: { hits: hits.length, ...(mossMs !== null ? { mossMs } : {}) } };
        });
    }

    /** Deletes a question's passages and places once it is answered. A closed run has already dropped them. */
    async forget(questionId: string): Promise<number> {
        const qid = checkQuestionId(questionId);
        this.sync();
        const generation = this.generation;
        return this.inTurn(qid, () => this.forgetNow(qid, generation));
    }

    private async forgetNow(qid: string, generation: number): Promise<number> {
        this.sync();
        // Queued before its run closed: that run's passages went with its session.
        if (this.generation !== generation) return 0;
        const ids = [...(this.byQuestion.get(qid) ?? [])];
        if (ids.length === 0) return 0;
        if (!this.run.isOpen) {
            this.untrack(ids);
            return 0;
        }
        const deleted = await this.run.op('web forget', async (session) => {
            const removed = await session.deleteDocs(ids);
            return { value: removed, counts: { deleted: removed } };
        });
        // Only after the delete succeeded, so a failed forget can be tried again.
        if (this.run.generation === generation) this.untrack(ids);
        return deleted;
    }

    /**
     * Runs index and forget calls for one question one after another, each after the last has settled, so a
     * replacement, a forget and an index started during either cannot interleave and leave chunks untracked.
     */
    private inTurn<T>(questionId: string, task: () => Promise<T>): Promise<T> {
        const previous = this.queues.get(questionId) ?? Promise.resolve();
        const result = previous.then(task);
        const tail = result.then(
            () => undefined,
            () => undefined,
        );
        this.queues.set(questionId, tail);
        void tail.then(() => {
            if (this.queues.get(questionId) === tail) this.queues.delete(questionId);
        });
        return result;
    }

    private track(id: string, owner: Owner): void {
        this.owners.set(id, owner);
        let question = this.byQuestion.get(owner.questionId);
        if (!question) this.byQuestion.set(owner.questionId, (question = new Set()));
        question.add(id);
        let parent = this.byParent.get(owner.parentId);
        if (!parent) this.byParent.set(owner.parentId, (parent = new Set()));
        parent.add(id);
    }

    private untrack(ids: Iterable<string>): void {
        for (const id of ids) {
            const owner = this.owners.get(id);
            if (!owner) continue;
            this.owners.delete(id);
            const question = this.byQuestion.get(owner.questionId);
            question?.delete(id);
            if (question?.size === 0) this.byQuestion.delete(owner.questionId);
            const parent = this.byParent.get(owner.parentId);
            parent?.delete(id);
            if (parent?.size === 0) this.byParent.delete(owner.parentId);
        }
    }

    /**
     * Drops what this object remembers about an earlier run, whose passages went with its session. Its queues go too,
     * so a call stuck in a closed run cannot hold up the next one; anything still queued there bails when it runs.
     */
    private sync(): void {
        if (this.generation === this.run.generation) return;
        this.generation = this.run.generation;
        this.owners.clear();
        this.byQuestion.clear();
        this.byParent.clear();
        this.queues.clear();
    }
}
