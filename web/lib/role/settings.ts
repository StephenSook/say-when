/**
 * Which database a role page pairs with: NEXT_PUBLIC_SPACETIMEDB_HOST and NEXT_PUBLIC_SPACETIMEDB_DB, the same two
 * settings the dashboards read (lib/data/source-mode.ts). Neither is a secret. Next.js writes `NEXT_PUBLIC_` values
 * into the bundle at build time, which is why they are read here by their full literal names.
 * Null when either is missing: a role page then says it has no database to pair with, and never falls back to a replay.
 */
import { readSpacetimeSettings, type SpacetimeSettings } from '../data/source-mode';

export function roleSettingsFromEnv(): SpacetimeSettings | null {
  return readSpacetimeSettings(process.env.NEXT_PUBLIC_SPACETIMEDB_HOST, process.env.NEXT_PUBLIC_SPACETIMEDB_DB);
}
