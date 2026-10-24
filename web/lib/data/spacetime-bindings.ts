/**
 * The bridge between the generated SpacetimeDB bindings and the dashboard's types. lib/data/spacetime.ts loads this
 * file with a dynamic import, so the SDK and the bindings ship in their own chunk and load only in SpacetimeDB mode.
 *
 * The bindings in ./module_bindings are a byte-for-byte copy of spacetime/bindings/web, made by `npm run bindings`
 * after every `spacetime generate`, so this app builds on its own (CI and the host install only web/).
 * test/module-bindings.test.ts fails while the copy differs from the generated folder.
 *
 * The dashboard is an anonymous reader (docs/spacetime.md 1.3): no token, no pairing, no reducer calls. It subscribes
 * to what docs/spacetime.md 7.1 lists for the dashboards, through the generated query builder:
 *
 *   config          the board's session (active_session_id) and the sharing toggle
 *   scan_state      the scan clock and the pause reason
 *   pipeline_event  the content-free steps
 *   device_status   whether the station is online, for the headset chip
 *   public_board    the last 20 questions with their scanned options ("Question N", "Option N" with sharing off)
 *   board_payloads  the content behind the steps, only while sharing is on
 *   board_errands   errands          board_calls  calls (a contact name only)
 *   board_ledger    the ledger; its gesture rows are the command events
 *
 * `cue_event` (chimes and toasts) is left out: no screen shows a cue yet, and an event table has no rows to read.
 * lib/data/spacetime-map.ts `boardRows` maps every row onto lib/data/types.ts.
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
  return [db.config, db.scanState, db.pipelineEvent, db.deviceStatus, db.publicBoard, db.boardPayloads, db.boardErrands, db.boardCalls, db.boardLedger];
}

export const bindings: SpacetimeBindings<DbConnection> = {
  builder: () => DbConnection.builder(),
  queries: [
    tables.config,
    tables.scanState,
    tables.pipelineEvent,
    tables.deviceStatus,
    tables.publicBoard,
    tables.boardPayloads,
    tables.boardErrands,
    tables.boardCalls,
    tables.boardLedger,
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
      pipelineEvents: [...db.pipelineEvent.iter()],
      devices: [...db.deviceStatus.iter()],
      questions: [...db.publicBoard.iter()],
      payloads: [...db.boardPayloads.iter()],
      errands: [...db.boardErrands.iter()],
      calls: [...db.boardCalls.iter()],
      ledger: [...db.boardLedger.iter()],
    });
  },
};
