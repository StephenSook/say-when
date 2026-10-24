// The generated SpacetimeDB bindings (spacetime/bindings/agent), imported statically for the CLIs.
//
// The library (src/sources/spacetime.ts) is written against structural shapes so it builds without the bindings.
// This file is where those shapes meet the generated code: `npm run typecheck` fails here if a regenerated binding
// drops a table telemetry reads, renames or retypes a field a normalizer reads, or changes the connection API.
//
// At run time the bindings resolve `spacetimedb` from spacetime/node_modules, so run `npm install` in spacetime/
// as well. tsx runs them as TypeScript (their relative imports carry no extension, which tsconfig's Bundler
// resolution accepts). Nothing here calls a reducer.
import { DbConnection } from '../../../spacetime/bindings/agent/index.js';
import type { BuilderLike, SUBSCRIBED } from '../sources/spacetime.js';

/** The generated `DbConnection.builder`, as the source takes it. Assignability here is the API check. */
export const builder: () => BuilderLike = () => DbConnection.builder();

// ---------- Compile-time checks of the generated rows against what the normalizers read ----------

type Db = DbConnection['db'];
/** `board_ledger` to `boardLedger`, as `camel()` does at run time. */
type Camel<S extends string> = S extends `${infer Head}_${infer Tail}` ? `${Head}${Capitalize<Camel<Tail>>}` : S;
type Accessor<K extends keyof typeof SUBSCRIBED> = Camel<(typeof SUBSCRIBED)[K]>;
/** The row type behind a `conn.db` accessor, or never when the accessor or its `iter()` is missing. */
type RowAt<A extends string> = A extends keyof Db ? (Db[A] extends { iter(): Iterable<infer R> } ? R : never) : never;
/** True only when the row exists and every field the normalizer reads has a type the normalizer accepts. */
type Check<Row, Needs> = [Row] extends [never] ? false : [Row] extends [Needs] ? true : false;
type Expect<T extends true> = T;

// What each normalizer accepts (u64() takes bigint or a safe number, small() takes number or bigint, and so on).
type U64 = bigint | number;
type Small = number | bigint;
type Time = { readonly microsSinceUnixEpoch: bigint };
type Tagged = { readonly tag: string };
type Maybe<T> = T | null | undefined;

interface LedgerNeeds {
    id: U64;
    sessionId: U64;
    at: Time;
    kind: string;
    questionId: U64;
    optionId: U64;
    errandId: U64;
    callId: U64;
    gestureId: string;
    command: string;
    stepSeq: U64;
    cursor: Small;
    outcome: string;
    reason: string;
    ms: Small;
}

interface ScanNeeds {
    sessionId: U64;
    questionId: U64;
    phase: Tagged;
    mode: Tagged;
    answerMode: Tagged;
    cursor: Small;
    optionCount: Small;
    pass: Small;
    stepSeq: U64;
    stepStartedAt: Time;
    stepEndsAt: Time;
    outcome: Maybe<Tagged>;
    pauseReason: Maybe<Tagged>;
    updatedAt: Time;
}

interface ErrandNeeds {
    errandId: U64;
    sessionId: U64;
    status: Tagged;
    createdAt: Time;
    previewedAt: Maybe<Time>;
    readbackDoneAt: Maybe<Time>;
    confirmedAt: Maybe<Time>;
    claimedAt: Maybe<Time>;
    submittedAt: Maybe<Time>;
    endedAt: Maybe<Time>;
    updatedAt: Time;
}

interface CallNeeds {
    callId: U64;
    sessionId: U64;
    status: Tagged;
    result: string;
    createdAt: Time;
    confirmedAt: Maybe<Time>;
    dialedAt: Maybe<Time>;
    ringingAt: Maybe<Time>;
    connectedAt: Maybe<Time>;
    endedAt: Maybe<Time>;
    updatedAt: Time;
}

interface DeviceNeeds {
    identity: { toHexString(): string };
    role: Tagged;
    online: boolean;
    lastSeenAt: Time;
    decoderHealthy: Maybe<boolean>;
}

/** Each entry fails to compile when the generated bindings drift from src/sources/spacetime.ts. */
export type BindingChecks = [
    Expect<Check<RowAt<Accessor<'ledger'>>, LedgerNeeds>>,
    Expect<Check<RowAt<Accessor<'scan'>>, ScanNeeds>>,
    Expect<Check<RowAt<Accessor<'errands'>>, ErrandNeeds>>,
    Expect<Check<RowAt<Accessor<'calls'>>, CallNeeds>>,
    Expect<Check<RowAt<Accessor<'devices'>>, DeviceNeeds>>,
];
