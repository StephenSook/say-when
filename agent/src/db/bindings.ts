// Where the generated SpacetimeDB bindings plug into the sidecar.
//
// The bindings are generated into spacetime/bindings/agent (docs/spacetime.md 7.1 and 9.2):
//   spacetime generate --no-config --lang typescript --out-dir spacetime/bindings/agent --module-path spacetime
// They are loaded at run time rather than imported statically, for two reasons:
// - The generated files use extensionless relative imports ("./types"). They run under tsx, but they do not
//   type-check under this package's NodeNext settings, so a static import would break `npm run typecheck`.
// - They import `spacetimedb` from spacetime/node_modules, so spacetime/ needs its dependencies installed.
//
// The typed check lives in typecheck/bindings.check.ts and runs in `npm run typecheck` with its own tsconfig: it
// fails to compile if the generated DbConnection stops fitting src/db/spacetime-db.ts, if a reducer stops taking
// the sidecar's arguments, or if a view row or an enum changes. test/contract.test.ts also loads the generated
// files and compares every reducer's argument names, in order, and every view's columns with src/contract.ts.
// After every `spacetime generate`, run `npm run typecheck` and `npm test` in agent/.

import { existsSync } from 'node:fs';

import type { BuilderLike } from './spacetime-db.js';

/** Where `spacetime generate` writes the agent's bindings. */
export const BINDINGS_DIR = new URL('../../../spacetime/bindings/agent/', import.meta.url);

/** The generated `spacetimedb` package the bindings import (spacetime/node_modules). */
export const BINDINGS_SDK = new URL('../../../spacetime/node_modules/spacetimedb/package.json', import.meta.url);

/** The generated `DbConnection.builder`, or null when the bindings have not been generated. */
export async function loadBuilder(): Promise<(() => BuilderLike) | null> {
    const url = new URL('index.ts', BINDINGS_DIR);
    if (!existsSync(url)) return null;
    if (!existsSync(BINDINGS_SDK)) {
        throw new Error('The generated bindings import spacetimedb from spacetime/node_modules. Run npm ci in spacetime/ first.');
    }
    const generated = (await import(url.href)) as { DbConnection?: { builder?: () => unknown } };
    const builder = generated.DbConnection?.builder;
    if (typeof builder !== 'function') {
        throw new Error('spacetime/bindings/agent/index.ts has no DbConnection.builder. Generate the bindings again (docs/spacetime.md 7.1).');
    }
    return () => builder.call(generated.DbConnection) as BuilderLike;
}
