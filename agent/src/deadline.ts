// Bounded waits. A job must never wait forever on an outside call: a stuck wait holds the job's slot, keeps the
// orchestrator from claiming the job again after its lease lapses, and three of them stop all work.

/** The job's own signal fired (it was cancelled, or another attempt owns it). The work is dropped. */
export class JobAbortedError extends Error {
    constructor() {
        super('job aborted');
        this.name = 'JobAbortedError';
    }
}

/** A bounded wait ran out. `what` is a fixed step name, never content. */
export class DeadlineError extends Error {
    constructor(
        readonly what: string,
        readonly ms: number,
    ) {
        super(`${what} took longer than ${ms} ms`);
        this.name = 'DeadlineError';
    }
}

/**
 * Waits for `work` at most `ms`, and only while `signal` has not fired. The work itself is not cancelled (Moss
 * calls take no signal); a late result or error is dropped.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, what: string, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let done = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (settle: () => void) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            settle();
        };
        const onAbort = () => finish(() => reject(new JobAbortedError()));
        // Handlers go on the work before anything can end the wait, so a late rejection is always handled. Without
        // them, a Moss call that fails after its job was cancelled is an unhandled rejection, which ends the process.
        work.then(
            (value) => finish(() => resolve(value)),
            (error: unknown) => finish(() => reject(error)),
        );
        if (signal?.aborted) {
            onAbort();
            return;
        }
        timer = setTimeout(() => finish(() => reject(new DeadlineError(what, ms))), ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
