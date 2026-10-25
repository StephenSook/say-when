/**
 * The route rule behind the frames and the data provider (docs/station.md 1.6): /station and /speaker get the bare
 * frame and no board source; /partner gets the phone frame; everything else is a dashboard.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { isPhoneRoute, isRolePageRoute } from '../lib/routes';

describe('route rule', () => {
  test('the station, the speaker, the try page and the quiz are role pages', () => {
    for (const path of ['/station', '/speaker', '/station/', '/speaker/x', '/try', '/quiz']) assert.equal(isRolePageRoute(path), true, path);
  });

  test('dashboards and the phone are not role pages', () => {
    for (const path of ['/', '/live', '/agents', '/conversation', '/partner', '/stations', '/speakers', '/judge', '/brain', '/quizzes', null, '']) {
      assert.equal(isRolePageRoute(path), false, String(path));
    }
  });

  test('the phone route is /partner only', () => {
    assert.equal(isPhoneRoute('/partner'), true);
    assert.equal(isPhoneRoute('/partner/'), true);
    assert.equal(isPhoneRoute('/partners'), false);
    assert.equal(isPhoneRoute('/station'), false);
    assert.equal(isPhoneRoute(null), false);
  });

  test('the shell and the provider both use the shared rule', () => {
    const shell = readFileSync(join(process.cwd(), 'components', 'shell', 'Shell.tsx'), 'utf8');
    const provider = readFileSync(join(process.cwd(), 'lib', 'data', 'provider.tsx'), 'utf8');
    assert.match(shell, /if \(isRolePageRoute\(pathname\)\) return <BareFrame>/);
    assert.match(provider, /if \(isRolePageRoute\(window\.location\.pathname\) \|\| isBrainRoute\(window\.location\.pathname\)\) return;/);
  });
});
