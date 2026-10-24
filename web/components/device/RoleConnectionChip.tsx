'use client';

/**
 * The role page's own connection (lib/role/connection.ts): Connecting, Live, Reconnecting, Offline, with one sentence
 * when something needs a person: a refused saved pairing offers Forget this device (docs/station.md 5.7).
 */
import { TextLink } from '@/components/ui/TextLink';
import { cx } from '@/lib/cx';
import type { RoleConnectionState } from '@/lib/role/connection';
import { DeviceChip } from './DeviceChip';
import { roleConnectionView } from './model';
import styles from './DeviceLine.module.css';

export interface RoleConnectionChipProps {
  state: RoleConnectionState;
  /** `device.forget()`. Offered only when the server refused the saved token. */
  onForget?: () => void;
  /** Show the sentence under the chip. Default true. */
  showSentence?: boolean;
  className?: string;
}

export function RoleConnectionChip({ state, onForget, showSentence = true, className }: RoleConnectionChipProps) {
  const view = roleConnectionView(state);
  return (
    <span className={cx(styles.block, className)}>
      <span role="status" aria-label="Connection">
        <DeviceChip view={view} title={state.errorText ?? undefined} />
      </span>
      {showSentence && view.sentence ? (
        <span className={styles.line}>
          <span className={styles.sentence} role={state.status === 'offline' ? 'alert' : undefined}>
            {view.sentence}
          </span>
          {view.forget && onForget ? <TextLink onClick={onForget}>Forget this device</TextLink> : null}
        </span>
      ) : null}
    </span>
  );
}
