'use client';

/**
 * Screen 2, Agents at work (PLAN 5.3). Spec: docs/ui.md "Screen 2: Agents at work". Look: docs/mockups/agents.html.
 *
 * The form agent and the call agent doing their jobs step by step, so the room sees that nothing
 * leaves without a fresh CONFIRM:
 * - One plain sentence on top, rolled up from the agent at work (docs/ui.md pattern 8).
 * - The agent at work gets the big card. The other agent is one dimmed line at the bottom.
 * - Under the form errand, the care team email (PLAN D25): drafted with the read-back, sent only after the form.
 * - Errands and calls are options (PLAN D11): YES picks one, the read-back plays, and only a fresh
 *   CONFIRM matched to the read-back digest sends it (a single jaw clench with the headset; the key
 *   or the switch press in a keyboard or switch session). STOP hangs up a call.
 *
 * States: it renders inside the shell's <main> behind ConnectionGate, so loading and "Not connected"
 * belong to the gate. Reconnecting dims the screen (the shell) and stops its clocks
 * (components/agents/useClockNow.ts). Paused and the input off change the sentence on top and the
 * confirm step, since both cancel anything pending. The empty state is the sentence from docs/ui.md.
 * The rules sit in components/agents/model.ts.
 */
import { useMemo, useState } from 'react';
import { AgentLine } from '@/components/agents/AgentLine';
import { CallCard } from '@/components/agents/CallCard';
import { emailCardView } from '@/components/agents/email';
import { EmailCard } from '@/components/agents/EmailCard';
import { ErrandCard } from '@/components/agents/ErrandCard';
import {
  agentsEmptySentence,
  callHeadline,
  callIsMoving,
  chooseFocus,
  errandHeadline,
  errandIsMoving,
  findOption,
  newest,
  type AgentKind,
  type AgentRef,
} from '@/components/agents/model';
import { StatusMark } from '@/components/ui/StatusMark';
import { useCalls, useCommands, useErrands, useInput, usePipelineEvents, useRows, useSafety } from '@/lib/data/provider';
import styles from './Agents.module.css';

/** The viewer's "Show" choice, tied to the rows on screen when it was made. */
interface Pin {
  kind: AgentKind;
  errandId: string | null;
  callId: string | null;
}

export function Agents() {
  const errands = useErrands();
  const calls = useCalls();
  const commands = useCommands();
  const events = usePipelineEvents();
  const { options } = useRows();
  const safety = useSafety();
  const input = useInput();

  const errand = newest(errands);
  const call = newest(calls);
  const busy = (errand !== null && errandIsMoving(errand)) || (call !== null && callIsMoving(call));

  // "Show" on the dimmed line picks which finished agent fills the big card. Work in progress always
  // wins, and a new errand or call row retires the choice, so the screen goes back to following live work.
  const [pin, setPin] = useState<Pin | null>(null);
  const errandId = errand?.id ?? null;
  const callId = call?.id ?? null;
  const pinned: AgentKind | null =
    !busy && pin !== null && pin.errandId === errandId && pin.callId === callId ? pin.kind : null;

  const focus = chooseFocus(errand, call, pinned);
  const errandOption = useMemo(() => findOption(options, errand?.optionId ?? null), [options, errand?.optionId]);
  // PLAN D25: the care team email under the form errand, from the agent's email steps.
  const focusErrand = focus?.kind === 'errand' ? focus.row : null;
  const email = useMemo(() => (focusErrand ? emailCardView(focusErrand, events) : null), [focusErrand, events]);

  const headline =
    focus === null
      ? null
      : focus.kind === 'errand'
        ? errandHeadline(focus.row, safety.state, input)
        : callHeadline(focus.row, safety.state, input, commands);

  let other: AgentRef | null = null;
  if (focus?.kind === 'errand' && call !== null) other = { kind: 'call', row: call };
  if (focus?.kind === 'call' && errand !== null) other = { kind: 'errand', row: errand };
  const otherKind: AgentKind = focus?.kind === 'errand' ? 'call' : 'errand';
  const showOther: Pin | null = other !== null && !busy ? { kind: other.kind, errandId, callId } : null;

  return (
    <section className={styles.root} aria-labelledby="agents-title">
      <h1 id="agents-title" className="visually-hidden">
        Agents at work
      </h1>

      {/* One live region for the sentence on top, kept mounted so screen readers hear it change. */}
      <div className={headline ? styles.lede : styles.empty}>
        {headline ? (
          <span className={styles.ledeMark} aria-hidden="true">
            <StatusMark status={headline.status} showWord={false} />
          </span>
        ) : null}
        <p role="status" className={headline ? styles.headline : styles.emptyText}>
          {headline ? headline.text : agentsEmptySentence(input)}
        </p>
      </div>

      {focus?.kind === 'errand' ? (
        <ErrandCard key={`errand:${focus.row.id}`} errand={focus.row} option={errandOption} commands={commands} safety={safety.state} input={input} />
      ) : null}
      {focus?.kind === 'errand' && email !== null ? <EmailCard key={`email:${focus.row.id}`} view={email} /> : null}
      {focus?.kind === 'call' ? <CallCard key={`call:${focus.row.id}`} call={focus.row} commands={commands} safety={safety.state} input={input} /> : null}

      {focus !== null ? (
        <AgentLine kind={otherKind} agent={other} safety={safety.state} onShow={showOther ? () => setPin(showOther) : null} />
      ) : null}
    </section>
  );
}
