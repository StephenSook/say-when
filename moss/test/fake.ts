import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SnapshotInfo } from '@moss-js/moss';

import type { RetrieveEvent } from '../src/events.js';
import { MossRun, type MossClientLike, type MossDoc, type MossFilter, type MossHit, type MossQueryOptions, type MossSearchResult, type MossSession, type Timers } from '../src/session.js';

export const FAKE_SNAPSHOT_FILE = 'fake-snapshot.json';
export const TEST_PROJECT_ID = 'project-test-id';
// Deliberately low-entropy, so a secret scanner does not mistake it for a real key.
export const TEST_PROJECT_KEY = 'fakekey-aaaaaaaaaaaa';

const words = (text: string): Set<string> => new Set(text.toLowerCase().match(/[a-z]{3,}/g) ?? []);

/** Share of the query's words found in the document, 0 to 1. Deterministic, so tests can predict the order. */
export function overlapScore(query: string, doc: MossDoc): number {
    const q = words(query);
    if (q.size === 0) return 0;
    const d = words(doc.text);
    let shared = 0;
    for (const word of q) if (d.has(word)) shared += 1;
    return shared / q.size;
}

function distanceMeters(a: [number, number], b: [number, number]): number {
    const rad = (deg: number) => (deg * Math.PI) / 180;
    const dLat = rad(b[0] - a[0]);
    const dLng = rad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/** The filter grammar as docs.moss.dev describes it, including: a condition never matches a doc that lacks the field. */
export function matches(metadata: Record<string, string> | undefined, filter: MossFilter): boolean {
    if ('$and' in filter) return filter.$and.every((part) => matches(metadata, part));
    if ('$or' in filter) return filter.$or.some((part) => matches(metadata, part));
    const value = metadata?.[filter.field];
    if (value === undefined) return false;
    const condition = filter.condition;
    if ('$eq' in condition) return value === condition.$eq;
    if ('$in' in condition) return condition.$in.includes(value);
    if ('$near' in condition) {
        const [lat, lng, radius] = condition.$near.split(',').map(Number);
        const [docLat, docLng] = value.split(',').map(Number);
        return distanceMeters([lat, lng], [docLat, docLng]) <= radius;
    }
    throw new Error('fake moss: unsupported filter condition');
}

/** Stands in for a Moss SessionIndex: same interface, in memory, with a JSON file as its snapshot. */
export class FakeSession implements MossSession {
    readonly docs = new Map<string, MossDoc>();
    readonly calls: Array<{ method: string; args: unknown[] }> = [];
    /** Reported scores by doc id. The hybrid order still follows the overlap score, as Moss's order ignores score. */
    readonly scores = new Map<string, number>();
    /** Errors to throw once, by method name. */
    readonly failures = new Map<string, Error>();
    /** Changes every hit before it is returned, to mimic hits that come back without some fields. */
    reshape: ((hit: MossHit) => MossHit) | null = null;
    timeTakenInMs: number | undefined = 1.5;
    closed = false;
    private readonly holds = new Map<string, Promise<void>>();

    constructor(
        readonly name: string,
        readonly modelId: string,
    ) {}

    /** Makes the next call to method wait until the returned function is called. */
    hold(method: string): () => void {
        let release: () => void = () => {};
        this.holds.set(
            method,
            new Promise<void>((resolve) => {
                release = () => resolve();
            }),
        );
        return () => {
            this.holds.delete(method);
            release();
        };
    }

    private async enter(method: string, args: unknown[]): Promise<void> {
        if (this.closed) throw new Error(`SessionIndex '${this.name}' is closed`);
        this.calls.push({ method, args });
        const failure = this.failures.get(method);
        if (failure) {
            this.failures.delete(method);
            throw failure;
        }
        await this.holds.get(method);
    }

    async addDocs(docs: MossDoc[]): Promise<{ added: number; updated: number }> {
        await this.enter('addDocs', [docs]);
        let added = 0;
        let updated = 0;
        for (const doc of docs) {
            if (this.docs.has(doc.id)) updated += 1;
            else added += 1;
            this.docs.set(doc.id, structuredClone(doc));
        }
        return { added, updated };
    }

    async deleteDocs(docIds: string[]): Promise<number> {
        await this.enter('deleteDocs', [docIds]);
        let removed = 0;
        for (const id of new Set(docIds)) if (this.docs.delete(id)) removed += 1;
        return removed;
    }

    async getDocs(): Promise<MossDoc[]> {
        await this.enter('getDocs', []);
        return [...this.docs.values()].map((doc) => structuredClone(doc));
    }

    async query(text: string, options: MossQueryOptions = {}): Promise<MossSearchResult> {
        await this.enter('query', [text, options]);
        if (!text.trim()) return { docs: [] }; // Moss: a blank query returns no results
        const hits = [...this.docs.values()]
            .filter((doc) => !options.filter || matches(doc.metadata, options.filter))
            .map((doc) => ({ doc, order: overlapScore(text, doc) }))
            .sort((a, b) => b.order - a.order)
            .slice(0, options.topK ?? 5)
            .map(({ doc, order }): MossHit => {
                const hit: MossHit = { id: doc.id, text: doc.text, metadata: { ...doc.metadata }, score: this.scores.get(doc.id) ?? order };
                if (doc.payload !== undefined) hit.payload = doc.payload;
                return this.reshape ? this.reshape(hit) : hit;
            });
        return this.timeTakenInMs === undefined ? { docs: hits } : { docs: hits, timeTakenInMs: this.timeTakenInMs };
    }

    async saveToDisk(cachePath: string): Promise<void> {
        await this.enter('saveToDisk', [cachePath]);
        const dir = join(cachePath, this.name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, FAKE_SNAPSHOT_FILE), JSON.stringify([...this.docs.values()]));
    }

    async loadFromDisk(cachePath: string): Promise<number> {
        await this.enter('loadFromDisk', [cachePath]);
        let docs: MossDoc[];
        try {
            docs = JSON.parse(readFileSync(join(cachePath, this.name, FAKE_SNAPSHOT_FILE), 'utf8')) as MossDoc[];
        } catch {
            throw Object.assign(new Error('The snapshot is missing or damaged'), { code: 'DESERIALIZATION' });
        }
        this.docs.clear();
        for (const doc of docs) this.docs.set(doc.id, doc);
        return docs.length;
    }

    async inspectSnapshot(cachePath: string): Promise<SnapshotInfo> {
        await this.enter('inspectSnapshot', [cachePath]);
        const file = join(cachePath, this.name, FAKE_SNAPSHOT_FILE);
        const docCount = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown[]).length : 0;
        return { modelId: this.modelId, hasModelArtifact: true, docCount, dimension: 384, legacyLayout: false };
    }

    async close(): Promise<void> {
        this.calls.push({ method: 'close', args: [] });
        this.closed = true;
    }
}

