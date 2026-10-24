/**
 * One authenticated SpacetimeDB connection for one role page (docs/station.md 1.5, 7.2 C1). Plain TypeScript outside
 * React, so the callbacks that drive audio are registered once per connection object, never in a render.
 *
 * - Token: read from `<host>/<db>/auth_token/<role>` (lib/role/storage.ts) and passed with `withToken` (undefined on
 *   a first visit, when the server makes a new identity). `onConnect` and `onAutomaticReconnect` save the token the
 *   server returns when it differs. The token is never logged, shown or put in an address.
 * - Reconnects: `withAutomaticReconnect({ minDelayMs: 1000, maxDelayMs: 8000 })`. The SDK never retries a failed
 *   first connect, so this file rebuilds after 1, 2, 4, then every 8 s. Offline after 10 s without a live connection.
 * - A saved token the server refuses (HTTP 401 or 403 at `/v1/identity/websocket-token`) is not retried: the state
 *   says `token_rejected` and the page offers "Forget this device" (docs/station.md 5.7). The same for a reconnect
 *   that returns another identity (`identity_changed`).
 * - Live means connected and the role's subscription applied. The SDK replays the subscription after a reconnect.
 *
 * Checked against spacetimedb 2.13.0 (`dist/sdk/db_connection_builder.d.ts`, `db_connection_impl.d.ts`,
 * `index.browser.mjs` for WebSocketTokenError). Not yet run from a browser against Maincloud (docs/station.md 5.7).
 */
import type { DbConnectionBuilder, DbConnectionImpl, RowTypedQuery } from 'spacetimedb';
import { DbConnection } from '../data/module_bindings';
import type { SpacetimeSettings } from '../data/source-mode';
import { browserStorage, forgetToken, readToken, saveToken, type DeviceRole, type StorageLike } from './storage';

export type AnyDbConnection = DbConnectionImpl<any>;

export type RoleConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

export type RoleConnectionProblem =
  /** The server refused the saved token. Forget this device and pair again. */
  | 'token_rejected'
  /** A reconnect came back as another identity; the SDK stops reconnecting. */
  | 'identity_changed'
  /** The server refused the role's subscription. */
  | 'subscription'
  /** No live connection for 10 s. */
  | 'network';

export interface RoleConnectionState {
  status: RoleConnectionStatus;
  /** The role's subscription is applied on the current connection, so the client cache holds its rows. */
  ready: boolean;
  /** This browser's identity for this role, as hex. Identities are not secrets; the owner needs it to revoke. */
  identityHex: string | null;
  problem: RoleConnectionProblem | null;
  /** Raw error text, for a `title` tooltip only. */
  errorText: string | null;
  /** When `status` last changed, on the `now` clock. */
  since: number;
  /** False when this browser would not keep the token (a private window): every load is then a new identity. */
  tokenSaved: boolean | null;
}

export type RoleQuery = string | RowTypedQuery<any, any>;

export interface RoleConnectionOptions<Conn extends AnyDbConnection = DbConnection> {
  role: DeviceRole;
  settings: SpacetimeSettings;
  /** The role page's subscriptions, through the generated query builder, for example `[tables.config, tables.mySession]`. */
  queries: readonly RoleQuery[];
  /**
   * Register row callbacks on a new connection object (`conn.db.scanState.onUpdate(...)`). Called once per object,
   * before it subscribes; the SDK keeps them across its own reconnects. Return a function that removes them.
   */
  attach?: (conn: Conn) => (() => void) | void;
  /** Called each time the subscription is applied: at connect and after every reconnect. */
  onApplied?: (conn: Conn) => void;
  /** Defaults to the generated `DbConnection.builder()`. Tests pass a fake. */
  builder?: () => DbConnectionBuilder<Conn>;
  /** Defaults to the page's localStorage. */
  storage?: StorageLike | null;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface RoleConnection<Conn extends AnyDbConnection = DbConnection> {
  readonly role: DeviceRole;
  readonly settings: SpacetimeSettings;
  getState(): RoleConnectionState;
  /** Calls `listener` after every change. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Connect. Safe to call again after stop() (React Strict Mode does). */
  start(): void;
  /** Disconnect and clear every timer. */
  stop(): void;
  /** The current connection object, for `conn.reducers`, `conn.procedures` and `conn.db`, or null. */
  conn(): Conn | null;
  /** Resolves true as soon as the state is Live, or false after `timeoutMs`. */
  whenLive(timeoutMs: number): Promise<boolean>;
  /** Deletes this role's saved token and stops. The page then reloads to get a new identity. */
  forget(): boolean;
}

/** docs/ui.md: Offline after 10 s without a live connection. */
export const ROLE_OFFLINE_AFTER_MS = 10_000;

/** Waits between rebuilds after a failed first connect (docs/station.md 1.5). */
export const ROLE_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];

