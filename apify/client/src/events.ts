/** The stages this package reports. A subset of `stage` in the pipeline_event contract in PLAN.md. */
export type PipelineStage = 'search' | 'errand';

export type PipelineStatus = 'started' | 'ok' | 'error';

/**
 * One progress report for the dashboard. Content-free: it never carries the question, page text, answers,
 * form values, URLs or response bodies, only which call ran, how it ended, how long it took, and counts.
 * The caller adds `id`, `session_id` and `at` when it writes the pipeline_event row.
 */
export interface PipelineEvent {
    stage: PipelineStage;
    status: PipelineStatus;
    /** A short label from a fixed vocabulary, for example "web", "maps timeout" or "preview refused: captcha". */
    detail: string;
    /** Milliseconds since the call started. 0 for "started". */
    ms: number;
    /** Numbers only, for example { rows: 3, skipped: 1 }. */
    counts?: Record<string, number>;
}

export type EventSink = (event: PipelineEvent) => void | Promise<void>;

/** Calls the listener and ignores anything it throws or rejects with, so telemetry never breaks a call. */
export function emit(sink: EventSink | undefined, event: PipelineEvent): void {
    if (!sink) return;
    try {
        const out = sink(event);
        if (out && typeof out.then === 'function') out.catch(() => undefined);
    } catch {
        // A broken dashboard listener must not stop a search or an errand.
    }
}

/** Whole milliseconds since `started`, a value from performance.now(). */
export const elapsedMs = (started: number): number => Math.max(0, Math.round(performance.now() - started));
