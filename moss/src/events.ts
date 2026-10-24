import type { MossErrorCode } from '@moss-js/moss';

/** Every Moss step by a fixed name, so an event detail can never carry question, memory or web text. */
export type MossOp =
    | 'open session'
    | 'close session'
    | 'inspect snapshot'
    | 'memory add'
    | 'memory recall'
    | 'memory affinity'
    | 'memory write back'
    | 'web index'
    | 'web search'
    | 'web forget';

export type CountName =
    | 'added'
    | 'updated'
    | 'deleted'
    | 'restored'
    | 'purged'
    | 'docs'
    | 'hits'
    | 'instant'
    | 'options'
    | 'rows'
    | 'chunks'
    | 'skippedRows'
    | 'mossMs'
    | 'heldMs';

/** Numbers only. mossMs is Moss's own timeTakenInMs, when the SDK reports one. */
export type RetrieveCounts = Partial<Record<CountName, number>>;

/**
 * One Moss step for the content-free pipeline_event table in PLAN.md. The agent adds id, session_id and at.
 * detail is the step name, plus the Moss error code when the step failed.
 */
export interface RetrieveEvent {
    stage: 'retrieve';
    status: 'started' | 'ok' | 'error';
    detail: string;
    /** Wall time on this laptop in milliseconds; null while started. */
    ms: number | null;
    counts?: RetrieveCounts;
}

export type EventSink = (event: RetrieveEvent) => void;

// The stable codes in @moss-js/moss 1.21.0: MossErrorCode in dist/moss.d.ts, CODES in dist/index.esm.js.
const MOSS_CODES: ReadonlySet<string> = new Set<MossErrorCode>([
    'INVALID_ARGUMENT',
    'NOT_FOUND',
    'UNAUTHORIZED',
    'NETWORK',
    'DESERIALIZATION',
    'MODEL_UNAVAILABLE',
    'INTERNAL',
]);

/** The Moss error code, or ERROR when there is none. Messages are never copied into events. */
export function errorCode(error: unknown): string {
    const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
    return typeof code === 'string' && MOSS_CODES.has(code) ? code : 'ERROR';
}

/**
 * A paused project. The native core 0.36.0 holds two messages for it, "The project's usage limit has been reached;
 * billing must be updated before it can be used." and "The project's usage limit is exceeded." (read with strings on
 * the darwin-arm64 binary). Moss's changelog pairs the first with UNAUTHORIZED; the code of the second is not
 * known, so only the text is matched.
 */
export function isUsageLimitError(error: unknown): boolean {
    return error instanceof Error && /usage limit/i.test(error.message);
}

export function failureDetail(op: MossOp, error: unknown): string {
    if (isUsageLimitError(error)) return 'Moss paused: usage limit reached';
    return `${op} failed: ${errorCode(error)}`;
}

/**
 * Hands the event to the sink once the current step has settled, so a sink that calls back into the run (start,
 * close, a query) never runs in the middle of a state change. Events keep their order.
 */
export function emit(sink: EventSink | undefined, event: RetrieveEvent): void {
    if (!sink) return;
    queueMicrotask(() => deliver(sink, event));
}

// A broken dashboard sink must not stop the person's reply. Events hold no content, so nothing leaks here.
const dropped = (): void => console.warn('moss: onEvent failed, one retrieve event was dropped');

function deliver(sink: EventSink, event: RetrieveEvent): void {
    try {
        // An async sink's rejection is caught too; left alone it would be an unhandled rejection, which ends the process.
        void Promise.resolve(sink(event) as unknown).catch(dropped);
    } catch {
        dropped();
    }
}

export const roundMs = (ms: number): number => Math.round(ms * 10) / 10;
