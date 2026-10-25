/**
 * The station engine's state as one plain snapshot, for the screen (components/station) and its pure view model
 * (lib/station/model.ts). Types only: nothing here runs.
 */
import type { RoleConnectionState } from '../role/connection';
import type { PairingState } from '../role/pairing';
import type { InputMode } from '../role/storage';
import type { AudioUnlockSnapshot } from '../voice/audio';
import type { VoiceState } from '../voice/token';
import type { CommandEntry } from './commands';
import type { DecoderHealthWord } from './decoder';
import type { EarpieceState } from './earpiece';
import type { HeardPhase } from './heard';
import type { HeartbeatState } from './heartbeat';
import type { ReadbackState } from './readback';

export type Purpose = 'demo' | 'test';

/** Who holds the active session, as far as this page knows. */
export type Ownership =
  /** No active session, or this page has not claimed it. */
  | 'none'
  /** `start_session` is on its way. */
  | 'starting'
  /** Continue: the first beat will prove the session is this station's. */
  | 'claiming'
  | 'mine'
  /** A beat was refused with `not the session station`. */
  | 'other'
  /** `end_session` is on its way. */
  | 'ending';

export type PauseReasonWord = 'stop' | 'idle' | 'operator' | 'headset_off' | 'headset_lost';

export interface StationSetup {
  mode: InputMode | null;
  purpose: Purpose;
  /** Silent test mode: keyboard only, no voice (docs/station.md 2.9). */
  silent: boolean;
  port: number;
  switchKey: string | null;
  learningSwitch: boolean;
  assistantSpeed: number | null;
  optionSpeed: number | null;
  /** Say a new partner question in the earpiece before its options (lib/station/question.ts); off unless turned on. */
  readQuestion?: boolean;
}

export interface DecoderView {
  word: DecoderHealthWord;
  port: number;
  badMessages: number;
  idsReplaced: number;
  /** A bad message or a replaced id in the last 10 s. */
  recentBad: boolean;
  /** The decoder sent YES, NO or CONFIRM in the last 10 s: it runs `--mode scan`. */
  recentScanWord?: boolean;
  recentIdReplaced: boolean;
  errorText: string | null;
  /** Still connecting after 3 s: most likely Chrome's local network permission prompt is waiting for a click. */
  slowConnect: boolean;
}

export interface ScanView {
  phase: HeardPhase;
  mode: 'answer' | 'menu';
  answerMode: 'pick' | 'yes_no';
  cursor: number;
  optionCount: number;
  pass: number;
  maxPasses: number;
  /** The step's planned length (`step_ends_at - step_started_at`). */
  stepMs: number;
  /** When this step's update arrived, wall clock. */
  arrivedWall: number;
  pauseReason: PauseReasonWord | null;
  pickedRank: number | null;
}

export interface OptionView {
  optionId: bigint;
  rank: number;
  text: string;
  /** The short earpiece words (D18); '' means the earpiece reads `text`. */
  label: string;
  tone: string;
  /** Reply, Errand, Call, Search, Category or Menu. */
  kind: string;
  ready: boolean;
}

export interface WorkView {
  errand: { status: string; formTitle: string; reason: string } | null;
  call: { status: string; contactName: string; reason: string } | null;
  /** The web search waiting for its read-back and confirm (D18). */
  search?: { status: string; reason: string } | null;
}

export interface StationConfigView {
  shareText: boolean;
  heartbeatMs: number;
  idlePauseMs: number;
  menuEnabled: boolean;
  yesNoCueMs: number;
  replyVetoMs: number;
  audioPadMs: number;
}

export interface StationSnapshot {
  /** NEXT_PUBLIC_SPACETIMEDB_HOST and _DB are set. */
  hasSettings: boolean;
  /** For the owner's commands on screen. */
  cliTarget: { server: string; db: string } | null;
  connection: RoleConnectionState;
  pairing: PairingState;
  voice: VoiceState;
  audio: AudioUnlockSnapshot;
  setup: StationSetup;
  decoder: DecoderView | null;
  /** `decoder_healthy` for the chosen mode right now. */
  inputHealthy: boolean;
  visible: boolean;
  focused: boolean;
  phrases: { ready: number; failed: number; total: number; warming: boolean };
  config: StationConfigView | null;
  session: {
    id: bigint | null;
    ownership: Ownership;
    /** The label, when this page started the session. */
    label: string | null;
    error: string | null;
    questionId: bigint | null;
    questionText: string;
    origin: 'partner' | 'menu' | null;
  };
  scan: ScanView | null;
  /** The current version's options, in rank order. */
  options: readonly OptionView[];
  earpiece: EarpieceState;
  /** What the options channel plays now ('question': the partner's question, before its options). */
  playing: 'option' | 'prompt' | 'readback' | 'question' | 'phrase' | null;
  readback: ReadbackState & { windowStartedWall: number | null };
  work: WorkView;
  commands: readonly CommandEntry[];
  heartbeat: HeartbeatState;
  stale: boolean;
  /** A test key was pressed in headset mode, wall clock. */
  keysOffAt: number | null;
  lastCue: { kind: string; reason: string; at: number } | null;
  /** Cartesia failed during this session. */
  voiceDown: boolean;
}
