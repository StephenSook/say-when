/**
 * The cartesia browser code this app imports (lib/cartesia) must be cartesia/src byte for byte, so the station,
 * speaker and partner pages play and listen with exactly the code the cartesia tests cover (docs/station.md 7.2, C3).
 * `npm run cartesia` makes the copy. A stale copy would keep every other check green, so this fails until it matches.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const WEB = process.cwd();
const COPY = join(WEB, 'lib', 'cartesia');
const SOURCE = join(WEB, '..', 'cartesia', 'src');

interface FileList {
  files: string[];
  stripJsSpecifiers: boolean;
}

const list = JSON.parse(readFileSync(join(WEB, 'scripts', 'cartesia-files.json'), 'utf8')) as FileList;

/** The same rewrite as scripts/sync-cartesia.mjs: off unless the list turns it on. */
function rewrite(text: string): string {
  if (!list.stripJsSpecifiers) return text;
  return text.replace(/(from\s+['"]\.\/[A-Za-z0-9_-]+)\.js(['"])/g, '$1$2');
}

/** Every relative module a file imports or re-exports, as a file name in the same folder. */
function relativeImports(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/from\s+['"]\.\/([A-Za-z0-9_-]+)(\.js)?['"]/g)) found.push(`${match[1]}.ts`);
  return found;
}

describe('the cartesia browser copy', () => {
  test('the list names the whole browser closure, and nothing in it imports Node', () => {
    // A floor, so a check over an empty list cannot pass: docs/station.md names ten files.
    assert.ok(list.files.length >= 10, `the list has ${list.files.length} files`);
    for (const file of list.files) {
      assert.ok(existsSync(join(SOURCE, file)), `cartesia/src/${file} exists`);
      const text = readFileSync(join(SOURCE, file), 'utf8');
      assert.doesNotMatch(text, /from\s+['"]node:/, `${file} imports nothing from node:`);
      for (const imported of relativeImports(text)) assert.ok(list.files.includes(imported), `${file} imports ${imported}, which is in the list`);
    }
  });

  test('lib/cartesia is cartesia/src byte for byte (run npm run cartesia after any change there)', () => {
    assert.ok(existsSync(COPY), 'lib/cartesia exists');
    assert.deepEqual(readdirSync(COPY).sort(), [...list.files].sort(), 'the same files, and no others');
    for (const file of list.files) {
      const source = readFileSync(join(SOURCE, file));
      const copy = readFileSync(join(COPY, file));
      if (list.stripJsSpecifiers) assert.equal(copy.toString('utf8'), rewrite(source.toString('utf8')), `${file} matches`);
      else assert.ok(copy.equals(source), `${file} matches`);
    }
  });

  test('the comparison would catch a one-byte change', () => {
    const file = list.files[0] ?? 'browser.ts';
    const source = readFileSync(join(SOURCE, file));
    const changed = Buffer.concat([source, Buffer.from(' ')]);
    assert.equal(changed.equals(source), false);
    assert.equal(rewrite("export * from './ws.js';"), list.stripJsSpecifiers ? "export * from './ws';" : "export * from './ws.js';");
  });
});
