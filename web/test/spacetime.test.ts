/**
 * The SpacetimeDB source's connection lifecycle, against a fake of the spacetimedb 2.13.0 builder and
 * connection, and the real bindings file against a fake client cache. Nothing here reaches a network.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DbConnection } from '../lib/data/module_bindings';
import { createSpacetimeSource, OFFLINE_AFTER_MS, RETRY_DELAYS_MS, type SpacetimeBindings } from '../lib/data/spacetime';
import { boardRows, type BoardSnapshot } from '../lib/data/spacetime-map';
import { EMPTY_ROWS, type CommandEvent, type DataRows } from '../lib/data/types';
import { midScan, read, wordTiming } from './board-fixtures';

type Callback = (...args: any[]) => void;

/**
 * A client cache with the ten tables and views the dashboard subscribes to: each table iterates its rows and keeps the
 * row callbacks registered on it, by kind, so a test can fire them and check they are removed.
 */
function fakeBoardConnection(board: BoardSnapshot) {
  const listeners = new Map<string, Map<'insert' | 'delete' | 'update', Set<() => void>>>();
  const table = (name: string, rows: readonly unknown[]) => {
    const kinds = new Map<'insert' | 'delete' | 'update', Set<() => void>>([
      ['insert', new Set()],
      ['delete', new Set()],
      ['update', new Set()],
    ]);
    listeners.set(name, kinds);
    const on = (kind: 'insert' | 'delete' | 'update') => (callback: () => void) => void kinds.get(kind)!.add(callback);
    const off = (kind: 'insert' | 'delete' | 'update') => (callback: () => void) => void kinds.get(kind)!.delete(callback);
    return {
      iter: () => rows[Symbol.iterator](),
      onInsert: on('insert'),
      removeOnInsert: off('insert'),
      onDelete: on('delete'),
      removeOnDelete: off('delete'),
      onUpdate: on('update'),
      removeOnUpdate: off('update'),
    };
  };
  const db = {
    config: table('config', board.config),
    scanState: table('scan_state', board.scanStates),
    boardEvents: table('board_events', board.pipelineEvents),
    deviceStatus: table('device_status', board.devices),
    publicBoard: table('public_board', board.questions),
    boardPayloads: table('board_payloads', board.payloads),
    boardErrands: table('board_errands', board.errands),
    boardCalls: table('board_calls', board.calls),
    boardSessionLedger: table('board_session_ledger', board.ledger),
    boardWordTimings: table('board_word_timings', board.wordTimings ?? []),
  };
  return { conn: { db } as unknown as DbConnection, listeners };
}

