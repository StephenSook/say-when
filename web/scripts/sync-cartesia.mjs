// Copies the cartesia browser code (cartesia/src: the earpiece and speaker player, Ink-2 listening, tones, PCM and the
// socket helpers) into lib/cartesia, byte for byte, so this app builds on its own: CI and the host install only web/,
// and Next.js builds only what is inside it (docs/station.md 7.2, C3).
//
//   npm run cartesia          run from web/ after any change in cartesia/src
//
// The file list lives in scripts/cartesia-files.json. test/cartesia-copy.test.ts reads the same list and fails while
// any copied file differs from cartesia/src. These files take access tokens only; none of them holds or sends an API key.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(web, '..', 'cartesia', 'src');
const target = join(web, 'lib', 'cartesia');
const list = JSON.parse(readFileSync(join(web, 'scripts', 'cartesia-files.json'), 'utf8'));

/** The same rewrite as test/cartesia-copy.test.ts: drop the .js ending of a relative import, only when the list says so. */
function rewrite(text) {
  if (!list.stripJsSpecifiers) return text;
  return text.replace(/(from\s+['"]\.\/[A-Za-z0-9_-]+)\.js(['"])/g, '$1$2');
}

for (const file of list.files) {
  if (!existsSync(join(source, file))) {
    console.error(`No ${file} in ${source}. The cartesia package moved or the list in scripts/cartesia-files.json is stale.`);
    process.exit(1);
  }
}
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const file of list.files) {
  const bytes = readFileSync(join(source, file));
  writeFileSync(join(target, file), list.stripJsSpecifiers ? rewrite(bytes.toString('utf8')) : bytes);
}
console.log(`Copied ${list.files.length} files from ${source} to ${target}`);
