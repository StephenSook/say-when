'use client';

/**
 * The pairing card for the station, speaker and partner phone (docs/station.md 1.2, 1.3 and 4.1). It shows the
 * 6-digit code in large digits, the owner's approve command with a copy button, and the time left. On the partner
 * phone it offers only the fixed labels, so nobody types a name into a public field. Nothing here shows, copies or
 * puts a token in an address; the device id it copies is the public identity the owner needs to revoke the device.
 */
import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { TextLink } from '@/components/ui/TextLink';
import { cx } from '@/lib/cx';
import type { RoleDevice } from '@/lib/role/device';
import type { PairingState } from '@/lib/role/pairing';
import { useNow } from '@/lib/use-now';
import { DeviceChip } from './DeviceChip';
import { pairingCardView, runStatusChip } from './model';
import { useCopy } from './useCopy';
import styles from './PairingCard.module.css';

export interface PairingCardProps {
  /** The page's device, for its actions and database settings. Null before it exists (the first render). */
  device: Pick<RoleDevice<any>, 'settings' | 'requestCode' | 'chooseLabel' | 'forget'> | null;
  pairing: PairingState;
  className?: string;
}

export function PairingCard({ device, pairing, className }: PairingCardProps) {
  const now = useNow(1_000);
  const { result, which, copy } = useCopy();
  const [confirmForget, setConfirmForget] = useState(false);
  const settings = device?.settings ?? { host: '', db: '' };
  const view = pairingCardView(pairing, settings, now);
  const titleId = `pairing-title-${pairing.role}`;
  const copiedWord = (name: string) => (which === name && result === 'copied' ? 'Copied' : which === name && result === 'failed' ? 'Copy did not work. Select the text.' : null);

  return (
    <Card as="section" className={cx(styles.card, className)} aria-labelledby={titleId}>
      <div className={styles.status} role="status">
        <DeviceChip view={runStatusChip(view.status, view.statusWord)} className={styles.chip} />
        <h2 id={titleId} className={styles.title}>
          {view.title}
        </h2>
      </div>

      {view.sentence ? (
        <p className={styles.sentence} role={view.status === 'failed' ? 'alert' : undefined}>
          {view.sentence}
        </p>
      ) : null}

      {view.codeText ? (
        <div className={styles.codeBlock}>
          <p className={styles.codeLabel}>Pairing code</p>
          <p className={cx(styles.code, 'num')}>{view.codeText}</p>
          {view.timeLeft ? <p className={cx(styles.meta, 'num')}>{view.timeLeft}</p> : null}
        </div>
      ) : null}

      {view.command ? (
        <div className={styles.commandBlock}>
          <p className={styles.codeLabel}>The owner runs</p>
          {/* Each word is one unit, so a line breaks only between words, never inside --server or say-when-dev. */}
          <code className={styles.command}>
            {view.command.split(' ').map((word, i) => (
              <span key={i}>
                {i > 0 ? ' ' : null}
                <span className={styles.commandWord}>{word}</span>
              </span>
            ))}
          </code>
          <div className={styles.row}>
            <button type="button" className={styles.secondary} onClick={() => copy('command', view.command ?? '')}>
              Copy command
            </button>
            <span className={styles.meta} aria-live="polite">
              {copiedWord('command')}
            </span>
          </div>
          {view.commandNote ? <p className={styles.meta}>{view.commandNote}</p> : null}
        </div>
      ) : null}

      {view.showLabelPicker ? (
        <fieldset className={styles.labels}>
          <legend className={styles.codeLabel}>Which phone is this?</legend>
          {view.labels.map((label) => (
            <label key={label} className={styles.choice}>
              <input
                type="radio"
                name={`pairing-label-${pairing.role}`}
                value={label}
                checked={view.label === label}
                onChange={() => device?.chooseLabel(label)}
              />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
      ) : null}

      {view.action ? (
        <button
          type="button"
          className={styles.primary}
          disabled={view.action.disabled || device === null}
          onClick={() => device?.requestCode(view.label ?? undefined)}
        >
          {view.action.label}
        </button>
      ) : null}

      <div className={styles.footer}>
        {view.identityShort ? (
          <p className={styles.meta}>
            This device <span className="mono">{view.identityShort}</span>
          </p>
        ) : null}
        <div className={styles.row}>
          {view.revoke ? (
            <TextLink onClick={() => copy('revoke', view.revoke ?? '')}>Copy the revoke command</TextLink>
          ) : null}
          <span className={styles.meta} aria-live="polite">
            {copiedWord('revoke')}
          </span>
        </div>
        {confirmForget ? (
          <div className={styles.row}>
            <span className={styles.meta}>Forget it? The owner must approve a new code.</span>
            <TextLink onClick={() => device?.forget()}>Yes, forget this device</TextLink>
            <TextLink onClick={() => setConfirmForget(false)}>Keep it</TextLink>
          </div>
        ) : (
          <TextLink onClick={() => setConfirmForget(true)}>Forget this device</TextLink>
        )}
      </div>
    </Card>
  );
}
