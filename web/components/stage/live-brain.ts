/**
 * The live brain (Screen 1, /brain, web/components/brain/) for the stage's brain slot. Switched on: the line below
 * loads Screen 1's own `BrainScreen` in the browser only, as its page does (it needs WebGL). It is drawn for a whole
 * window, so the slot fits it into its box (components/stage/Stage.module.css `.liveBrain`).
 *
 * The slot mounts it only on a loopback address (the laptop that runs the EEG bridge) or with `?brain=1`, because it
 * opens a socket to ws://127.0.0.1:8766 as it loads; the deployed site keeps the decoder panel
 * (components/stage/DecoderPanel.tsx), and `?brain=0` keeps it anywhere (lib/stage/layout.ts `brainSlotKind`).
 *
 * To switch it off everywhere, replace the one line below with this one, and nothing else:
 *
 * export const LIVE_BRAIN: ComponentType | null = null;
 */
import dynamic from 'next/dynamic';
import type { ComponentType } from 'react';

export const LIVE_BRAIN: ComponentType | null = dynamic(() => import('@/components/brain/BrainScreen'), { ssr: false, loading: () => null });
