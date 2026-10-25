/**
 * The status vocabulary from docs/ui.md ("Status vocabulary"). Use exactly these words on every
 * screen and the phone. Each status is drawn as an icon shape, a word and a color, never color alone
 * (components/ui/StatusMark.tsx).
 */
import type { CallRequest, CallStatus, ErrandStatus, PipelineStatus } from './data/types';

export type RunStatus = 'not_started' | 'working' | 'waiting' | 'done' | 'refused' | 'stopped' | 'failed';

export const STATUS_WORDS: Readonly<Record<RunStatus, string>> = {
  not_started: 'Not started',
  working: 'Working',
  waiting: 'Waiting for confirm',
  done: 'Done',
  refused: 'Refused',
  stopped: 'Stopped',
  failed: 'Failed',
};

/** pipeline_event.status: started is Working, ok is Done, error is Failed. No row yet is Not started. */
export function statusFromPipeline(status: PipelineStatus | null | undefined): RunStatus {
  if (status === 'started') return 'working';
  if (status === 'ok') return 'done';
  if (status === 'error') return 'failed';
  return 'not_started';
}

/**
 * An errand's overall state. A confirm window that runs out is Stopped, never Failed.
 * 'unknown_outcome' shows as Failed; the screen must add its reason ("It may or may not have gone
 * through. Nothing was sent again."), since the form may have been sent.
 */
export function statusFromErrand(status: ErrandStatus): RunStatus {
  switch (status) {
    case 'preparing':
    case 'previewed':
    case 'reading_back':
    case 'confirmed':
    case 'submitting':
      return 'working';
    case 'awaiting_confirm':
      return 'waiting';
    case 'sent':
      return 'done';
    case 'stopped':
      return 'stopped';
    case 'refused':
      return 'refused';
    case 'failed':
    case 'unknown_outcome':
      return 'failed';
  }
}

/** A call's overall state. After the read-back it waits for its own fresh CONFIRM (a single jaw clench). */
export function statusFromCall(status: CallStatus): RunStatus {
  switch (status) {
    case 'prepared':
    case 'confirmed':
    case 'dialing':
    case 'ringing':
    case 'connected':
      return 'working';
    case 'awaiting_confirm':
      return 'waiting';
    case 'ended':
      return 'done';
    case 'stopped':
      return 'stopped';
    case 'refused':
      return 'refused';
    case 'failed':
      return 'failed';
  }
}

/**
 * A call's state in words for the card's top-right label (docs/ui.md): Dialing, Ringing, Connected,
 * Ended, No answer, Failed, plus the shared words for the steps before dialing.
 */
export function callStatusWord(call: Pick<CallRequest, 'status' | 'result'>): string {
  if (call.status === 'ended' && call.result === 'no_answer') return 'No answer';
  switch (call.status) {
    case 'prepared':
    case 'confirmed':
      return STATUS_WORDS.working;
    case 'awaiting_confirm':
      return STATUS_WORDS.waiting;
    case 'dialing':
      return 'Dialing';
    case 'ringing':
      return 'Ringing';
    case 'connected':
      return 'Connected';
    case 'ended':
      return 'Ended';
    case 'failed':
      return 'Failed';
    case 'stopped':
      return 'Stopped';
    case 'refused':
      return 'Refused';
  }
}
