/**
 * The live brain (Screen 1, /brain) for the stage's brain slot. Screen 1 lives on branch screen1-brain
 * (web/app/brain/, web/components/brain/), not on main yet, so the slot shows the decoder panel instead
 * (components/stage/DecoderPanel.tsx), which draws no brain activity.
 *
 * When Screen 1 is on main, replace the one line below with this one, and nothing else:
 *
 * export const LIVE_BRAIN: ComponentType | null = dynamic(() => import('@/components/brain/BrainScreen'), { ssr: false, loading: () => null });
 *
 * `BrainScreen` is Screen 1's own default export, loaded in the browser only as its page does (it needs WebGL). It is
 * drawn for a whole window, so the slot fits it into its box (components/stage/Stage.module.css `.liveBrain`).
 * `?brain=0` on /stage keeps the decoder panel even then, for a stage laptop that does not run the EEG bridge.
 */
// Imported now for the line above, so switching it on touches one line only.
import dynamic from 'next/dynamic';
import type { ComponentType } from 'react';

export const LIVE_BRAIN: ComponentType | null = null;
