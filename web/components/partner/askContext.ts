'use client';

/**
 * The partner phone's asking parts, shared by the screen below the provider (components/partner/usePartnerAsk.tsx).
 * Null on a phone with no database settings (the sample replay): the phone is then read-only, as before.
 */
import { createContext } from 'react';
import type { AskRequest } from '@/lib/partner/ask';
import type { PushToTalkState } from '@/lib/partner/push-to-talk';
import type { RoleConnectionState } from '@/lib/role/connection';
import type { RoleDevice } from '@/lib/role/device';
import type { PairingState } from '@/lib/role/pairing';
import type { VoiceState } from '@/lib/voice/token';

export interface PartnerAsk {
  device: RoleDevice | null;
  pairing: PairingState;
  connection: RoleConnectionState;
  voice: VoiceState;
  /** `config.share_text_on_board`, from the role connection. */
  sharing: boolean;
  hold: PushToTalkState;
  /** The sender is waiting for the connection to send again. */
  retrying: boolean;
  /** The typed box's sender, once the phone is paired. It rejects with an AskError carrying the sentence to show. */
  ask: ((request: AskRequest) => Promise<void>) | null;
  onHoldChange(held: boolean): void;
  sendAgain(): void;
  dismiss(): void;
}

export const PartnerAskContext = createContext<PartnerAsk | null>(null);