class FakeSubscription {
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

class FakeConnection {
  disconnects = 0;
  subscriptions: FakeSubscription[] = [];
  subscriptionBuilder() {
    const sub = new FakeSubscription();
    this.subscriptions.push(sub);
    return sub;
  }
  disconnect() {
    this.disconnects++;
  }
}

class FakeBuilder {
  uri = '';
  db = '';
  reconnect: unknown = null;
  callbacks: Record<string, Callback> = {};
  connection: FakeConnection | null = null;
  withUri(uri: string) {
    this.uri = uri;
    return this;
  }
  withDatabaseName(db: string) {
    this.db = db;
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
    this.connection = new FakeConnection();
    return this.connection;
  }
}

function harness(rows: DataRows | (() => DataRows) = EMPTY_ROWS) {
  let now = 1_000_000;
  const timers = new Map<number, { at: number; run: () => void }>();
  let nextId = 0;
  const builders: FakeBuilder[] = [];
  const changeListeners: Array<() => void> = [];
  let reads = 0;
  const bindings = {
    builder: () => {
      const builder = new FakeBuilder();
      builders.push(builder);
      return builder;
    },
    queries: ['SELECT * FROM question'],
    watch: (_conn: unknown, onChange: () => void) => {
      changeListeners.push(onChange);
      return () => {};
    },
    read: () => {
      reads++;
      return typeof rows === 'function' ? rows() : rows;
    },
  } as unknown as SpacetimeBindings;

  const source = createSpacetimeSource(
    { host: 'http://localhost:3000', db: 'say-when' },
    {
      loadBindings: async () => bindings,
      now: () => now,
      setTimer: (run, ms) => {
        timers.set(++nextId, { at: now + ms, run });
        return nextId;
      },
      clearTimer: (handle) => {
        timers.delete(handle as number);
      },
    },
  );

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
    source,
    builders,
    changeListeners,
    advance,
    timers,
    now: () => now,
    reads: () => reads,
    latest: () => builders[builders.length - 1]!,
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('SpacetimeDB source', () => {
  test('connects with the settings and a capped automatic reconnect, then goes Live when the subscription applies', async () => {
    const rows: DataRows = { ...EMPTY_ROWS, safety: { state: 'ok', since: 5 } };
    const h = harness(rows);
    h.source.start();
    assert.equal(h.source.getState().connection, 'connecting');
    await flush();

    const builder = h.latest();
    assert.equal(builder.uri, 'http://localhost:3000');
    assert.equal(builder.db, 'say-when');
    assert.deepEqual(builder.reconnect, { minDelayMs: 1_000, maxDelayMs: 8_000 });

    builder.callbacks.connect?.(builder.connection, {}, 'token');
    const sub = builder.connection!.subscriptions[0]!;
    assert.deepEqual(sub.queries, ['SELECT * FROM question']);
    sub.applied?.({});

    const state = h.source.getState();
    assert.equal(state.connection, 'live');
    assert.equal(state.ready, true);
    assert.equal(state.rows.safety.state, 'ok');

    // Row callbacks are read once per burst.
    const before = h.reads();
    h.changeListeners[0]?.();
    h.changeListeners[0]?.();
    h.advance(20);
    assert.equal(h.reads(), before + 1);
    h.source.stop();
  });

  test('a failed first connection is rebuilt with a doubling wait, and goes Offline after 10 s', async () => {
    const h = harness();
    h.source.start();
    await flush();
    assert.equal(h.builders.length, 1);

    h.latest().callbacks.connectError?.({}, new Error('refused'), undefined, undefined);
    assert.equal(h.source.getState().connection, 'connecting');
    assert.equal(h.source.getState().errorText, 'refused');
    h.advance(RETRY_DELAYS_MS[0]!);
    assert.equal(h.builders.length, 2, 'rebuilt after 1 s');

    h.latest().callbacks.connectError?.({}, new Error('refused again'), undefined, undefined);
    h.advance(RETRY_DELAYS_MS[1]! - 1);
    assert.equal(h.builders.length, 2, 'waits 2 s the second time');
    h.advance(1);
    assert.equal(h.builders.length, 3);

    h.advance(OFFLINE_AFTER_MS);
    const offline = h.source.getState();
    assert.equal(offline.connection, 'offline');
    assert.equal(offline.reason, 'network');
    assert.equal(offline.mode, 'spacetime', 'never falls back to the replay');
    h.source.stop();
  });

  test('a dropped connection shows Reconnecting with the last rows, then Live again after the replayed subscription', async () => {
    const h = harness();
    h.source.start();
    await flush();
    const builder = h.latest();
    builder.callbacks.connect?.(builder.connection, {}, 'token');
    builder.connection!.subscriptions[0]!.applied?.({});
    assert.equal(h.source.getState().connection, 'live');

    builder.callbacks.disconnect?.({}, new Error('socket closed'), 1, 1_000);
    let state = h.source.getState();
    assert.equal(state.connection, 'reconnecting');
    assert.equal(state.ready, true, 'cached rows stay');
    assert.equal(h.builders.length, 1, 'the SDK retries on its own; no rebuild');

    builder.callbacks.automaticReconnect?.(builder.connection, {}, 'token');
    builder.connection!.subscriptions[0]!.applied?.({});
    state = h.source.getState();
    assert.equal(state.connection, 'live');
    assert.equal(state.errorText, null);

    h.advance(OFFLINE_AFTER_MS * 2);
    assert.equal(h.source.getState().connection, 'live', 'the offline countdown was cleared');
    h.source.stop();
  });

  test('a rejected subscription is Offline with its own reason', async () => {
    const h = harness();
    h.source.start();
    await flush();
    const builder = h.latest();
    builder.callbacks.connect?.(builder.connection, {}, 'token');
    builder.connection!.subscriptions[0]!.error?.({ event: new Error('no such table: question') });
    const state = h.source.getState();
    assert.equal(state.connection, 'offline');
    assert.equal(state.reason, 'subscription');
    assert.equal(state.errorText, 'no such table: question');
    h.source.stop();
  });

  test('no generated bindings: Offline at once, with the reason', async () => {
    const source = createSpacetimeSource(
      { host: 'http://localhost:3000', db: 'say-when' },
      { loadBindings: async () => null },
    );
    source.start();
    await flush();
    const state = source.getState();
    assert.equal(state.connection, 'offline');
    assert.equal(state.reason, 'no-bindings');
    assert.equal(state.mode, 'spacetime', 'never falls back to the replay');
    source.stop();
  });

  test("the bindings' chunk does not download: Offline for the network, not for missing bindings", async () => {
    const source = createSpacetimeSource(
      { host: 'http://localhost:3000', db: 'say-when' },
      { loadBindings: () => Promise.reject(new Error('Failed to fetch dynamically imported module')) },
    );
    source.start();
    await flush();
    const state = source.getState();
    assert.equal(state.connection, 'offline');
    assert.equal(state.reason, 'network');
    assert.match(state.errorText ?? '', /Could not load the SpacetimeDB client: Failed to fetch/);
    assert.equal(state.mode, 'spacetime', 'never falls back to the replay');
    source.stop();
  });

  test('the real bindings file is wired: it subscribes to the anonymous board tables and the session-scoped views', async () => {
    const { bindings } = await import('../lib/data/spacetime-bindings');
    assert.ok(bindings, 'wired to the generated module');
    const sql = bindings.queries.map((query) => (typeof query === 'string' ? query : (query as unknown as { toSql(): string }).toSql()));
    assert.deepEqual(sql, [
      'SELECT * FROM "config"',
      'SELECT * FROM "scan_state"',
      'SELECT * FROM "board_events"',
      'SELECT * FROM "device_status"',
      'SELECT * FROM "public_board"',
      'SELECT * FROM "board_payloads"',
      'SELECT * FROM "board_errands"',
      'SELECT * FROM "board_calls"',
      'SELECT * FROM "board_session_ledger"',
      'SELECT * FROM "board_word_timings"',
    ]);
    // The unscoped table and view grow with every session the database ever ran (docs/spacetime.md 14).
    assert.ok(!sql.some((query) => /"pipeline_event"|"board_ledger"/.test(query)));
  });

  test('the real bindings watch every subscribed table for inserts, deletes and updates, and the cleanup removes them all', async () => {
    const { bindings } = await import('../lib/data/spacetime-bindings');
    const fake = fakeBoardConnection(midScan());
    let changes = 0;
    const unwatch = bindings.watch(fake.conn, () => changes++);
    assert.equal(fake.listeners.size, 10);
    for (const [table, kinds] of fake.listeners) {
      for (const [kind, callbacks] of kinds) assert.equal(callbacks.size, 1, `${table} ${kind}`);
    }
    for (const kinds of fake.listeners.values()) for (const callbacks of kinds.values()) for (const callback of callbacks) callback();
    assert.equal(changes, 30);
    unwatch();
    for (const kinds of fake.listeners.values()) for (const callbacks of kinds.values()) assert.equal(callbacks.size, 0);
  });

  test('the real bindings read the client cache through boardRows, word timings included', async () => {
    const { bindings } = await import('../lib/data/spacetime-bindings');
    const rows = bindings.read(fakeBoardConnection(midScan()).conn);
    assert.deepEqual(rows, boardRows(midScan()));
    assert.equal(rows.scan?.cursor, 2);
    assert.equal(rows.options.length, 4);
    const timed = midScan({
      pipelineEvents: [...midScan().pipelineEvents, read(44, 5_000, { optionId: 102, rank: 2, stepSeq: 8 })],
      wordTimings: [wordTiming(44, [0, 240], [220, 520])],
    });
    const words = bindings.read(fakeBoardConnection(timed).conn).pipelineEvents.find((event) => event.id === '44')?.detail;
    assert.deepEqual((words as { words?: unknown }).words, [
      { startMs: 0, endMs: 220 },
      { startMs: 240, endMs: 520 },
    ]);
  });

  test('row times move onto the laptop clock when the server clock runs ahead, counted from new events only', async () => {
    const SERVER_AHEAD_MS = 3_000;
    const yes = (id: string, at: number): CommandEvent => ({
      id,
      command: 'PICK_1',
      at,
      accepted: true,
      ignoredReason: null,
      confidence: 0.9,
      questionId: null,
      optionId: null,
    });
    let commands: CommandEvent[] = [];
    const h = harness(() => ({ ...EMPTY_ROWS, commands }));
    commands = [yes('old', h.now() + SERVER_AHEAD_MS - 60_000)];
    h.source.start();
    await flush();
    const builder = h.latest();
    builder.callbacks.connect?.(builder.connection, {}, 'token');
    builder.connection!.subscriptions[0]!.applied?.({});
    assert.equal(h.source.getState().rows.commands[0]?.at, commands[0]!.at, 'the first read is a snapshot, so nothing moves');

    // A new command written on the server clock, arriving 40 ms later and read in the next burst.
    h.advance(5_000);
    const written = h.now() + SERVER_AHEAD_MS;
    commands = [...commands, yes('new', written)];
    h.advance(40);
    h.changeListeners[0]?.();
    h.advance(20);
    const shown = h.source.getState().rows.commands.find((c) => c.id === 'new')!;
    assert.ok(Math.abs(shown.at - h.now()) <= 100, `the new command shows ${shown.at - h.now()} ms from the laptop's now`);
    const old = h.source.getState().rows.commands.find((c) => c.id === 'old')!;
    assert.equal(written - shown.at, commands[0]!.at - old.at, 'every row moves by the same offset');
    h.source.stop();
  });

  test('stop disconnects, clears every timer, and ignores late callbacks', async () => {
    const h = harness();
    h.source.start();
    await flush();
    const builder = h.latest();
    builder.callbacks.connect?.(builder.connection, {}, 'token');
    h.source.stop();
    assert.equal(builder.connection!.disconnects, 1);
    assert.equal(h.timers.size, 0);
    builder.connection!.subscriptions[0]!.applied?.({});
    assert.notEqual(h.source.getState().connection, 'live');
  });
});
