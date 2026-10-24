/**
 * One authenticated connection per role page (lib/role/connection.ts, docs/station.md 1.5 and 7.2 C1), against a fake
 * of the spacetimedb 2.13.0 builder: the saved token goes in, a new token is saved, callbacks are registered once per
 * connection object, failed first connects are rebuilt after 1, 2, 4 and 8 s, Offline after 10 s, and a refused
 * saved token stops the retries.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createRoleConnection, ROLE_OFFLINE_AFTER_MS, ROLE_RETRY_DELAYS_MS } from '../lib/role/connection';
import { tokenKey } from '../lib/role/storage';
import { FakeBuilder, FakeConnection, fakeTimers, memoryStorage, tokenError } from './role-fakes';

const SETTINGS = { host: 'https://maincloud.spacetimedb.com', db: 'say-when-dev' };
const KEY = 'https://maincloud.spacetimedb.com/say-when-dev/auth_token/station';

function harness(options: { storage?: ReturnType<typeof memoryStorage> | null; attach?: (conn: FakeConnection) => (() => void) | void } = {}) {
  const clock = fakeTimers();
  const builders: FakeBuilder[] = [];
  const storage = options.storage === undefined ? memoryStorage() : options.storage;
  const applied: FakeConnection[] = [];
  const connection = createRoleConnection<any>({
    role: 'station',
    settings: SETTINGS,
    queries: ['config', 'scan_state'],
    attach: options.attach as any,
    onApplied: (conn) => applied.push(conn as FakeConnection),
    builder: () => {
      const builder = new FakeBuilder();
      builders.push(builder);
      return builder as any;
    },
    storage,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, builders, storage, connection, applied, latest: () => builders[builders.length - 1]! };
}

describe('the role connection', () => {
  test('a first visit connects without a token, saves the new one under the role key, and goes Live', () => {
    const h = harness();
    h.connection.start();
    const builder = h.latest();
    assert.equal(builder.uri, SETTINGS.host);
    assert.equal(builder.db, SETTINGS.db);
    assert.equal(builder.token, undefined, 'no token on a first visit');
    assert.deepEqual(builder.reconnect, { minDelayMs: 1_000, maxDelayMs: 8_000 });
    assert.equal(h.connection.getState().status, 'connecting');

    builder.connect('c200aa', 'secret-token-1');
    const state = h.connection.getState();
    assert.equal(state.status, 'live');
    assert.equal(state.ready, true);
    assert.equal(state.identityHex, 'c200aa');
    assert.equal(state.tokenSaved, true);
    assert.equal(h.storage!.items.get(KEY), 'secret-token-1');
    assert.equal(KEY, tokenKey(SETTINGS, 'station'));
    assert.deepEqual(builder.connection!.subscriptions[0]!.queries, ['config', 'scan_state']);
    assert.equal(h.applied.length, 1);
    assert.equal(h.connection.conn(), builder.connection);
    h.connection.stop();
  });

  test('a reload sends the saved token, and the same token is not written again', () => {
    const storage = memoryStorage();
    storage.setItem(KEY, 'secret-token-1');
    let writes = 0;
    const counting = { ...storage, setItem: (k: string, v: string) => (writes++, storage.setItem(k, v)) };
    const h = harness({ storage: counting as ReturnType<typeof memoryStorage> });
    h.connection.start();
    assert.equal(h.latest().token, 'secret-token-1');
    h.latest().connect('c200aa', 'secret-token-1');
    assert.equal(writes, 0);
    assert.equal(h.connection.getState().tokenSaved, true);
    h.connection.stop();
  });

  test('a browser that will not keep the token says so (a private window)', () => {
    const throwing = {
      items: new Map<string, string>(),
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    const h = harness({ storage: throwing });
    h.connection.start();
    assert.equal(h.latest().token, undefined);
    h.latest().connect('c200aa', 'secret-token-1');
    assert.equal(h.connection.getState().status, 'live');
    assert.equal(h.connection.getState().tokenSaved, false);
    h.connection.stop();
  });

  test('row callbacks are registered once per connection object and removed on stop', () => {
    let attached = 0;
    let detached = 0;
    const h = harness({
      attach: () => {
        attached++;
        return () => {
          detached++;
        };
      },
    });
    h.connection.start();
    h.latest().connect('c200aa', 't');
    // A drop the SDK repairs on its own keeps the same object and its callbacks.
    h.latest().callbacks.disconnect?.({}, new Error('socket closed'), 1, 1_000);
    h.latest().callbacks.automaticReconnect?.(h.latest().connection, { toHexString: () => 'c200aa' }, 't');
    h.latest().connection!.subscriptions[0]!.applied?.({});
    assert.equal(attached, 1);
    assert.equal(h.connection.getState().status, 'live');
    h.connection.stop();
    assert.equal(detached, 1);
    assert.equal(h.connection.getState().ready, false);
  });

  test('a failed first connect is rebuilt after 1, 2, 4, then 8 s, and is Offline after 10 s', () => {
    const h = harness();
    h.connection.start();
    assert.deepEqual([...ROLE_RETRY_DELAYS_MS], [1_000, 2_000, 4_000, 8_000]);
    h.latest().callbacks.connectError?.({}, new Error('refused'), undefined, undefined);
    assert.equal(h.connection.getState().status, 'connecting');
    h.clock.advance(999);
    assert.equal(h.builders.length, 1);
    h.clock.advance(1);
    assert.equal(h.builders.length, 2, 'rebuilt after 1 s');
    h.latest().callbacks.connectError?.({}, new Error('refused'), undefined, undefined);
    h.clock.advance(2_000);
    assert.equal(h.builders.length, 3, 'then after 2 s');
    h.latest().callbacks.connectError?.({}, new Error('refused'), undefined, undefined);
    h.clock.advance(4_000);
    assert.equal(h.builders.length, 4, 'then after 4 s');
    assert.equal(h.connection.getState().status, 'connecting', '7 s in: still connecting');
    h.latest().callbacks.connectError?.({}, new Error('refused'), undefined, undefined);
    h.clock.advance(3_000);
    assert.equal(h.connection.getState().status, 'offline', 'Offline after 10 s without a live connection');
    assert.equal(h.connection.getState().problem, 'network');
    h.clock.advance(5_000);
    assert.equal(h.builders.length, 5, 'then every 8 s');
    h.latest().connect('c200aa', 't');
    assert.equal(h.connection.getState().status, 'live');
    assert.equal(h.connection.getState().problem, null);
    h.connection.stop();
    assert.equal(ROLE_OFFLINE_AFTER_MS, 10_000);
  });

  test('a drop the SDK retries shows Reconnecting with the rows kept, and does not rebuild', () => {
    const h = harness();
    h.connection.start();
    h.latest().connect('c200aa', 't');
    h.latest().callbacks.disconnect?.({}, new Error('socket closed'), 1, 1_000);
    assert.equal(h.connection.getState().status, 'reconnecting');
    assert.equal(h.connection.getState().ready, true);
    h.clock.advance(ROLE_OFFLINE_AFTER_MS);
    assert.equal(h.connection.getState().status, 'offline');
    assert.equal(h.builders.length, 1, 'the SDK reconnects on its own');
    h.connection.stop();
  });

  test('a refused saved token is not retried, and Forget removes it', () => {
    const storage = memoryStorage();
    storage.setItem(KEY, 'old-token');
    const h = harness({ storage });
    h.connection.start();
    h.latest().callbacks.connectError?.({}, tokenError(401), undefined, undefined);
    const state = h.connection.getState();
    assert.equal(state.status, 'offline');
    assert.equal(state.problem, 'token_rejected');
    h.clock.advance(60_000);
    assert.equal(h.builders.length, 1, 'no rebuild with a refused token');
    assert.equal(h.connection.forget(), true);
    assert.equal(storage.items.has(KEY), false);
    // Other errors with a 5xx status are network trouble, not a refusal.
    const h2 = harness();
    h2.connection.start();
    h2.latest().callbacks.connectError?.({}, tokenError(503), undefined, undefined);
    assert.equal(h2.connection.getState().problem, null);
    h2.clock.advance(1_000);
    assert.equal(h2.builders.length, 2);
    h2.connection.stop();
  });

  test('a reconnect that comes back as another identity stops', () => {
    const h = harness();
    h.connection.start();
    h.latest().connect('c200aa', 't');
    const changed = new Error('identity changed');
    changed.name = 'IdentityChangedError';
    h.latest().callbacks.disconnect?.({}, changed, undefined, undefined);
    assert.equal(h.connection.getState().problem, 'identity_changed');
    assert.equal(h.connection.getState().status, 'offline');
    h.clock.advance(60_000);
    assert.equal(h.builders.length, 1);
  });

  test('a refused subscription is Offline with its reason', () => {
    const h = harness();
    h.connection.start();
    const builder = h.latest();
    builder.callbacks.connect?.(builder.connection, { toHexString: () => 'c200aa' }, 't');
    builder.connection!.subscriptions[0]!.error?.({ event: new Error('no such table') });
    assert.equal(h.connection.getState().status, 'offline');
    assert.equal(h.connection.getState().problem, 'subscription');
    h.connection.stop();
  });

  test('whenLive resolves when Live, or false after its timeout', async () => {
    const h = harness();
    h.connection.start();
    const waiting = h.connection.whenLive(5_000);
    h.latest().connect('c200aa', 't');
    assert.equal(await waiting, true);
    h.latest().callbacks.disconnect?.({}, new Error('gone'), 1, 1_000);
    const late = h.connection.whenLive(2_000);
    h.clock.advance(2_000);
    assert.equal(await late, false);
    h.connection.stop();
    assert.equal(await h.connection.whenLive(1_000), false, 'a stopped connection never comes back on its own');
  });

  test('stop then start (React Strict Mode) builds a fresh connection and ignores the old one', () => {
    const h = harness();
    h.connection.start();
    const first = h.latest();
    h.connection.stop();
    assert.equal(first.connection!.disconnects, 1);
    h.connection.start();
    const second = h.latest();
    assert.notEqual(first, second);
    first.connect('c200old', 'old');
    assert.equal(h.connection.getState().identityHex, null, 'callbacks from the old connection are ignored');
    second.connect('c200aa', 't');
    assert.equal(h.connection.getState().identityHex, 'c200aa');
    h.connection.stop();
  });
});
