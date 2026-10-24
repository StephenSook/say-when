/**
 * What the screens should do with the connection state (docs/ui.md "Connection chip"). Pure.
 *
 * | Connecting   | not active, no rows yet  | loading: show the screen's status line       |
 * | Live         | active and ready         | ready                                        |
 * | Reconnecting | not active, rows shown   | ready, dimmed: "Showing the last known state" |
 * | Offline      | not active for 10 s      | "Not connected. Check the network."          |
 */
import type { Connection, OfflineReason, SourceMode, SourceState } from './types';

export type ScreenPhase =
  /** No rows yet and still connecting: show the screen's StatusLine. */
  | 'loading'
  /** No rows and not connected: show `line`, never an empty state like "Waiting for the partner". */
  | 'offline'
  /** Rows are on screen. They may be stale; see `dimmed`. */
  | 'ready';

export interface ConnectionInfo {
  status: Connection;
  mode: SourceMode;
  ready: boolean;
  reason: OfflineReason | null;
  /** Raw error text, for a `title` tooltip only. */
  errorText: string | null;
  since: number;
  phase: ScreenPhase;
  /** Rows are shown but may be stale: draw them at 60% opacity. */
  dimmed: boolean;
  /** The one sentence under the header, or null when there is nothing to say. */
  line: string | null;
}

export function offlineSentence(reason: OfflineReason | null): string {
  switch (reason) {
    case 'not-configured':
      return 'Not connected. No live data source is set up for this page.';
    case 'no-bindings':
      return 'Not connected. This build has no SpacetimeDB tables wired in yet.';
    case 'subscription':
      return 'Not connected. The server refused the live tables.';
    case 'network':
    case null:
      return 'Not connected. Check the network.';
  }
}

export function describeConnection(state: SourceState): ConnectionInfo {
  const { connection, ready } = state;
  const phase: ScreenPhase = ready ? 'ready' : connection === 'offline' ? 'offline' : 'loading';
  const dimmed = ready && (connection === 'reconnecting' || connection === 'offline');
  let line: string | null = null;
  if (connection === 'reconnecting' && ready) line = 'Showing the last known state';
  if (connection === 'offline') line = offlineSentence(state.reason);
  return {
    status: connection,
    mode: state.mode,
    ready,
    reason: state.reason,
    errorText: state.errorText,
    since: state.since,
    phase,
    dimmed,
    line,
  };
}
