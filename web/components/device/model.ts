/**
 * The words and marks for the shared device parts (pairing card, voice status, audio tap, role connection), as pure
 * functions of the state, so every sentence is tested without a browser. Plain words; every state gets a word, an
 * icon and a color (docs/ui.md "Status vocabulary"); a timeout or a revocation is never drawn as a failure.
 */
import type { ChipTone } from '@/components/ui/Chip';
import { formatClockDuration } from '@/lib/format';
import type { RoleConnectionState } from '@/lib/role/connection';
import { approveCommand, revokeCommand } from '@/lib/role/device';
import { formatPairingCode, PAIRING_LABELS, type PairingState } from '@/lib/role/pairing';
import type { DeviceRole } from '@/lib/role/storage';
import type { RunStatus } from '@/lib/status';
import type { AudioUnlockSnapshot } from '@/lib/voice/audio';
import type { VoiceState } from '@/lib/voice/token';
import type { SpacetimeSettings } from '@/lib/data/source-mode';

const ROLE_WORD: Readonly<Record<DeviceRole, string>> = {
  station: 'station',
  speaker: 'speaker',
  partner: 'partner phone',
};

/** "0x" and the first 8 hex characters of an identity, for the screen. The full value is copied, never shown whole. */
export function shortIdentity(identityHex: string | null): string | null {
  if (!identityHex) return null;
  const hex = identityHex.replace(/^0x/i, '');
  return `0x${hex.slice(0, 8)}`;
}

/** "4:32 left", rounded up to whole seconds so it never shows 0:00 while time remains. */
export function codeTimeLeft(expiresAt: number | null, now: number): string | null {
  if (expiresAt === null || now <= 0) return null;
  const left = Math.max(0, Math.ceil((expiresAt - now) / 1000) * 1000);
  return `${formatClockDuration(left)} left`;
}

export interface PairingCardView {
  /** The line at the top of the card. */
  title: string;
  status: RunStatus;
  /** The word next to the mark, when it differs from the title. */
  statusWord: string;
  sentence: string | null;
  /** "482 913" while a code waits for the owner. */
  codeText: string | null;
  timeLeft: string | null;
  /** The owner's approve command, with the code in it. */
  command: string | null;
  /** On the partner phone: the caregiver's phone is approved with true at the end. */
  commandNote: string | null;
  showLabelPicker: boolean;
  labels: readonly string[];
  label: string | null;
  /** The main button, or null. */
  action: { kind: 'new_code' | 'get_code'; label: string; disabled: boolean } | null;
  identityShort: string | null;
  /** What the owner types to revoke this device, for the copy link. */
  revoke: string | null;
}

