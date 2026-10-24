'use client';

/**
 * The form errand's big card (docs/ui.md "Screen 2", docs/mockups/agents.html): six numbered
 * steps on the left and the preview of the filled form on the right.
 *
 * 1 Picked with YES        the errand option, from the option rows
 * 2 Form filled            the Actor filled the form in a browser; nothing is sent
 * 3 Values read back       the values the Actor read back off the page
 * 4 Read back              the read-back plays in the earpiece, with its digest
 * 5 CONFIRM                the confirm window and its countdown; only CONFIRM sends it (a double jaw clench
 *                          with the headset, the key or the switch press otherwise)
 * 6 Sent                   with the form's confirmation text
 *
 * A NO, a STOP, the input coming off, a pause or the window running out stops the step it lands
 * on with "Not sent: <reason>", in calm muted text. Only a broken step is red.
 */
import type { ReactNode } from 'react';
import { StepList, type Step } from '@/components/ui/StepList';
import { signalPhrase, withSignal } from '@/lib/commands';
import type { AnswerOption, CommandEvent, Errand, InputKind } from '@/lib/data/types';
import { formatClock, formatSeconds } from '@/lib/format';
import type { RunStatus } from '@/lib/status';
import { AgentCard } from './AgentCard';
import { FormPreview } from './FormPreview';
import { errandBadge, errandMaybeSent, errandPlan, pauseWords, rowReason, screenText, stopReason, type SafetyWord } from './model';
import { Digest, Note, numbered, Quote, ReadBackValues } from './StepParts';
import { Countdown, Elapsed } from './Timers';

export interface ErrandCardProps {
  errand: Errand;
  /** The errand option YES picked, for its words. null when it is not in the rows. */
  option: AnswerOption | null;
  commands: readonly CommandEvent[];
  safety: SafetyWord;
  /** The session's input, for the words that name what the person did. */
  input: InputKind;
}

export function ErrandCard({ errand, option, commands, safety, input }: ErrandCardProps) {
  return (
    <AgentCard kind="errand" name={errand.form} badge={errandBadge(errand, safety)}>
      <StepList steps={errandSteps(errand, option, commands, safety, input)} label="Form errand steps" size="lg" />
      <FormPreview errand={errand} />
    </AgentCard>
  );
}

function clock(at: number | null): string | undefined {
  return at === null ? undefined : formatClock(at);
}

function errandSteps(errand: Errand, option: AnswerOption | null, commands: readonly CommandEvent[], safety: SafetyWord, input: InputKind): Step[] {
  const plan = errandPlan(errand);
  const notSent = <Note>Not sent: {stopReason(errand, commands, input)}</Note>;
  const ended = clock(errand.endedAt);
  const picked = screenText(option?.text);

  const steps: Step[] = [
    {
      key: 'picked',
      status: plan.picked,
      label: numbered(1, picked ? `Picked with YES: "${picked}"` : 'Picked with YES'),
      time: formatClock(errand.createdAt),
      pick: true,
    },
  ];

  steps.push(filledStep(errand, plan.filled, notSent, ended, input));

  steps.push({
    key: 'values',
    status: plan.values,
    label: numbered(3, 'Values read back off the page'),
    time: plan.values === 'done' ? clock(errand.previewedAt) : undefined,
    detail:
      plan.values !== 'done' ? undefined : errand.readBack.length > 0 ? (
        <ReadBackValues items={errand.readBack} />
      ) : (
        <Note>The values are not shared with this screen.</Note>
      ),
  });

  steps.push(readBackStep(errand, plan.readBack, notSent, ended, input));
  steps.push(confirmStep(errand, plan.confirm, notSent, ended, commands, safety, input));
  steps.push(sendStep(errand, plan.send, notSent, ended, input));
  return steps;
}

function filledStep(errand: Errand, status: RunStatus, notSent: ReactNode, ended: string | undefined, input: InputKind): Step {
  const step = { key: 'filled', status };
  switch (status) {
    case 'working':
      return { ...step, label: numbered(2, 'Filling in the form in a browser'), time: <Elapsed since={errand.createdAt} /> };
    case 'done': {
      // Once the form went out, "not sent" would describe only this step, so the words drop it.
      const after = errand.status === 'sent' || errandMaybeSent(errand);
      return {
        ...step,
        label: numbered(2, after ? 'Form filled in a browser' : 'Form filled in a browser, not sent'),
        time: errand.previewMs !== null ? formatSeconds(errand.previewMs) : clock(errand.previewedAt),
      };
    }
    case 'stopped':
      return { ...step, label: numbered(2, 'Stopped while filling in the form'), time: ended, detail: notSent, statusWord: 'Not sent' };
    case 'refused':
      return { ...step, label: numbered(2, 'Refused to fill in the form'), time: ended, detail: <Note>{rowReason(errand, input)}</Note> };
    case 'failed':
      return { ...step, label: numbered(2, 'Could not fill in the form'), time: ended, detail: <Note>{rowReason(errand, input)}</Note> };
    default:
      return { ...step, label: numbered(2, 'Fill in the form in a browser') };
  }
}

