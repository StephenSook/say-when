'use client';

/**
 * Asking from the partner phone (docs/station.md 4, PLAN row 5.5): a Partner role connection beside the anonymous
 * board connection the status view already reads (two sockets on the phone; the shared provider is unchanged).
 *
 * - Pairing as Partner with a label from the fixed list (partner phone 1, 2 or 3). Unpaired phones stay read-only, so
 *   a judge's phone can watch without pairing.
 * - Hold to ask streams to Ink-2 only while held (lib/partner/push-to-talk.ts); the typed box uses the same sender
 *   (lib/partner/ask.ts), with a request id so a retry can never ask twice.
 * - The words Ink-2 hears follow the room's sharing toggle, read on the role connection.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { listen } from '@/lib/cartesia/browser';
import type { SpacetimeSettings } from '@/lib/data/source-mode';
import { AskError, createAskSender, type AskRequest, type AskSender } from '@/lib/partner/ask';
import { createPushToTalk, PUSH_TO_TALK_READY, type PushToTalk } from '@/lib/partner/push-to-talk';
import { attachPartnerRows, readSharing, type PartnerConnLike } from '@/lib/partner/rows';
import { notConnectedError } from '@/lib/role/calls';
import { createRoleDevice, type RoleDevice } from '@/lib/role/device';
import { useRoleDevice, useStoreState } from '@/lib/role/hooks';
import { roleSettingsFromEnv } from '@/lib/role/settings';
import { PartnerAskContext, type PartnerAsk } from './askContext';
import { newRequestId } from './useAsk';

interface Flags {
  sharing: boolean;
  retrying: boolean;
}

interface FlagStore {
  getState(): Flags;
  subscribe(listener: () => void): () => void;
  patch(next: Partial<Flags>): void;
}

const FLAGS_START: Flags = { sharing: false, retrying: false };

function createFlagStore(): FlagStore {
  let flags = FLAGS_START;
  const listeners = new Set<() => void>();
  return {
    getState: () => flags,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    patch(next) {
      const merged = { ...flags, ...next };
      if (merged.sharing === flags.sharing && merged.retrying === flags.retrying) return;
      flags = merged;
      for (const listener of [...listeners]) listener();
    },
  };
}

interface PartnerParts {
  device: RoleDevice;
  send: AskSender;
  push: PushToTalk;
  flags: FlagStore;
}

interface PartnerReducers {
  reducers: {
    askQuestion(args: { requestId: string; text: string; via: string; listenMs: number }): Promise<void>;
    partnerListening(args: { requestId: string; on: boolean }): Promise<void>;
  };
}

function makePartnerParts(settings: SpacetimeSettings): PartnerParts {
  // Assigned below; the functions that read it run only after the page has started.
  let device: RoleDevice | null = null;
  const conn = () => (device?.connection.conn() as PartnerReducers | null | undefined) ?? null;
  const flags = createFlagStore();
  const send = createAskSender({
    call: (request) => {
      const c = conn();
      return c ? c.reducers.askQuestion(request) : Promise.reject(notConnectedError());
    },
    waitForLive: (timeoutMs) => (device ? device.connection.whenLive(timeoutMs) : Promise.resolve(false)),
    noteCallError: (error) => {
      device?.noteCallError(error);
    },
    onRetrying: (retrying) => flags.patch({ retrying }),
  });
  const push = createPushToTalk({
    listen,
    getToken: () => (device ? device.voice.getToken() : Promise.reject(notConnectedError())),
    setListening: (requestId, on) => {
      const c = conn();
      return c ? c.reducers.partnerListening({ requestId, on }) : Promise.reject(notConnectedError());
    },
    send,
    newRequestId,
  });
  device = createRoleDevice({
    role: 'partner',
    settings,
    attach: (c) => attachPartnerRows(c as unknown as PartnerConnLike, (sharing) => flags.patch({ sharing })),
    onApplied: (c) => flags.patch({ sharing: readSharing(c as unknown as PartnerConnLike) }),
  });
  return { device, send, push, flags };
}

/** Wrap the partner screen in this, so Hold to ask, the typed box and the pairing link share one connection. */
export function PartnerAskProvider({ children }: { children: ReactNode }) {
  const partsRef = useRef<PartnerParts | null>(null);
  const [hasSettings] = useState(() => roleSettingsFromEnv() !== null);
  const role = useRoleDevice('partner', () => {
    const settings = roleSettingsFromEnv();
    if (!settings) return null;
    partsRef.current = makePartnerParts(settings);
    return partsRef.current.device;
  });
  const parts = role.device ? partsRef.current : null;
  const hold = useStoreState(parts?.push ?? null, PUSH_TO_TALK_READY);
  const flags = useStoreState(parts?.flags ?? null, FLAGS_START);
  const paired = role.pairing.phase === 'paired';

  // A hold in progress is thrown away when the page closes or the phone stops being paired.
  useEffect(() => {
    if (!paired) partsRef.current?.push.abort();
  }, [paired]);
  useEffect(() => () => partsRef.current?.push.abort(), []);

  const ask = useCallback(async (request: AskRequest) => {
    const current = partsRef.current;
    if (!current) throw notConnectedError();
    const outcome = await current.send(request);
    if (!outcome.ok) throw new AskError(outcome);
  }, []);

  const onHoldChange = useCallback((held: boolean) => {
    const push = partsRef.current?.push;
    if (!push) return;
    if (held) push.press();
    else push.release();
  }, []);
  const sendAgain = useCallback(() => partsRef.current?.push.sendAgain(), []);
  const dismiss = useCallback(() => partsRef.current?.push.dismiss(), []);

  const value = useMemo<PartnerAsk | null>(
    () =>
      hasSettings
        ? {
            device: role.device,
            pairing: role.pairing,
            connection: role.connection,
            voice: role.voice,
            sharing: flags.sharing,
            retrying: flags.retrying,
            hold,
            ask: paired ? ask : null,
            onHoldChange,
            sendAgain,
            dismiss,
          }
        : null,
    [hasSettings, role.device, role.pairing, role.connection, role.voice, flags, hold, paired, ask, onHoldChange, sendAgain, dismiss],
  );

  return <PartnerAskContext.Provider value={value}>{children}</PartnerAskContext.Provider>;
}
