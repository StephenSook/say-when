/**
 * The station screen's words, as pure functions of the engine's snapshot (docs/station.md 2.2, 2.3, 2.10, 2.14;
 * docs/ui.md). The wearer never looks at this screen; it is for the operator and the judges: one large status, the
 * input mode in words (never presented as brain input when it is not), decoder health, the heartbeat, what is in the
 * earpiece, and the last commands with their outcomes.
 *
 * Words follow the room's toggle `config.share_text_on_board`: with it off, the screen says "Option 2 of 4, warm" and
 * never the option's words, a question's words, or a refusal sentence that may name a person.
 */
import type { ChipView } from '@/components/device/model';
import { formatSeconds } from '@/lib/format';
import type { RunStatus } from '@/lib/status';
import type { InputMode } from '../role/storage';
import { cliServer } from '../role/device';
import type { CommandEntry, CommandEntryStatus } from './commands';
import { decoderUrl, type DecoderHealthWord } from './decoder';
import { KEYBOARD_LEGEND } from './keys';
import type { PauseReasonWord, StationSnapshot } from './snapshot';

export const MODE_WORDS: Readonly<Record<InputMode, string>> = {
  headset: 'Headset',
  keyboard: 'Keyboard test',
  switch: 'USB switch',
};

/** The banner that keeps a stand-in from passing as headset input (docs/station.md 2.3 and 2.5). */
export function inputBanner(s: Pick<StationSnapshot, 'setup'>): string | null {
  const parts: string[] = [];
  if (s.setup.mode === 'keyboard') parts.push('Keyboard test input. These are key presses, not headset signals.');
  if (s.setup.mode === 'switch') parts.push('USB switch input. These are switch presses, not headset signals.');
  if (s.setup.mode === 'keyboard' && s.setup.silent) parts.push('Silent test: options are not voiced.');
  return parts.length ? parts.join(' ') : null;
}

/** The keyboard legend, in keyboard mode only. */
export function keyboardLegend(s: Pick<StationSnapshot, 'setup'>): string | null {
  return s.setup.mode === 'keyboard' ? KEYBOARD_LEGEND : null;
}

export function sessionLabel(mode: InputMode, purpose: 'demo' | 'test'): string {
  // The keyboard is only ever a test stand-in (docs/station.md 2.3).
  return mode === 'keyboard' ? 'keyboard-test' : `${mode}-${purpose}`;
}

export const SESSION_LABEL_RE = /^[a-z0-9_-]{1,20}$/;

const DECODER_WORDS: Readonly<Record<DecoderHealthWord, (port: number) => ChipView>> = {
  off: () => ({ words: 'Decoder off', tone: 'muted', lead: 'ring' }),
  connecting: () => ({ words: 'Looking for the decoder', tone: 'default', lead: 'spinner' }),
  not_found: (port) => ({ words: `Decoder not found on ${decoderUrl(port).replace('ws://', '')}`, tone: 'error', lead: 'cross' }),
  silent: () => ({ words: 'Decoder silent', tone: 'error', lead: 'cross' }),
  not_ready: () => ({ words: 'Decoder says the headset is not ready', tone: 'error', lead: 'cross' }),
  healthy: () => ({ words: 'Decoder healthy', tone: 'accent', lead: 'check' }),
};

/** The input chip: decoder health in headset mode; page visibility and focus for the keyboard and the switch. */
export function inputChip(s: Pick<StationSnapshot, 'setup' | 'decoder' | 'visible' | 'focused' | 'inputHealthy'>): ChipView {
  switch (s.setup.mode) {
    case null:
      return { words: 'No input mode picked', tone: 'muted', lead: 'ring' };
    case 'headset':
      return s.decoder ? DECODER_WORDS[s.decoder.word](s.decoder.port) : DECODER_WORDS.off(s.setup.port);
    case 'keyboard':
      return s.visible ? { words: 'Keyboard test input', tone: 'accent', lead: 'check' } : { words: 'Input off: page hidden', tone: 'error', lead: 'cross' };
    case 'switch':
      if (!s.setup.switchKey) return { words: 'Switch key not learned', tone: 'muted', lead: 'ring' };
      if (!s.visible) return { words: 'Input off: page hidden', tone: 'error', lead: 'cross' };
      if (!s.inputHealthy) return { words: 'Input off: page not focused', tone: 'error', lead: 'cross' };
      return { words: s.focused ? 'USB switch input' : 'USB switch input, focus lost', tone: s.focused ? 'accent' : 'wait', lead: s.focused ? 'check' : 'hourglass' };
  }
}

