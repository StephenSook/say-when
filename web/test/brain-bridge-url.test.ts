/** ?bridge=wss://host on /brain: a forwarded bridge a wearer shares on purpose (eeg-data/share.py). */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bridgeUrlFrom, shouldAutoConnect } from '../lib/brain/model';

describe('forwarded bridge address', () => {
  test('a bare wss origin is taken and connects without a click', () => {
    assert.equal(bridgeUrlFrom('?bridge=wss://abc-def.trycloudflare.com'), 'wss://abc-def.trycloudflare.com');
    assert.equal(bridgeUrlFrom('?bridge=wss://abc.trycloudflare.com/'), 'wss://abc.trycloudflare.com');
    assert.equal(shouldAutoConnect('xyz.trycloudflare.com', '?bridge=wss://abc.trycloudflare.com'), true);
  });

  test('anything else is refused and the page keeps the local bridge', () => {
    for (const s of ['', '?bridge=1', '?bridge=ws://abc.example.com', '?bridge=https://abc.example.com',
      '?bridge=wss://user:pw@abc.example.com', '?bridge=wss://abc.example.com/path', '?bridge=wss://abc.example.com?x=1']) {
      assert.equal(bridgeUrlFrom(s), null, s);
    }
    assert.equal(shouldAutoConnect('neurolingo-web.vercel.app', ''), false);
  });
});
