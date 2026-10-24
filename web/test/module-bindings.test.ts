/**
 * The generated bindings this app imports (lib/data/module_bindings) must be the module's own, byte for byte:
 * spacetime/bindings/web, which `spacetime generate` writes. `npm run bindings` makes the copy. A stale copy would
 * read old tables or miss new ones with every other check still green, so this fails until the copy matches.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, test } from 'node:test';

const COPY = join(process.cwd(), 'lib', 'data', 'module_bindings');
const GENERATED = join(process.cwd(), '..', 'spacetime', 'bindings', 'web');

/** Every file under `dir`, as paths relative to it, sorted. */
function filesIn(dir: string, root: string = dir, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) filesIn(path, root, found);
    else found.push(relative(root, path));
  }
  return found.sort();
}

describe('the generated SpacetimeDB bindings', () => {
  test('lib/data/module_bindings is spacetime/bindings/web byte for byte (run npm run bindings after spacetime generate)', () => {
    assert.ok(existsSync(join(GENERATED, 'index.ts')), `the generated bindings exist at ${GENERATED}`);
    const generated = filesIn(GENERATED);
    // A floor, so a check that walked an empty folder cannot pass: the module has 16 tables and views, 32 reducers and 2 procedures.
    assert.ok(generated.length >= 50, `walked ${generated.length} generated files`);
    assert.deepEqual(filesIn(COPY), generated, 'the same files');
    for (const file of generated) {
      assert.ok(readFileSync(join(COPY, file)).equals(readFileSync(join(GENERATED, file))), `${file} matches`);
    }
  });
});