/** The heartbeat chip. */
export function heartbeatChip(s: Pick<StationSnapshot, 'heartbeat' | 'session'>): ChipView {
  if (s.heartbeat.problem) return { words: 'Connection problem', tone: 'error', lead: 'cross' };
  if (s.heartbeat.armed && s.heartbeat.lastOkAt !== null) return { words: 'Heartbeat on', tone: 'live', lead: 'dot' };
  if (s.heartbeat.armed) return { words: 'Heartbeat starting', tone: 'default', lead: 'spinner' };
  return { words: 'Heartbeat off', tone: 'muted', lead: 'ring' };
}

/** "Heartbeat every 500 ms. Module round trip 95 ms. Earpiece start lag 80 ms." */
export function timingLine(s: Pick<StationSnapshot, 'heartbeat' | 'earpiece' | 'setup'>): string {
  const parts = [`Heartbeat every ${s.heartbeat.intervalMs} ms.`];
  if (s.heartbeat.rttMedianMs !== null) parts.push(`Module round trip ${Math.round(s.heartbeat.rttMedianMs)} ms.`);
  if (!s.setup.silent && s.earpiece.lagMedianMs !== null) parts.push(`Earpiece start lag ${Math.round(s.earpiece.lagMedianMs)} ms.`);
  return parts.join(' ');
}

export function owner(s: Pick<StationSnapshot, 'cliTarget'>, reducer: string): string {
  const target = s.cliTarget ?? { server: 'maincloud', db: 'say-when-dev' };
  return `spacetime call --no-config --server ${target.server} ${target.db} ${reducer}`;
}

export function cliTargetOf(settings: { host: string; db: string } | null): { server: string; db: string } | null {
  return settings ? { server: cliServer(settings.host), db: settings.db } : null;
}

/** The pause sentences on the station screen (docs/station.md 2.14). */
export function pauseSentence(reason: PauseReasonWord | null, mode: InputMode | null, idlePauseMs: number): string {
  switch (reason) {
    case 'stop':
      return 'Paused. YES resumes.';
    case 'idle': {
      const minutes = Math.max(1, Math.round(idlePauseMs / 60_000));
      return `Paused after ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}. YES resumes.`;
    }
    case 'operator':
      return 'Paused by a helper. Only the owner can resume.';
    case 'headset_off':
      return mode === 'headset' || mode === null ? 'Headset off. Nothing will be sent.' : 'Input off. Nothing will be sent.';
    case 'headset_lost':
      return 'Signal lost. Nothing will be sent.';
    case null:
      return 'Paused. Nothing will be sent.';
  }
}

export interface BigStatus {
  status: RunStatus;
  title: string;
  sentence: string | null;
  /** An owner command to show with a copy button. */
  command: string | null;
  /** Announce as an alert: something needs a person now. */
  alert: boolean;
}

function status(status: RunStatus, title: string, sentence: string | null = null, extra: Partial<BigStatus> = {}): BigStatus {
  return { status, title, sentence, command: null, alert: status === 'failed', ...extra };
}

const ACTIVE_ERRAND: Readonly<Record<string, string>> = {
  Drafted: 'Getting it ready',
  Confirmed: 'Confirmed. Sending',
  Submitting: 'Sending',
};

const ACTIVE_CALL: Readonly<Record<string, string>> = {
  Confirmed: 'Confirmed. Calling',
  Dialing: 'Phone call: dialing',
  Ringing: 'Phone call: ringing',
  Connected: 'Phone call: connected',
};

