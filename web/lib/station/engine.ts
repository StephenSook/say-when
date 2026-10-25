/**
 * The station engine (docs/station.md 2.1): plain TypeScript outside React that wires the paired role connection,
 * the inputs, the heard log, the command sender, the heartbeat, the earpiece, read-backs, cues and staleness. React
 * renders `getState()` (lib/station/snapshot.ts) and calls the action methods from clicks.
 *
 *  decoder ws://127.0.0.1:<port> -> DecoderBridge --+
 *  keyboard or USB switch --------> keys ------------+--> CommandSender ---> gesture(...)
 *  scan_state, my_options --------> HeardLog <-------+        (heard step and option at the onset)
 *  scan_state, my_options, cues --> Earpiece, CueSpeaker (two channels, chimes)
 *  my_session.errand/.call/.search > Readback ---> report_readback_done
 *  my_session question -----------> QuestionReader ---> Earpiece.playQuestion ("Question: ...", then the options)
 *  worker tick every heartbeat_ms -> Heartbeat ---> heartbeat(beat_seq, decoder_healthy)
 *
 * Row callbacks are registered once per connection object (lib/role/connection.ts), never in a render. The SDK runs
 * row callbacks after the whole transaction is in the cache, and cues are read one microtask later, so a cue sees
 * the scan step its own transaction wrote.
 */
import { tables, type DbConnection } from '../data/module_bindings';
import type { SpacetimeSettings } from '../data/source-mode';
import { AudioOut, PhraseCache, TtsPlayer, type AudioContextLike, type Clip } from '../cartesia/tts';
import { utterance, voiceProfile, type Utterance, type VoiceProfile } from '../cartesia/tones';
import { callErrorText, isSenderMessage, notConnectedError, SENDER_MESSAGES, wordTimingsReducer } from '../role/calls';
import { initialPairingState } from '../role/pairing';
import { createRoleDevice, type RoleDevice, type RoleDeviceOptions } from '../role/device';
import {
  browserStorage,
  readAssistantSpeed,
  readDecoderPort,
  readInputMode,
  readOptionSpeed,
  readReadQuestion,
  readSwitchKey,
  saveDecoderPort,
  saveInputMode,
  saveReadQuestion,
  saveSpeed,
  saveSwitchKey,
  type InputMode,
  type StorageLike,
} from '../role/storage';
import { contextLatencyMs, createAudioUnlock, type AudioUnlock, type ChimeName } from '../voice/audio';
import { CommandSender, confirmDigest, type CommandInput, type StationCommand } from './commands';
import { CueSpeaker, cueAction, type CueLite } from './cues';
import { DecoderBridge } from './decoder';
import { Channel, Earpiece, type OptionRowLite, type ScanLite, type SynthJob } from './earpiece';
import { HeardLog, type HeardPhase } from './heard';
import { Heartbeat, heartbeatInterval, inputHealthy, workerTicker, FOCUS_GRACE_MS, type Ticker } from './heartbeat';
import { canLearnSwitchKey, isPickKey, isTypingTarget, keyboardCommand, SwitchPattern } from './keys';
import { cliTargetOf, SESSION_LABEL_RE, sessionLabel } from './model';
import { isMenuItemText, MENU_ITEM_TEXTS, optionEarText, phraseText, warmPhraseKeys, type PhraseKey } from './phrases';
import { indexedDbClipStore, persistentSynth, type ClipStore } from './phrase-store';
import { QuestionReader, type SessionQuestion } from './question';
import { Readback, readbackSegments, type WorkLite } from './readback';
import type { Ownership, PauseReasonWord, Purpose, ScanView, StationSnapshot } from './snapshot';
import { StalenessWatch } from './staleness';

/** The lead AudioOut schedules every clip with (cartesia/src/tts.ts `leadSeconds = 0.05`). */
export const AUDIO_OUT_LEAD_MS = 50;
/** Decoder warnings stay on screen this long. */
const NOTE_MS = 10_000;

const PHASES: Readonly<Record<string, HeardPhase>> = {
  Idle: 'idle',
  Preparing: 'preparing',
  Reading: 'reading',
  Window: 'window',
  Veto: 'veto',
  Paused: 'paused',
};

const PAUSE_WORDS: Readonly<Record<string, PauseReasonWord>> = {
  Stop: 'stop',
  Idle: 'idle',
  Operator: 'operator',
  HeadsetOff: 'headset_off',
  HeadsetLost: 'headset_lost',
};

type Row<T extends keyof DbConnection['db']> = DbConnection['db'][T] extends { iter(): Iterable<infer R> } ? R : never;
type ScanRow = Row<'scanState'>;
type SessionRow = Row<'mySession'>;
type OptionRow = Row<'myOptions'>;
type ConfigRow = Row<'config'>;

function micros(ts: { microsSinceUnixEpoch: bigint } | undefined | null): bigint | null {
  return ts ? ts.microsSinceUnixEpoch : null;
}

/** `my_session`'s scanned question, as lib/station/question.ts reads it. */
function sessionQuestion(row: SessionRow | null): SessionQuestion | null {
  if (!row) return null;
  return {
    questionId: row.questionId,
    text: row.questionText,
    origin: row.origin.tag === 'Menu' ? 'menu' : 'partner',
    lastGestureOutcome: row.lastGestureOutcome,
  };
}

function perfNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export interface StationEngineOptions {
  settings: SpacetimeSettings | null;
  storage?: StorageLike | null;
  /** NEXT_PUBLIC_CARTESIA_DICT_ID, an id and not a secret; unset until a dictionary exists. */
  pronunciationDictId?: string;
  /** More subscriptions on this connection, for a page that reads more than the station does (the try page). */
  extraQueries?: RoleDeviceOptions<DbConnection>['queries'];
  /** Where stock phrase audio is kept across loads (lib/station/phrase-store.ts): IndexedDB by default, null for none. */
  phraseStore?: ClipStore | null;
  /** For tests: the connection builder, the voice mint and the heartbeat tick. */
  builder?: RoleDeviceOptions<DbConnection>['builder'];
  mint?: RoleDeviceOptions<DbConnection>['mint'];
  ticker?: Ticker;
}

export class StationEngine {
  readonly device: RoleDevice | null;
  private audio: AudioUnlock;
  private player: TtsPlayer | null = null;
  private cache: PhraseCache | null = null;
  private optionsOut: AudioOut | null = null;
  private promptsOut: AudioOut | null = null;
  private audioContext: AudioContext | null = null;
  private profile: VoiceProfile;

