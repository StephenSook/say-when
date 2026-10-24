'use client';

import type { ReactNode } from 'react';
import { CrossIcon } from '@/components/ui/icons';
import { Spinner } from '@/components/ui/Spinner';
import { StatusLine, type StatusLineProps } from '@/components/ui/StatusLine';
import { useConnection } from '@/lib/data/provider';
import styles from './ConnectionLine.module.css';

/**
 * The one line shown while rows are on screen but may be stale: "Showing the last known state"
 * while reconnecting, "Not connected. Check the network." once offline. The raw error is a tooltip.
 */
export function ConnectionLine() {
  const conn = useConnection();
  const show = conn.dimmed && conn.line !== null;
  return (
    <div role="status" className={styles.region}>
      {show ? (
        <p className={styles.line} title={conn.errorText ?? undefined}>
          {conn.status === 'reconnecting' ? <Spinner size={14} /> : <CrossIcon className={styles.offlineIcon} />}
          <span>{conn.line}</span>
        </p>
      ) : null}
    </div>
  );
}

const CONNECTING: StatusLineProps['messages'] = [
  'Connecting to the live data',
  'Still connecting',
  'Still connecting. The first connection can take a few seconds.',
];
const LOADING_REPLAY: StatusLineProps['messages'] = ['Loading the sample replay', 'Still loading the sample replay'];

export interface ConnectionGateProps {
  children: ReactNode;
  /** The loading sentences at 0, 3 and 10 s, while no rows have arrived yet. Defaults to the connecting sentences. */
  loading?: StatusLineProps['messages'];
}

/**
 * Renders `children` only once rows exist. Before that: the loading status line while connecting,
 * or the "Not connected" sentence. So no screen ever shows an empty state like "Waiting for the
 * partner to ask something." when the real problem is that it has no connection.
 */
export function ConnectionGate({ children, loading }: ConnectionGateProps) {
  const conn = useConnection();
  if (conn.phase === 'loading') {
    return (
      <div className={styles.center}>
        <StatusLine messages={loading ?? (conn.mode === 'replay' ? LOADING_REPLAY : CONNECTING)} />
      </div>
    );
  }
  if (conn.phase === 'offline') {
    return (
      <div className={styles.center}>
        <p className={styles.offline} role="status" title={conn.errorText ?? undefined}>
          <CrossIcon size={14} className={styles.offlineIcon} />
          <span>{conn.line}</span>
        </p>
      </div>
    );
  }
  return <>{children}</>;
}
