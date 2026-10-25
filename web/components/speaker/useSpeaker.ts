'use client';

/**
 * The room voice page's parts (docs/station.md 3): the Speaker role device (lib/role/device.ts), the engine that
 * decides what to say (lib/speaker/engine.ts), the mirror of the earpiece (lib/speaker/mirror.ts), the Cartesia voice
 * (lib/speaker/voice.ts), and the room facts read from the rows (lib/speaker/rows.ts, mirror-rows.ts). Everything lives
 * outside React; this hook makes them once, starts them, and reads their snapshots. The row callbacks are registered
 * once per connection object, never in a render.
 *
 * Audio that plays every time: the room voice keeps running when the audio devices change (a projector or speaker
 * plugged in moves the sound, which is the point here; the earpiece is the one that must stop), it asks the browser to
 * resume by itself after the first tap, and it wakes again when the page comes back into view.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { tables } from '@/lib/data/module_bindings';
import type { SpacetimeSettings } from '@/lib/data/source-mode';
import { notConnectedError } from '@/lib/role/calls';
import { createRoleDevice, type RoleDevice } from '@/lib/role/device';
import { useAudioUnlock, useRoleDevice, useStoreState } from '@/lib/role/hooks';
import { roleSettingsFromEnv } from '@/lib/role/settings';
import { readMirrorEarpiece, readReplyVolume, saveMirrorEarpiece, saveReplyVolume, VOLUME_RANGE } from '@/lib/role/storage';
import { createSpeakerEngine, SPEAKER_IDLE, type SpeakerEngine } from '@/lib/speaker/engine';
import { createSpeakerMirror, MIRROR_INITIAL, type SpeakerMirror } from '@/lib/speaker/mirror';
import { attachMirrorRows, type MirrorConnLike } from '@/lib/speaker/mirror-rows';
import { attachSpeakerRows, offerSnapshot, readSpeakerSnapshot, SPEAKER_ROOM_UNKNOWN, type SpeakerConnLike, type SpeakerRoom } from '@/lib/speaker/rows';
import { createSpeakerVoice, type SpeakerVoice } from '@/lib/speaker/voice';
import type { AudioUnlock, AudioUnlockOptions } from '@/lib/voice/audio';

/** The room voice's audio: never stopped by a device change, resumed by itself after the first tap. */
const ROOM_AUDIO: AudioUnlockOptions = { onDeviceChange: 'report', autoResume: true };

/** The anonymous board views the mirror reads, on their own subscription (lib/speaker/mirror-rows.ts). */
const MIRROR_QUERIES = [tables.publicBoard, tables.boardErrands, tables.boardCalls, tables.boardSearches];

interface RoomStore {
  getState(): SpeakerRoom;
  subscribe(listener: () => void): () => void;
  set(next: SpeakerRoom): void;
}