/** The one large status at the top of the station screen. */
export function bigStatus(s: StationSnapshot, now: number): BigStatus {
  if (!s.hasSettings) return status('failed', 'No database is set up for this page.', 'Set NEXT_PUBLIC_SPACETIMEDB_HOST and NEXT_PUBLIC_SPACETIMEDB_DB for this build.');
  if (s.connection.status === 'offline') return status('failed', 'Not connected', 'Nothing will be sent until the connection is back.');
  if (s.pairing.phase !== 'paired') return status('not_started', 'Not paired', 'Pair this station with the owner first.', { alert: false });
  if (s.stale) return status('stopped', 'Connection lost. Nothing will be sent.', 'Reconnecting.');

  const session = s.session;
  if (session.ownership === 'other') {
    return status('failed', 'This session belongs to another station.', 'End it there, or the owner ends it:', { command: owner(s, 'end_session') });
  }
  if (session.ownership === 'starting') return status('working', 'Starting the session');
  if (session.ownership === 'ending') return status('working', 'Ending the session');
  if (session.id === null) {
    return status('not_started', 'No session running', session.error ?? startBlocker(s) ?? 'Ready to start.', { alert: session.error !== null });
  }
  if (session.ownership === 'claiming') return status('working', `Taking over session ${session.id}`);
  if (session.ownership === 'none') return status('waiting', `Session ${session.id} is active.`, 'Continue it here, or end it.', { alert: false });

  // This station runs the session.
  const scan = s.scan;
  if (scan?.phase === 'paused') {
    const command = scan.pauseReason === 'operator' ? owner(s, 'operator_resume') : null;
    return status('stopped', pauseSentence(scan.pauseReason, s.setup.mode, s.config?.idlePauseMs ?? 120_000), null, { command });
  }

  const rb = s.readback;
  if (rb.phase === 'preparing') return status('working', 'Getting the read-back ready');
  if (rb.phase === 'playing') return status('working', 'Reading it back', 'Nothing is sent without a fresh CONFIRM after the read-back.');
  if (rb.phase === 'reporting' || rb.phase === 'hold') return status('waiting', 'Waiting for your confirm', 'The confirm window opens in a moment.');
  if (rb.phase === 'window') {
    const left = rb.windowStartedWall === null ? rb.windowMs : rb.windowMs - (now - rb.windowStartedWall);
    return status('waiting', 'Waiting for your confirm', left > 0 ? `${formatSeconds(left)} left. Silence sends nothing.` : 'The window is closing. Nothing was sent.');
  }
  if (rb.phase === 'too_long') return status('stopped', 'Not sent: the read-back is too long.');
  if (rb.phase === 'late') return status('stopped', 'Not sent: the read-back took too long.');
  if (rb.phase === 'failed') return status('failed', rb.message ?? 'Could not voice the read-back. Nothing will be sent.');

  const errandWord = s.work.errand ? ACTIVE_ERRAND[s.work.errand.status] : undefined;
  if (errandWord) return status('working', errandWord);
  const callWord = s.work.call ? ACTIVE_CALL[s.work.call.status] : undefined;
  if (callWord) return status('working', callWord);

  if (!scan) return status('not_started', 'Idle. Nothing in the earpiece.');
  const of = scan.optionCount > 0 ? ` of ${scan.optionCount}` : '';
  const item = scan.mode === 'menu' ? 'menu item' : 'option';
  switch (scan.phase) {
    case 'preparing':
      return status('working', 'Getting options ready');
    case 'reading':
      return status('working', scan.answerMode === 'yes_no' ? 'Reading: Yes or no?' : `Reading ${item} ${scan.cursor}${of}`);
    case 'window':
      return status('working', scan.answerMode === 'yes_no' ? 'Window open for yes or no' : `Window open for ${item} ${scan.cursor}${of}`, 'NO skips. Silence moves on.');
    case 'veto': {
      const left = Math.max(0, scan.stepMs - (now - scan.arrivedWall));
      const which = scan.pickedRank !== null ? `${item} ${scan.pickedRank}` : 'the reply';
      return status('working', `Picked ${which}. Saying it in ${formatSeconds(left)}.`, 'NO or STOP cancels.');
    }
    case 'idle':
      return status('not_started', 'Idle. Nothing in the earpiece.', s.config?.menuEnabled ? "YES opens the person's menu." : null);
  }
}

