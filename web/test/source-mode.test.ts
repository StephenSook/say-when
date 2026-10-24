import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { describeConnection } from '../lib/data/connection';
import { createNoneSource, createPendingSource, initialState } from '../lib/data/source';
import { chooseSource, readReplayParam, withReplayParam } from '../lib/data/source-mode';

const ENV = { host: 'https://maincloud.spacetimedb.com', db: 'say-when' };

describe('chooseSource', () => {
  test('SpacetimeDB when both settings are present', () => {
    const choice = chooseSource({ nodeEnv: 'production', ...ENV, search: '' });
    assert.equal(choice.mode, 'spacetime');
    assert.deepEqual(choice.spacetime, ENV);
  });

  test('the sample replay in development, or with ?replay=1 anywhere', () => {
    assert.equal(chooseSource({ nodeEnv: 'development', host: undefined, db: undefined, search: '' }).mode, 'replay');
    assert.equal(chooseSource({ nodeEnv: 'production', host: undefined, db: undefined, search: '?replay=1' }).mode, 'replay');
    assert.equal(chooseSource({ nodeEnv: 'production', ...ENV, search: '?replay=1' }).mode, 'replay');
  });

  test('nothing in a production build with no settings: honestly not connected', () => {
    assert.equal(chooseSource({ nodeEnv: 'production', host: undefined, db: undefined, search: '' }).mode, 'none');
    assert.equal(chooseSource({ nodeEnv: 'production', host: '  ', db: 'say-when', search: '' }).mode, 'none');
    assert.equal(chooseSource({ nodeEnv: 'production', host: ENV.host, db: undefined, search: '' }).mode, 'none');
  });

  test('?replay=0 turns the development replay off, but never turns SpacetimeDB off', () => {
    assert.equal(chooseSource({ nodeEnv: 'development', host: undefined, db: undefined, search: '?replay=0' }).mode, 'none');
    assert.equal(chooseSource({ nodeEnv: 'development', ...ENV, search: '?replay=0' }).mode, 'spacetime');
  });

  test('replay flag spellings', () => {
    assert.equal(readReplayParam('?replay=1'), '1');
    assert.equal(readReplayParam('?replay=true'), '1');
    assert.equal(readReplayParam('?replay'), '1');
    assert.equal(readReplayParam('?replay=0'), '0');
    assert.equal(readReplayParam('?replay=off'), '0');
    assert.equal(readReplayParam('?replay=maybe'), null);
    assert.equal(readReplayParam(''), null);
  });
});

describe('withReplayParam', () => {
  test('keeps the flag on in-app links', () => {
    assert.equal(withReplayParam('/agents', null), '/agents');
    assert.equal(withReplayParam('/agents', '1'), '/agents?replay=1');
    assert.equal(withReplayParam('/live?q=2', '1'), '/live?q=2&replay=1');
    assert.equal(withReplayParam('/live?replay=0#events', '1'), '/live?replay=1#events');
  });
});

describe('sources that are not live', () => {
  test('no settings: Offline and not configured, with no rows', () => {
    const source = createNoneSource({ now: () => 42 });
    source.start();
    const state = source.getState();
    assert.equal(state.mode, 'none');
    assert.equal(state.connection, 'offline');
    assert.equal(state.reason, 'not-configured');
    assert.equal(state.ready, false);
    assert.equal(state.since, 42);
    assert.equal(state.rows.questions.length, 0);
  });

  test('a replay whose code could not load: still the replay mode, Offline, with the error for the tooltip', () => {
    const source = createNoneSource({ mode: 'replay', reason: 'network', errorText: 'Could not load the sample replay: chunk failed' });
    source.start();
    const info = describeConnection(source.getState());
    assert.equal(info.mode, 'replay');
    assert.equal(info.phase, 'offline');
    assert.equal(info.line, 'Not connected. Check the network.');
    assert.equal(info.errorText, 'Could not load the sample replay: chunk failed');
  });

  test('a pending source stays Connecting and never changes', () => {
    const pending = createPendingSource('replay');
    const before = pending.getState();
    pending.start();
    assert.equal(pending.getState(), before);
    assert.equal(describeConnection(before).phase, 'loading');
    assert.equal(before.mode, 'replay');
  });
});

describe('describeConnection', () => {
  test('before any rows: loading while connecting, the offline sentence once offline', () => {
    const loading = describeConnection(initialState('spacetime'));
    assert.equal(loading.phase, 'loading');
    assert.equal(loading.line, null);

    const none = describeConnection({ ...initialState('none'), connection: 'offline', reason: 'not-configured' });
    assert.equal(none.phase, 'offline');
    assert.equal(none.line, 'Not connected. No live data source is set up for this page.');

    const noBindings = describeConnection({ ...initialState('spacetime'), connection: 'offline', reason: 'no-bindings' });
    assert.equal(noBindings.line, 'Not connected. This build has no SpacetimeDB tables wired in yet.');
  });

  test('with rows: dimmed while reconnecting or offline, never while live', () => {
    const base = { ...initialState('spacetime'), ready: true };
    assert.equal(describeConnection({ ...base, connection: 'live' }).dimmed, false);
    const reconnecting = describeConnection({ ...base, connection: 'reconnecting' });
    assert.equal(reconnecting.phase, 'ready');
    assert.equal(reconnecting.dimmed, true);
    assert.equal(reconnecting.line, 'Showing the last known state');
    const offline = describeConnection({ ...base, connection: 'offline', reason: 'network' });
    assert.equal(offline.dimmed, true);
    assert.equal(offline.line, 'Not connected. Check the network.');
  });
});
