// Source to tracker to writer. The tracker emits rows into the writer's queue; the writer's flush tick first asks
// the tracker for the idle slices up to the latest server time, then sends a batch.
import type { Logger } from './log.js';
import type { RowSink } from './sink.js';
import type { TelemetrySource } from './sources/source.js';
import { Tracker } from './tracker.js';
import { TelemetryWriter, type Timers } from './writer.js';

export interface PipelineOptions {
    readonly source: TelemetrySource;
    readonly sink: RowSink;
    readonly log: Logger;
    readonly describeError?: (error: unknown) => string;
    readonly timers?: Timers;
    readonly capacity?: number;
    readonly maxBatch?: number;
    readonly flushEveryMs?: number;
}

export interface Pipeline {
    readonly tracker: Tracker;
    readonly writer: TelemetryWriter;
    readonly source: TelemetrySource;
    /** Starts the writer's timer, then the source. Resolves when the source's start resolves. */
    start(): Promise<void>;
    /** Stops the source, writes the last idle slices and whatever is queued (up to `deadlineMs`). */
    stop(deadlineMs?: number): Promise<void>;
}

export function createPipeline(options: PipelineOptions): Pipeline {
    let writer: TelemetryWriter | null = null;
    const tracker = new Tracker({
        database: options.source.database,
        emit: (row) => writer?.push(row),
    });
    writer = new TelemetryWriter({
        sink: options.sink,
        log: options.log,
        describeError: options.describeError,
        beforeFlush: () => tracker.checkpoint(),
        timers: options.timers,
        capacity: options.capacity,
        maxBatch: options.maxBatch,
        flushEveryMs: options.flushEveryMs,
    });
    const w = writer;
    return {
        tracker,
        writer: w,
        source: options.source,
        async start() {
            w.start();
            await options.source.start({
                ledger: (row) => tracker.ledger(row),
                scan: (row) => tracker.scan(row),
                action: (row) => tracker.action(row),
                device: (row) => tracker.device(row),
                ready: () => tracker.markReady(),
                lost: () => tracker.markLost(),
            });
        },
        async stop(deadlineMs = 5_000) {
            options.source.stop();
            await w.stop(deadlineMs);
        },
    };
}
