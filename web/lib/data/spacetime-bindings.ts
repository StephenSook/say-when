/**
 * The bridge between the generated SpacetimeDB bindings and the dashboard's types. lib/data/spacetime.ts loads this
 * file with a dynamic import, so the SDK and the bindings ship in their own chunk and load only in SpacetimeDB mode.
 *
 * The bindings in ./module_bindings are a byte-for-byte copy of spacetime/bindings/web, made by `npm run bindings`
 * after every `spacetime generate`, so this app builds on its own (CI and the host install only web/).
 * test/module-bindings.test.ts fails while the copy differs from the generated folder.
 *
 * The dashboard is an anonymous reader (docs/spacetime.md 1.3): no token, no pairing, no reducer calls. It subscribes
 * to what docs/spacetime.md 7.1 and 14.2 list for the dashboards, through the generated query builder:
 *
 *   config                the board's session (active_session_id) and the sharing toggle
 *   scan_state            the scan clock and the pause reason
 *   board_events          the board session's content-free steps (the pipeline_event rows of that session)
 *   device_status         whether the station is online, for the headset chip
 *   public_board          the last 20 questions with their scanned options ("Question N", "Option N" with sharing off)
 *   board_payloads        the content behind the steps, only while sharing is on
 *   board_errands         errands          board_calls  calls (a contact name only)
 *   board_session_ledger  the board session's ledger; its gesture rows are the command events
 *   board_word_timings    the station's word timings for each read, numbers only
 *
 * The session-scoped views (module v2, docs/spacetime.md 14) replace the unscoped `pipeline_event` table and
 * `board_ledger` view, which grow with every session the database ever ran; those stay for the tools that read every
 * session. `cue_event` (chimes and toasts) is left out: no screen shows a cue yet, and an event table has no rows to
 * read. lib/data/spacetime-map.ts `boardRows` maps every row onto lib/data/types.ts.
 */
import { DbConnection, tables } from './module_bindings';
import type { SpacetimeBindings } from './spacetime';
import { boardRows } from './spacetime-map';

/** The row callbacks every subscribed table offers at runtime (spacetimedb 2.13.0 `TableCacheImpl`). */
interface WatchedTable {
  onInsert(callback: () => void): void;
  removeOnInsert(callback: () => void): void;
  onDelete(callback: () => void): void;
  removeOnDelete(callback: () => void): void;
  onUpdate(callback: () => void): void;
  removeOnUpdate(callback: () => void): void;
}

function watchedTables(conn: DbConnection): WatchedTable[] {
  const db = conn.db;
  return [
    db.config,
    db.scanState,
    db.boardEvents,
    db.deviceStatus,
    db.publicBoard,
    db.boardPayloads,
    db.boardErrands,
    db.boardCalls,
    db.boardSessionLedger,
    db.boardWordTimings,
  ];
}

export const bindings: SpacetimeBindings<DbConnection> = {
  builder: () => DbConnection.builder(),
  queries: [
    tables.config,
    tables.scanState,
    tables.boardEvents,
    tables.deviceStatus,
    tables.publicBoard,
    tables.boardPayloads,
    tables.boardErrands,
    tables.boardCalls,
    tables.boardSessionLedger,
    tables.boardWordTimings,
  ],
  watch(conn, onChange) {
    const changed = () => onChange();
    const watched = watchedTables(conn);
    for (const table of watched) {
      table.onInsert(changed);
      table.onDelete(changed);
      table.onUpdate(changed);
    }
    return () => {
      for (const table of watched) {
        table.removeOnInsert(changed);
        table.removeOnDelete(changed);
        table.removeOnUpdate(changed);
      }
    };
  },
  read(conn) {
    const db = conn.db;
    return boardRows({
      config: [...db.config.iter()],
      scanStates: [...db.scanState.iter()],
      pipelineEvents: [...db.boardEvents.iter()],
      devices: [...db.deviceStatus.iter()],
      questions: [...db.publicBoard.iter()],
      payloads: [...db.boardPayloads.iter()],
      errands: [...db.boardErrands.iter()],
      calls: [...db.boardCalls.iter()],
      ledger: [...db.boardSessionLedger.iter()],
      wordTimings: [...db.boardWordTimings.iter()],
    });
  },
};
