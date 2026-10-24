/**
 * Fakes of the spacetimedb 2.13.0 builder and connection for the role page tests, plus a fake clock. Nothing here
 * opens a socket. The shapes follow `dist/sdk/db_connection_builder.d.ts` and the generated bindings.
 */
type Callback = (...args: any[]) => void;

export class FakeSubscription {
  applied: Callback | null = null;
  error: Callback | null = null;
  queries: unknown = null;
  onApplied(cb: Callback) {
    this.applied = cb;
    return this;
  }
  onError(cb: Callback) {
    this.error = cb;
    return this;
  }
  subscribe(queries: unknown) {
    this.queries = queries;
    return {};
  }
}

/** A table in the client cache with its rows and the row callbacks registered on it. */
export class FakeTable<Row> {
  rows: Row[] = [];
  readonly listeners = { insert: new Set<() => void>(), update: new Set<() => void>(), delete: new Set<() => void>() };
  iter() {
    return this.rows[Symbol.iterator]();
  }
  onInsert(cb: () => void) {
    this.listeners.insert.add(cb);
  }
  removeOnInsert(cb: () => void) {
    this.listeners.insert.delete(cb);
  }
  onUpdate(cb: () => void) {
    this.listeners.update.add(cb);
  }
  removeOnUpdate(cb: () => void) {
    this.listeners.update.delete(cb);
  }
  onDelete(cb: () => void) {
    this.listeners.delete.add(cb);
  }
  removeOnDelete(cb: () => void) {
    this.listeners.delete.delete(cb);
  }
  /** Replace the rows and fire the update callbacks, as a server update would. */
  set(rows: Row[]) {
    this.rows = rows;
    for (const cb of [...this.listeners.update]) cb();
    for (const cb of [...this.listeners.insert]) cb();
  }
  callbackCount() {
    return this.listeners.insert.size + this.listeners.update.size + this.listeners.delete.size;
  }
}

export interface FakeDeviceStatusRow {
  identity: { toHexString(): string };
  role: { tag: string };
  label: string;
  online: boolean;
  lastSeenAt: { microsSinceUnixEpoch: bigint };
  decoderHealthy: boolean | undefined;
}

export function deviceStatusRow(identityHex: string, role: 'Station' | 'Speaker' | 'Partner' | 'Agent', micros: bigint, label = role.toLowerCase()): FakeDeviceStatusRow {
  return {
    identity: { toHexString: () => identityHex },
    role: { tag: role },
    label,
    online: false,
    lastSeenAt: { microsSinceUnixEpoch: micros },
    decoderHealthy: undefined,
  };
}

export function fakeIdentity(hex: string) {
  return { toHexString: () => hex };
}

export class FakeConnection {
  disconnects = 0;
  subscriptions: FakeSubscription[] = [];
  readonly db = {
    deviceStatus: new FakeTable<FakeDeviceStatusRow>(),
    config: new FakeTable<{ pairingTtlMs: number }>(),
    scanState: new FakeTable<unknown>(),
  };
  readonly calls: Array<{ name: string; args: unknown }> = [];
  /** What each reducer call does: resolve, or reject with the given error. */
  reducerAnswer: (name: string, args: unknown) => Promise<void> = async () => {};
  mintAnswer: (purpose: string) => Promise<{ token: string; expiresAtMs: bigint; error: string }> = async () => ({
    token: '',
    expiresAtMs: 0n,
    error: 'voice_key_missing',
  });
  readonly reducers = {
    requestPairing: (args: unknown) => {
      this.calls.push({ name: 'requestPairing', args });
      return this.reducerAnswer('requestPairing', args);
    },
  };
  readonly procedures = {
    mintVoiceToken: (args: { purpose: string }) => {
      this.calls.push({ name: 'mintVoiceToken', args });
      return this.mintAnswer(args.purpose);
    },
  };
  subscriptionBuilder() {
    const sub = new FakeSubscription();
    this.subscriptions.push(sub);
    return sub;
  }
  disconnect() {
    this.disconnects++;
  }
}

export class FakeBuilder {
  uri = '';
  db = '';
  token: string | undefined = 'unset';
  reconnect: unknown = null;
  callbacks: Record<string, Callback> = {};
  connection: FakeConnection | null = null;
  constructor(private readonly make: () => FakeConnection = () => new FakeConnection()) {}
  withUri(uri: string) {
    this.uri = uri;
    return this;
  }
  withDatabaseName(db: string) {
    this.db = db;
    return this;
  }
  withToken(token?: string) {
    this.token = token;
    return this;
  }
  withAutomaticReconnect(options: unknown) {
    this.reconnect = options;
    return this;
  }
  onConnect(cb: Callback) {
    this.callbacks.connect = cb;
    return this;
  }
  onAutomaticReconnect(cb: Callback) {
    this.callbacks.automaticReconnect = cb;
    return this;
  }
  onConnectError(cb: Callback) {
    this.callbacks.connectError = cb;
    return this;
  }
  onDisconnect(cb: Callback) {
    this.callbacks.disconnect = cb;
    return this;
  }
  build() {
    this.connection = this.make();
    return this.connection;
  }
  /** The server accepted the connection: onConnect, then the subscription applies. */
  connect(identityHex: string, token: string) {
    this.callbacks.connect?.(this.connection, fakeIdentity(identityHex), token);
    // An ignored (stale) connection never subscribes, so there may be nothing to apply.
    this.connection?.subscriptions[this.connection.subscriptions.length - 1]?.applied?.({});
  }
}

/** A fake clock with timers that run only when the test advances time. */
export function fakeTimers(start = 1_000_000) {
  let now = start;
  let nextId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].run();
    }
    now = end;
  };
  return {
    now: () => now,
    setTimer: (run: () => void, ms: number) => {
      timers.set(++nextId, { at: now + ms, run });
      return nextId;
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number);
    },
    advance,
    pending: () => timers.size,
  };
}

export function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

/** Lets pending promise callbacks run. */
export const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A WebSocketTokenError as spacetimedb 2.13.0 throws it for a refused saved token. */
export function tokenError(status: number): Error {
  const error = new Error(`Failed to verify token: ${status} Unauthorized`) as Error & { status: number };
  error.name = 'WebSocketTokenError';
  error.status = status;
  return error;
}
