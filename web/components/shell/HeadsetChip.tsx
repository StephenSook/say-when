'use client';

import { Chip } from '@/components/ui/Chip';
import { CrossIcon, HeadsetIcon, PauseIcon } from '@/components/ui/icons';
import { useSafety } from '@/lib/data/provider';

/** "Headset on" in muted text; Paused or Headset off in the error color; unknown before any data. */
export function HeadsetChip() {
  const safety = useSafety();
  let chip;
  if (safety.state === 'paused') {
    chip = (
      <Chip tone="error" lead={<PauseIcon />}>
        Paused
      </Chip>
    );
  } else if (safety.state === 'headset_off') {
    chip = (
      <Chip tone="error" lead={<CrossIcon />}>
        Headset off
      </Chip>
    );
  } else if (safety.state === 'ok') {
    chip = (
      <Chip tone="muted" lead={<HeadsetIcon size={14} />}>
        Headset on
      </Chip>
    );
  } else {
    chip = (
      <Chip tone="muted" lead={<HeadsetIcon size={14} />} dashed>
        Headset unknown
      </Chip>
    );
  }
  return (
    <span role="status" aria-label="Headset">
      {chip}
    </span>
  );
}
