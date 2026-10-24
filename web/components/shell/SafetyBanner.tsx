'use client';

import { CrossIcon, PauseIcon } from '@/components/ui/icons';
import { safetySentence } from '@/lib/commands';
import { useInput, useSafety } from '@/lib/data/provider';
import styles from './SafetyBanner.module.css';

export { safetySentence };

/**
 * Full-width banner under the header (docs/ui.md "Shared shell"): the sentence the room must see while the system is
 * paused (STOP or the idle auto-pause) or the input is off ("Headset off" in a headset session, "Input off" for keys
 * or a switch). Both cancel anything pending. The live region stays mounted.
 */
export function SafetyBanner() {
  const { state } = useSafety();
  const input = useInput();
  const sentence = safetySentence(state, input);
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
