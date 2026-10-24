/**
 * The bridge between the generated SpacetimeDB bindings and the dashboard's types.
 *
 * TODO(PLAN 1.1 and 1.2): not wired yet, so this exports null. With null, the SpacetimeDB source reports
 * Offline ("This build has no SpacetimeDB tables wired in yet") and never falls back to the sample replay.
 * The module in spacetime/ and its generated web bindings in spacetime/bindings/web now exist (docs/spacetime.md
 * section 11); the module is not published yet, so nothing here could be checked against a live database.
 *
 * The module design is docs/spacetime.md. Section 7.1 lists what each screen subscribes to and maps
 * every `DataRows` field onto its tables and views; follow that table. In short:
 *
 *   questions       public_board (text is null while the board does not share question text)
 *   pipelineEvents  pipeline_event merged with board_payloads by event_id
 *   options         public_board[].options (text from label)
 *   errands         board_errands       calls  board_calls (contact name only)
 *   commands        board_ledger rows with kind 'gesture'
 *   scan            scan_state plus the scanned question in public_board
 *   safety          scan_state.pause_reason: HeadsetOff is 'headset_off'; Stop, Idle, Operator and
 *                   HeadsetLost are 'paused'
 *
 * Steps once the module in spacetime/ is published:
 *
 * 1. Generate the web bindings (docs/spacetime.md 7.1), then point `./module_bindings` at them through a
 *    path alias or a copy:
 *
 *      spacetime generate --no-config --lang typescript --out-dir spacetime/bindings/web --module-path spacetime
 *
 * 2. Replace the export below with something like this, using the generated accessor names:
 *
 *      import { DbConnection, tables } from './module_bindings';
 *      import { isCommand, pipelineDetail, sortedBy, timestampToMillis } from './spacetime-map';
 *      import { maskPhoneNumbers } from '../format';
 *      import type { SpacetimeBindings } from './spacetime';
 *
 *      export const bindings: SpacetimeBindings<DbConnection> = {
 *        builder: () => DbConnection.builder(),
 *        queries: [tables.config, tables.scanState, tables.pipelineEvent, tables.deviceStatus,
 *                  tables.publicBoard, tables.boardPayloads, tables.boardErrands, tables.boardCalls, tables.boardLedger],
 *        watch(conn, onChange) {
 *          const watched = [conn.db.scanState, conn.db.pipelineEvent, conn.db.publicBoard, ...];
 *          const onRow = () => onChange();
 *          for (const table of watched) { table.onInsert(onRow); table.onDelete(onRow); table.onUpdate?.(onRow); }
 *          return () => { for (const table of watched) { table.removeOnInsert(onRow); table.removeOnDelete(onRow); table.removeOnUpdate?.(onRow); } };
 *        },
 *        read(conn) { ...map each source as in docs/spacetime.md 7.1... },
 *      };
 *
 *    Rules for the mapping:
 *    - Generated TypeScript bindings use camelCase. Timestamps arrive as `Timestamp` objects: use timestampToMillis.
 *      Enum tags map to snake case (`AwaitingConfirm` to `awaiting_confirm`).
 *    - Commands are the D11 names only (YES, NO, CONFIRM, STOP, HEADSET_OFF). isCommand drops anything else.
 *    - Build each event's detail with pipelineDetail(stage, status, row.detail, row.countsJson, payloadJson):
 *      it keeps the producer's label, renames counts that would hide a payload list, fills a failed
 *      step's error, and strips memory text from retrieve hits (shared memory text arrives only as `sharedText`).
 *    - Keep row times on the server clock. The source moves them onto the laptop clock (lib/data/clock-offset.ts).
 *    - Map `call_request.cancel_requested` to `cancelRequested` if board_calls carries it.
 *    - Never map a phone number into these types. Run transcript lines through maskPhoneNumbers.
 *    - Register audio-critical callbacks once at connect, not in a render (docs/spacetime.md 7.1).
 *
 * 3. Set NEXT_PUBLIC_SPACETIMEDB_HOST (for example https://maincloud.spacetimedb.com, or
 *    http://localhost:3000 for `spacetime start`) and NEXT_PUBLIC_SPACETIMEDB_DB (the database name) in
 *    web/.env.local and in the deployed project's settings.
 *
 * 4. Run `npm run typecheck` and `npm run build` in web/, open /conversation and check the chip says Live.
 */
import type { SpacetimeBindings } from './spacetime';

export const bindings: SpacetimeBindings | null = null;
