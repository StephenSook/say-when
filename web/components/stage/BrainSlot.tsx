'use client';

/**
 * The stage's brain slot: the live brain (Screen 1) once it is on this build, else the decoder panel
 * (lib/stage/layout.ts `brainSlotKind`; the switch is one line in components/stage/live-brain.ts).
 */
import { useSyncExternalStore } from 'react';
import { brainSlotKind, type BrainSlotKind } from '@/lib/stage/layout';
import { DecoderPanel } from './DecoderPanel';
import { LIVE_BRAIN } from './live-brain';
import styles from './Stage.module.css';

const noSubscribe = () => () => {};

/** What fills the slot on this page. The server render and the first client render say 'decoder'. */
export function useBrainSlotKind(): BrainSlotKind {
  const search = useSyncExternalStore(
    noSubscribe,
    () => window.location.search,
    () => null,
  );
  // Before the address is known, the slot waits on the decoder panel, so the server and the client agree.
  return search === null ? 'decoder' : brainSlotKind(LIVE_BRAIN !== null, search);
}

export function BrainSlot({ kind }: { kind: BrainSlotKind }) {
  const LiveBrain = LIVE_BRAIN;
  if (kind === 'live-brain' && LiveBrain !== null) {
    return (
      <div className={styles.liveBrain}>
        <LiveBrain />
      </div>
    );
  }
  return <DecoderPanel />;
}
