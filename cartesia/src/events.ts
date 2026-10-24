/** Stages this package reports, a subset of `pipeline_event.stage` in PLAN.md. */
export type PipelineStage = 'listen' | 'speak' | 'call';
export type PipelineStatus = 'started' | 'ok' | 'error';

/**
 * One content-free step report: the shape of `pipeline_event` in PLAN.md minus its id, session and time.
 * Never carries transcript text, names, phone numbers, keys or tokens.
 */
export interface PipelineEvent {
    stage: PipelineStage;
    status: PipelineStatus;
    /** A short fixed phrase, for example "socket open" or "refused: do_not_call". */
    detail: string;
    /** Milliseconds the step took; 0 when it starts. */
    ms: number;
    counts?: Record<string, number>;
}

export type OnEvent = (event: PipelineEvent) => void;

const API_KEY = /sk_car_[A-Za-z0-9_-]+/g;
const TOKEN_PARAM = /(access_token|api_key)=[^&\s"']+/gi;
const JWT_LIKE = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const DIGIT_RUN = /\+?\d[\d\s().-]{5,}\d/g;

/** Masks API keys, tokens and digit runs that could be phone numbers. Applied to every event and error message. */
export function redact(text: string): string {
    return String(text)
        .replace(API_KEY, '[key]')
        .replace(TOKEN_PARAM, '$1=[token]')
        .replace(JWT_LIKE, '[token]')
        .replace(DIGIT_RUN, '[number]');
}

const COUNT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

/** Sends a cleaned copy of the event. A sink that throws is ignored: telemetry must never stop speech or a cancel. */
export function emit(onEvent: OnEvent | undefined, event: PipelineEvent): void {
    if (!onEvent) return;
    const clean: PipelineEvent = {
        stage: event.stage,
        status: event.status,
        detail: redact(event.detail).slice(0, 120),
        ms: Number.isFinite(event.ms) ? Math.max(0, Math.round(event.ms)) : 0,
    };
    if (event.counts) {
        const counts: Record<string, number> = {};
        for (const [name, value] of Object.entries(event.counts)) {
            if (COUNT_NAME.test(name) && Number.isFinite(value)) counts[name] = value;
        }
        if (Object.keys(counts).length > 0) clean.counts = counts;
    }
    try {
        onEvent(clean);
    } catch {
        // Deliberately ignored, see above.
    }
}
