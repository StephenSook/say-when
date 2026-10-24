// A replayable source for tests: plays a fixed list of events, in order, the same way every time.
//
// Its database name must start with `test-`, so every session key it produces (`test-...:<id>`) is test data:
// the stats exclude it by default and the live test deletes it. A fake source can never pass as real usage.
import type { ActionIn, DeviceIn, LedgerIn, ScanIn } from '../types.js';
import type { SourceHandlers, TelemetrySource } from './source.js';

export type FakeEvent =
    | { readonly type: 'ledger'; readonly row: LedgerIn }
    | { readonly type: 'scan'; readonly row: ScanIn }
    | { readonly type: 'action'; readonly row: ActionIn }
    | { readonly type: 'device'; readonly row: DeviceIn }
    | { readonly type: 'ready' }
    | { readonly type: 'lost'; readonly reason?: string };

export interface FakeSourceOptions {
    /** Awaited before each event, for example a writer's `whenWritable`, so a replay honours back-pressure. */
    readonly beforeEach?: () => Promise<void>;
}

export class FakeSource implements TelemetrySource {
    private stopped = false;

    constructor(
        readonly database: string,
        private readonly events: readonly FakeEvent[],
        private readonly options: FakeSourceOptions = {},
    ) {
        if (!/^test-[a-z0-9]+(-[a-z0-9]+)*$/.test(database)) {
            throw new Error('A fake source must use a database name starting with test- (lowercase letters, digits, dashes).');
        }
    }

    async start(handlers: SourceHandlers): Promise<void> {
        this.stopped = false;
        for (const e of this.events) {
            if (this.stopped) return;
            if (this.options.beforeEach) await this.options.beforeEach();
            switch (e.type) {
                case 'ledger':
                    handlers.ledger(e.row);
                    break;
                case 'scan':
                    handlers.scan(e.row);
                    break;
                case 'action':
                    handlers.action(e.row);
                    break;
                case 'device':
                    handlers.device(e.row);
                    break;
                case 'ready':
                    handlers.ready();
                    break;
                case 'lost':
                    handlers.lost(e.reason ?? 'replayed loss');
                    break;
            }
        }
    }

    stop(): void {
        this.stopped = true;
    }
}
