'use client';

/**
 * The voice check's answer in words (docs/station.md 1.3): "Voice ready", "Voice off: the database has no Cartesia
 * key.", "Voice service problem (<code>)." with Retry, and so on. The token itself is never shown.
 */
import { TextLink } from '@/components/ui/TextLink';
import { cx } from '@/lib/cx';
import type { VoiceState } from '@/lib/voice/token';
import { DeviceChip } from './DeviceChip';
import { voiceView } from './model';
import styles from './DeviceLine.module.css';

export interface VoiceStatusProps {
  voice: VoiceState;
  /** The Retry link: `device.recheckVoice()`. */
  onRetry?: () => void;
  className?: string;
}

export function VoiceStatus({ voice, onRetry, className }: VoiceStatusProps) {
  const view = voiceView(voice);
  return (
    <span className={cx(styles.line, className)}>
      <span role="status">
        <DeviceChip view={view} title={view.code ?? undefined} />
      </span>
      {view.retry && onRetry ? <TextLink onClick={onRetry}>Retry</TextLink> : null}
    </span>
  );
}
