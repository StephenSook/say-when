'use client';

import { ReplayIcon } from '@/components/ui/icons';
import { useSourceMode } from '@/lib/data/provider';
import styles from './ReplayBanner.module.css';

/** Shown on every screen, the phone included, whenever the sample replay is the source. */
export function ReplayBanner() {
  const mode = useSourceMode();
  if (mode !== 'replay') return null;
  return (
    <div className={styles.banner} role="note">
      <ReplayIcon size={16} />
      <span>Sample replay, not live data</span>
    </div>
  );
}