export function pairingCardView(pairing: PairingState, settings: SpacetimeSettings, now: number): PairingCardView {
  const role = pairing.role;
  const identityShort = shortIdentity(pairing.identityHex);
  const revoke = pairing.identityHex ? revokeCommand(settings, pairing.identityHex) : null;
  const labels = PAIRING_LABELS[role];
  const base: PairingCardView = {
    title: '',
    status: 'working',
    statusWord: '',
    sentence: null,
    codeText: null,
    timeLeft: null,
    command: null,
    commandNote: null,
    showLabelPicker: false,
    labels,
    label: pairing.label,
    action: null,
    identityShort,
    revoke,
  };
  const notPairedAnymore = pairing.revokedBefore ? 'This device is not paired anymore. ' : '';
  const pickLabel = role === 'partner' && pairing.label === null;

  switch (pairing.phase) {
    case 'connecting':
      return { ...base, title: 'Connecting', status: 'working', statusWord: 'Working' };
    case 'checking':
      return { ...base, title: 'Checking the pairing', status: 'working', statusWord: 'Working' };
    case 'paired':
      return { ...base, title: `Paired as ${ROLE_WORD[role]}`, status: 'done', statusWord: 'Done' };
    case 'unpaired':
    case 'revoked': {
      const title = pairing.phase === 'revoked' ? 'This device is not paired anymore.' : role === 'partner' ? 'Pair this phone to ask' : `This ${ROLE_WORD[role]} is not paired`;
      return {
        ...base,
        title,
        status: pairing.phase === 'revoked' ? 'stopped' : 'not_started',
        statusWord: pairing.phase === 'revoked' ? 'Not paired' : 'Not started',
        sentence: role === 'partner' ? 'Pick this phone\'s label, then ask the owner to approve the code.' : 'Getting a code for the owner to approve.',
        showLabelPicker: role === 'partner',
        action: role === 'partner' || !pairing.autoRequest ? { kind: 'get_code', label: 'Get a code', disabled: pickLabel } : null,
      };
    }
    case 'requesting':
      return { ...base, title: 'Getting a pairing code', status: 'working', statusWord: 'Working', sentence: notPairedAnymore.trim() || null };
    case 'waiting': {
      const code = pairing.code;
      return {
        ...base,
        title: 'Waiting for the owner to approve',
        status: 'waiting',
        statusWord: 'Waiting',
        sentence: `${notPairedAnymore}Ask the owner to approve this code.`,
        codeText: code !== null ? formatPairingCode(code) : null,
        timeLeft: codeTimeLeft(pairing.expiresAt, now),
        command: code !== null ? approveCommand(settings, code, false) : null,
        commandNote: role === 'partner' ? "For the caregiver's phone, the last word is true instead of false." : null,
        action: { kind: 'new_code', label: 'New code', disabled: false },
      };
    }
    case 'expired':
      return {
        ...base,
        title: 'Code expired',
        status: 'stopped',
        statusWord: 'Stopped',
        sentence: 'Nobody approved it in time. Get a new code.',
        showLabelPicker: role === 'partner',
        action: { kind: 'new_code', label: 'New code', disabled: pickLabel },
      };
    case 'wrong_role':
      return {
        ...base,
        title: `This browser's ${ROLE_WORD[role]} identity is paired as ${pairing.pairedRole ?? 'another role'}.`,
        status: 'failed',
        statusWord: 'Failed',
        sentence: 'Ask the owner to revoke it, or forget this device.',
      };
    case 'error':
      return {
        ...base,
        title: 'Could not get a pairing code',
        status: 'failed',
        statusWord: 'Failed',
        sentence: pairing.errorText,
        showLabelPicker: role === 'partner',
        action: { kind: 'new_code', label: 'New code', disabled: pickLabel },
      };
  }
}

export interface ChipView {
  words: string;
  tone: ChipTone;
  /** What sits before the words. */
  lead: 'dot' | 'spinner' | 'check' | 'cross' | 'pause' | 'ring' | 'hourglass';
}

/** A status from docs/ui.md as a chip: the word, its mark and its color (never color alone). */
export function runStatusChip(status: RunStatus, words: string): ChipView {
  switch (status) {
    case 'not_started':
      return { words, tone: 'muted', lead: 'ring' };
    case 'working':
      return { words, tone: 'default', lead: 'spinner' };
    case 'waiting':
      return { words, tone: 'wait', lead: 'hourglass' };
    case 'done':
      return { words, tone: 'accent', lead: 'check' };
    case 'refused':
    case 'stopped':
      return { words, tone: 'muted', lead: 'pause' };
    case 'failed':
      return { words, tone: 'error', lead: 'cross' };
  }
}

export interface VoiceView extends ChipView {
  /** Show a Retry link next to the chip. */
  retry: boolean;
  /** The raw code, for a tooltip. */
  code: string | null;
}

export function voiceView(voice: VoiceState): VoiceView {
  switch (voice.status) {
    case 'unknown':
      return { words: 'Voice not checked', tone: 'muted', lead: 'ring', retry: false, code: null };
    case 'checking':
      return { words: 'Checking voice', tone: 'default', lead: 'spinner', retry: false, code: null };
    case 'ready':
      return { words: 'Voice ready', tone: 'accent', lead: 'check', retry: false, code: null };
    case 'problem':
      switch (voice.problem) {
        case 'not_paired':
          return { words: voice.words, tone: 'muted', lead: 'pause', retry: false, code: voice.code };
        case 'offline':
          return { words: voice.words, tone: 'muted', lead: 'spinner', retry: false, code: voice.code };
        case 'key_missing':
        case 'service':
        case 'bug':
          return { words: voice.words, tone: 'error', lead: 'cross', retry: true, code: voice.code };
      }
  }
}