/** The newest errand or call that finished, as one line under the status, or null. */
export function lastWorkLine(s: Pick<StationSnapshot, 'work' | 'config'>): string | null {
  const share = s.config?.shareText === true;
  const reason = (text: string) => (share && text.trim() !== '' ? ` ${text.trim()}` : '');
  const e = s.work.errand;
  if (e) {
    if (e.status === 'Submitted') return 'Last request: Sent.';
    if (e.status === 'UnknownOutcome') return 'Last request: it may or may not have gone through.';
    if (e.status === 'Refused' || e.status === 'Failed' || e.status === 'Stopped') return `Last request: Not sent.${reason(e.reason)}`;
  }
  const c = s.work.call;
  if (c) {
    if (c.status === 'Ended') return 'Last phone call: ended.';
    if (c.status === 'Refused' || c.status === 'Failed' || c.status === 'Stopped') return `Last phone call: no call was made.${reason(c.reason)}`;
  }
  return null;
}

export interface EarpieceHero {
  /** "Option 2 of 4, warm", "Yes or no?", "The read-back", or "Nothing". */
  title: string;
  /** The option's words, only while sharing is on. */
  words: string | null;
  note: string | null;
  bar: { value: number; max: number; label: string; valueText: string; tone: 'accent' | 'wait' } | null;
}

/** "In the earpiece now" (docs/station.md 2.2). */
export function earpieceHero(s: StationSnapshot, now: number): EarpieceHero {
  const share = s.config?.shareText === true;
  const scan = s.scan;
  if (s.setup.silent) {
    const title = scan && (scan.phase === 'reading' || scan.phase === 'window') && scan.cursor > 0 ? `Option ${scan.cursor}, not voiced` : 'Nothing';
    return { title, words: null, note: 'Silent test: options are not voiced.', bar: scanBar(s, now) };
  }
  if (s.playing === 'readback') return { title: 'The read-back', words: null, note: null, bar: null };
  if (scan && (scan.phase === 'reading' || scan.phase === 'window')) {
    if (scan.answerMode === 'yes_no') return { title: 'Yes or no?', words: null, note: null, bar: scanBar(s, now) };
    const option = s.options.find((o) => o.rank === scan.cursor);
    const item = scan.mode === 'menu' || option?.kind === 'Menu' ? 'Menu item' : 'Option';
    const of = scan.optionCount > 0 ? ` of ${scan.optionCount}` : '';
    const tone = option && option.tone.trim() !== '' ? `, ${option.tone.trim()}` : '';
    const kind = option?.kind === 'Errand' ? ', a request' : option?.kind === 'Call' ? ', a phone call' : '';
    const waiting = s.earpiece.waitingFor !== null && option && s.earpiece.waitingFor === option.optionId;
    return {
      title: `${item} ${scan.cursor}${of}${tone}${kind}`,
      words: share && option ? option.text : null,
      note: waiting ? 'Its voice is not ready yet. It plays the moment it is.' : null,
      bar: scanBar(s, now),
    };
  }
  if (s.playing === 'phrase') return { title: 'A spoken notice', words: null, note: null, bar: null };
  return { title: 'Nothing', words: null, note: null, bar: null };
}

function scanBar(s: StationSnapshot, now: number): EarpieceHero['bar'] {
  const scan = s.scan;
  if (!scan || scan.stepMs <= 0 || (scan.phase !== 'reading' && scan.phase !== 'window')) return null;
  const elapsed = Math.min(scan.stepMs, Math.max(0, now - scan.arrivedWall));
  if (scan.phase === 'reading') {
    return { value: elapsed, max: scan.stepMs, label: 'Reading the option', valueText: `${formatSeconds(elapsed)} of ${formatSeconds(scan.stepMs)}`, tone: 'accent' };
  }
  const left = scan.stepMs - elapsed;
  return { value: left, max: scan.stepMs, label: 'Time left to answer', valueText: `window, ${formatSeconds(left)} left`, tone: 'wait' };
}

export interface SetupStep {
  key: 'paired' | 'voice' | 'mode' | 'audio' | 'phrases' | 'input';
  label: string;
  status: RunStatus;
  detail: string | null;
}

