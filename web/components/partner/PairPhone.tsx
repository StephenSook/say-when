'use client';

/**
 * "Pair this phone to ask" (docs/station.md 4.1): a text link under Hold to ask that opens the pairing card with the
 * label picker (partner phone 1, 2 or 3). The owner approves the code from the CLI, with `true` at the end for the
 * caregiver's phone. Unpaired phones stay read-only, so a judge's phone can watch without pairing.
 * The card stays open by itself while a code is on its way, waiting, expired or refused.
 */
import { useState } from 'react';
import { PairingCard } from '@/components/device';
import { TextLink } from '@/components/ui/TextLink';
import type { RoleDevice } from '@/lib/role/device';
import type { PairingState } from '@/lib/role/pairing';
import styles from './PairPhone.module.css';

/** Phases where the card shows by itself: a code is being asked for, is waiting, ran out, or was refused. */
export function pairingCardOpen(phase: PairingState['phase']): boolean {
  return phase === 'requesting' || phase === 'waiting' || phase === 'expired' || phase === 'error' || phase === 'wrong_role';
}

export function PairPhone({ device, pairing }: { device: RoleDevice | null; pairing: PairingState }) {
  const [opened, setOpened] = useState(false);
  const open = opened || pairingCardOpen(pairing.phase);
  if (!open) {
    return (
      <div className={styles.link}>
        <TextLink onClick={() => setOpened(true)}>Pair this phone to ask</TextLink>
      </div>
    );
  }
  return (
    <div className={styles.card}>
      <PairingCard device={device} pairing={pairing} />
      {!pairingCardOpen(pairing.phase) ? (
        <div className={styles.link}>
          <TextLink onClick={() => setOpened(false)}>Not now</TextLink>
        </div>
      ) : null}
    </div>
  );
}