  private readonly heard = new HeardLog();
  private readonly optionsChannel: Channel<Clip>;
  private readonly promptsChannel: Channel<Clip>;
  private readonly earpiece: Earpiece<Clip>;
  private readonly question: QuestionReader<Clip>;
  private readonly readback: Readback<Clip>;
  private readonly cues: CueSpeaker<Clip>;
  private readonly sender: CommandSender;
  private readonly heartbeat: Heartbeat;
  private readonly staleness: StalenessWatch;
  private readonly switchPattern: SwitchPattern;
  private decoder: DecoderBridge | null = null;

  private readonly storage: StorageLike | null;
  private mode: InputMode | null;
  private purpose: Purpose = 'demo';
  private silent = false;
  private port: number;
  private switchKey: string | null;
  private learning = false;
  private assistantSpeed: number | null;
  private optionSpeed: number | null;
  /** Say a new partner question in the earpiece before its options (lib/station/question.ts). */
  private readQuestion: boolean;

  private phrases = { ready: 0, failed: 0, total: 0, warming: false };
  private warmRun = 0;

  private sessionId: bigint | null = null;
  private ownership: Ownership = 'none';
  /** Set while this station's own start_session is out; the next new session id is ours. */
  private expectNewSession = false;
  private startedLabel: string | null = null;
  private sessionError: string | null = null;
  /** The session a "Could not end the session" error is about; null for a start error, which belongs to no session. */
  private sessionErrorFor: bigint | null = null;
  private configRow: ConfigRow | null = null;
  private sessionRow: SessionRow | null = null;
  private scanView: ScanView | null = null;
  private options: OptionRowLite[] = [];
  private lastCue: StationSnapshot['lastCue'] = null;
  private voiceDown = false;
  private keysOffAt: number | null = null;
  private stale = false;

  private visible = true;
  private focused = true;
  private blurredAt: number | null = null;
  private blurTimer: ReturnType<typeof setTimeout> | null = null;
  private lastInputHealthy: boolean | null = null;

