'use client';

/**
 * Screen 4, Partner phone view (PLAN 5.5). Spec: docs/ui.md "Screen 4: Partner phone view".
 * Look: docs/mockups/partner.html.
 *
 * Purpose: let the partner ask a question from their phone and see where it is at a glance.
 * Focus: one status sentence at the top, then the reply. One column, at most 420 px wide.
 *
 * It renders inside the phone frame's <main> with no dashboard header, so it draws its own top row
 * (NeuroLingo and the connection chip) and its own connection states:
 * - Loading: the status line ("Connecting to the live data", or "Loading the sample replay").
 * - Offline with no rows: "Not connected. ..." from the shell.
 * - Reconnecting, or offline with rows: the last known state at 60% under "Showing the last known state".
 * - Empty: "Ask a question out loud." (", or type it here." once a typed question can be sent).
 * - Asking (docs/station.md 4): a paired phone asks with Hold to ask (Ink-2, only while held) or the typed box,
 *   through its own Partner role connection beside the board connection (components/partner/usePartnerAsk.tsx).
 *   Unpaired phones stay read-only, with "Pair this phone to ask" under the button.
 * - Working: "Listening.", "Looking it up.", "Getting options ready.", "They are choosing, option 2 of 4."
 * - Error: "Could not draft options. Ask again." and the like, with a cross in the error color.
 * - Paused: "Paused. Please wait." Headset off: "Headset off. Please wait."
 *
 * The phone never shows the words of the options (docs/spacetime.md `partner_view`), only which
 * option number is in the earpiece, and then the reply the person picked. The rules for reading the
 * rows live in components/partner/model.ts.
 */
import { useId, useMemo } from 'react';
import { AskArea } from '@/components/partner/AskArea';
import { buildPartnerView } from '@/components/partner/model';
import { StatusSentence } from '@/components/partner/StatusSentence';
import { TheirAnswer } from '@/components/partner/TheirAnswer';
import { useAsk } from '@/components/partner/useAsk';
import { PartnerAskProvider } from '@/components/partner/usePartnerAsk';
import { ConnectionChip, ConnectionGate, ConnectionLine } from '@/components/shell';
import { StepList } from '@/components/ui';
import { cx } from '@/lib/cx';
import {
  useCalls,
  useConnection,
  useCurrentQuestion,
  useErrands,
  useQuestionEvents,
  useRows,
  useSafety,
  useScanState,
} from '@/lib/data/provider';
import styles from './Partner.module.css';

export function Partner() {
  return (
    <PartnerAskProvider>
      <section className={styles.root} aria-labelledby="partner-title">
        <div className={styles.phone}>
          <h1 id="partner-title" className="visually-hidden">
            Partner view
          </h1>
          <div className={styles.top}>
            <span className={styles.brand}>NeuroLingo</span>
            <ConnectionChip />
          </div>
          <ConnectionLine />
          <ConnectionGate>
            <PartnerNow />
          </ConnectionGate>
        </div>
      </section>
    </PartnerAskProvider>
  );
}

/** Everything under the top row, once rows exist. */
function PartnerNow() {
  const conn = useConnection();
  const question = useCurrentQuestion();
  const events = useQuestionEvents(question?.id ?? null);
  const { options } = useRows();
  const errands = useErrands();
  const calls = useCalls();
  const scan = useScanState();
  const safety = useSafety();
  const ask = useAsk();
  const askedId = useId();
  const canType = ask !== null;

  const view = useMemo(
    () => buildPartnerView({ question, events, options, errands, calls, scan, safety, canType }),
    [question, events, options, errands, calls, scan, safety, canType],
  );

  return (
    <>
      <div className={cx(styles.now, conn.dimmed && styles.dimmed)}>
        <StatusSentence status={view.status} hint={view.hint} />
        {view.asked ? (
          <section className={styles.asked} aria-labelledby={askedId}>
            <h2 id={askedId} className={styles.label}>
              You asked
            </h2>
            <p className={styles.question}>{view.asked.quoted ? `"${view.asked.text}"` : view.asked.text}</p>
          </section>
        ) : null}
        {view.steps.length > 0 ? <StepList steps={view.steps} size="lg" label="Progress" /> : null}
        {view.answer ? <TheirAnswer answer={view.answer} /> : null}
      </div>
      <div className={styles.ask}>
        <AskArea scanReading={scan !== null && scan.outcome === null && (scan.phase === 'reading' || scan.phase === 'window')} />
      </div>
    </>
  );
}
