// The narrow interfaces the sidecar uses from each package, typed with the packages' own types. src/wiring.ts
// builds the real ones from apify/client, moss and cartesia; the tests pass fakes. Swapping a piece means
// writing one object that fits its port.

import type { ErrandResult, PreviewRequest, QuestionClass, SearchResult, SearchRow, SubmitRequest } from '@say-when/apify-client';
import type { CallOutcome, CallRefusal, CallRequest, CallSnapshot, CancelReason, PreparedCall } from '@say-when/cartesia/server';
import type { CandidateOption, IndexResult, Ordering, Recall, WebSearch } from '@say-when/moss';

/** classifyQuestion from apify/client: local rules, no network (PLAN D8). */
export type Classifier = (question: string) => QuestionClass;

export interface SearchPort {
    /** RAG Web Browser: Google, then the top pages. */
    web(question: string, options: { signal: AbortSignal }): Promise<SearchResult>;
    /** Google Maps Scraper. `query` is a short search string such as "lunch", never the whole question. */
    places(query: string, options: { signal: AbortSignal; near?: { lat: number; lng: number } }): Promise<SearchResult>;
}

/** The person's memory (moss MemoryStore and rankOptions over the open MossRun). */
export interface MemoryPort {
    /** False when the Moss run is closed (not started, idle close, or Stop). */
    isOpen(): boolean;
    recall(question: string, partnerId: string): Promise<Recall>;
    writeBack(confirmed: { question: string; reply: string; partnerId: string; shareable?: boolean }): Promise<{ id: string; added: number; updated: number }>;
    rank(partnerId: string, options: readonly CandidateOption[]): Promise<Ordering>;
    /**
     * Keeps a past request (src/requests.ts): a private note for every partner, written only after a form was sent
     * under memory consent. Never shareable, so its text never shows on a screen.
     */
    addNote(note: { text: string; shareable: false }): Promise<{ id: string; added: number; updated: number }>;
}

/** The current question's web passages (moss WebIndex). */
export interface WebIndexPort {
    index(questionKey: string, rows: readonly SearchRow[]): Promise<IndexResult>;
    search(questionKey: string, query: string): Promise<WebSearch>;
    forget(questionKey: string): Promise<number>;
}

/** The form-errand Actor client (apify/client FormErrandClient). Submit is sent once and never retried. */
export interface ErrandPort {
    preview(request: PreviewRequest, call?: { signal?: AbortSignal }): Promise<ErrandResult>;
    submit(request: SubmitRequest): Promise<ErrandResult>;
}

export interface CallHandleLike {
    readonly requestId: string;
    readonly done: Promise<CallOutcome>;
}

/** The guarded outbound call (cartesia Dialer). Its `onUpdate` dependency feeds CallRunner.onSnapshot. */
export interface DialerPort {
    prepare(request: CallRequest): { ok: true; call: PreparedCall } | { ok: false; refusal: CallRefusal };
    /**
     * `confirmedAtMs` is the CONFIRM's time by the module's clock (ms since the epoch, from `call_queue.confirmed_at`),
     * so the Dialer can measure its confirm-to-dial window from the CONFIRM. A Dialer that takes only two arguments
     * still fits this port.
     */
    place(requestId: string, confirmDigest: string, confirmedAtMs: number): { ok: true; handle: CallHandleLike } | { ok: false; refusal: CallRefusal };
    cancelActive(reason: CancelReason): void;
}

export type { CallSnapshot, CancelReason, CallOutcome, PreparedCall };