export class FakeClient implements MossClientLike {
    readonly sessions: FakeSession[] = [];
    closed = false;
    closeCalls = 0;
    closeFailure: Error | null = null;
    /** Thrown by session(), as a failed credential check or model load would be. */
    sessionFailure: Error | null = null;

    constructor(
        readonly projectId: string,
        readonly projectKey: string,
        private readonly setup: (session: FakeSession) => void,
    ) {}

    async session(indexName: string, modelId: 'moss-minilm'): Promise<MossSession> {
        if (this.closed) throw new Error('MossClient is closed');
        if (this.sessionFailure) throw this.sessionFailure;
        const session = new FakeSession(indexName, modelId);
        this.setup(session);
        this.sessions.push(session);
        return session;
    }

    async close(): Promise<void> {
        this.closeCalls += 1;
        if (this.closeFailure) throw this.closeFailure;
        this.closed = true;
        await Promise.all(this.sessions.map((session) => session.close()));
    }
}

/** Hands out fake clients and keeps them for assertions. */
export class FakeMoss {
    readonly clients: FakeClient[] = [];
    /** Runs on every new session, to set scores or failures before the run uses it. */
    onSession: ((session: FakeSession) => void) | null = null;
    /** Handed to every new client as its sessionFailure. */
    sessionFailure: Error | null = null;

    readonly connect = async (projectId: string, projectKey: string): Promise<MossClientLike> => {
        const client = new FakeClient(projectId, projectKey, (session) => this.onSession?.(session));
        client.sessionFailure = this.sessionFailure;
        this.clients.push(client);
        return client;
    };

    /** The newest session. */
    get session(): FakeSession {
        const session = this.clients.at(-1)?.sessions.at(-1);
        if (!session) throw new Error('fake moss: no session was opened');
        return session;
    }
}

/** Timers that only fire when a test says so. */
export class FakeTimers implements Timers {
    readonly pending = new Map<number, { callback: () => void; ms: number }>();
    private next = 1;

    set(callback: () => void, ms: number): unknown {
        const id = this.next;
        this.next += 1;
        this.pending.set(id, { callback, ms });
        return id;
    }

    clear(handle: unknown): void {
        this.pending.delete(handle as number);
    }

    delays(): number[] {
        return [...this.pending.values()].map((timer) => timer.ms);
    }

    fireAll(): void {
        for (const [id, timer] of [...this.pending]) {
            this.pending.delete(id);
            timer.callback();
        }
    }
}

export const tempDir = (): string => mkdtempSync(join(tmpdir(), 'say-when-moss-'));

export function testEnv(snapshotDir: string, extra: Record<string, string> = {}): Record<string, string> {
    return { MOSS_PROJECT_ID: TEST_PROJECT_ID, MOSS_PROJECT_KEY: TEST_PROJECT_KEY, MOSS_SNAPSHOT_DIR: snapshotDir, ...extra };
}

/** A run wired to a fake Moss, fake timers and an event list. */
export function harness(snapshotDir: string, extraEnv: Record<string, string> = {}) {
    const moss = new FakeMoss();
    const timers = new FakeTimers();
    const events: RetrieveEvent[] = [];
    const run = new MossRun({ env: testEnv(snapshotDir, extraEnv), connect: moss.connect, timers, onEvent: (event) => events.push(event) });
    return { moss, timers, events, run };
}
