/**
 * The SpacetimeDB data source, behind NEXT_PUBLIC_SPACETIMEDB_HOST and NEXT_PUBLIC_SPACETIMEDB_DB.
 *
 * The connection lifecycle is written against the spacetimedb 2.13.0 client API (every call below
 * was checked in node_modules/spacetimedb/dist/sdk/*.d.ts):
 *   DbConnection.builder().withUri().withDatabaseName().withAutomaticReconnect()
 *     .onConnect().onAutomaticReconnect().onConnectError().onDisconnect().build()
 *   conn.subscriptionBuilder().onApplied().onError().subscribe(queries)
 *   conn.disconnect()
 *
 * What it does:
 * - Connecting until the subscription is applied, then Live.
 * - A dropped connection: the SDK reconnects on its own (withAutomaticReconnect) and replays the
 *   subscription. Meanwhile the chip says Reconnecting and the last known rows stay on screen.
 * - A failed first connection is never retried by the SDK, so this file rebuilds the connection
 *   with a doubling wait capped at 8 s (docs/ui.md).
 * - Not live for 10 s: Offline. It keeps trying, and it never falls back to the sample replay.
 * - Row times come from the server's clock. Each read moves them onto this laptop's clock by the
 *   measured offset (lib/data/clock-offset.ts), so countdowns and running times stay right even when
 *   the two clocks disagree (docs/spacetime.md 2.1).
 *
 * The table mapping lives in lib/data/spacetime-bindings.ts. Until that file is wired to the
 * generated bindings, it exports null and this source reports Offline with the reason 'no-bindings'.
 */
import type { DbConnectionBuilder, DbConnectionImpl, RowTypedQuery } from 'spacetimedb';
import { createClockOffset, shiftRows } from './clock-offset';
import { createStateStore, initialState, type DataSource } from './source';
import type { SpacetimeSettings } from './source-mode';
import type { DataRows, OfflineReason } from './types';

/** The generated DbConnection's module type is only known once bindings exist. */
export type AnyDbConnection = DbConnectionImpl<any>;

/** What lib/data/spacetime-bindings.ts provides once `spacetime generate` has run. */
export interface SpacetimeBindings<Conn extends AnyDbConnection = AnyDbConnection> {
  /** The generated `DbConnection.builder()`. */
  builder(): DbConnectionBuilder<Conn>;
  /** Everything the screens read, for example `[tables.question, tables.pipelineEvent]`. */
  queries: Array<string | RowTypedQuery<any, any>>;
  /** Register insert, update and delete callbacks on every mapped table. Returns a function that removes them. */
  watch(conn: Conn, onChange: () => void): () => void;
  /** Read the client cache into the dashboard's types (lib/data/types.ts). */
  read(conn: Conn): DataRows;
}

/** docs/ui.md: Offline after 10 s without a live connection. */
export const OFFLINE_AFTER_MS = 10_000;

/** Waits between rebuilds after a failed first connection: doubling, capped at 8 s (docs/ui.md). */
export const RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];

/** The SDK's own reconnect after a drop, kept inside the same cap. */
const AUTOMATIC_RECONNECT = { minDelayMs: 1_000, maxDelayMs: 8_000 } as const;

/** Row callbacks arrive one per row; read the cache once per burst. */
const READ_COALESCE_MS = 16;

