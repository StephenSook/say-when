'use client';

/**
 * The room voice page's parts (docs/station.md 3): the Speaker role device (lib/role/device.ts), the engine that
 * decides what to say (lib/speaker/engine.ts), the Cartesia voice (lib/speaker/voice.ts), and the room facts read from
 * the rows (lib/speaker/rows.ts). Everything lives outside React; this hook makes them once, starts them, and reads
 * their snapshots. The row callbacks are registered once per connection object, never in a render.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { tables } from '@/lib/data/module_bindings';
import type { SpacetimeSettings } from '@/lib/data/source-mode';
import { notConnectedError } from '@/lib/role/calls';
import { createRoleDevice, type RoleDevice } from '@/lib/role/device';
import { useAudioUnlock, useRoleDevice, useStoreState } from '@/lib/role/hooks';
import { roleSettingsFromEnv } from '@/lib/role/settings';
import { readReplyVolume, saveReplyVolume, VOLUME_RANGE } from '@/lib/role/storage';
import { createSpeakerEngine, SPEAKER_IDLE, type SpeakerEngine } from '@/lib/speaker/engine';
import { attachSpeakerRows, offerSnapshot, readSpeakerSnapshot, SPEAKER_ROOM_UNKNOWN, type SpeakerConnLike, type SpeakerRoom } from '@/lib/speaker/rows';
import { createSpeakerVoice, type SpeakerVoice } from '@/lib/speaker/voice';
import type { AudioUnlock } from '@/lib/voice/audio';

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
  voice: SpeakerVoice;
  room: RoomStore;
}

interface ReplySpokenConn {
  reducers: { replySpoken(args: { questionId: bigint; ms: number }): Promise<void> };
}

function makeSpeakerParts(settings: SpacetimeSettings, getAudio: () => AudioUnlock | null): SpeakerParts {
  // Assigned below; the functions that read it run only after the page has started.
  let device: RoleDevice | null = null;
  const voice = createSpeakerVoice({
    getToken: () => (device ? device.voice.getToken() : Promise.reject(notConnectedError())),
    context: () => getAudio()?.audioContext() ?? null,
    volume: () => readReplyVolume(),
    pronunciationDictId: process.env.NEXT_PUBLIC_CARTESIA_DICT_ID || undefined,
  });
  const engine = createSpeakerEngine({
    db: settings.db,
    say: (reply, attempt) => voice.say(reply, attempt),
    audioReady: () => getAudio()?.running() ?? false,
    reportSpoken: (questionId, ms) => {
      const conn = device?.connection.conn() as ReplySpokenConn | null | undefined;
      return conn ? conn.reducers.replySpoken({ questionId, ms }) : Promise.reject(notConnectedError());
    },
    waitForLive: (timeoutMs) => (device ? device.connection.whenLive(timeoutMs) : Promise.resolve(false)),
    noteCallError: (error) => {
      device?.noteCallError(error);
    },
  });
  const room = createRoomStore();
  const paired = () => device?.pairing.getState().phase === 'paired';
  const target = { engine, room: (next: SpeakerRoom) => room.set(next), paired };
  const made = createRoleDevice({
    role: 'speaker',
    settings,
    queries: [tables.scanState, tables.mySession],
    attach: (conn) => attachSpeakerRows(conn as unknown as SpeakerConnLike, target),
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
  return { device: made, engine, voice, room };
}

export function useSpeaker() {
  const { audio, state: audioState } = useAudioUnlock();
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

  // A reply that waited for the tap is said once the room voice runs (rule 3 in lib/speaker/engine.ts).
  useEffect(() => {
    parts?.engine.audioChanged();
  }, [parts, audioState.state]);

  useEffect(
    () => () => {
      partsRef.current?.engine.stop();
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

  const [testing, setTesting] = useState(false);
  const testVoice = useCallback(() => {
    const current = partsRef.current;
    if (!current || testing) return;
    setTesting(true);
    void current.voice.testVoice().done.finally(() => setTesting(false));
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
    volume,
    setVolume,
    testing,
    testVoice,
  };
}