  private running = false;
  private readonly listeners = new Set<() => void>();
  private snapshot: StationSnapshot | null = null;
  private notifyQueued = false;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly pendingCues: CueLite[] = [];
  private noteTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options_: StationEngineOptions) {
    this.storage = options_.storage === undefined ? browserStorage() : options_.storage;
    this.mode = readInputMode(this.storage);
    this.port = readDecoderPort(this.storage);
    this.switchKey = readSwitchKey(this.storage);
    this.assistantSpeed = readAssistantSpeed(this.storage);
    this.optionSpeed = readOptionSpeed(this.storage);
    this.readQuestion = readReadQuestion(this.storage);
    this.profile = this.makeProfile();
    this.audio = createAudioUnlock();

    const channelOut = (which: 'options' | 'prompts') => ({
      play: (clip: Clip) => {
        const out = which === 'options' ? this.optionsOut : this.promptsOut;
        return out ? out.play(clip) : Promise.resolve<'ended' | 'stopped'>('stopped');
      },
      stop: () => (which === 'options' ? this.optionsOut : this.promptsOut)?.stop(),
      positionMs: () => (which === 'options' ? this.optionsOut : this.promptsOut)?.positionMs() ?? 0,
    });
    this.optionsChannel = new Channel<Clip>(channelOut('options'));
    this.promptsChannel = new Channel<Clip>(channelOut('prompts'));

    const waitForLive = (ms: number) => this.device?.connection.whenLive(ms) ?? Promise.resolve(false);

    this.earpiece = new Earpiece<Clip>({
      now: perfNow,
      latencyMs: () => AUDIO_OUT_LEAD_MS + contextLatencyMs(this.audio.context()),
      heard: this.heard,
      options: this.optionsChannel,
      speakOption: (row) => this.speakOption(row),
      yesNoPrompt: () => this.phraseClip('yesOrNo'),
      silent: () => this.isSilent(),
      ready: () => this.player !== null && this.cache !== null,
      reportClip: (args) => {
        const conn = this.conn();
        return conn ? conn.reducers.reportClipReady(args) : Promise.reject(notConnectedError());
      },
      wordTimings: () => wordTimingsReducer(this.conn()),
      waitForLive,
      onVoiceError: (error) => this.voiceError(error),
      promptsBusy: () => this.promptsChannel.busy(),
      onChange: () => this.changed(),
    });

    // The partner's question, "Question: ...", voiced by the same player as the option clips (assistant voice) and
    // played by the earpiece before its list. Direct select only (see directSelect).
    this.question = new QuestionReader<Clip>({
      now: perfNow,
      enabled: () => this.readQuestion && this.sessionRuns() && !this.isSilent() && this.directSelect(),
      ready: () => this.player !== null,
      synth: (text) => this.speak(utterance({ kind: 'prompt', text }, this.profile)),
      play: (questionId, clip) => this.earpiece.playQuestion(questionId, clip),
      onVoiceError: (error) => this.voiceError(error),
    });

    this.readback = new Readback<Clip>({
      now: perfNow,
      synth: (text, kind) => this.speak(utterance({ kind: 'readback', segments: readbackSegments(text, this.mode ?? 'headset', kind) }, this.profile)),
      channel: this.optionsChannel,
      report: (args) => {
        const conn = this.conn();
        return conn ? conn.reducers.reportReadbackDone({ kind: args.kind, id: args.id, digest: args.digest }) : Promise.reject(notConnectedError());
      },
      waitForLive,
      chime: (name) => this.chime(name),
      timing: () => ({
        readbackDeadlineMs: this.configRow?.readbackDeadlineMs ?? 30_000,
        quietHoldMs: this.configRow?.quietHoldMs ?? 1_000,
        confirmWindowMs: this.configRow?.confirmWindowMs ?? 8_000,
      }),
      sayTooLong: () => this.say('tooLong'),
      sayInterrupted: () => this.say('interrupted'),
      onVoiceError: (error) => this.voiceError(error),
      onChange: () => this.changed(),
    });

    this.cues = new CueSpeaker<Clip>({
      now: perfNow,
      phrase: (key) => this.phraseClip(key),
      text: (text) => this.speak(utterance({ kind: 'prompt', text }, this.profile)).done,
      options: this.optionsChannel,
      prompts: this.promptsChannel,
      chime: (name) => this.chime(name),
      stopReadback: () => this.readback.stop(),
      stopOptions: () => this.earpiece.stopOptions(),
    });

    this.sender = new CommandSender({
      now: perfNow,
      wallNow: Date.now,
      heardAt: (onset) => this.heard.lookup(onset),
      digest: () => confirmDigest(this.workLite(), this.readback.played),
      oneWayMs: () => this.heartbeat.oneWayMs(),
      send: (args) => {
        const conn = this.conn();
        return conn ? conn.reducers.gesture(args) : Promise.reject(notConnectedError());
      },
      waitForLive,
      chime: (name) => this.chime(name),
      feedback: (fb) => {
        if ('chime' in fb) this.chime(fb.chime);
        else this.say(fb.phrase);
      },
      rankOf: (id) => this.earpiece.rowOf(id)?.rank ?? null,
      sessionRefused: (error) => this.sessionRefused(error),
      onChange: () => this.changed(),
    });

    this.heartbeat = new Heartbeat({
      send: (beatSeq, decoderHealthy) => {
        const conn = this.conn();
        return conn ? conn.reducers.heartbeat({ beatSeq, decoderHealthy }) : Promise.reject(notConnectedError());
      },
      healthy: () => this.inputHealthyNow(),
      canBeat: () => this.canBeat(),
      ticker: options_.ticker ?? workerTicker(),
      now: perfNow,
      onBeatOk: () => {
        if (this.ownership === 'claiming') {
          this.ownership = 'mine';
          this.changed();
        }
      },
      onRefused: (error) => this.sessionRefused(error),
      onChange: () => this.changed(),
    });

    this.staleness = new StalenessWatch({
      onStale: () => {
        if (this.ownership !== 'mine') return;
        this.stale = true;
        if (!this.isSilent()) this.cues.safety('connectionLost');
        else this.earpiece.stopOptions();
        this.changed();
      },
    });

    this.switchPattern = new SwitchPattern({
      onCommand: (command, onset) => this.relay({ command, gestureId: null, source: 'switch', confidence: 1, onsetLocal: onset, via: 'switch' }),
    });

    this.device = options_.settings
      ? createRoleDevice<DbConnection>({
          role: 'station',
          settings: options_.settings,
          storage: this.storage,
          queries: [tables.config, tables.scanState, tables.deviceStatus, tables.cueEvent, tables.mySession, tables.myOptions, ...(options_.extraQueries ?? [])],
          attach: (conn) => this.attach(conn),
          onApplied: (conn) => this.readAll(conn),
          ...(options_.builder ? { builder: options_.builder } : {}),
          ...(options_.mint ? { mint: options_.mint } : {}),
        })
      : null;
  }

  // ---------- The store React reads ----------

  getState = (): StationSnapshot => {
    if (!this.snapshot) this.snapshot = this.build();
    return this.snapshot;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private changed(): void {
    this.snapshot = null;
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      for (const listener of [...this.listeners]) listener();
    });
  }

  // ---------- Life cycle ----------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.unsubscribers.push(this.audio.subscribe(() => this.audioChanged()));
    if (this.device) {
      this.unsubscribers.push(this.device.connection.subscribe(() => this.connectionChanged()));
      this.unsubscribers.push(this.device.pairing.subscribe(() => this.pairingChanged()));
      this.unsubscribers.push(this.device.voice.subscribe(() => this.voiceChanged()));
      this.device.start();
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onKeyDown, true);
      window.addEventListener('keyup', this.onKeyUp, true);
      window.addEventListener('focus', this.onFocus);
      window.addEventListener('blur', this.onBlur);
      document.addEventListener('visibilitychange', this.onVisibility);
      this.visible = document.visibilityState === 'visible';
      this.focused = document.hasFocus();
    }
    this.syncDecoder();
    this.changed();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const off of this.unsubscribers.splice(0)) off();
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.onKeyDown, true);
      window.removeEventListener('keyup', this.onKeyUp, true);
      window.removeEventListener('focus', this.onFocus);
      window.removeEventListener('blur', this.onBlur);
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
    if (this.blurTimer) clearTimeout(this.blurTimer);
    this.blurTimer = null;
    if (this.noteTimer) clearTimeout(this.noteTimer);
    this.noteTimer = null;
    this.heartbeat.disarm();
    this.staleness.stop();
    this.switchPattern.reset();
    this.decoder?.stop();
    this.decoder = null;
    this.readback.stop();
    this.cues.clear();
    this.question.cancel();
    this.earpiece.dispose();
    this.player?.close();
    this.player = null;
    this.cache = null;
    this.optionsOut = null;
    this.promptsOut = null;
    this.audio.close();
    this.audioContext = null;
    this.device?.stop();
    this.ownership = this.ownership === 'mine' || this.ownership === 'claiming' ? 'none' : this.ownership;
    this.phrases = { ready: 0, failed: 0, total: this.phrases.total, warming: false };
  }

  // ---------- Actions from the screen ----------

  chooseMode(mode: InputMode): void {
    if (this.sessionRuns()) return;
    this.mode = mode;
    saveInputMode(mode, this.storage);
    if (mode !== 'keyboard') this.silent = false;
    if (mode === 'keyboard') this.purpose = 'test';
    this.switchPattern.reset();
    this.heard.setSilent(this.isSilent());
    this.syncDecoder();
    // The confirm sentences differ per mode: voice the new mode's set.
    this.warmPhrases(true);
    this.inputMaybeChanged();
    this.changed();
  }

  choosePurpose(purpose: Purpose): void {
    if (this.sessionRuns()) return;
    this.purpose = this.mode === 'keyboard' ? 'test' : purpose;
    this.changed();
  }

  /** Silent test mode: keyboard only (docs/station.md 2.9). */
  setSilent(silent: boolean): void {
    if (this.sessionRuns()) return;
    this.silent = silent && this.mode === 'keyboard';
    this.heard.setSilent(this.isSilent());
    this.changed();
  }

  setPort(port: number): boolean {
    if (!saveDecoderPort(port, this.storage)) return false;
    this.port = port;
    this.decoder?.setPort(port);
    this.changed();
    return true;
  }

  /** "Press your switch now": the next key's code becomes the switch key. */
  learnSwitch(on = true): void {
    this.learning = on;
    this.changed();
  }

  /**
   * "Read the partner's question in the earpiece" (on by default): a new partner question is said before its
   * options. Turning it off drops a question still being voiced; one already playing finishes.
   */
  setReadQuestion(on: boolean): void {
    this.readQuestion = on;
    saveReadQuestion(on, this.storage);
    if (!on) this.question.cancel();
    this.changed();
  }

  setSpeed(which: 'assistant' | 'option', speed: number | null): boolean {
    if (!saveSpeed(which, speed, this.storage)) return false;
    if (which === 'assistant') this.assistantSpeed = speed;
    else this.optionSpeed = speed;
    this.profile = this.makeProfile();
    // Speed is part of every cached phrase's key: voice them again, restarting any warm-up still on the old speed.
    this.cache?.clear();
    this.warmPhrases(true);
    this.changed();
    return true;
  }

  /** Call directly from the Start audio click, so the browser counts it as the user's gesture. */
  startAudio(): Promise<void> {
    return this.audio.start().then(() => this.audioChanged());
  }

  retryVoice(): void {
    this.device?.recheckVoice();
  }

  retryPhrases(): void {
    this.warmPhrases(true);
  }

  /**
   * Start a session. The try page (PLAN 5.11) passes its own label and `replaceActive`: in the module's try sandbox a
   * try whose station went quiet or ran past its time gives way, and the module (not this page) decides.
   */
  startSession(options: { label?: string; replaceActive?: boolean } = {}): void {
    const conn = this.conn();
    if (!conn || !this.mode || this.sessionRuns()) return;
    if (this.sessionId !== null && !options.replaceActive) return;
    const label = options.label ?? sessionLabel(this.mode, this.purpose);
    if (!SESSION_LABEL_RE.test(label)) return;
    this.ownership = 'starting';
    this.sessionError = null;
    // The session id this start makes is ours, also when it replaces another one (readSession).
    this.expectNewSession = true;
    this.changed();
    conn.reducers.startSession({ label }).then(
      () => {
        this.startedLabel = label;
        this.ownership = 'mine';
        this.prepareSession();
        this.heartbeat.arm(heartbeatInterval(this.configRow?.heartbeatMs));
        this.heartbeat.beat();
        this.changed();
      },
      (error: unknown) => {
        this.ownership = 'none';
        this.expectNewSession = false;
        this.device?.noteCallError(error);
        this.sessionError = `Could not start the session: ${callErrorText(error)}`;
        this.sessionErrorFor = null;
        this.changed();
      },
    );
  }

  /** Continue: take the active session; the first beat proves it is this station's (docs/station.md 2.10). */
  continueSession(): void {
    if (this.sessionId === null || this.sessionRuns()) return;
    this.ownership = 'claiming';
    this.sessionError = null;
    this.prepareSession();
    this.heartbeat.arm(heartbeatInterval(this.configRow?.heartbeatMs));
    this.heartbeat.beat();
    this.changed();
  }

  /** "Start audio and continue session N": one click after a reload. */
  startAudioAndContinue(): void {
    const started = this.audio.start();
    this.continueSession();
    void started.then(() => this.audioChanged());
  }

  endSession(): void {
    const conn = this.conn();
    if (!conn || this.sessionId === null) return;
    const was = this.ownership;
    const ending = this.sessionId;
    this.ownership = 'ending';
    this.changed();
    conn.reducers.endSession({}).then(
      () => {
        this.sessionEnded();
      },
      (error: unknown) => {
        this.device?.noteCallError(error);
        // The session ended meanwhile (the owner ended it): nothing is left to end, and nothing to report.
        if (this.sessionId !== ending) {
          this.changed();
          return;
        }
        this.ownership = was;
        this.sessionError = `Could not end the session: ${callErrorText(error)}`;
        this.sessionErrorFor = ending;
        this.changed();
      },
    );
  }

  /**
   * An on-screen button on the judge try page (PLAN 5.11): the same path as a key press in keyboard mode, recorded with
   * source `button`, so nobody can mistake it for a headset signal. Ignored in any other mode.
   */
  press(command: StationCommand, onsetLocal: number = perfNow()): void {
    if (this.mode !== 'keyboard') return;
    this.relay({ command, gestureId: null, source: 'button', confidence: 1, onsetLocal, via: 'button' });
  }

  /** The word being read in the options channel now, for the screen's mark (sharing on only). */
  wordIndex(): number {
    const clip = this.optionsChannel.clip();
    if (!clip || this.optionsChannel.use() !== 'option') return -1;
    const ms = this.optionsChannel.positionMs();
    let index = -1;
    for (let i = 0; i < clip.words.length; i++) {
      if ((clip.words[i]?.startMs ?? Infinity) <= ms) index = i;
      else break;
    }
    return index;
  }

  /** The words of the clip in the options channel now, as Cartesia timed them. */
  playingWords(): readonly string[] {
    const clip = this.optionsChannel.clip();
    return clip && this.optionsChannel.use() === 'option' ? clip.words.map((w) => w.word) : [];
  }

  // ---------- Rows ----------

  private conn(): DbConnection | null {
    return this.device?.connection.conn() ?? null;
  }

  private attach(conn: DbConnection): () => void {
    const db = conn.db;
    const onScan = () => this.readScan(conn);
    const onSession = () => this.readSession(conn);
    const onOptions = () => this.readOptions(conn);
    const onConfig = () => this.readConfig(conn);
    const onCue = (_ctx: unknown, row: Row<'cueEvent'>) => this.cueArrived(row);
    db.scanState.onInsert(onScan);
    db.scanState.onUpdate(onScan);
    db.mySession.onInsert(onSession);
    db.mySession.onUpdate(onSession);
    db.mySession.onDelete(onSession);
    db.myOptions.onInsert(onOptions);
    db.myOptions.onUpdate(onOptions);
    db.myOptions.onDelete(onOptions);
    db.config.onInsert(onConfig);
    db.config.onUpdate(onConfig);
    db.cueEvent.onInsert(onCue);
    return () => {
      db.scanState.removeOnInsert(onScan);
      db.scanState.removeOnUpdate(onScan);
      db.mySession.removeOnInsert(onSession);
      db.mySession.removeOnUpdate(onSession);
      db.mySession.removeOnDelete(onSession);
      db.myOptions.removeOnInsert(onOptions);
      db.myOptions.removeOnUpdate(onOptions);
      db.myOptions.removeOnDelete(onOptions);
      db.config.removeOnInsert(onConfig);
      db.config.removeOnUpdate(onConfig);
      db.cueEvent.removeOnInsert(onCue);
    };
  }

  /** After every (re)subscribe: cue rows from a gap are gone, so the screen reads state, not cues (docs/station.md 2.15). */
  private readAll(conn: DbConnection): void {
    this.readConfig(conn);
    this.readSession(conn);
    this.readOptions(conn);
    this.readScan(conn);
    this.syncDecoder();
  }

  private readConfig(conn: DbConnection): void {
    try {
      this.configRow = [...conn.db.config.iter()][0] ?? null;
    } catch {
      this.configRow = null;
    }
    if (this.configRow && this.heartbeat.getState().armed) this.heartbeat.arm(heartbeatInterval(this.configRow.heartbeatMs));
    this.changed();
  }

  private readSession(conn: DbConnection): void {
    let row: SessionRow | null = null;
    try {
      row = [...conn.db.mySession.iter()][0] ?? null;
    } catch {
      row = null;
    }
    this.sessionRow = row;
    const id = row ? row.sessionId : null;
    if (id !== this.sessionId) {
      const had = this.sessionId !== null;
      this.sessionId = id;
      // The first new id after this station's own start is that session, not one that replaced ours.
      if (this.expectNewSession && id !== null) this.expectNewSession = false;
      else if (had) this.sessionEnded(id !== null);
    }
    if (row) {
      this.sender.noteOutcome(row.lastGestureId, row.lastGestureOutcome);
      if (row.questionId !== 0n) this.earpiece.setAnswerHint(row.questionId, row.answerMode.tag === 'YesNo' ? 'yes_no' : 'pick');
      // A new partner question is voiced now, ahead of its options' clips, and said before its list.
      if (this.sessionRuns()) this.question.update(sessionQuestion(row));
      const [errand, call, search] = this.workRows(row);
      if (this.sessionRuns()) this.readback.update(errand, call, perfNow(), search);
    }
    this.changed();
  }

  private readOptions(conn: DbConnection): void {
    let rows: OptionRow[] = [];
    try {
      rows = [...conn.db.myOptions.iter()];
    } catch {
      rows = [];
    }
    this.options = rows.map((r) => ({
      optionId: r.optionId,
      questionId: r.questionId,
      version: r.version,
      rank: r.rank,
      kind: r.kind.tag,
      text: r.text,
      // A row from a module before D18 has no label: the earpiece then reads the text.
      label: r.label ?? '',
      tone: r.tone,
      laugh: r.laugh,
      current: r.current,
    }));
    this.earpiece.setOptions(this.sessionRuns() ? this.options : []);
    this.changed();
  }

  private readScan(conn: DbConnection): void {
    // Row callbacks of one transaction may run scan_state first: read my_options from the cache now, so the read
    // finds its option row.
    if (this.sessionRuns()) this.readOptions(conn);
    const sessionId = this.sessionId ?? this.configRow?.activeSessionId ?? 0n;
    let row: ScanRow | undefined;
    try {
      row = [...conn.db.scanState.iter()].find((r) => r.sessionId === sessionId);
    } catch {
      row = undefined;
    }
    if (!row || sessionId === 0n) {
      this.scanView = null;
      this.changed();
      return;
    }
    const arrival = perfNow();
    const phase = PHASES[row.phase.tag] ?? 'idle';
    const startedAt = row.stepStartedAt.microsSinceUnixEpoch;
    const endsAt = row.stepEndsAt.microsSinceUnixEpoch;
    const stepMs = endsAt > startedAt ? Number((endsAt - startedAt) / 1000n) : 0;
    const previous = this.scanView;
    const sameStep = previous !== null && this.lastScanStep === row.stepSeq;
    this.lastScanStep = row.stepSeq;
    this.scanView = {
      phase,
      mode: row.mode.tag === 'Menu' ? 'menu' : 'answer',
      answerMode: row.answerMode.tag === 'YesNo' ? 'yes_no' : 'pick',
      cursor: row.cursor,
      optionCount: row.optionCount,
      pass: row.pass,
      maxPasses: row.maxPasses,
      stepMs,
      // A same-step update (a clip report moving the dwell) keeps its arrival, so the bar does not jump back.
      arrivedWall: sameStep && previous ? previous.arrivedWall : Date.now(),
      pauseReason: row.pauseReason ? (PAUSE_WORDS[row.pauseReason.tag] ?? null) : null,
      pickedRank: row.pickedRank ?? null,
    };
    if (this.sessionRuns()) {
      const lite: ScanLite = {
        sessionId: row.sessionId,
        questionId: row.questionId,
        version: row.version,
        phase,
        answerMode: row.answerMode.tag === 'YesNo' ? 'yes_no' : 'pick',
        cursor: row.cursor,
        optionCount: row.optionCount,
        stepSeq: row.stepSeq,
        optionStartSeq: row.optionStartSeq,
      };
      this.earpiece.onScan(lite, arrival);
      if (phase === 'paused') this.readback.stop();
      if (this.staleness.update({ phase, stepStartedAt: startedAt, stepEndsAt: endsAt }) || this.stale) this.stale = false;
    }
    this.changed();
  }

  private lastScanStep: bigint | null = null;

  private workRows(row: SessionRow): [WorkLite | null, WorkLite | null, WorkLite | null] {
    const e = row.errand;
    const c = row.call;
    const w = row.search;
    const errand: WorkLite | null = e
      ? {
          kind: 'errand',
          id: e.errandId,
          status: e.status.tag,
          readBackText: e.readBackText,
          digest: e.previewDigest,
          confirmOpensAt: micros(e.confirmOpensAt),
          confirmClosesAt: micros(e.confirmClosesAt),
          reasonCode: e.reasonCode,
          reason: e.reason,
        }
      : null;
    const call: WorkLite | null = c
      ? {
          kind: 'call',
          id: c.callId,
          status: c.status.tag,
          readBackText: c.readBackText,
          digest: c.scriptDigest,
          confirmOpensAt: micros(c.confirmOpensAt),
          confirmClosesAt: micros(c.confirmClosesAt),
          reasonCode: c.reasonCode,
          reason: c.reason,
        }
      : null;
    // D18: a web search waits for the same read-back and two-option confirm as an errand or a call.
    const search: WorkLite | null = w
      ? {
          kind: 'search',
          id: w.searchId,
          status: w.status.tag,
          readBackText: w.readBackText,
          digest: w.digest,
          confirmOpensAt: micros(w.confirmOpensAt),
          confirmClosesAt: micros(w.confirmClosesAt),
          reasonCode: w.reasonCode,
          reason: w.reason,
        }
      : null;
    return [errand, call, search];
  }

  private workLite() {
    const row = this.sessionRow;
    if (!row) return null;
    return {
      errand: row.errand ? { errandId: row.errand.errandId, status: row.errand.status.tag } : null,
      call: row.call ? { callId: row.call.callId, status: row.call.status.tag } : null,
      search: row.search ? { searchId: row.search.searchId, status: row.search.status.tag } : null,
    };
  }

  // ---------- Cues ----------

  private cueArrived(row: Row<'cueEvent'>): void {
    if (this.sessionId === null || row.sessionId !== this.sessionId || !this.sessionRuns()) return;
    this.pendingCues.push({
      sessionId: row.sessionId,
      kind: row.kind,
      reason: row.reason,
      questionId: row.questionId,
      optionId: row.optionId,
      errandId: row.errandId,
      callId: row.callId,
    });
    if (this.pendingCues.length === 1) queueMicrotask(() => this.playCues());
  }

  private playCues(): void {
    const cues = this.pendingCues.splice(0);
    for (const cue of cues) {
      this.lastCue = { kind: cue.kind, reason: cue.reason, at: Date.now() };
      const action = cueAction(cue, {
        mode: this.mode ?? 'headset',
        phase: this.scanView?.phase ?? null,
        readbackActive: this.readback.getState().phase === 'preparing' || this.readback.getState().phase === 'playing',
        errandReason: this.sessionRow?.errand?.reason ?? '',
        callReason: this.sessionRow?.call?.reason ?? '',
      });
      if (this.isSilent() && action.type !== 'chime' && action.type !== 'none') {
        // No voice in the silent test; a safety cue still stops anything local.
        if (action.type === 'safety') this.readback.stop();
        continue;
      }
      this.cues.handle(action);
    }
    this.changed();
  }

  // ---------- Inputs ----------

  private relay(input: CommandInput): void {
    if (!this.sessionRuns()) return;
    this.sender.relay(input);
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (this.learning) {
      if (event.code === 'Escape') {
        this.learning = false;
        this.changed();
        return;
      }
      if (!canLearnSwitchKey(event.code)) return;
      event.preventDefault();
      event.stopPropagation();
      this.switchKey = event.code;
      saveSwitchKey(event.code, this.storage);
      this.learning = false;
      this.inputMaybeChanged();
      this.changed();
      return;
    }
    if (this.mode === 'switch' && this.switchKey !== null && event.code === this.switchKey) {
      // A switch that types Enter or Space must not also press a focused button.
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat && this.sessionRuns()) this.switchPattern.down(event.timeStamp);
      return;
    }
    // While a session runs, the dashboard's screen keys (1 to 5) must not navigate away from the station: leaving the
    // page stops the earpiece and the heartbeat. The shell skips a key whose default was prevented. In the keyboard
    // test, 1 to 4 are the picks (D18) and go on to the relay below.
    if (this.sessionRuns() && /^[1-5]$/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey && !isTypingTarget(event.target)) {
      event.preventDefault();
      if (!(this.mode === 'keyboard' && isPickKey(event.key))) return;
    }
    const command = keyboardCommand(event);
    if (!command || isTypingTarget(event.target)) return;
    if (this.mode === 'keyboard' && this.sessionRuns()) {
      event.preventDefault();
      this.relay({ command, gestureId: null, source: 'key', confidence: 1, onsetLocal: event.timeStamp, via: 'key' });
      return;
    }
    if (this.mode === 'headset' && this.sessionRuns()) {
      this.keysOffAt = Date.now();
      this.changed();
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    if (this.mode === 'switch' && this.switchKey !== null && event.code === this.switchKey) {
      event.preventDefault();
      event.stopPropagation();
      if (this.sessionRuns()) this.switchPattern.up(event.timeStamp);
    }
  };

  private onVisibility = (): void => {
    this.visible = document.visibilityState === 'visible';
    this.inputMaybeChanged();
    this.changed();
  };

  private onFocus = (): void => {
    this.focused = true;
    this.blurredAt = null;
    if (this.blurTimer) clearTimeout(this.blurTimer);
    this.blurTimer = null;
    this.inputMaybeChanged();
    this.changed();
  };

  private onBlur = (): void => {
    this.focused = false;
    this.blurredAt = perfNow();
    if (this.blurTimer) clearTimeout(this.blurTimer);
    // A focus loss counts in switch mode only after 2 s; look again then.
    this.blurTimer = setTimeout(() => {
      this.blurTimer = null;
      this.inputMaybeChanged();
      this.changed();
    }, FOCUS_GRACE_MS + 20);
    this.inputMaybeChanged();
    this.changed();
  };

  private inputHealthyNow(): boolean {
    if (!this.mode) return false;
    return inputHealthy({
      mode: this.mode,
      decoderHealthy: this.decoder?.healthyNow() ?? false,
      visible: this.visible,
      focused: this.focused,
      blurredAt: this.blurredAt,
      now: perfNow(),
    });
  }

  /** The input may have changed: one extra beat on healthy to unhealthy, and the option audio stops at once. */
  private inputMaybeChanged(): void {
    const healthy = this.inputHealthyNow();
    if (this.lastInputHealthy === true && !healthy && this.sessionRuns()) this.earpiece.stopOptions();
    this.lastInputHealthy = healthy;
    this.heartbeat.inputChanged();
  }

  private syncDecoder(): void {
    const want = this.running && this.mode === 'headset' && this.device !== null && this.device.pairing.getState().phase === 'paired';
    if (want && !this.decoder) {
      this.decoder = new DecoderBridge({
        port: this.port,
        onCommand: (input) => this.relay(input),
        onChange: () => {
          this.inputMaybeChanged();
          this.armNoteTimer();
          this.changed();
        },
      });
      this.decoder.start();
    } else if (!want && this.decoder) {
      this.decoder.stop();
      this.decoder = null;
      this.inputMaybeChanged();
    }
  }

  /** Redraw once the decoder's 10 s notes expire. */
  private armNoteTimer(): void {
    if (this.noteTimer) clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => {
      this.noteTimer = null;
      this.changed();
    }, NOTE_MS + 50);
  }

  // ---------- Session ----------

  private sessionRuns(): boolean {
    return this.ownership === 'mine' || this.ownership === 'claiming';
  }

  private canBeat(): boolean {
    if (!this.sessionRuns()) return false;
    if (this.device?.connection.getState().status !== 'live') return false;
    return this.isSilent() || this.audio.running();
  }

  /** A fresh start for the heard log, the earpiece and the read-backs of a session this page now runs. */
  private prepareSession(): void {
    this.earpiece.resetSession();
    this.readback.reset();
    this.sender.clear();
    this.voiceDown = false;
    this.stale = false;
    this.heard.setSilent(this.isSilent());
    this.earpiece.setOptions(this.options);
    // The question current now (Continue after a reload) was asked before this page took the session: not said.
    this.question.begin(sessionQuestion(this.sessionRow));
    const conn = this.conn();
    if (conn) {
      this.readSession(conn);
      this.readScan(conn);
    }
  }

  /** The session ended (here or elsewhere), or another one replaced it. */
  private sessionEnded(replaced = false): void {
    this.heartbeat.disarm();
    this.staleness.stop();
    this.switchPattern.reset();
    this.readback.reset();
    this.cues.clear();
    this.question.cancel();
    this.earpiece.stopOptions();
    this.earpiece.setOptions([]);
    this.ownership = 'none';
    this.startedLabel = null;
    this.stale = false;
    if (!replaced) this.sessionId = null;
    // A "Could not end the session" error is stale once its session is no longer the active one.
    if (this.sessionErrorFor !== null && this.sessionErrorFor !== this.sessionId) {
      this.sessionError = null;
      this.sessionErrorFor = null;
    }
    this.changed();
  }

  private sessionRefused(error: unknown): void {
    if (isSenderMessage(error, SENDER_MESSAGES.notAllowed)) {
      this.device?.noteCallError(error);
      this.sessionEnded(true);
      return;
    }
    if (isSenderMessage(error, SENDER_MESSAGES.notSessionStation)) {
      this.heartbeat.disarm();
      this.ownership = 'other';
      this.changed();
      return;
    }
    if (isSenderMessage(error, SENDER_MESSAGES.noActiveSession)) this.sessionEnded();
  }

  // ---------- Audio and voice ----------

  private isSilent(): boolean {
    return this.silent && this.mode === 'keyboard';
  }

  /**
   * The module runs direct select (D18, `config.input_mode` Direct): a pick counts for any step of the live list, so
   * reads may wait behind the partner's question. The scan fallback resolves YES by the step heard, where a read that
   * played late would count as stale, so it gets no question.
   */
  private directSelect(): boolean {
    return this.configRow?.inputMode?.tag === 'Direct';
  }

  private makeProfile(): VoiceProfile {
    return voiceProfile({ assistantSpeed: this.assistantSpeed ?? 1, ...(this.optionSpeed !== null ? { optionSpeed: this.optionSpeed } : {}) });
  }

  private audioChanged(): void {
    const ctx = this.audio.audioContext();
    if (ctx && ctx !== this.audioContext) {
      this.audioContext = ctx;
      // The DOM's AudioContext has a richer `onended` signature than cartesia's structural type; it is the same object.
      const like = ctx as unknown as AudioContextLike;
      this.optionsOut = new AudioOut(like);
      this.promptsOut = new AudioOut(like);
    }
    if (!this.audio.running()) {
      // The earpiece stopped: no sound and no beats, so the module pauses (docs/station.md 2.8).
      this.optionsChannel.stop();
      this.promptsChannel.stop();
    }
    this.ensurePlayer();
    this.warmPhrases();
    this.changed();
  }

  private connectionChanged(): void {
    this.changed();
  }

  private pairingChanged(): void {
    const phase = this.device?.pairing.getState().phase;
    if (phase === 'revoked' && this.sessionRuns()) this.sessionEnded(true);
    this.syncDecoder();
    this.changed();
  }

  private voiceChanged(): void {
    this.ensurePlayer();
    this.warmPhrases();
    this.changed();
  }

  private voiceReady(): boolean {
    return this.device?.voice.getState().status === 'ready';
  }

  private ensurePlayer(): void {
    if (this.player || !this.device || !this.voiceReady()) return;
    const device = this.device;
    const dict = this.options_.pronunciationDictId?.trim();
    this.player = new TtsPlayer({ getToken: () => device.voice.getToken(), maxActive: 1, ...(dict ? { pronunciationDictId: dict } : {}) });
    // Stock phrases and menu items come from the browser's store after the first load, so a reload costs no credits.
    const store = this.options_.phraseStore === undefined ? indexedDbClipStore() : this.options_.phraseStore;
    this.cache = new PhraseCache(persistentSynth(this.player, store));
    // Options that arrived before the voice was ready are voiced now.
    this.earpiece.kick();
  }

  private promptUtterance(key: PhraseKey): Utterance {
    return utterance({ kind: 'prompt', text: phraseText(key, this.mode ?? 'headset') }, this.profile);
  }

  private optionUtterance(row: Pick<OptionRowLite, 'text' | 'tone' | 'laugh'>): Utterance {
    return utterance({ kind: 'option', text: row.text, tone: row.tone, laugh: row.laugh }, this.profile);
  }

  /**
   * One option in the earpiece (D18): "One: good." in the reply voice with the option's tone, no laugh (the number
   * comes first). The room hears the full text only once the person picks it.
   */
  private earUtterance(row: Pick<OptionRowLite, 'rank' | 'label' | 'text' | 'tone'>): Utterance {
    return this.optionUtterance({ text: optionEarText(row.rank, row.label, row.text), tone: row.tone, laugh: false });
  }

  private phraseClip(key: PhraseKey): Promise<Clip> {
    if (!this.cache) return Promise.reject(new Error('The voice is not ready.'));
    return this.cache.get(this.promptUtterance(key));
  }

  private speak(u: Utterance): SynthJob<Clip> {
    if (!this.player) throw new Error('The voice is not ready.');
    const job = this.player.speak(u);
    return { done: job.done, cancel: () => job.cancel() };
  }

  private speakOption(row: OptionRowLite): SynthJob<Clip> {
    if (row.kind === 'Menu' && isMenuItemText(row.text)) {
      if (!this.cache) throw new Error('The voice is not ready.');
      // Menu items were cached at start in the reply voice, numbered, by their text.
      return { done: this.cache.get(this.earUtterance({ rank: row.rank, label: '', text: row.text, tone: '' })), cancel: () => {} };
    }
    return this.speak(this.earUtterance(row));
  }

  /** Say one stock sentence when the earpiece is free. */
  private say(key: PhraseKey): void {
    if (this.isSilent() || !this.cache) return;
    this.cues.info({ phrase: key });
  }

  private voiceError(error: unknown): void {
    console.error('Eleven: the voice failed', error);
    if (this.voiceDown) return;
    this.voiceDown = true;
    this.say('voiceDown');
    this.changed();
  }

  private chime(name: ChimeName): void {
    this.audio.chime(name);
  }

  /**
   * Voice every stock phrase for the input mode plus the four menu items, one at a time (docs/station.md 2.9
   * "Phrases ready"). Runs once the voice and the earpiece are ready, and again after a mode or speed change.
   */
  private warmPhrases(force = false): void {
    if (!this.mode || !this.cache || !this.audio.running() || !this.voiceReady() || this.isSilent()) return;
    if (this.phrases.warming && !force) return;
    const mode = this.mode;
    const list: Array<{ u: Utterance; key: PhraseKey | null }> = [
      ...warmPhraseKeys(mode).map((key) => ({ u: this.promptUtterance(key), key })),
      ...MENU_ITEM_TEXTS.map((text, i) => ({ u: this.earUtterance({ rank: i + 1, label: '', text, tone: '' }), key: null })),
    ];
    const cache = this.cache;
    const run = ++this.warmRun;
    this.phrases = { ready: 0, failed: 0, total: list.length, warming: true };
    this.changed();
    void (async () => {
      for (const item of list) {
        if (run !== this.warmRun || cache !== this.cache) return;
        try {
          const clip = await cache.get(item.u);
          if (run !== this.warmRun) return;
          this.phrases = { ...this.phrases, ready: this.phrases.ready + 1 };
          if (item.key === 'yesOrNo') this.earpiece.noteYesNoCue(this.configRow?.yesNoCueMs ?? 900, clip.durationMs);
        } catch {
          if (run !== this.warmRun) return;
          this.phrases = { ...this.phrases, failed: this.phrases.failed + 1 };
        }
        this.changed();
      }
      if (run === this.warmRun) {
        this.phrases = { ...this.phrases, warming: false };
        this.changed();
      }
    })();
  }

  // ---------- The snapshot ----------

  private build(): StationSnapshot {
    const device = this.device;
    const connection = device?.connection.getState() ?? {
      status: 'offline' as const,
      ready: false,
      identityHex: null,
      problem: null,
      errorText: null,
      since: 0,
      tokenSaved: null,
    };
    const decoder = this.decoder;
    const decoderState = decoder?.getState();
    const now = perfNow();
    const rb = this.readback.getState();
    const config = this.configRow;
    const row = this.sessionRow;
    const current = this.options.filter((o) => o.current).sort((a, b) => a.rank - b.rank);
    return {
      hasSettings: device !== null,
      cliTarget: cliTargetOf(this.options_.settings),
      connection,
      pairing: device?.pairing.getState() ?? initialPairingState('station'),
      voice: device?.voice.getState() ?? { status: 'unknown' },
      audio: this.audio.getState(),
      setup: {
        mode: this.mode,
        purpose: this.mode === 'keyboard' ? 'test' : this.purpose,
        silent: this.isSilent(),
        port: this.port,
        switchKey: this.switchKey,
        learningSwitch: this.learning,
        assistantSpeed: this.assistantSpeed,
        optionSpeed: this.optionSpeed,
        readQuestion: this.readQuestion,
      },
      decoder:
        decoder && decoderState
          ? {
              word: decoder.healthWord(now),
              port: decoderState.port,
              badMessages: decoderState.badMessages,
              idsReplaced: decoderState.idsReplaced,
              recentBad: decoderState.lastBadAt !== null && now - decoderState.lastBadAt < NOTE_MS,
              recentScanWord: decoderState.lastScanWordAt !== null && now - decoderState.lastScanWordAt < NOTE_MS,
              recentIdReplaced: decoderState.lastIdReplacedAt !== null && now - decoderState.lastIdReplacedAt < NOTE_MS,
              errorText: decoderState.errorText,
              slowConnect: decoderState.slowConnect,
            }
          : null,
      inputHealthy: this.inputHealthyNow(),
      visible: this.visible,
      focused: this.focused,
      phrases: { ...this.phrases },
      config: config
        ? {
            shareText: config.shareTextOnBoard,
            heartbeatMs: config.heartbeatMs,
            idlePauseMs: config.idlePauseMs,
            menuEnabled: config.menuEnabled,
            yesNoCueMs: config.yesNoCueMs,
            replyVetoMs: config.replyVetoMs,
            audioPadMs: config.audioPadMs,
          }
        : null,
      session: {
        id: this.sessionId,
        ownership: this.ownership,
        label: this.startedLabel,
        error: this.sessionError,
        questionId: row && row.questionId !== 0n ? row.questionId : null,
        questionText: row?.questionText ?? '',
        origin: row && row.questionId !== 0n ? (row.origin.tag === 'Menu' ? 'menu' : 'partner') : null,
      },
      scan: this.scanView,
      options: current.map((o) => ({ optionId: o.optionId, rank: o.rank, text: o.text, label: o.label, tone: o.tone, kind: o.kind, ready: this.earpiece.clipOf(o.optionId) !== undefined })),
      earpiece: this.earpiece.getState(),
      playing: this.optionsChannel.use() ?? (this.promptsChannel.busy() ? 'phrase' : null),
      readback: { ...rb, windowStartedWall: rb.windowStartedAt === null ? null : Date.now() - (now - rb.windowStartedAt) },
      work: {
        errand: row?.errand ? { status: row.errand.status.tag, formTitle: row.errand.formTitle, reason: row.errand.reason } : null,
        call: row?.call ? { status: row.call.status.tag, contactName: row.call.contactName, reason: row.call.reason } : null,
        search: row?.search ? { status: row.search.status.tag, reason: row.search.reason } : null,
      },
      commands: this.sender.entries(),
      heartbeat: this.heartbeat.getState(),
      stale: this.stale,
      keysOffAt: this.keysOffAt,
      lastCue: this.lastCue,
      voiceDown: this.voiceDown,
    };
  }
}
