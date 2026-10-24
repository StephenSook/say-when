'use client';

/**
 * The phone call's big card (docs/ui.md "Screen 2", docs/mockups/agents.html): five numbered
 * steps on the left and the transcript on the right.
 *
 * 1 Prepared and read back the call script plays in the earpiece, with its digest
 * 2 CONFIRM                the confirm window; only a double jaw clench places the call
 * 3 Ringing                Dialing, then Ringing with a ring timer (our own events: Cartesia has no ringing)
 * 4 Connected              the live duration; STOP, a long jaw clench, hangs up
 * 5 Ended                  with the reason in plain words
 *
 * The contact shows by name only. Never a phone number.
 */
import type { ReactNode } from 'react';
import { StepList, type Step } from '@/components/ui/StepList';
import type { CallRequest, CommandEvent } from '@/lib/data/types';
import { formatClock, formatClockDuration } from '@/lib/format';
import { callStatusWord, type RunStatus } from '@/lib/status';
import { AgentCard } from './AgentCard';
import {
  callBadge,
  callEndReason,
  callFailedSentence,
  callHoldNote,
  callPlan,
  pauseWords,
  rowReason,
  stopReason,
  type CallPlan,
  type SafetyWord,
} from './model';
import { Digest, Note, numbered, Quote } from './StepParts';
import { Countdown, Elapsed, LiveDuration } from './Timers';
import { Transcript } from './Transcript';

export interface CallCardProps {
  call: CallRequest;
  commands: readonly CommandEvent[];
  safety: SafetyWord;
}

export function CallCard({ call, commands, safety }: CallCardProps) {
  return (
    <AgentCard kind="call" name={call.contactName} badge={callBadge(call, safety)}>
      <StepList steps={callSteps(call, commands, safety)} label="Phone call steps" size="lg" />
      <Transcript call={call} />
    </AgentCard>
  );
}

function clock(at: number | null): string | undefined {
  return at === null ? undefined : formatClock(at);
}

/** A span between two moments as a clock face, or nothing when either is missing. */
function span(from: number | null, to: number | null): string | undefined {
  return from === null || to === null ? undefined : formatClockDuration(Math.max(0, to - from));
}

function callSteps(call: CallRequest, commands: readonly CommandEvent[], safety: SafetyWord): Step[] {
  const plan = callPlan(call);
  const notCalled = <Note>Not called: {stopReason(call, commands)}</Note>;
  const ended = clock(call.endedAt);
  return [
    scriptStep(call, plan.script, notCalled, ended),
    confirmStep(call, plan.confirm, notCalled, ended, commands, safety),
    ringStep(call, plan, notCalled, ended),
    talkStep(call, plan, safety),
    endStep(call, plan.end, commands),
  ];
}

function scriptStep(call: CallRequest, status: RunStatus, notCalled: ReactNode, ended: string | undefined): Step {
  const step = { key: 'script', status };
  const text = call.readBackText?.trim() || null;
  switch (status) {
    case 'working':
      return {
        ...step,
        label: numbered(1, 'Reading the script in the earpiece'),
        time: <Elapsed since={call.createdAt} />,
        detail: text ? <Quote text={text} channel="In the earpiece now" /> : undefined,
      };
    case 'done':
      return {
        ...step,
        label: numbered(
          1,
          <>
            Prepared and read back
            {call.scriptDigest ? (
              <>
                , digest <Digest value={call.scriptDigest} />
              </>
            ) : null}
          </>,
        ),
        time: clock(call.readAloudAt),
        detail: text ? <Quote text={text} /> : undefined,
      };
    case 'stopped':
      return { ...step, label: numbered(1, 'Stopped during the read-back'), time: ended, detail: notCalled, statusWord: 'Not called' };
    case 'refused':
      return {
        ...step,
        label: numbered(1, 'Refused before the call'),
        time: ended,
        detail: <Note>Not called: {rowReason(call)}</Note>,
        statusWord: 'Refused',
      };
    case 'failed':
      return { ...step, label: numbered(1, 'Could not prepare the call'), time: ended, detail: <Note>{rowReason(call)}</Note> };
    default:
      return { ...step, label: numbered(1, 'Prepared and read back') };
  }
}

