'use client';

/**
 * React access to a role device and the audio tap (lib/role/device.ts, lib/voice/audio.ts). The device lives outside
 * React; these hooks only start it, stop it and read its snapshots with useSyncExternalStore.
 *
 * The device is made in an effect, so the server render and the first client render both see `device: null`
 * (no hydration mismatch, and no connection from the server). Under React Strict Mode the same device is stopped and
 * started again, never made twice.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createAudioUnlock, type AudioUnlock, type AudioUnlockOptions, type AudioUnlockSnapshot } from '../voice/audio';
import type { VoiceState } from '../voice/token';
import type { AnyDbConnection, RoleConnectionState } from './connection';
import type { RoleDevice } from './device';
import { initialPairingState, type PairingState } from './pairing';
import type { DeviceRole } from './storage';
import type { DbConnection } from '../data/module_bindings';

interface Store<T> {
  getState(): T;
  subscribe(listener: () => void): () => void;
}

const noSubscribe = () => () => {};

/** Reads a store, or `fallback` while there is none (the server render and the first client render). */
export function useStoreState<T>(store: Store<T> | null, fallback: T): T {
  return useSyncExternalStore(store ? store.subscribe : noSubscribe, store ? store.getState : () => fallback, () => fallback);
}

const CONNECTING: RoleConnectionState = {
  status: 'connecting',
  ready: false,
  identityHex: null,
  problem: null,
  errorText: null,
  since: 0,
  tokenSaved: null,
};

const VOICE_UNKNOWN: VoiceState = { status: 'unknown' };

const pairingFallbacks = new Map<DeviceRole, PairingState>();
function pairingFallback(role: DeviceRole): PairingState {
  let value = pairingFallbacks.get(role);
  if (!value) {
    value = initialPairingState(role);
    pairingFallbacks.set(role, value);
  }
  return value;
}

export interface RoleDeviceView<Conn extends AnyDbConnection = DbConnection> {
  /** Null during the server render and the first client render, and when `create` returned null. */
  device: RoleDevice<Conn> | null;
  connection: RoleConnectionState;
  pairing: PairingState;
  voice: VoiceState;
}

/**
 * Makes the device once with `create` (read once; later values are ignored), starts it, and stops it on unmount.
 * `create` may return null, for example when the database settings are missing.
 */
export function useRoleDevice<Conn extends AnyDbConnection = DbConnection>(role: DeviceRole, create: () => RoleDevice<Conn> | null): RoleDeviceView<Conn> {
  const createRef = useRef(create);
  const deviceRef = useRef<RoleDevice<Conn> | null>(null);
  const [device, setDevice] = useState<RoleDevice<Conn> | null>(null);

  useEffect(() => {
    if (!deviceRef.current) deviceRef.current = createRef.current();
    const made = deviceRef.current;
    setDevice(made);
    made?.start();
    return () => made?.stop();
  }, []);

  const connection = useStoreState(device?.connection ?? null, CONNECTING);
  const pairing = useStoreState(device?.pairing ?? null, pairingFallback(role));
  const voice = useStoreState(device?.voice ?? null, VOICE_UNKNOWN);
  return { device, connection, pairing, voice };
}

const AUDIO_LOCKED: AudioUnlockSnapshot = {
  state: 'locked',
  errorText: null,
  startedAt: null,
  deviceChangedAt: null,
  wakeLock: 'off',
  latencyMs: 0,
};

/** One audio tap helper for the page, closed on unmount. `options` are read once. */
export function useAudioUnlock(options?: AudioUnlockOptions): { audio: AudioUnlock | null; state: AudioUnlockSnapshot } {
  const optionsRef = useRef(options);
  const audioRef = useRef<AudioUnlock | null>(null);
  const [audio, setAudio] = useState<AudioUnlock | null>(null);

  useEffect(() => {
    if (!audioRef.current) audioRef.current = createAudioUnlock(optionsRef.current);
    setAudio(audioRef.current);
    const made = audioRef.current;
    return () => {
      made.close();
      audioRef.current = null;
    };
  }, []);

  const state = useStoreState(audio, AUDIO_LOCKED);
  return { audio, state };
}
