// A compile-time check of the sidecar against the generated SpacetimeDB bindings (spacetime/bindings/agent).
// `npm run typecheck` compiles it with tsconfig.bindings.json; it is never run. It fails to compile when:
// - the generated DbConnection or its builder no longer fits the adapter's structural types,
// - a reducer the sidecar calls is missing, or no longer accepts the sidecar's argument object,
// - a reducer's argument names differ from src/contract.ts,
// - a view row lacks a field the adapter reads, or an enum gains, loses or renames a variant.
// The generated files use extensionless imports, which is why this lives outside the NodeNext program.

import type { Timestamp } from 'spacetimedb';

import { DbConnection } from '../../spacetime/bindings/agent/index';
import type { Camel } from '../src/contract';
import { BOARD_CALLS, REDUCERS, VIEWS } from '../src/contract';
import type { BuilderLike, ConnectionLike } from '../src/db/spacetime-db';
import type { CallStatus, ErrandStatus, JobKind, JobStatus, MenuItem, Origin, ReducerArgs, ReducerName } from '../src/types';

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

type Db = DbConnection['db'];
// The row type the generated table hands to onInsert. (A conditional `infer` over the method signature came out
// loose enough to let a missing field through; this form keeps the exact generated row.)
type RowOf<T extends { onInsert: (...args: never[]) => unknown }> = Parameters<Parameters<T['onInsert']>[0]>[1];
type AgentQueueItem = RowOf<Db['agentQueue']>;
type ErrandQueueItem = RowOf<Db['errandQueue']>;
type CallQueueItem = RowOf<Db['callQueue']>;
type DeviceStatusItem = RowOf<Db['deviceStatus']>;
type BoardCallItem = RowOf<Db['boardCalls']>;

// The view rows carry every field the adapter reads.
type FieldsOf<V extends keyof typeof VIEWS> = Camel<(typeof VIEWS)[V]['fields'][number]>;
export type ViewFieldsExist = [
    Assert<[FieldsOf<'agentQueue'>] extends [keyof AgentQueueItem] ? true : false>,
    Assert<[FieldsOf<'errandQueue'>] extends [keyof ErrandQueueItem] ? true : false>,
    Assert<[FieldsOf<'callQueue'>] extends [keyof CallQueueItem] ? true : false>,
    Assert<['identity' | 'role'] extends [keyof DeviceStatusItem] ? true : false>,
    Assert<[Camel<(typeof BOARD_CALLS)['fields'][number]>] extends [keyof BoardCallItem] ? true : false>,
];

// The call board gives the call's id as a u64 and the CONFIRM's time as an optional timestamp, which is what
// callConfirmedAt in spacetime-db.ts reads (u64Of, then millisOf, which takes a Timestamp or undefined).
export type BoardCallTypes = [
    Assert<Equal<BoardCallItem['callId'], bigint>>,
    Assert<Equal<BoardCallItem['confirmedAt'], Timestamp | undefined>>,
];

// Each reducer's argument object has exactly the names in src/contract.ts, in camelCase.
type ArgNames<K extends ReducerName> = Camel<(typeof REDUCERS)[K]['args'][number]>;
type ArgNamesMatch = { [K in ReducerName]: Equal<ArgNames<K>, keyof ReducerArgs[K]> };
export type ReducerArgNamesMatch = Assert<ArgNamesMatch[ReducerName] extends true ? true : false>;

// Enum variants map one to one onto the sidecar's lowercase values (tagOf in spacetime-db.ts snake-cases them).
export const jobKinds: Record<AgentQueueItem['kind']['tag'], JobKind> = { Options: 'options', ErrandPreview: 'errand_preview', Remember: 'remember' };
export const jobStatuses: Record<AgentQueueItem['status']['tag'], JobStatus> = { Pending: 'pending', Claimed: 'claimed', Done: 'done', Failed: 'failed', Cancelled: 'cancelled' };
export const origins: Record<AgentQueueItem['origin']['tag'], Origin> = { Partner: 'partner', Menu: 'menu' };
export const menuItems: Record<AgentQueueItem['menuItem']['tag'], MenuItem> = { None: 'none', Need: 'need', Request: 'request', Call: 'call', Say: 'say' };
export const errandStatuses: Record<ErrandQueueItem['status']['tag'], ErrandStatus> = {
    Drafted: 'drafted',
    Previewed: 'previewed',
    AwaitingConfirm: 'awaiting_confirm',
    Confirmed: 'confirmed',
    Submitting: 'submitting',
    Submitted: 'submitted',
    Refused: 'refused',
    Failed: 'failed',
    UnknownOutcome: 'unknown_outcome',
    Stopped: 'stopped',
};
export const callStatuses: Record<CallQueueItem['status']['tag'], CallStatus> = {
    Prepared: 'prepared',
    AwaitingConfirm: 'awaiting_confirm',
    Confirmed: 'confirmed',
    Dialing: 'dialing',
    Ringing: 'ringing',
    Connected: 'connected',
    Ended: 'ended',
    Failed: 'failed',
    Stopped: 'stopped',
    Refused: 'refused',
};

/** Never called: it only has to compile. */
export function check(conn: DbConnection): void {
    // The generated builder and connection fit the adapter.
    const builder: BuilderLike = DbConnection.builder();
    const connection: ConnectionLike = conn;

    // Every reducer accepts the sidecar's argument object (function types are checked strictly here).
    type Call<K extends ReducerName> = (args: ReducerArgs[K]) => Promise<void>;
    const reducers: { [K in ReducerName]: Call<K> } = {
        agentClaim: conn.reducers.agentClaim,
        agentProgress: conn.reducers.agentProgress,
        agentPublishOptions: conn.reducers.agentPublishOptions,
        agentAttachPreview: conn.reducers.agentAttachPreview,
        agentFail: conn.reducers.agentFail,
        agentDone: conn.reducers.agentDone,
        claimErrand: conn.reducers.claimErrand,
        completeErrand: conn.reducers.completeErrand,
        claimCall: conn.reducers.claimCall,
        reportCallStatus: conn.reducers.reportCallStatus,
        addCallLine: conn.reducers.addCallLine,
        requestPairing: conn.reducers.requestPairing,
    };
    void [builder, connection, reducers];
}
