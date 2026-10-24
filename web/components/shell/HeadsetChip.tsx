'use client';

import { Chip } from '@/components/ui/Chip';
import { CrossIcon, HeadsetIcon, PauseIcon } from '@/components/ui/icons';
import { inputChip } from '@/lib/commands';
import { useInput, useSafety } from '@/lib/data/provider';

/**
 * "Headset on" in muted text; Paused or Headset off in the error color; unknown before any data. A keyboard or switch
 * session says "Keyboard input" or "Switch input" and "Input off" instead (lib/commands.ts `inputChip`), so key presses
 * never read as headset input.
 */
export function HeadsetChip() {
  const safety = useSafety();
  const input = useInput();
  const view = inputChip(safety.state, input);
  const lead =
    view.lead === 'pause' ? <PauseIcon /> : view.lead === 'cross' ? <CrossIcon /> : view.lead === 'headset' ? <HeadsetIcon size={14} /> : 'dot';
  return (
    <span role="status" aria-label={view.name}>
      <Chip tone={view.tone} lead={lead} dashed={view.dashed}>
        {view.words}
      </Chip>
    </span>
  );
}