function createRoomStore(): RoomStore {
  let room = SPEAKER_ROOM_UNKNOWN;
  const listeners = new Set<() => void>();
  return {
    getState: () => room,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next) {
      if (next.sharing === room.sharing && next.paused === room.paused && next.speakersOnline === room.speakersOnline) return;
      room = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

interface SpeakerParts {
  device: RoleDevice;
  engine: SpeakerEngine;
  mirror: SpeakerMirror;
  voice: SpeakerVoice;
  room: RoomStore;
  /** True while the test sentence plays: no mirror line starts then. */
  setTesting(on: boolean): void;
}

interface ReplySpokenConn {
  reducers: { replySpoken(args: { questionId: bigint; ms: number }): Promise<void> };
}

function makeSpeakerParts(settings: SpacetimeSettings, getAudio: () => AudioUnlock | null): SpeakerParts {
  // Assigned below; the functions that read it run only after the page has started.
  let device: RoleDevice | null = null;
  let testing = false;
  const audioReady = () => getAudio()?.running() ?? false;
  const voice = createSpeakerVoice({
    getToken: () => (device ? device.voice.getToken() : Promise.reject(notConnectedError())),
    context: () => getAudio()?.audioContext() ?? null,
    volume: () => readReplyVolume(),
    pronunciationDictId: process.env.NEXT_PUBLIC_CARTESIA_DICT_ID || undefined,
  });
  const engine = createSpeakerEngine({
    db: settings.db,
    say: (reply, attempt) => voice.say(reply, attempt),
    audioReady,
    reportSpoken: (questionId, ms) => {
      const conn = device?.connection.conn() as ReplySpokenConn | null | undefined;
      return conn ? conn.reducers.replySpoken({ questionId, ms }) : Promise.reject(notConnectedError());
    },
    waitForLive: (timeoutMs) => (device ? device.connection.whenLive(timeoutMs) : Promise.resolve(false)),
    noteCallError: (error) => {
      device?.noteCallError(error);
    },
  });
  const mirror = createSpeakerMirror({
    say: (item, attempt) => voice.sayLine(item, attempt),
    audioReady,
    replyIdle: () => engine.getState().phase !== 'speaking' && !testing,
    on: readMirrorEarpiece(),
  });
  // The picked reply has priority over the mirror: it cuts the line being said, and lines go on once it is said.
  engine.subscribe(() => {
    const state = engine.getState();
    if (state.phase === 'speaking' && state.reply) mirror.replyStarted(state.reply.questionId);
    else mirror.kick();
  });
  const room = createRoomStore();
  const paired = () => device?.pairing.getState().phase === 'paired';
  const target = { engine, room: (next: SpeakerRoom) => room.set(next), paired };
  const made = createRoleDevice({
    role: 'speaker',
    settings,
    queries: [tables.scanState, tables.mySession],
    attach: (conn) => {
      const detachRows = attachSpeakerRows(conn as unknown as SpeakerConnLike, target);
      let detachMirror: () => void = () => {};
      try {
        detachMirror = attachMirrorRows(conn as unknown as MirrorConnLike, { mirror, paired }, MIRROR_QUERIES);
      } catch (error) {
        // The reply never depends on the mirror.
        console.error('Eleven: the room voice could not read the board for the mirror', error);
        mirror.setProblem(error instanceof Error ? error.message : String(error));
      }
      return () => {
        detachRows();
        detachMirror();
      };
    },
    onApplied: (conn) => readSpeakerSnapshot(conn as unknown as SpeakerConnLike, target),
  });
  device = made;
  // The reply this page first sees when pairing completes counts as a snapshot: one released long ago is missed.
  let wasPaired = false;
  made.pairing.subscribe(() => {
    const now = paired();
    if (now && !wasPaired) {
      const conn = made.connection.conn();
      if (conn) offerSnapshot(conn as unknown as SpeakerConnLike, target);
    }
    wasPaired = now;
  });
  return {
    device: made,
    engine,
    mirror,
    voice,
    room,
    setTesting(on) {
      testing = on;
      if (!on) mirror.kick();
    },
  };
}

export function useSpeaker() {
  const { audio, state: audioState } = useAudioUnlock(ROOM_AUDIO);
  const audioRef = useRef<AudioUnlock | null>(null);
  const partsRef = useRef<SpeakerParts | null>(null);

  useEffect(() => {
    audioRef.current = audio;
  }, [audio]);

  const role = useRoleDevice('speaker', () => {
    const settings = roleSettingsFromEnv();
    if (!settings) return null;
    partsRef.current = makeSpeakerParts(settings, () => audioRef.current);
    return partsRef.current.device;
  });
  const parts = role.device ? partsRef.current : null;
  const state = useStoreState(parts?.engine ?? null, SPEAKER_IDLE);
  const room = useStoreState(parts?.room ?? null, SPEAKER_ROOM_UNKNOWN);
  const mirrorState = useStoreState(parts?.mirror ?? null, MIRROR_INITIAL);

  // A reply that waited for the tap is said once the room voice runs (rule 3 in lib/speaker/engine.ts), and the
  // mirror's waiting lines go on.
  useEffect(() => {
    parts?.engine.audioChanged();
    parts?.mirror.kick();
  }, [parts, audioState.state]);

  // Back in view (a laptop lid opened, another window closed): ask a suspended room voice to run again.
  useEffect(() => {
    if (!audio || typeof document === 'undefined') return;
    const wake = () => {
      if (document.visibilityState === 'visible') audio.wake();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
    };
  }, [audio]);

  useEffect(
    () => () => {
      partsRef.current?.engine.stop();
      partsRef.current?.mirror.stop();
      partsRef.current?.voice.close();
    },
    [],
  );

  const [volume, setVolumeState] = useState(1);
  useEffect(() => {
    setVolumeState(readReplyVolume());
  }, []);
  const setVolume = useCallback((value: number) => {
    const next = Math.min(VOLUME_RANGE.max, Math.max(VOLUME_RANGE.min, Math.round(value * 10) / 10));
    setVolumeState(next);
    saveReplyVolume(next);
  }, []);

  const setMirrorOn = useCallback((on: boolean) => {
    saveMirrorEarpiece(on);
    partsRef.current?.mirror.setOn(on);
  }, []);

  const [testing, setTesting] = useState(false);
  const testVoice = useCallback(() => {
    const current = partsRef.current;
    if (!current || testing) return;
    setTesting(true);
    current.setTesting(true);
    void current.voice
      .testVoice()
      .done.finally(() => {
        current.setTesting(false);
        setTesting(false);
      });
  }, [testing]);

  return {
    settingsMissing: role.device === null && roleSettingsFromEnv() === null,
    device: role.device,
    connection: role.connection,
    pairing: role.pairing,
    voiceState: role.voice,
    voice: parts?.voice ?? null,
    engine: parts?.engine ?? null,
    audio,
    audioState,
    state,
    room,
    mirror: mirrorState,
    setMirrorOn,
    volume,
    setVolume,
    testing,
    testVoice,
  };
}
