/**
 * The care team email after a sent form (PLAN D25), for the Email card under the form errand on Screen 2. Pure rules,
 * no React, so the card's states are tested here.
 *
 * The agent drafts the email when the form is read back ("email drafted"), and sends it, once, only after the form was
 * sent ("email sending", then "email sent" or "email failed: <code>"). Every state on the card comes from those
 * steps, so the card never shows an email as sent unless the agent reported it sent. A form that was not sent never
 * sends its email, and the card says so from the errand's own state.
 *
 * The subject, the body and the masked address ride in the steps' private payload, which reaches the board only while
 * the room shares text; without it the card shows the state alone.
 */
import type { Errand, ErrandEmailPayload, PipelineEvent, PipelineEventOf } from '@/lib/data/types';
import { maskPhoneNumbers } from '@/lib/format';
import type { RunStatus } from '@/lib/status';
import { errandMaybeSent } from './model';

export type EmailState = 'drafted' | 'sending' | 'sent' | 'failed' | 'unknown' | 'not_sent';

export interface EmailCardView {
  state: EmailState;
  /** For the badge's mark and color. */
  status: RunStatus;
  /** The badge's word: Drafted, Sending, Sent, Failed, Outcome unknown, Not sent. */
  word: string;
  /** One plain sentence under the title. */
  sentence: string;
  /** Masked, for example "s***@gmail.com". null when the room does not share text. */
  to: string | null;
  subject: string | null;
  body: string | null;
  /** False when no step's payload reached this screen (sharing is off). */
  shared: boolean;
  draftedAt: number | null;
  /** When sending began, for the running clock. */
  sendingSince: number | null;
  sentAt: number | null;
}

const BADGE: Readonly<Record<EmailState, { status: RunStatus; word: string }>> = {
  drafted: { status: 'not_started', word: 'Drafted' },
  sending: { status: 'working', word: 'Sending' },
  sent: { status: 'done', word: 'Sent' },
  failed: { status: 'failed', word: 'Failed' },
  unknown: { status: 'failed', word: 'Outcome unknown' },
  not_sent: { status: 'stopped', word: 'Not sent' },
};

/** Errand states that end without the form being sent. */
const FORM_NOT_SENT: ReadonlySet<Errand['status']> = new Set<Errand['status']>(['stopped', 'refused', 'failed', 'unknown_outcome']);

const labelOf = (event: PipelineEvent): string => event.detail.label ?? '';

/** An email step (PLAN D25): an errand step whose label starts "email ". Not a step of the form itself. */
export function isEmailStep(event: PipelineEvent): boolean {
  return event.stage === 'errand' && labelOf(event).startsWith('email ');
}

/** An address that is not masked yet gets masked here, so a full address never reaches the screen. */
export function maskedAddress(value: string | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  if (text.includes('***')) return text;
  const at = text.lastIndexOf('@');
  return at > 0 ? `${text.slice(0, 1)}***@${text.slice(at + 1)}` : '***';
}

/** This errand's email steps, oldest first. */
export function emailSteps(errand: Pick<Errand, 'id'>, events: readonly PipelineEvent[]): PipelineEventOf<'errand'>[] {
  return events
    .filter((event): event is PipelineEventOf<'errand'> => isEmailStep(event) && event.stage === 'errand' && event.detail.errandId === errand.id)
    .sort((a, b) => a.at - b.at);
}

function isoTime(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** The Email card for this errand, or null when the agent drafted no email for it. */
export function emailCardView(errand: Errand, events: readonly PipelineEvent[]): EmailCardView | null {
  const steps = emailSteps(errand, events);
  if (steps.length === 0) return null;
  const find = (label: string) => steps.find((step) => labelOf(step) === label) ?? null;
  const drafted = find('email drafted');
  const sending = find('email sending');
  const sent = steps.find((step) => labelOf(step) === 'email sent' && step.status === 'ok') ?? null;
  const ended = steps.find((step) => step.status === 'error') ?? null;

  const content: ErrandEmailPayload = {};
  let shared = false;
  for (const step of steps) {
    const email = step.detail.email;
    if (email && typeof email === 'object') {
      shared = true;
      Object.assign(content, email);
    }
  }
  const reason = typeof content.reason === 'string' && content.reason.trim() !== '' ? maskPhoneNumbers(content.reason.trim()) : null;

  let state: EmailState;
  let sentence: string;
  if (sent) {
    state = 'sent';
    sentence = 'Sent to the care team after the form was sent.';
  } else if (ended) {
    const label = labelOf(ended);
    if (ended.detail.notSent === true || label.startsWith('email not sent')) {
      state = 'not_sent';
      sentence = reason ?? 'No email was sent.';
    } else if (ended.detail.maybeSent === true || label.startsWith('email unknown')) {
      state = 'unknown';
      sentence = reason ?? 'The email may or may not have gone out. It was not sent again.';
    } else {
      state = 'failed';
      sentence = reason ?? 'The email could not be sent.';
    }
  } else if (sending) {
    state = 'sending';
    sentence = 'The form was sent. Sending the email to the care team.';
  } else if (FORM_NOT_SENT.has(errand.status)) {
    state = 'not_sent';
    sentence = errandMaybeSent(errand)
      ? 'Not sent: it is not known whether the form went through, so no email went out.'
      : 'Not sent, because the form was not sent.';
  } else if (errand.status === 'sent') {
    state = 'drafted';
    sentence = 'The form was sent. The email has not reported back yet.';
  } else {
    state = 'drafted';
    sentence = 'Drafted. It goes to the care team only after the form is sent.';
  }

  const body = typeof content.text === 'string' && content.text.trim() !== '' ? maskPhoneNumbers(content.text.trim()) : null;
  const subject = typeof content.subject === 'string' && content.subject.trim() !== '' ? maskPhoneNumbers(content.subject.trim()) : null;
  return {
    state,
    ...BADGE[state],
    sentence,
    to: maskedAddress(content.to),
    subject,
    body,
    shared,
    draftedAt: drafted?.at ?? null,
    sendingSince: sending?.at ?? null,
    sentAt: sent ? (isoTime(content.sentAt) ?? sent.at) : null,
  };
}
