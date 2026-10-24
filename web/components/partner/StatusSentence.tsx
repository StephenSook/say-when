'use client';

/**
 * The phone's one large status sentence and the muted hint under it (docs/mockups/partner.html).
 * Any state other than plain progress also gets an icon, so the state is never color alone.
 *
 * Screen readers hear the sentence only when its `key` changes, not every few seconds as the
 * cursor moves through the options (docs/ui.md: do not make the option list a live region). A failure
 * is announced as an alert.
 */
import { useState } from 'react';
import { CheckIcon, CrossIcon, HourglassIcon, NoEntryIcon, PauseIcon } from '@/components/ui/icons';
import { cx } from '@/lib/cx';
import type { PartnerStatus, StatusIcon } from './model';
import styles from './StatusSentence.module.css';

export function StatusSentence({ status, hint }: { status: PartnerStatus; hint: string | null }) {
  const announcement = useAnnouncement(status.key, status.announce);
  const failed = status.tone === 'failed';
  return (
    <div className={styles.block}>
      <p className={cx(styles.sentence, styles[status.tone])} title={status.title ?? undefined}>
        {status.icon !== 'none' ? (
          <span className={styles.icon} data-icon={status.icon} aria-hidden="true">
            <Glyph icon={status.icon} />
          </span>
        ) : null}
        <span key={status.text} className={styles.text}>
          {status.text}
        </span>
      </p>
      {hint ? <p className={styles.hint}>{hint}</p> : null}
      <p className="visually-hidden" role="status">
        {failed ? '' : announcement}
      </p>
      <p className="visually-hidden" role="alert">
        {failed ? announcement : ''}
      </p>
    </div>
  );
}

/** The words to announce: they change only when `key` changes (React's pattern for state that follows a prop). */
function useAnnouncement(key: string, text: string): string {
  const [said, setSaid] = useState({ key, text });
  if (said.key !== key) {
    setSaid({ key, text });
    return text;
  }
  return said.text;
}

function Glyph({ icon }: { icon: StatusIcon }) {
  switch (icon) {
    case 'check':
      return <CheckIcon size={14} />;
    case 'hourglass':
      return <HourglassIcon size={14} />;
    case 'pause':
      return <PauseIcon size={14} />;
    case 'cross':
      return <CrossIcon size={14} />;
    case 'no_entry':
      return <NoEntryIcon size={16} />;
    case 'none':
      return null;
  }
}
