/**
 * The partner role connection reads one public row besides pairing: `config.share_text_on_board`, the room's toggle
 * (docs/station.md 4.4). The paired phone follows it like the board does: with it off, no words Ink-2 heard are
 * shown. Until config has been read, sharing counts as off.
 */

type Callback = (...args: any[]) => void;

export interface PartnerConnLike {
  db: {
    config: {
      iter(): Iterable<{ shareTextOnBoard: boolean }>;
      onInsert(cb: Callback): void;
      removeOnInsert(cb: Callback): void;
      onUpdate?(cb: Callback): void;
      removeOnUpdate?(cb: Callback): void;
    };
  };
}

export function readSharing(conn: PartnerConnLike): boolean {
  for (const row of conn.db.config.iter()) return row.shareTextOnBoard === true;
  return false;
}

/** Calls `onSharing` with the toggle after every config change. Returns the function that removes the callbacks. */
export function attachPartnerRows(conn: PartnerConnLike, onSharing: (sharing: boolean) => void): () => void {
  const changed = () => onSharing(readSharing(conn));
  conn.db.config.onInsert(changed);
  conn.db.config.onUpdate?.(changed);
  return () => {
    conn.db.config.removeOnInsert(changed);
    conn.db.config.removeOnUpdate?.(changed);
  };
}