export interface ConnectionView extends ChipView {
  /** A sentence under the chip, or null. */
  sentence: string | null;
  /** Offer Forget this device. */
  forget: boolean;
}

export function roleConnectionView(state: RoleConnectionState): ConnectionView {
  const keep = state.tokenSaved === false ? 'This browser does not keep the pairing, so a reload will need a new code.' : null;
  switch (state.status) {
    case 'live':
      return { words: 'Live', tone: 'live', lead: 'dot', sentence: keep, forget: false };
    case 'connecting':
      return { words: 'Connecting', tone: 'default', lead: 'spinner', sentence: keep, forget: false };
    case 'reconnecting':
      return { words: 'Reconnecting', tone: 'default', lead: 'spinner', sentence: 'Showing the last known state', forget: false };
    case 'offline':
      switch (state.problem) {
        case 'token_rejected':
          return { words: 'Offline', tone: 'error', lead: 'cross', sentence: "The database refused this device's saved pairing. Forget this device and pair it again.", forget: true };
        case 'identity_changed':
          return { words: 'Offline', tone: 'error', lead: 'cross', sentence: 'The connection came back as another device. Reload the page.', forget: false };
        case 'subscription':
          return { words: 'Offline', tone: 'error', lead: 'cross', sentence: 'Not connected. The server refused the live tables.', forget: false };
        case 'network':
        case null:
          return { words: 'Offline', tone: 'error', lead: 'cross', sentence: 'Not connected. Check the network.', forget: false };
      }
  }
}

export interface AudioLabels {
  /** The button, for example "Start audio" or "Start room voice". */
  start: string;
  /** The running state, for example "Earpiece on" or "Room voice on". */
  running: string;
}

export const EARPIECE_LABELS: AudioLabels = { start: 'Start audio', running: 'Earpiece on' };
export const ROOM_VOICE_LABELS: AudioLabels = { start: 'Start room voice', running: 'Room voice on' };

export interface AudioView extends ChipView {
  status: RunStatus;
  /** The button's words, or null when no tap is needed. */
  button: string | null;
  buttonDisabled: boolean;
  sentence: string | null;
}

export function audioView(audio: AudioUnlockSnapshot, labels: AudioLabels = EARPIECE_LABELS): AudioView {
  switch (audio.state) {
    case 'locked':
    case 'closed':
      return { words: 'Audio off', tone: 'muted', lead: 'ring', status: 'not_started', button: labels.start, buttonDisabled: false, sentence: 'The browser plays sound only after a tap.' };
    case 'starting':
      return { words: 'Starting audio', tone: 'default', lead: 'spinner', status: 'working', button: labels.start, buttonDisabled: true, sentence: null };
    case 'running':
      return { words: labels.running, tone: 'accent', lead: 'check', status: 'done', button: null, buttonDisabled: false, sentence: null };
    case 'suspended':
      return { words: 'Audio paused by the browser', tone: 'muted', lead: 'pause', status: 'stopped', button: labels.start, buttonDisabled: false, sentence: 'Tap to start it again.' };
    case 'device_changed':
      return {
        words: 'Audio devices changed',
        tone: 'muted',
        lead: 'pause',
        status: 'stopped',
        button: labels.start,
        buttonDisabled: false,
        sentence: 'Check that the right earpiece or speaker is plugged in, then start audio again.',
      };
    case 'failed':
      return { words: 'Audio did not start', tone: 'error', lead: 'cross', status: 'failed', button: 'Try again', buttonDisabled: false, sentence: null };
    case 'unsupported':
      return { words: 'No audio in this browser', tone: 'error', lead: 'cross', status: 'failed', button: null, buttonDisabled: false, sentence: 'Open this page in Chrome.' };
  }
}
