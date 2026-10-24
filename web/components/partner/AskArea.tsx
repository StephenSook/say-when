'use client';

/**
 * The bottom of the partner phone: Hold to ask, the line under it, a problem with Send again, the pairing link, and
 * the typed box (docs/station.md 4.4). What shows at each step comes from lib/partner/view.ts.
 *
 * With no database settings (the sample replay) there is no asking context: Hold to ask shows only the microphone
 * level and says nothing is sent, as before.
 */
import { useContext } from 'react';
import { RoleConnectionChip } from '@/components/device';
import { CrossIcon, PauseIcon } from '@/components/ui/icons';
import { cx } from '@/lib/cx';
import { buildAskView } from '@/lib/partner/view';
import { PartnerAskContext } from './askContext';
import { HoldToAsk } from './HoldToAsk';
import { PairPhone } from './PairPhone';
import { TypedQuestion } from './TypedQuestion';
import styles from './AskArea.module.css';

export function AskArea({ scanReading }: { scanReading: boolean }) {
  const asking = useContext(PartnerAskContext);
  if (!asking) return <HoldToAsk />;

  const view = buildAskView({
    pairing: asking.pairing,
    voice: asking.voice,
    hold: asking.hold,
    sharing: asking.sharing,
    scanReading,
    retrying: asking.retrying,
  });

  return (
    <>
      <HoldToAsk
        onHoldChange={view.canHold ? asking.onHoldChange : undefined}
        disabled={view.holdDisabled}
        note={view.note}
        heard={view.heard}
        busy={view.busy}
      />
      {view.problem ? (
        <div className={styles.problemRow}>
          <p className={cx(styles.problem, view.problem.tone === 'failed' && styles.failed)} role="alert" title={view.problem.title ?? undefined}>
            {view.problem.tone === 'failed' ? <CrossIcon size={14} /> : <PauseIcon size={14} />}
            <span>{view.problem.sentence}</span>
          </p>
          {view.problem.sendAgain ? (
            <button type="button" className={styles.again} onClick={asking.sendAgain}>
              Send again
            </button>
          ) : null}
        </div>
      ) : null}
      {asking.connection.status === 'offline' ? <RoleConnectionChip state={asking.connection} onForget={() => asking.device?.forget()} /> : null}
      {view.showPairLink ? <PairPhone device={asking.device} pairing={asking.pairing} /> : null}
      {view.canType && asking.ask ? <TypedQuestion send={asking.ask} /> : null}
    </>
  );
}