function readBackStep(errand: Errand, status: RunStatus, notSent: ReactNode, ended: string | undefined, input: InputKind): Step {
  const step = { key: 'read-back', status };
  const text = errand.readBackText?.trim() || null;
  switch (status) {
    case 'working':
      return {
        ...step,
        label: numbered(4, 'Reading it back in the earpiece'),
        time: <Elapsed since={errand.previewedAt ?? errand.createdAt} />,
        detail: text ? <Quote text={text} channel="In the earpiece now" /> : undefined,
      };
    case 'done':
      return {
        ...step,
        label: numbered(
          4,
          <>
            Read back in the earpiece
            {errand.previewDigest ? (
              <>
                , digest <Digest value={errand.previewDigest} />
              </>
            ) : null}
          </>,
        ),
        time: clock(errand.readAloudAt),
        detail: text ? <Quote text={text} /> : undefined,
      };
    case 'stopped':
      return { ...step, label: numbered(4, 'Stopped during the read-back'), time: ended, detail: notSent, statusWord: 'Not sent' };
    case 'refused':
    case 'failed':
      return { ...step, label: numbered(4, 'The read-back did not finish'), time: ended, detail: <Note>{rowReason(errand, input)}</Note> };
    default:
      return { ...step, label: numbered(4, 'Read back in the earpiece') };
  }
}

function confirmStep(
  errand: Errand,
  status: RunStatus,
  notSent: ReactNode,
  ended: string | undefined,
  commands: readonly CommandEvent[],
  safety: SafetyWord,
  input: InputKind,
): Step {
  const step = { key: 'confirm', status };
  const phrase = signalPhrase('CONFIRM', input);
  switch (status) {
    case 'waiting': {
      const paused = pauseWords(safety, input);
      return {
        ...step,
        label: numbered(5, `Waiting for ${withSignal('CONFIRM', input)}`),
        detail: paused ? (
          // The banner and the sentence on top already say "Nothing will be sent".
          <Note>{paused} This errand stops here and will not be sent.</Note>
        ) : (
          <>
            {errand.confirmClosesAt !== null ? (
              <Countdown closesAt={errand.confirmClosesAt} opensAt={errand.confirmOpensAt ?? errand.readAloudAt} label="Time left to confirm" />
            ) : null}
            <Note>Only {phrase ?? 'CONFIRM'} sends it. If the time runs out, nothing is sent.</Note>
          </>
        ),
      };
    }
    case 'done': {
      const confirm = errand.confirmCommandId === null ? undefined : commands.find((event) => event.id === errand.confirmCommandId);
      return { ...step, label: numbered(5, phrase ? `Confirmed with ${phrase}` : 'Confirmed'), time: clock(errand.confirmedAt ?? confirm?.at ?? null) };
    }
    case 'stopped':
      return { ...step, label: numbered(5, 'Not confirmed'), time: ended, detail: notSent, statusWord: 'Not sent' };
    case 'refused':
    case 'failed':
      return { ...step, label: numbered(5, 'Not confirmed'), time: ended, detail: <Note>{rowReason(errand, input)}</Note> };
    default:
      return { ...step, label: numbered(5, phrase ? `Confirm with ${phrase}` : 'CONFIRM') };
  }
}

function sendStep(errand: Errand, status: RunStatus, notSent: ReactNode, ended: string | undefined, input: InputKind): Step {
  const step = { key: 'send', status };
  switch (status) {
    case 'working':
      return { ...step, label: numbered(6, 'Sending the form'), time: <Elapsed since={errand.confirmedAt ?? errand.createdAt} /> };
    case 'done': {
      const confirmation = errand.confirmationText?.trim() || null;
      return {
        ...step,
        label: numbered(6, "Sent, with the form's confirmation"),
        time: clock(errand.sentAt),
        detail: confirmation ? <Quote text={confirmation} /> : undefined,
      };
    }
    case 'failed':
      if (errandMaybeSent(errand)) {
        // The send was tried and did not report back: say so, never "nothing was sent".
        const own = errand.status === 'failed' ? <Note>{rowReason(errand, input)}</Note> : null;
        return {
          ...step,
          label: numbered(6, 'Sending did not finish'),
          time: ended,
          statusWord: 'Outcome unknown',
          detail: (
            <>
              {own}
              <Note>It may or may not have gone through. Nothing was sent again.</Note>
            </>
          ),
        };
      }
      return { ...step, label: numbered(6, 'Could not send the form'), time: ended, detail: <Note>{rowReason(errand, input)}</Note> };
    case 'refused':
      return { ...step, label: numbered(6, 'Refused before sending'), time: ended, detail: <Note>{rowReason(errand, input)}</Note> };
    case 'stopped':
      return { ...step, label: numbered(6, 'Stopped before sending'), time: ended, detail: notSent, statusWord: 'Not sent' };
    default:
      return { ...step, label: numbered(6, "Sent, with the form's confirmation") };
  }
}