export interface SpacetimeSourceDeps {
  /** Loads the bindings. Defaults to a lazy import of ./spacetime-bindings, so the SDK loads only when used. */
  loadBindings?: () => Promise<SpacetimeBindings | null>;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

async function defaultLoadBindings(): Promise<SpacetimeBindings | null> {
  const loaded = await import('./spacetime-bindings');
  return loaded.bindings as SpacetimeBindings | null;
}

function errorText(error: unknown): string | null {
  if (error === undefined || error === null) return null;
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

export function createSpacetimeSource(settings: SpacetimeSettings, deps: SpacetimeSourceDeps = {}): DataSource {
  const loadBindings = deps.loadBindings ?? defaultLoadBindings;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const store = createStateStore(initialState('spacetime'));
  /** The server clock against this laptop's clock; row times are moved onto the laptop's clock (lib/data/clock-offset.ts). */
  const clock = createClockOffset();
  const onLaptopClock = (raw: DataRows, snapshot: boolean): DataRows => shiftRows(raw, -clock.update(raw, now(), snapshot));

  let running = false;
  let bindings: SpacetimeBindings | null = null;
  let conn: AnyDbConnection | null = null;
  /** Bumped on every new connection and on stop, so callbacks from an old connection are ignored. */
  let attemptId = 0;
  let failures = 0;
  let unwatch: (() => void) | null = null;
  let offlineTimer: unknown = null;
  let retryTimer: unknown = null;
  let readTimer: unknown = null;

  const set = (patch: Parameters<typeof store.set>[0]) => store.set(patch, now());

  const clear = (handle: unknown) => {
    if (handle !== null) clearTimer(handle);
    return null;
  };

  const goOffline = (reason: OfflineReason, text: string | null) => {
    offlineTimer = clear(offlineTimer);
    set({ connection: 'offline', reason, errorText: text });
  };

  /** Starts the 10 s countdown to Offline, unless one is already running. */
  const armOffline = () => {
    if (offlineTimer !== null) return;
    offlineTimer = setTimer(() => {
      offlineTimer = null;
      if (running && store.get().connection !== 'live') set({ connection: 'offline', reason: 'network' });
    }, OFFLINE_AFTER_MS);
  };

  const detach = () => {
    attemptId++;
    readTimer = clear(readTimer);
    if (unwatch) {
      try {
        unwatch();
      } catch {
        // A failed unregister must not stop the teardown.
      }
      unwatch = null;
    }
    const old = conn;
    conn = null;
    if (old) {
      try {
        old.disconnect();
      } catch {
        // Already closed.
      }
    }
  };

  const readRows = (id: number) => {
    readTimer = null;
    if (!running || id !== attemptId || !conn || !bindings) return;
    try {
      set({ rows: onLaptopClock(bindings.read(conn), false) });
    } catch (error) {
      // A mapping bug keeps the last good rows on screen and shows its text in the tooltip.
      console.error('NeuroLingo: could not read the SpacetimeDB rows', error);
      set({ errorText: errorText(error) });
    }
  };

  const scheduleRead = (id: number) => {
    if (readTimer !== null) return;
    readTimer = setTimer(() => readRows(id), READ_COALESCE_MS);
  };

  /** The connection is down. `sdkRetries` says whether the SDK will reconnect on its own. */
  const lost = (id: number, error: unknown, sdkRetries: boolean) => {
    if (!running || id !== attemptId) return;
    const state = store.get();
    const connection = state.connection === 'offline' ? 'offline' : state.ready ? 'reconnecting' : 'connecting';
    set({ connection, errorText: errorText(error) ?? state.errorText });
    armOffline();
    if (!sdkRetries) scheduleRebuild();
  };

  const scheduleRebuild = () => {
    detach();
    if (retryTimer !== null) return;
    const wait = RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)] ?? 8_000;
    failures++;
    retryTimer = setTimer(() => {
      retryTimer = null;
      if (running) connect();
    }, wait);
  };

  const onConnected = (id: number, connected: AnyDbConnection) => {
    if (!running || id !== attemptId || !bindings) return;
    conn = connected;
    failures = 0;
    const active = bindings;
    unwatch = active.watch(connected, () => scheduleRead(id));
    connected
      .subscriptionBuilder()
      .onApplied(() => {
        if (!running || id !== attemptId) return;
        offlineTimer = clear(offlineTimer);
        try {
          // A (re)applied subscription holds old rows: a snapshot, which never moves the clock offset.
          set({ rows: onLaptopClock(active.read(connected), true), connection: 'live', ready: true, reason: null, errorText: null });
        } catch (error) {
          console.error('NeuroLingo: could not read the SpacetimeDB rows', error);
          set({ connection: 'live', ready: true, reason: null, errorText: errorText(error) });
        }
      })
      .onError((ctx) => {
        if (!running || id !== attemptId) return;
        goOffline('subscription', errorText(ctx.event));
      })
      .subscribe(active.queries);
  };

  const connect = () => {
    if (!running || !bindings) return;
    const id = ++attemptId;
    try {
      conn = bindings
        .builder()
        .withUri(settings.host)
        .withDatabaseName(settings.db)
        .withAutomaticReconnect(AUTOMATIC_RECONNECT)
        .onConnect((connected) => onConnected(id, connected))
        .onAutomaticReconnect(() => {
          // The subscription replays on its own; onApplied above sets Live again.
        })
        .onConnectError((_ctx, error, nextAttempt) => lost(id, error, nextAttempt !== undefined))
        .onDisconnect((_ctx, error, nextAttempt) => lost(id, error, nextAttempt !== undefined))
        .build();
    } catch (error) {
      lost(id, error, false);
    }
  };

  return {
    mode: 'spacetime',
    getState: store.get,
    subscribe: store.subscribe,
    start() {
      if (running) return;
      running = true;
      const startId = ++attemptId;
      set({ connection: store.get().ready ? 'reconnecting' : 'connecting', reason: null, errorText: null });
      armOffline();
      loadBindings().then(
        (loaded) => {
          if (!running || startId !== attemptId) return;
          if (!loaded) {
            goOffline('no-bindings', 'This build has no generated SpacetimeDB bindings. See web/lib/data/spacetime-bindings.ts.');
            return;
          }
          bindings = loaded;
          connect();
        },
        (error: unknown) => {
          if (!running || startId !== attemptId) return;
          goOffline('no-bindings', errorText(error));
        },
      );
    },
    stop() {
      running = false;
      offlineTimer = clear(offlineTimer);
      retryTimer = clear(retryTimer);
      detach();
    },
  };
}
