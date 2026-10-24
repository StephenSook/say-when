// What any telemetry source hands over. A source reads SpacetimeDB (or replays a script); it never writes to it.
import type { ActionIn, DeviceIn, LedgerIn, ScanIn } from '../types.js';

export interface SourceHandlers {
    ledger(row: LedgerIn): void;
    scan(row: ScanIn): void;
    action(row: ActionIn): void;
    /** A device_status row: a server clock tick, and for the station, whether the decoder is reading the person. */
    device(row: DeviceIn): void;
    /** The subscription's snapshot is complete. */
    ready(): void;
    /** The connection dropped; rows stop until the next `ready`. */
    lost(reason: string): void;
}

export interface TelemetrySource {
    /** The SpacetimeDB database name: part of every session key in Tiger. */
    readonly database: string;
    start(handlers: SourceHandlers): Promise<void>;
    stop(): void;
}
