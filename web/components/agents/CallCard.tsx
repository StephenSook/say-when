'use client';

/**
 * The phone call's big card (docs/ui.md "Screen 2", docs/mockups/agents.html): five numbered
 * steps on the left and the transcript on the right.
 *
 * 1 Prepared and read back the call script plays in the earpiece, with its digest
 * 2 CONFIRM                the confirm window; only CONFIRM places the call (a double jaw clench with the headset)
 * 3 Ringing                Dialing, then Ringing with a ring timer (our own events: Cartesia has no ringing)
 * 4 Connected              the live duration; STOP hangs up (a long jaw clench with the headset)
 * 5 Ended                  with the reason in plain words
 *
 * The contact shows by name only. Never a phone number.
 */
import type { ReactNode } from 'react';
import { StepList, type Step } from '@/components/ui/StepList';
import { signalPhrase, withSignal } from '@/lib/commands';
import type { CallRequest, CommandEvent, InputKind } from '@/lib/data/types';
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
  stopHangsUp,
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
  /** The session's input, for the words that name what the person did. */
  input: InputKind;
}

export function CallCard({ call, commands, safety, input }: CallCardProps) {
  return (
    <AgentCard kind="call" name={call.contactName} badge={callBadge(call, safety)}>
      <StepList steps={callSteps(call, commands, safety, input)} label="Phone call steps" size="lg" />
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

function callSteps(call: CallRequest, commands: readonly CommandEvent[], safety: SafetyWord, input: InputKind): Step[] {
  const plan = callPlan(call);
  const notCalled = <Note>Not called: {stopReason(call, commands, input)}</Note>;
  const ended = clock(call.endedAt);
  return [
    scriptStep(call, plan.script, notCalled, ended, input),
    confirmStep(call, plan.confirm, notCalled, ended, commands, safety, input),
    ringStep(call, plan, notCalled, ended, input),
    talkStep(call, plan, safety, input),
    endStep(call, plan.end, commands, input),
  ];
}

function scriptStep(call: CallRequest, status: RunStatus, notCalled: ReactNode, ended: string | undefined, input: InputKind): Step {
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
        detail: <Note>Not called: {rowReason(call, input)}</Note>,
        statusWord: 'Refused',
      };
    case 'failed':
      return { ...step, label: numbered(1, 'Could not prepare the call'), time: ended, detail: <Note>{rowReason(call, input)}</Note> };
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
  input: InputKind,
): Step {
  const step = { key: 'confirm', status };
  const phrase = signalPhrase('CONFIRM', input);
  switch (status) {
    case 'waiting': {
      const paused = pauseWords(safety, input);
      return {
        ...step,
        label: numbered(2, `Waiting for ${withSignal('CONFIRM', input)}`),
        detail: paused ? (
          <Note>{paused} This call stops here and will not be placed.</Note>
        ) : (
          <>
            {call.confirmClosesAt !== null ? (
              <Countdown closesAt={call.confirmClosesAt} opensAt={call.confirmOpensAt ?? call.readAloudAt} label="Time left to confirm the call" />
            ) : null}
            <Note>Only {phrase ?? 'CONFIRM'} places the call. If the time runs out, nobody is called.</Note>
          </>
        ),
      };
    }
    case 'done': {
      const confirm = call.confirmCommandId === null ? undefined : commands.find((event) => event.id === call.confirmCommandId);
      return { ...step, label: numbered(2, phrase ? `Confirmed with ${phrase}` : 'Confirmed'), time: clock(call.confirmedAt ?? confirm?.at ?? null) };
    }
    case 'stopped':
      return { ...step, label: numbered(2, 'Not confirmed'), time: ended, detail: notCalled, statusWord: 'Not called' };
    case 'refused':
    case 'failed':
      return { ...step, label: numbered(2, 'Not confirmed'), time: ended, detail: <Note>Not called: {rowReason(call, input)}</Note> };
    default:
      return { ...step, label: numbered(2, phrase ? `Confirm with ${phrase}` : 'CONFIRM') };
  }
}

function ringStep(call: CallRequest, plan: CallPlan, notCalled: ReactNode, ended: string | undefined, input: InputKind): Step {
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
        detail: <Note>Not called: {rowReason(call, input)}</Note>,
      };
    case 'failed':
      return { ...step, label: numbered(3, 'Could not dial'), time: ended, detail: <Note>{rowReason(call, input)}</Note> };
    default:
      // A call that finished without dialing says so; one that has not got here yet just names the step.
      return { ...step, label: numbered(3, plan.end !== 'not_started' ? 'Not dialed' : 'Ringing') };
  }
}

function talkStep(call: CallRequest, plan: CallPlan, safety: SafetyWord, input: InputKind): Step {
  const status = plan.talk;
  const step = { key: 'talk', status };
  switch (status) {
    case 'working': {
      // A pause or the input coming off asks the call agent to hang up (docs/spacetime.md 4.4).
      const note =
        safety === 'headset_off'
          ? `Hanging up because the ${input === 'headset' ? 'headset' : 'input'} is off.`
          : safety === 'paused'
            ? 'Hanging up because of the pause.'
            : call.cancelRequested === true
              ? `Hanging up. The person used ${withSignal('STOP', input)}.`
              : stopHangsUp(input);
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

function endStep(call: CallRequest, status: RunStatus, commands: readonly CommandEvent[], input: InputKind): Step {
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
    detail: endNotes(call, callEndReason(call, input, commands)),
    statusWord: callStatusWord(call),
  };
}
