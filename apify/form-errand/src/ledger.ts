import { canonicalFormUrl, sha256 } from './digest.js';

/** The slice of an Apify key-value store the ledger needs, so tests can pass an in-memory store. */
export interface RecordStore {
    getValue<T>(key: string): Promise<T | null>;
    setValue(key: string, value: unknown): Promise<void>;
}

export interface LedgerEntry {
    status: 'pending' | 'submitted' | 'unconfirmed';
    at: string;
    confirmationText: string | null;
}

export type Claim = { duplicate: false; key: string } | { duplicate: true; key: string; previous: LedgerEntry };

/**
 * Refuses a second submit of the same form and digest inside the window, so a misfired double confirm
 * sends once. The claim is written before the click, so a crash after clicking still blocks a resend.
 */
export class SubmitLedger {
    private readonly inFlight = new Set<string>();

    constructor(
        private readonly store: RecordStore,
        private readonly windowMs = 10 * 60 * 1000,
        private readonly now: () => number = Date.now,
    ) {}

    static keyFor(formUrl: string, digest: string): string {
        return `SUBMISSION-${sha256(`${canonicalFormUrl(formUrl)}|${digest}`).slice(0, 40)}`;
    }

    async claim(formUrl: string, digest: string): Promise<Claim> {
        const key = SubmitLedger.keyFor(formUrl, digest);
        if (this.inFlight.has(key)) {
            return { duplicate: true, key, previous: { status: 'pending', at: new Date(this.now()).toISOString(), confirmationText: null } };
        }
        const previous = await this.store.getValue<LedgerEntry>(key);
        if (previous && this.now() - Date.parse(previous.at) < this.windowMs) return { duplicate: true, key, previous };
        this.inFlight.add(key);
        await this.store.setValue(key, { status: 'pending', at: new Date(this.now()).toISOString(), confirmationText: null });
        return { duplicate: false, key };
    }

    /** Drops a claim when nothing was clicked, so a later confirmed submit is not blocked. */
    async release(key: string): Promise<void> {
        try {
            await this.store.setValue(key, null);
        } finally {
            this.inFlight.delete(key);
        }
    }

    async finish(key: string, status: 'submitted' | 'unconfirmed', confirmationText: string | null): Promise<void> {
        try {
            await this.store.setValue(key, { status, at: new Date(this.now()).toISOString(), confirmationText });
        } finally {
            this.inFlight.delete(key);
        }
    }
}