function confirmStep(
  call: CallRequest,
  status: RunStatus,
  notCalled: ReactNode,
  ended: string | undefined,
  commands: readonly CommandEvent[],
  safety: SafetyWord,
): Step {
  const step = { key: 'confirm', status };
  switch (status) {
    case 'waiting': {
      const paused = pauseWords(safety);
      return {
        ...step,
        label: numbered(2, 'Waiting for CONFIRM, a double jaw clench'),
        detail: paused ? (
          <Note>{paused} This call stops here and will not be placed.</Note>
        ) : (
          <>
            {call.confirmClosesAt !== null ? (
              <Countdown closesAt={call.confirmClosesAt} opensAt={call.confirmOpensAt ?? call.readAloudAt} label="Time left to confirm the call" />
            ) : null}
            <Note>Only a double jaw clench places the call. If the time runs out, nobody is called.</Note>
          </>
        ),
      };
    }
    case 'done': {
      const confirm = call.confirmCommandId === null ? undefined : commands.find((event) => event.id === call.confirmCommandId);
      return { ...step, label: numbered(2, 'Confirmed with a double jaw clench'), time: clock(call.confirmedAt ?? confirm?.at ?? null) };
    }
    case 'stopped':
      return { ...step, label: numbered(2, 'Not confirmed'), time: ended, detail: notCalled, statusWord: 'Not called' };
    case 'refused':
    case 'failed':
      return { ...step, label: numbered(2, 'Not confirmed'), time: ended, detail: <Note>Not called: {rowReason(call)}</Note> };
    default:
      return { ...step, label: numbered(2, 'Confirm with a double jaw clench') };
  }
}

function ringStep(call: CallRequest, plan: CallPlan, notCalled: ReactNode, ended: string | undefined): Step {
  const status = plan.ring;
  const step = { key: 'ring', status };
  switch (status) {
    case 'working':
      if (call.status === 'ringing') {
        return { ...step, label: numbered(3, 'Ringing'), time: <LiveDuration since={call.ringingAt ?? call.dialedAt ?? call.createdAt} /> };
      }
      return { ...step, label: numbered(3, 'Dialing'), time: <Elapsed since={call.dialedAt ?? call.confirmedAt ?? call.createdAt} /> };
    case 'done':
      return call.ringingAt !== null
        ? { ...step, label: numbered(3, 'Ringing'), time: span(call.ringingAt, call.startedAt ?? call.endedAt) }
        : { ...step, label: numbered(3, 'Dialed'), time: clock(call.dialedAt) };
    case 'stopped':
      return { ...step, label: numbered(3, 'Not dialed'), time: ended, detail: notCalled, statusWord: 'Not called' };
    case 'refused':
      return {
        ...step,
        label: numbered(3, 'Refused before dialing'),
        time: ended,
        detail: <Note>Not called: {rowReason(call)}</Note>,
      };
    case 'failed':
      return { ...step, label: numbered(3, 'Could not dial'), time: ended, detail: <Note>{rowReason(call)}</Note> };
    default:
      // A call that finished without dialing says so; one that has not got here yet just names the step.
      return { ...step, label: numbered(3, plan.end !== 'not_started' ? 'Not dialed' : 'Ringing') };
  }
}

function talkStep(call: CallRequest, plan: CallPlan, safety: SafetyWord): Step {
  const status = plan.talk;
  const step = { key: 'talk', status };
  switch (status) {
    case 'working': {
      // A pause or the headset coming off asks the call agent to hang up (docs/spacetime.md 4.4).
      const note =
        safety === 'headset_off'
          ? 'Hanging up because the headset is off.'
          : safety === 'paused'
            ? 'Hanging up because of the pause.'
            : call.cancelRequested === true
              ? 'Hanging up. The person used STOP, a long jaw clench.'
              : 'STOP, a long jaw clench, hangs up.';
      return {
        ...step,
        label: numbered(4, 'Connected'),
        time: call.startedAt !== null ? <LiveDuration since={call.startedAt} /> : undefined,
        detail: <Note>{note}</Note>,
      };
    }
    case 'done':
      return { ...step, label: numbered(4, 'Connected'), time: span(call.startedAt, call.endedAt) };
    default:
      return { ...step, label: numbered(4, plan.end !== 'not_started' ? 'Not connected' : 'Connected') };
  }
}

/** The end step's reason, then the hold sentence when the contact is now on hold and the reason does not say so. */
function endNotes(call: CallRequest, reason: string | null): ReactNode {
  const hold = callHoldNote(call, reason);
  if (reason === null && hold === null) return undefined;
  return (
    <>
      {reason !== null ? <Note>{reason}</Note> : null}
      {hold !== null ? <Note>{hold}</Note> : null}
    </>
  );
}

function endStep(call: CallRequest, status: RunStatus, commands: readonly CommandEvent[]): Step {
  const step = { key: 'end', status };
  if (status === 'not_started') return { ...step, label: numbered(5, 'Ended, with the reason') };
  if (status === 'failed') {
    return {
      ...step,
      label: numbered(5, 'Call failed'),
      time: clock(call.endedAt),
      detail: endNotes(call, callFailedSentence(call)),
      statusWord: callStatusWord(call),
    };
  }
  return {
    ...step,
    label: numbered(5, 'Ended'),
    time: clock(call.endedAt),
    detail: endNotes(call, callEndReason(call, commands)),
    statusWord: callStatusWord(call),
  };
}
