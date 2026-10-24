/**
 * One paired device page: the role connection, pairing and the voice check, wired together (docs/station.md 1.2 to
 * 1.5, 7.2 C1, C2 and C4). The station, speaker and partner pages each make one with `createRoleDevice` and read it
 * through `useRoleDevice` (lib/role/hooks.ts).
 *
 *   connection   lib/role/connection.ts: the DbConnection with this role's token, its reconnect rules and state
 *   pairing      lib/role/pairing.ts: the pure state machine; this file runs its effects
 *   voice        lib/voice/token.ts: `mint_voice_token`, the voice check, and `getToken` for Cartesia sockets
 *
 * `device_status` and `config` are always subscribed: pairing reads this identity's row and `pairing_ttl_ms`.
 * A role call refused with `not allowed`, or a mint that says `not_paired_for_purpose`, shows the pairing card again.
 */
import type { DbConnectionBuilder } from 'spacetimedb';
import { tables, type DbConnection } from '../data/module_bindings';
import type { SpacetimeSettings } from '../data/source-mode';
import { createVoiceTokenClient, mintVia, voicePurposeFor, type MintFn, type VoiceTokenClient, type VoiceTokenRow } from '../voice/token';
import { callErrorKind, callErrorText, isSenderMessage, notConnectedError, SENDER_MESSAGES, type CallErrorKind } from './calls';
import { createRoleConnection, type AnyDbConnection, type RoleConnection, type RoleQuery } from './connection';
import {
  autoPairingLabel,
  DEFAULT_PAIRING_TTL_MS,
  initialPairingState,
  isPairingLabel,
  newPairingCode,
  pairingStep,
  type DeviceRowLite,
  type PairingEffect,
  type PairingEvent,
  type PairingState,
  type VoiceOutcome,
} from './pairing';
import type { DeviceRole, StorageLike } from './storage';

