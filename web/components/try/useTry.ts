'use client';

/**
 * The judge try page's parts (PLAN 5.11), wired once and kept outside React:
 * - one Station on the try database (lib/station/engine.ts, keyboard mode, label `try`): it starts the try, plays the
 *   options, takes the on-screen buttons (source `button`), asks the question and says the picked reply aloud;
 * - the anonymous board source on the same database, for the steps, the options and the reply;
 * - the room voice (lib/speaker): the same engine as /speaker, fed from the board rows of this page's own try and
 *   reporting `reply_spoken` through the station, which the module's sandbox allows for the try's own station only.
 * No key reaches this page: the module mints 60 s voice tokens for the station.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { tables } from '@/lib/data/module_bindings';
import { initialState, type DataSource } from '@/lib/data/source';
import { createSpacetimeSource } from '@/lib/data/spacetime';
import type { SourceState } from '@/lib/data/types';
import { createAskSender, type AskSender } from '@/lib/partner/ask';
import { notConnectedError } from '@/lib/role/calls';
import { useAudioUnlock } from '@/lib/role/hooks';
import { createSpeakerEngine, type SpeakerEngine } from '@/lib/speaker/engine';
import { createSpeakerVoice, type SpeakerVoice } from '@/lib/speaker/voice';
import { StationEngine } from '@/lib/station/engine';
import type { StationSnapshot } from '@/lib/station/snapshot';
import { TRY_SESSION_LABEL, trySettings, tryView, type TryView, type VoiceWord } from '@/lib/try/model';
import type { StationCommand } from '@/lib/station/commands';
import type { AudioUnlock } from '@/lib/voice/audio';

const noSubscribe = () => () => {};
const noSnapshot = () => null;
const BOARD_IDLE: SourceState = initialState('spacetime');

interface TryConnLike {
  reducers: {
    askQuestion(args: { requestId: string; text: string; via: string; listenMs: number }): Promise<void>;
    replySpoken(args: { questionId: bigint; ms: number }): Promise<void>;
  };
  db: {
    deviceStatus: { iter(): Iterable<{ role: { tag: string }; online: boolean }> };
    sandboxSettings: { iter(): Iterable<{ on: boolean; questionsPerTry: number }> };
  };
}

interface Parts {
  station: StationEngine;
  board: DataSource;
  speaker: SpeakerEngine;
  voice: SpeakerVoice;
  ask: AskSender;
}

function newRequestId(): string {
  const random = globalThis.crypto;
  if (typeof random?.randomUUID === 'function') return random.randomUUID();
  const bytes = new Uint8Array(16);
  random.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function voiceWord(s: StationSnapshot | null): VoiceWord {
  if (!s) return 'checking';
  if (s.voice.status === 'ready') return 'ready';
  if (s.voice.status === 'problem') return s.voice.problem === 'key_missing' ? 'off' : 'problem';
  return 'checking';
}

export function useTry() {
  const settings = useMemo(() => trySettings(process.env.NEXT_PUBLIC_SPACETIMEDB_HOST, process.env.NEXT_PUBLIC_TRY_SPACETIMEDB_DB), []);
  const { audio, state: audioState } = useAudioUnlock();
  const audioRef = useRef<AudioUnlock | null>(null);
  const mineRef = useRef(false);
  const partsRef = useRef<Parts | null>(null);
  const [parts, setParts] = useState<Parts | null>(null);

  useEffect(() => {
    audioRef.current = audio;
  }, [audio]);

  useEffect(() => {
    if (!partsRef.current) {
      const station = new StationEngine({ settings, pronunciationDictId: process.env.NEXT_PUBLIC_CARTESIA_DICT_ID, extraQueries: [tables.sandboxSettings] });
      const conn = () => (station.device?.connection.conn() as unknown as TryConnLike | null | undefined) ?? null;
      const waitForLive = (ms: number) => station.device?.connection.whenLive(ms) ?? Promise.resolve(false);
      // The room voice speaks only while this page holds its own try: never a reply of someone else's.
      const room = () => (mineRef.current ? audioRef.current : null);
      const voice = createSpeakerVoice({
        getToken: () => (station.device ? station.device.voice.getToken() : Promise.reject(notConnectedError())),
        context: () => room()?.audioContext() ?? null,
        volume: () => 1,
        pronunciationDictId: process.env.NEXT_PUBLIC_CARTESIA_DICT_ID || undefined,
      });
      const speaker = createSpeakerEngine({
        db: settings.db,
        say: (reply, attempt) => voice.say(reply, attempt),
        audioReady: () => room()?.running() ?? false,
        reportSpoken: (questionId, ms) => {
          const c = conn();
          return c ? c.reducers.replySpoken({ questionId, ms }) : Promise.reject(notConnectedError());
        },
        waitForLive,
        noteCallError: (error) => {
          station.device?.noteCallError(error);
        },
      });
      const ask = createAskSender({
        call: (request) => {
          const c = conn();
          return c ? c.reducers.askQuestion(request) : Promise.reject(notConnectedError());
        },
        waitForLive,
      });
      partsRef.current = { station, board: createSpacetimeSource(settings), speaker, voice, ask };
    }
    const made = partsRef.current;
    setParts(made);
    made.station.start();
    made.board.start();
    return () => {
      made.station.stop();
      made.board.stop();
      made.speaker.stop();
    };
  }, [settings]);

  useEffect(
    () => () => {
      partsRef.current?.voice.close();
    },
    [],
  );

  const snapshot = useSyncExternalStore(parts ? parts.station.subscribe : noSubscribe, parts ? parts.station.getState : noSnapshot, noSnapshot);
  const board = useSyncExternalStore(parts ? parts.board.subscribe : noSubscribe, parts ? parts.board.getState : () => BOARD_IDLE, () => BOARD_IDLE);

  // The session this page started, kept so a later try (someone else's) never reads as ours.
  const [mySessionId, setMySessionId] = useState<string | null>(null);
  const [everStarted, setEverStarted] = useState(false);
  const ownership = snapshot?.session.ownership ?? 'none';
  const activeId = snapshot?.session.id ?? null;
  useEffect(() => {
    if (ownership === 'mine' && activeId !== null) {
      setMySessionId(activeId.toString());
      setEverStarted(true);
    }
  }, [ownership, activeId]);
  const mine = mySessionId !== null && activeId !== null && mySessionId === activeId.toString() && (ownership === 'mine' || ownership === 'claiming');
  useEffect(() => {
    mineRef.current = mine;
    parts?.speaker.audioChanged();
  }, [mine, parts, audioState.state]);

  // Offer this try's newest released reply to the room voice (the engine says each question once).
  const rows = board.rows;
  useEffect(() => {
    if (!parts || !mine || mySessionId === null) return;
    const released = rows.questions.filter((q) => q.sessionId === mySessionId && q.replyText && q.spokenAt === null);
    const q = released[released.length - 1];
    if (!q || !q.replyText) return;
    let id: bigint;
    try {
      id = BigInt(q.id);
    } catch {
      return;
    }
    parts.speaker.offer({ questionId: id, text: q.replyText, tone: '', laugh: false, releasedAtMs: Date.now() }, 'live');
  }, [parts, mine, mySessionId, rows.questions]);

  // Read from the station's own connection: whether an agent is online, and the try's question limit.
  const [facts, setFacts] = useState<{ agentOnline: boolean | null; questionsPerTry: number | null }>({ agentOnline: null, questionsPerTry: null });
  useEffect(() => {
    if (!parts) return;
    const read = () => {
      const c = parts.station.device?.connection.conn() as unknown as TryConnLike | null | undefined;
      if (!c) return;
      try {
        const agentOnline = [...c.db.deviceStatus.iter()].some((d) => d.role.tag === 'Agent' && d.online);
        const settingsRow = [...c.db.sandboxSettings.iter()][0];
        const questionsPerTry = settingsRow && settingsRow.on ? settingsRow.questionsPerTry : null;
        setFacts((prev) => (prev.agentOnline === agentOnline && prev.questionsPerTry === questionsPerTry ? prev : { agentOnline, questionsPerTry }));
      } catch {
        // The subscription is not applied yet.
      }
    };
    read();
    const timer = setInterval(read, 2_000);
    return () => clearInterval(timer);
  }, [parts]);

  const [askError, setAskError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  const start = useCallback(() => {
    const current = partsRef.current;
    if (!current) return;
    const s = current.station.getState();
    current.station.chooseMode('keyboard');
    // No voice on the database: run the scan silently, the options show as text.
    current.station.setSilent(s.voice.status === 'problem' && s.voice.problem === 'key_missing');
    setAskError(null);
    // Both audio starts run inside the tap, so the browser counts it as the user's gesture.
    void current.station.startAudio();
    void audioRef.current?.start();
    current.station.startSession({ label: TRY_SESSION_LABEL, replaceActive: true });
  }, []);

  const end = useCallback(() => partsRef.current?.station.endSession(), []);

  const press = useCallback((command: StationCommand) => {
    partsRef.current?.station.press(command);
  }, []);

  const ask = useCallback(async (text: string): Promise<boolean> => {
    const current = partsRef.current;
    if (!current) return false;
    setAsking(true);
    setAskError(null);
    try {
      const outcome = await current.ask({ requestId: newRequestId(), text, via: 'typed', listenMs: 0 });
      if (!outcome.ok) setAskError(outcome.title ?? outcome.sentence);
      return outcome.ok;
    } finally {
      setAsking(false);
    }
  }, []);

  const view: TryView = tryView({
    connected: snapshot?.connection.status === 'live',
    paired: snapshot?.pairing.phase === 'paired',
    voice: voiceWord(snapshot),
    ownership,
    mySessionId,
    activeSessionId: activeId === null ? null : activeId.toString(),
    everStarted,
    sessionError: snapshot?.session.error ?? null,
    askError,
    agentOnline: facts.agentOnline,
    questionsPerTry: facts.questionsPerTry,
    rows,
  });

  return { view, start, end, press, ask, asking, settings };
}