/** The steps before Start session (docs/station.md 2.2), each with its status and a short reason. */
export function setupSteps(s: StationSnapshot): SetupStep[] {
  const silent = s.setup.silent && s.setup.mode === 'keyboard';
  // Each label says its state in words, so the mark's color and icon are never the only sign of it.
  const voice: SetupStep = silent
    ? { key: 'voice', label: 'Voice not needed in the silent test', status: 'done', detail: null }
    : s.voice.status === 'ready'
      ? { key: 'voice', label: 'Voice ready', status: 'done', detail: null }
      : s.voice.status === 'problem'
        ? { key: 'voice', label: s.voice.words, status: s.voice.problem === 'offline' ? 'working' : 'failed', detail: s.voice.words }
        : { key: 'voice', label: s.voice.status === 'checking' ? 'Checking voice' : 'Voice not checked yet', status: s.voice.status === 'checking' ? 'working' : 'not_started', detail: 'Checking with the database.' };
  const audioFailed = s.audio.state === 'failed' || s.audio.state === 'unsupported';
  const audio: SetupStep = silent
    ? { key: 'audio', label: 'Earpiece not needed in the silent test', status: 'done', detail: null }
    : s.audio.state === 'running'
      ? { key: 'audio', label: 'Earpiece on', status: 'done', detail: null }
      : { key: 'audio', label: audioFailed ? 'Earpiece did not start' : 'Earpiece off', status: audioFailed ? 'failed' : 'not_started', detail: 'Press Start audio.' };
  const total = s.phrases.total;
  const phrases: SetupStep = silent
    ? { key: 'phrases', label: 'Phrases not needed in the silent test', status: 'done', detail: null }
    : s.phrases.failed > 0
      ? {
          key: 'phrases',
          label: `Phrases ready ${s.phrases.ready} of ${total}, ${s.phrases.failed} failed`,
          status: 'failed',
          detail: `${s.phrases.failed} could not be voiced. Check the voice, then Retry.`,
        }
      : s.phrases.ready >= total && total > 0
        ? { key: 'phrases', label: `Phrases ready ${s.phrases.ready} of ${total}`, status: 'done', detail: null }
        : {
            key: 'phrases',
            label: total > 0 ? `Phrases ${s.phrases.ready} of ${total}` : 'Phrases not voiced yet',
            status: s.phrases.warming ? 'working' : 'not_started',
            detail: s.phrases.warming ? null : 'They are voiced once the voice and the earpiece are ready.',
          };
  const input = inputStep(s);
  const paired = s.pairing.phase === 'paired';
  return [
    { key: 'paired', label: paired ? 'Paired' : 'Not paired', status: paired ? 'done' : 'not_started', detail: null },
    voice,
    { key: 'mode', label: s.setup.mode ? `Input: ${MODE_WORDS[s.setup.mode]}` : 'No input mode picked', status: s.setup.mode ? 'done' : 'not_started', detail: s.setup.mode ? null : 'Pick one below.' },
    audio,
    phrases,
    input,
  ];
}

function inputStep(s: StationSnapshot): SetupStep {
  switch (s.setup.mode) {
    case null:
      return { key: 'input', label: 'Input not ready', status: 'not_started', detail: null };
    case 'headset': {
      const chip = inputChip(s);
      const ok = s.decoder?.word === 'healthy';
      return { key: 'input', label: ok ? 'Decoder healthy' : chip.words, status: ok ? 'done' : 'not_started', detail: ok ? null : 'Start the decoder, or switch to keyboard test.' };
    }
    case 'keyboard':
      return {
        key: 'input',
        label: s.visible ? 'Keyboard ready' : 'Input off: page hidden',
        status: s.visible ? 'done' : 'not_started',
        detail: s.visible ? null : 'Keep this window in front.',
      };
    case 'switch':
      if (!s.setup.switchKey) return { key: 'input', label: 'Switch key not learned', status: 'not_started', detail: 'Learn the switch key below.' };
      return {
        key: 'input',
        label: s.inputHealthy ? 'USB switch ready' : 'Input off: page not focused',
        status: s.inputHealthy ? 'done' : 'not_started',
        detail: s.inputHealthy ? null : 'Keep this window in front and focused.',
      };
  }
}

/** Why Start session is not allowed yet, or null when it is. */
export function startBlocker(s: StationSnapshot): string | null {
  if (s.connection.status !== 'live') return 'Waiting for the connection.';
  if (s.session.id !== null) return `Session ${s.session.id} is already active.`;
  for (const step of setupSteps(s)) {
    if (step.status === 'done') continue;
    if (step.key === 'paired') return 'Pair this station first.';
    if (step.key === 'voice') return s.voice.status === 'problem' && s.setup.mode === 'keyboard' ? `${step.detail ?? 'Voice is off.'} The silent test works without it.` : (step.detail ?? 'Waiting for the voice check.');
    if (step.key === 'mode') return 'Pick an input mode.';
    if (step.key === 'audio') return 'Press Start audio.';
    if (step.key === 'phrases') return step.status === 'failed' ? (step.detail ?? 'Some phrases could not be voiced.') : 'Waiting for the phrases.';
    if (step.key === 'input') return step.detail ?? 'The input is not ready.';
  }
  return null;
}

