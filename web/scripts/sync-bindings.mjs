// Copies the generated SpacetimeDB web bindings (spacetime/bindings/web) into lib/data/module_bindings, byte for
// byte, so this app builds on its own: CI and the host install only web/, and Next.js builds only what is inside it.
//
//   npm run bindings          run from web/ after every `spacetime generate`
//
// test/module-bindings.test.ts fails while the two folders differ, so a stale copy cannot pass the checks.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(web, '..', 'spacetime', 'bindings', 'web');
const target = join(web, 'lib', 'data', 'module_bindings');

if (!existsSync(join(source, 'index.ts'))) {
  console.error(`No generated bindings at ${source}. Run spacetime generate first (spacetime/README.md).`);
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log(`Copied ${source} to ${target}`);
