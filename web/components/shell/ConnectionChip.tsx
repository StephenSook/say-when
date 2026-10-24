'use client';

import { Chip } from '@/components/ui/Chip';
import { CrossIcon, ReplayIcon } from '@/components/ui/icons';
import { useConnection } from '@/lib/data/provider';

/**
 * Connecting (spinner), Live (accent dot), Reconnecting (spinner), Offline (in the error color).
 * The sample replay says "Replay" in a dashed chip, never "Live".
 */
export function ConnectionChip() {
  const conn = useConnection();
  const title = conn.errorText ?? undefined;
  let chip;
  if (conn.mode === 'replay' && conn.status === 'live') {
    chip = (
      <Chip tone="muted" lead={<ReplayIcon size={14} />} dashed title="Sample replay, not live data">
        Replay
      </Chip>
    );
  } else if (conn.status === 'live') {
    chip = (
      <Chip tone="live" lead="dot">
        Live
      </Chip>
    );
  } else if (conn.status === 'reconnecting') {
    chip = (
      <Chip lead="spinner" title={title}>
        Reconnecting
      </Chip>
    );
  } else if (conn.status === 'offline') {
    chip = (
      <Chip tone="error" lead={<CrossIcon />} title={title}>
        Offline
      </Chip>
    );
  } else {
    chip = <Chip lead="spinner">Connecting</Chip>;
  }
  return (
    <span role="status" aria-label="Connection">
      {chip}
    </span>
  );
}
