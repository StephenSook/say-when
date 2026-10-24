'use client';

import { CrossIcon, PauseIcon } from '@/components/ui/icons';
import { useSafety } from '@/lib/data/provider';
import type { SafetyState } from '@/lib/data/types';
import styles from './SafetyBanner.module.css';

/**
 * The sentence the room must see while the system is paused (STOP or the idle auto-pause) or the
 * headset is off (HEADSET_OFF). Both cancel anything pending.
 */
export function safetySentence(state: SafetyState['state']): string | null {
  if (state === 'paused') return 'Paused. Nothing will be sent.';
  if (state === 'headset_off') return 'Headset off. Nothing will be sent.';
  return null;
}

/** Full-width banner under the header (docs/ui.md "Shared shell"). The live region stays mounted. */
export function SafetyBanner() {
  const { state } = useSafety();
  const sentence = safetySentence(state);
  return (
    <div role="status" className={styles.region}>
      {sentence ? (
        <div className={styles.banner}>
          <span className={styles.icon} aria-hidden="true">
            {state === 'paused' ? <PauseIcon size={14} /> : <CrossIcon size={14} />}
          </span>
          <span>{sentence}</span>
        </div>
      ) : null}
    </div>
  );
}