export interface RoleDeviceOptions<Conn extends AnyDbConnection = DbConnection> {
  role: DeviceRole;
  settings: SpacetimeSettings;
  /** The page's own subscriptions; `device_status` and `config` are added. */
  queries?: readonly RoleQuery[];
  /** Row callbacks for the page's engine, registered once per connection object (see RoleConnectionOptions). */
  attach?: (conn: Conn) => (() => void) | void;
  onApplied?: (conn: Conn) => void;
  /** The label to pair with. Defaults to the fixed label for station and speaker; the partner picks one. */
  label?: string | null;
  builder?: () => DbConnectionBuilder<Conn>;
  storage?: StorageLike | null;
  /** Replaces the procedure call, for tests. */
  mint?: MintFn;
  /** Draws a pairing code. Defaults to `newPairingCode()` (crypto.getRandomValues). */
  drawCode?: () => number;
  /** Reloads the page after Forget this device. Defaults to `location.reload()`. */
  reload?: () => void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface PairingStore {
  getState(): PairingState;
  subscribe(listener: () => void): () => void;
}

export interface RoleDevice<Conn extends AnyDbConnection = DbConnection> {
  readonly role: DeviceRole;
  readonly settings: SpacetimeSettings;
  readonly connection: RoleConnection<Conn>;
  readonly pairing: PairingStore;
  readonly voice: VoiceTokenClient;
  start(): void;
  stop(): void;
  /** True once the voice check has confirmed this identity is paired for its role. */
  isPaired(): boolean;
  /** Ask for a new code ("New code", or "Get a code" on the partner phone with the picked label). */
  requestCode(label?: string): void;
  /** Remember the partner phone's label before asking. */
  chooseLabel(label: string): void;
  /** The Retry link: run the voice check again. */
  recheckVoice(): void;
  /**
   * Feed any reducer error here. `not allowed` shows the pairing card again. Returns the error's kind, so the caller
   * can decide between "never retry" (sender) and "send again" (disconnected, unknown_result).
   */
  noteCallError(error: unknown): CallErrorKind;
  /** Forget this device: delete this role's token and reload, which gives a new identity. */
  forget(): void;
}

/** The owner's CLI server argument: `maincloud` for Maincloud, else the host itself. */
export function cliServer(host: string): string {
  return /^https?:\/\/maincloud\.spacetimedb\.com\/?$/i.test(host.trim()) ? 'maincloud' : host.trim();
}

/** What the owner types to approve a code (docs/station.md 1.2). `caregiver` is true only for the caregiver's phone. */
export function approveCommand(settings: SpacetimeSettings, code: number, caregiver = false): string {
  return `spacetime call --no-config --server ${cliServer(settings.host)} ${settings.db} approve_pairing ${code} ${caregiver ? 'true' : 'false'}`;
}

/** What the owner types to revoke this device (identities are not secrets). */
export function revokeCommand(settings: SpacetimeSettings, identityHex: string): string {
  const hex = identityHex.startsWith('0x') ? identityHex : `0x${identityHex}`;
  return `spacetime call --no-config --server ${cliServer(settings.host)} ${settings.db} revoke_device ${hex}`;
}

interface DeviceStatusRowLike {
  identity: { toHexString(): string };
  role: { tag: string };
  label: string;
  online: boolean;
  lastSeenAt: { microsSinceUnixEpoch: bigint };
}

/** A `device_status` row as plain values for the pairing machine. */
export function deviceRowLite(row: DeviceStatusRowLike): DeviceRowLite {
  return {
    identityHex: row.identity.toHexString(),
    role: row.role.tag.toLowerCase(),
    label: row.label,
    online: row.online,
    stamp: row.lastSeenAt.microsSinceUnixEpoch.toString(),
  };
}

interface PairingTables {
  db: {
    deviceStatus: {
      iter(): Iterable<DeviceStatusRowLike>;
      onInsert(cb: () => void): void;
      removeOnInsert(cb: () => void): void;
      onUpdate(cb: () => void): void;
      removeOnUpdate(cb: () => void): void;
      onDelete(cb: () => void): void;
      removeOnDelete(cb: () => void): void;
    };
    config: { iter(): Iterable<{ pairingTtlMs: number }> };
  };
}

function outcomeOf(voice: VoiceTokenClient): VoiceOutcome {
  const state = voice.getState();
  if (state.status === 'ready') return 'ok';
  if (state.status === 'problem') return state.problem;
  return 'offline';
}

export function createRoleDevice<Conn extends AnyDbConnection = DbConnection>(options: RoleDeviceOptions<Conn>): RoleDevice<Conn> {
  const { role, settings } = options;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const drawCode = options.drawCode ?? (() => newPairingCode());
  const reload =
    options.reload ??
    (() => {
      if (typeof window !== 'undefined') window.location.reload();
    });

  let state = initialPairingState(role, options.label === undefined ? autoPairingLabel(role) : options.label);
  const listeners = new Set<() => void>();
  let running = false;
  let expiryTimer: unknown = null;
  const effectTimers = new Set<unknown>();
  let unwatchConnection: (() => void) | null = null;

  const queries: RoleQuery[] = [tables.deviceStatus, tables.config];
  for (const query of options.queries ?? []) if (!queries.includes(query)) queries.push(query);

  const pairingTables = (conn: Conn) => conn as unknown as PairingTables;

  const readRows = (conn: Conn) => {
    try {
      dispatch({ type: 'rows', rows: [...pairingTables(conn).db.deviceStatus.iter()].map(deviceRowLite) });
    } catch (error) {
      console.error('NeuroLingo: could not read device_status', error);
    }
  };

  const ttlMs = (): number => {
    const conn = connection.conn();
    if (!conn) return DEFAULT_PAIRING_TTL_MS;
    try {
      const row = [...pairingTables(conn).db.config.iter()][0];
      return row && Number.isFinite(row.pairingTtlMs) && row.pairingTtlMs > 0 ? row.pairingTtlMs : DEFAULT_PAIRING_TTL_MS;
    } catch {
      return DEFAULT_PAIRING_TTL_MS;
    }
  };

  const connection = createRoleConnection<Conn>({
    role,
    settings,
    queries,
    builder: options.builder,
    storage: options.storage,
    now,
    setTimer,
    clearTimer,
    attach(conn) {
      const tablesOf = pairingTables(conn).db.deviceStatus;
      const changed = () => readRows(conn);
      tablesOf.onInsert(changed);
      tablesOf.onUpdate(changed);
      tablesOf.onDelete(changed);
      let detachPage: (() => void) | void = undefined;
      try {
        detachPage = options.attach?.(conn);
      } catch (error) {
        console.error('NeuroLingo: the page could not register its row callbacks', error);
      }
      return () => {
        tablesOf.removeOnInsert(changed);
        tablesOf.removeOnUpdate(changed);
        tablesOf.removeOnDelete(changed);
        if (typeof detachPage === 'function') detachPage();
      };
    },
    onApplied(conn) {
      dispatch({ type: 'connection', identityHex: connection.getState().identityHex, live: true });
      readRows(conn);
      options.onApplied?.(conn);
    },
  });

  const getConn = () => connection.conn() as unknown as { procedures: { mintVoiceToken(args: { purpose: string }): Promise<VoiceTokenRow> } } | null;
  const voice = createVoiceTokenClient({
    purpose: voicePurposeFor(role),
    mint: options.mint ?? mintVia(getConn),
    now,
    onNotPaired: () => dispatch({ type: 'not_allowed' }),
  });

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const armExpiry = () => {
    if (expiryTimer !== null) {
      clearTimer(expiryTimer);
      expiryTimer = null;
    }
    if (state.phase !== 'waiting' || state.expiresAt === null) return;
    expiryTimer = setTimer(() => {
      expiryTimer = null;
      dispatch({ type: 'tick', at: now() });
    }, Math.max(0, state.expiresAt - now()) + 50);
  };

  const later = (ms: number | undefined, run: () => void) => {
    if (!ms) {
      run();
      return;
    }
    const handle = setTimer(() => {
      effectTimers.delete(handle);
      if (running) run();
    }, ms);
    effectTimers.add(handle);
  };

  const sendRequest = (fresh: boolean) => {
    const label = state.label;
    if (label === null || !isPairingLabel(role, label)) return;
    const code = fresh || state.code === null ? drawCode() : state.code;
    dispatch({ type: 'request', code, label });
    if (state.code !== code || state.phase !== 'requesting') return;
    const conn = connection.conn() as unknown as { reducers: { requestPairing(args: { code: number; role: string; label: string }): Promise<void> } } | null;
    const call = conn ? conn.reducers.requestPairing({ code, role, label }) : Promise.reject(notConnectedError());
    call.then(
      () => dispatch({ type: 'request_ok', code, at: now(), ttlMs: ttlMs() }),
      (error: unknown) => dispatch({ type: 'request_failed', code, kind: callErrorKind(error), message: callErrorText(error) }),
    );
  };

  const checkVoice = () => {
    void voice.check().then(() => dispatch({ type: 'voice', outcome: outcomeOf(voice), at: now() }));
  };

  const run = (effect: PairingEffect) => {
    if (effect.type === 'send_request') later(effect.delayMs, () => sendRequest(effect.fresh));
    else later(effect.delayMs, checkVoice);
  };

  function dispatch(event: PairingEvent) {
    const step = pairingStep(state, event);
    const changed = step.state !== state;
    state = step.state;
    if (changed) {
      armExpiry();
      notify();
    }
    if (!running) return;
    for (const effect of step.effects) run(effect);
  }

  return {
    role,
    settings,
    connection,
    voice,
    pairing: {
      getState: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    start() {
      if (running) return;
      running = true;
      let wasLive = connection.getState().status === 'live';
      unwatchConnection = connection.subscribe(() => {
        const current = connection.getState();
        const live = current.status === 'live';
        if (live !== wasLive || current.identityHex !== state.identityHex) {
          wasLive = live;
          dispatch({ type: 'connection', identityHex: current.identityHex, live });
        }
      });
      connection.start();
    },
    stop() {
      running = false;
      unwatchConnection?.();
      unwatchConnection = null;
      if (expiryTimer !== null) clearTimer(expiryTimer);
      expiryTimer = null;
      for (const handle of effectTimers) clearTimer(handle);
      effectTimers.clear();
      connection.stop();
      // A restart (React Strict Mode) reads everything again from a fresh connection.
      state = { ...state, live: false, rowsApplied: false, checkInFlight: false };
      voice.clear();
    },
    isPaired: () => state.phase === 'paired',
    requestCode(label) {
      if (label !== undefined) dispatch({ type: 'choose_label', label });
      if (state.phase === 'paired' || state.phase === 'checking') return;
      sendRequest(true);
    },
    chooseLabel(label) {
      dispatch({ type: 'choose_label', label });
    },
    recheckVoice() {
      if (state.phase === 'paired' || state.phase === 'checking') {
        // A recheck while paired updates the voice state; a "not paired" answer revokes through onNotPaired.
        void voice.check().then(() => {
          const outcome = outcomeOf(voice);
          if (outcome !== 'not_paired') dispatch({ type: 'voice', outcome, at: now() });
        });
      }
    },
    noteCallError(error) {
      const kind = callErrorKind(error);
      if (isSenderMessage(error, SENDER_MESSAGES.notAllowed)) dispatch({ type: 'not_allowed' });
      return kind;
    },
    forget() {
      voice.clear();
      connection.forget();
      reload();
    },
  };
}
