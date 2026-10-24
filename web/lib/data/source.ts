/**
 * The interface every data source implements (SpacetimeDB, the sample replay, or none), plus a
 * tiny store the sources share. The provider reads a source with React's useSyncExternalStore.
 */
import { EMPTY_ROWS, type OfflineReason, type SourceMode, type SourceState } from './types';

export interface DataSource {
  readonly mode: SourceMode;
  /** The current state. Returns the same object until something changes. */
  getState(): SourceState;
  /** Calls `listener` after every change. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Connect or start playing. Safe to call again after stop() (React Strict Mode does). */
  start(): void;
  /** Disconnect and clear every timer. */
  stop(): void;
}

/** What every source reports before it starts, and what the server renders. */
export function initialState(mode: SourceMode): SourceState {
  return {
    mode,
    connection: 'connecting',
    ready: false,
    reason: null,
    errorText: null,
    since: 0,
    rows: EMPTY_ROWS,
  };
}

export interface StateStore {
  get(): SourceState;
  /** Shallow-merges `patch`. Bumps `since` when the connection changes. Notifies listeners. */
  set(patch: Partial<SourceState>, now: number): void;
  subscribe(listener: () => void): () => void;
}

export function createStateStore(initial: SourceState): StateStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch, now) {
      const next: SourceState = { ...state, ...patch };
      if (next.connection !== state.connection) next.since = now;
      state = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export interface OfflineSourceOptions {
  /** Default 'none'. The provider passes 'replay' when the replay's code could not be loaded. */
  mode?: SourceMode;
  /** Default 'not-configured'. */
  reason?: OfflineReason;
  /** Raw error text for the tooltip. */
  errorText?: string | null;
  now?: () => number;
}

/** No SpacetimeDB settings and no replay, or a source that could not load: honestly not connected. */
export function createNoneSource(options: OfflineSourceOptions = {}): DataSource {
  const mode = options.mode ?? 'none';
  const now = options.now ?? Date.now;
  const store = createStateStore(initialState(mode));
  return {
    mode,
    getState: store.get,
    subscribe: store.subscribe,
    start() {
      store.set({ connection: 'offline', ready: false, reason: options.reason ?? 'not-configured', errorText: options.errorText ?? null }, now());
    },
    stop() {},
  };
}

/** A source that has not started yet: what the server renders, and what shows while a source's code loads. */
export function createPendingSource(mode: SourceMode): DataSource {
  const state = initialState(mode);
  return {
    mode,
    getState: () => state,
    subscribe: () => () => {},
    start() {},
    stop() {},
  };
}
