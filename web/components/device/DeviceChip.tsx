import type { ReactNode } from 'react';
import { Chip } from '@/components/ui/Chip';
import { cx } from '@/lib/cx';
import { CheckIcon, CrossIcon, HourglassIcon, PauseIcon } from '@/components/ui/icons';
import type { ChipView } from './model';
import styles from './DeviceChip.module.css';

export interface DeviceChipProps {
  view: ChipView;
  /** Raw detail for a tooltip only, such as an error code. Never a token. */
  title?: string;
  className?: string;
}

/** A 40 px chip (16 px words) with a word, a mark and a color for one device state. */
export function DeviceChip({ view, title, className }: DeviceChipProps) {
  let lead: 'dot' | 'spinner' | ReactNode;
  switch (view.lead) {
    case 'dot':
    case 'spinner':
      lead = view.lead;
      break;
    case 'check':
      lead = <CheckIcon size={14} />;
      break;
    case 'cross':
      lead = <CrossIcon size={14} />;
      break;
    case 'pause':
      lead = <PauseIcon size={14} />;
      break;
    case 'hourglass':
      lead = <HourglassIcon size={14} />;
      break;
    case 'ring':
      lead = <span className={styles.ring} />;
      break;
  }
  return (
    <Chip tone={view.tone} lead={lead} size="lg" title={title} className={cx(styles.wrap, className)}>
      {view.words}
    </Chip>
  );
}
