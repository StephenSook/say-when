/**
 * The /brain route (Screen 1): framed like the judge page (no live-data gate, no safety banner), on key 4, and never
 * a role page or the phone.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { isBrainRoute, isJudgeRoute, isPhoneRoute, isRolePageRoute } from '../lib/routes';

describe('the /brain route', () => {
  test('matches /brain only', () => {
    for (const path of ['/brain', '/brain/']) assert.equal(isBrainRoute(path), true, path);
    for (const path of ['/', '/brains', '/live', '/judge', '/station', null, '']) assert.equal(isBrainRoute(path), false, String(path));
    assert.equal(isRolePageRoute('/brain'), false);
    assert.equal(isPhoneRoute('/brain'), false);
    assert.equal(isJudgeRoute('/brain'), false);
  });

  test('the shell frames it as a reading page, and the tabs put it on key 4', () => {
    const shell = readFileSync(join(process.cwd(), 'components', 'shell', 'Shell.tsx'), 'utf8');
    assert.match(shell, /const readingPage = isJudgeRoute\(pathname\) \|\| isBrainRoute\(pathname\);/);
    const tabs = readFileSync(join(process.cwd(), 'components', 'shell', 'Tabs.tsx'), 'utf8');
    assert.match(tabs, /\{ href: '\/brain', label: 'Brain', key: '4' \}/);
  });

  test('Screen 1 never opens the station channel or SpacetimeDB', () => {
    const dir = join(process.cwd(), 'components', 'brain');
    const files = ['BrainScreen.tsx', 'BrainScene.tsx', 'BrainPage.tsx'].map((f) => readFileSync(join(dir, f), 'utf8'));
    const lib = ['protocol.ts', 'stream.ts', 'model.ts', 'useVizStream.ts'].map((f) => readFileSync(join(process.cwd(), 'lib', 'brain', f), 'utf8'));
    for (const text of [...files, ...lib]) {
      assert.doesNotMatch(text, /:8765/);
      assert.doesNotMatch(text, /from 'spacetimedb'|@\/lib\/data\/provider|module_bindings/);
    }
  });
});