export const COMMAND_STATUS: Readonly<Record<CommandEntryStatus, RunStatus>> = {
  sending: 'working',
  accepted: 'done',
  ignored: 'stopped',
  not_sent: 'stopped',
  refused: 'failed',
  unknown: 'not_started',
};

const SOURCE_WORDS: Readonly<Record<string, string>> = {
  key: 'key',
  switch: 'switch',
  imagery: 'imagery',
  jaw: 'jaw',
  decoder: 'decoder',
};

export interface CommandRow {
  key: string;
  command: string;
  source: string;
  words: string;
  status: RunStatus;
  title: string | null;
  note: string | null;
}

/** "YES  key  Picked option 2", newest first. HEADSET_OFF reads "HEADSET_OFF (test)" when it came from a key. */
export function commandRows(commands: readonly CommandEntry[]): CommandRow[] {
  return commands.map((c) => ({
    key: c.gestureId,
    command: c.command === 'HEADSET_OFF' && c.via !== 'decoder' ? 'HEADSET_OFF (test)' : c.command,
    source: SOURCE_WORDS[c.source] ?? c.source,
    words: c.words,
    status: COMMAND_STATUS[c.status],
    title: c.errorText,
    note: c.idReplaced ? 'Decoder id replaced' : null,
  }));
}

/** "Session 7, keyboard-test, running." */
export function sessionLine(s: Pick<StationSnapshot, 'session'>): string | null {
  const session = s.session;
  if (session.id === null) return null;
  const label = session.label ? `, ${session.label}` : '';
  const state = session.ownership === 'mine' ? 'running' : session.ownership === 'claiming' ? 'taking over' : 'active';
  return `Session ${session.id}${label}, ${state}.`;
}

/**
 * Notes for the owner's timing settings (docs/station.md 2.9): an earpiece start lag over `audio_pad_ms` means the
 * wearer hears the end of an option inside its window; a "Yes or no?" prompt longer than `yes_no_cue_ms` is cut short.
 */
export function tuningNotes(s: Pick<StationSnapshot, 'earpiece' | 'config' | 'setup'>): string[] {
  const notes: string[] = [];
  if (s.setup.silent || !s.config) return notes;
  const lag = s.earpiece.lagMedianMs;
  if (lag !== null && lag > s.config.audioPadMs) {
    notes.push(`Earpiece start lag ${Math.round(lag)} ms is over audio_pad_ms ${s.config.audioPadMs}. The owner raises audio_pad_ms with set_timing.`);
  }
  const prompt = s.earpiece.yesNoPromptMs;
  if (prompt !== null) notes.push(`The "Yes or no?" prompt is ${prompt} ms, longer than yes_no_cue_ms ${s.config.yesNoCueMs}. The owner raises it to ${prompt + 150} with set_timing.`);
  if (s.earpiece.wordTimingsOff) notes.push('This module does not take word timings yet, so the board cannot mark the word being read.');
  return notes;
}

/** The decoder's warnings, for 10 s after they happen. */
/** docs/station.md 5.1: from an https page, Chrome holds the decoder socket until the local network prompt is answered. */
export const DECODER_PERMISSION_NOTE = 'Still looking for the decoder. If Chrome asks to connect to devices on your local network, click Allow.';

export function decoderNotes(s: Pick<StationSnapshot, 'decoder'>): string[] {
  const notes: string[] = [];
  if (s.decoder?.slowConnect && s.decoder.word === 'connecting') notes.push(DECODER_PERMISSION_NOTE);
  if (s.decoder?.recentBad) notes.push(`Bad decoder message (${s.decoder.badMessages} so far).`);
  if (s.decoder?.recentIdReplaced) notes.push(`Decoder id replaced (${s.decoder.idsReplaced} so far). The command was still sent.`);
  return notes;
}
