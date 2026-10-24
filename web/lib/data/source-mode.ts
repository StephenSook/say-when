/**
 * Which data source the screens use. Pure, so it can be tested without a browser.
 *
 * Order:
 * 1. `?replay=1` in the address: the sample replay, always labeled "Sample replay, not live data".
 * 2. NEXT_PUBLIC_SPACETIMEDB_HOST and NEXT_PUBLIC_SPACETIMEDB_DB both set: SpacetimeDB.
 *    If it cannot connect, the screens say Offline. They never fall back to the replay.
 * 3. `?replay=0`: no source, so a developer can see the honest "Not connected" states.
 * 4. `next dev`: the sample replay.
 * 5. Anything else (a production build with no settings): no source, "Not connected".
 */
import type { SourceMode } from './types';

export interface SpacetimeSettings {
  host: string;
  db: string;
}

export interface SourceChoiceInput {
  /** process.env.NODE_ENV */
  nodeEnv: string | undefined;
  host: string | undefined;
  db: string | undefined;
  /** window.location.search, or '' on the server. */
  search: string;
}

export interface SourceChoice {
  mode: SourceMode;
  spacetime: SpacetimeSettings | null;
  /** The replay flag from the address, kept on links between screens. null when absent. */
  replayParam: '1' | '0' | null;
}

export function readReplayParam(search: string): '1' | '0' | null {
  const value = new URLSearchParams(search).get('replay');
  if (value === null) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === '') return '1';
  if (normalized === '0' || normalized === 'false' || normalized === 'off') return '0';
  return null;
}

export function readSpacetimeSettings(host: string | undefined, db: string | undefined): SpacetimeSettings | null {
  const h = host?.trim() ?? '';
  const d = db?.trim() ?? '';
  return h !== '' && d !== '' ? { host: h, db: d } : null;
}

export function chooseSource(input: SourceChoiceInput): SourceChoice {
  const replayParam = readReplayParam(input.search);
  const spacetime = readSpacetimeSettings(input.host, input.db);
  if (replayParam === '1') return { mode: 'replay', spacetime, replayParam };
  if (spacetime) return { mode: 'spacetime', spacetime, replayParam };
  if (replayParam === '0') return { mode: 'none', spacetime, replayParam };
  if (input.nodeEnv === 'development') return { mode: 'replay', spacetime, replayParam };
  return { mode: 'none', spacetime, replayParam };
}

/** Add the replay flag to an in-app link so it survives moving between screens. */
export function withReplayParam(href: string, replayParam: '1' | '0' | null): string {
  if (replayParam === null) return href;
  const hashAt = href.indexOf('#');
  const base = hashAt === -1 ? href : href.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : href.slice(hashAt);
  const queryAt = base.indexOf('?');
  const path = queryAt === -1 ? base : base.slice(0, queryAt);
  const params = new URLSearchParams(queryAt === -1 ? '' : base.slice(queryAt + 1));
  params.set('replay', replayParam);
  return `${path}?${params.toString()}${hash}`;
}