export const ROLE_AUTOMATIC_RECONNECT = { minDelayMs: 1_000, maxDelayMs: 8_000 } as const;

function errorText(error: unknown): string | null {
  if (error === undefined || error === null) return null;
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

/** A saved token the server refused: WebSocketTokenError with status 401 or 403 (spacetimedb 2.13.0). */
export function isTokenRejected(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'WebSocketTokenError') return false;
  const status = (error as { status?: unknown }).status;
  return status === 401 || status === 403;
}

export function isIdentityChanged(error: unknown): boolean {
  return error instanceof Error && error.name === 'IdentityChangedError';
}

interface IdentityLike {
  toHexString(): string;
}

export function createRoleConnection<Conn extends AnyDbConnection = DbConnection>(options: RoleConnectionOptions<Conn>): RoleConnection<Conn> {
  const { role, settings } = options;
  const builder = options.builder ?? ((() => DbConnection.builder()) as unknown as () => DbConnectionBuilder<Conn>);
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let state: RoleConnectionState = {
    status: 'connecting',
    ready: false,
    identityHex: null,
    problem: null,
    errorText: null,
    since: now(),
    tokenSaved: null,
  };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<RoleConnectionState>) => {
    const next = { ...state, ...patch };
    if (next.status !== state.status) next.since = now();
    state = next;
    for (const listener of [...listeners]) listener();
  };

  let running = false;
  let current: Conn | null = null;
  /** Bumped on every new connection object and on stop, so callbacks from an old one are ignored. */
  let attemptId = 0;
  let failures = 0;
  let detachRows: (() => void) | null = null;
  let offlineTimer: unknown = null;
  let retryTimer: unknown = null;

  const clear = (handle: unknown) => {
    if (handle !== null) clearTimer(handle);
    return null;
  };

  const armOffline = () => {
    if (offlineTimer !== null) return;
    offlineTimer = setTimer(() => {
      offlineTimer = null;
      if (running && state.status !== 'live') set({ status: 'offline', problem: state.problem ?? 'network' });
    }, ROLE_OFFLINE_AFTER_MS);
  };

  const keepToken = (token: string | undefined) => {
    if (typeof token !== 'string' || token === '') return;
    if (readToken(settings, role, storage) === token) {
      if (state.tokenSaved !== true) set({ tokenSaved: true });
      return;
    }
    set({ tokenSaved: saveToken(settings, role, token, storage) });
  };

  const detach = () => {
    attemptId++;
    if (detachRows) {
      try {
        detachRows();
      } catch {
        // A failed unregister must not stop the teardown.
      }
      detachRows = null;
    }
    const old = current;
    current = null;
    if (old) {
      try {
        old.disconnect();
      } catch {
        // Already closed.
      }
    }
  };

  const scheduleRebuild = () => {
    detach();
    if (retryTimer !== null) return;
    const wait = ROLE_RETRY_DELAYS_MS[Math.min(failures, ROLE_RETRY_DELAYS_MS.length - 1)] ?? 8_000;
    failures++;
    retryTimer = setTimer(() => {
      retryTimer = null;
      if (running) connect();
    }, wait);
  };

  /** The connection is down. `sdkRetries` says whether the SDK will reconnect on its own. */
  const lost = (id: number, error: unknown, sdkRetries: boolean) => {
    if (!running || id !== attemptId) return;
    if (isTokenRejected(error) || isIdentityChanged(error)) {
      // Retrying cannot help: the same token gets the same answer. Stop until the page forgets this device.
      offlineTimer = clear(offlineTimer);
      retryTimer = clear(retryTimer);
      detach();
      set({ status: 'offline', ready: false, problem: isTokenRejected(error) ? 'token_rejected' : 'identity_changed', errorText: errorText(error) });
      return;
    }
    const status = state.status === 'offline' ? 'offline' : state.ready ? 'reconnecting' : 'connecting';
    set({ status, errorText: errorText(error) ?? state.errorText });
    armOffline();
    if (!sdkRetries) scheduleRebuild();
  };

  const onConnected = (id: number, conn: Conn, identity: IdentityLike, token: string) => {
    if (!running || id !== attemptId) return;
    current = conn;
    failures = 0;
    keepToken(token);
    set({ identityHex: identity.toHexString(), problem: null });
    if (options.attach) {
      try {
        detachRows = options.attach(conn) ?? null;
      } catch (error) {
        console.error('Eleven: a role page could not register its row callbacks', error);
      }
    }
    conn
      .subscriptionBuilder()
      .onApplied(() => {
        if (!running || id !== attemptId) return;
        offlineTimer = clear(offlineTimer);
        set({ status: 'live', ready: true, problem: null, errorText: null });
        try {
          options.onApplied?.(conn);
        } catch (error) {
          console.error('Eleven: a role page failed after its subscription applied', error);
        }
      })
      .onError((ctx: { event?: unknown }) => {
        if (!running || id !== attemptId) return;
        offlineTimer = clear(offlineTimer);
        set({ status: 'offline', problem: 'subscription', errorText: errorText(ctx?.event) });
      })
      .subscribe([...options.queries]);
  };

  const connect = () => {
    if (!running) return;
    const id = ++attemptId;
    try {
      const built = builder()
        .withUri(settings.host)
        .withDatabaseName(settings.db)
        .withToken(readToken(settings, role, storage))
        .withAutomaticReconnect(ROLE_AUTOMATIC_RECONNECT)
        .onConnect((conn, identity, token) => onConnected(id, conn, identity, token))
        .onAutomaticReconnect((_conn, identity, token) => {
          if (!running || id !== attemptId) return;
          // The subscription replays on its own; onApplied sets Live again.
          keepToken(token);
          if (identity) set({ identityHex: identity.toHexString() });
        })
        .onConnectError((_ctx, error, nextAttempt) => lost(id, error, nextAttempt !== undefined))
        .onDisconnect((_ctx, error, nextAttempt) => lost(id, error, nextAttempt !== undefined))
        .build();
      // Calls made before onConnect still go through this object; detach() disconnects it.
      if (id === attemptId && current === null) current = built;
    } catch (error) {
      lost(id, error, false);
    }
  };

  const whenLive = (timeoutMs: number): Promise<boolean> => {
    if (state.status === 'live') return Promise.resolve(true);
    if (!running) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (value: boolean) => {
        if (done) return;
        done = true;
        listeners.delete(check);
        clearTimer(timer);
        resolve(value);
      };
      const check = () => {
        if (state.status === 'live') finish(true);
        else if (!running) finish(false);
      };
      const timer = setTimer(() => finish(false), Math.max(0, timeoutMs));
      listeners.add(check);
    });
  };

  return {
    role,
    settings,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      if (running) return;
      running = true;
      failures = 0;
      set({ status: state.ready ? 'reconnecting' : 'connecting', problem: null, errorText: null });
      armOffline();
      connect();
    },
    stop() {
      running = false;
      offlineTimer = clear(offlineTimer);
      retryTimer = clear(retryTimer);
      detach();
      // Stopped is not Live: a later start() connects again from Connecting.
      set({ status: 'connecting', ready: false });
    },
    conn: () => current,
    whenLive,
    forget() {
      const removed = forgetToken(settings, role, storage);
      running = false;
      offlineTimer = clear(offlineTimer);
      retryTimer = clear(retryTimer);
      detach();
      set({ ready: false, identityHex: null, tokenSaved: null });
      return removed;
    },
  };
}
