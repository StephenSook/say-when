import { spacetimedbModuleTestPlugin } from 'spacetimedb/server/test-utils/vitest';
import { defineConfig, type Plugin } from 'vitest/config';

// The plugin swaps the host-only `spacetime:sys` imports for the in-memory test datastore,
// so every reducer, view and procedure runs here with no server.
export default defineConfig({
  plugins: [spacetimedbModuleTestPlugin() as unknown as Plugin],
  test: {
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
  },
});
