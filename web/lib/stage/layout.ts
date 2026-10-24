/**
 * The stage view (/stage): one projector screen that shows the whole loop, so nobody switches tabs during the demo.
 * Pure rules, so a test can check them without React or a browser.
 *
 * - `stageLayout` picks the frame for the window: the tree beside a side column on a projector (1920 x 1080) or a laptop
 *   (1280 x 720), and one column with the tree as a list on anything narrower.
 * - `brainSlotKind` picks what fills the brain slot: the live brain (Screen 1) once it is on this build, else the
 *   decoder panel built from the rows that exist today. `?brain=0` keeps the decoder panel, for a stage laptop that
 *   does not run the EEG bridge.
 */

export type StageLayoutKind = 'wide' | 'compact' | 'stacked';

export interface StageLayout {
  kind: StageLayoutKind;
  /** The side column's width in px (brain slot, earpiece, said out loud). null when stacked. */
  sideWidth: number | null;
  /** The tree draws on its canvas; false shows the same tree as a list (components/replies/StackedTree.tsx). */
  canvas: boolean;
}

/** At or above this width the side column gets its full width (a 1920 px projector, a 1680 px laptop). */
export const WIDE_MIN_WIDTH = 1600;
/** Below this width, or this height, the canvas has no room: one column, the tree as a list. */
export const STACK_BELOW_WIDTH = 960;
export const STACK_BELOW_HEIGHT = 540;

export const SIDE_WIDE = 520;
export const SIDE_COMPACT = 400;

/**
 * The frame for a window of `width` x `height` CSS px. null (the server render, before the window is known) gets the
 * projector frame, the screen this page is for.
 */
export function stageLayout(size: { width: number; height: number } | null): StageLayout {
  if (size === null) return { kind: 'wide', sideWidth: SIDE_WIDE, canvas: true };
  const { width, height } = size;
  if (!(width > 0) || !(height > 0)) return { kind: 'wide', sideWidth: SIDE_WIDE, canvas: true };
  if (width < STACK_BELOW_WIDTH || height < STACK_BELOW_HEIGHT) return { kind: 'stacked', sideWidth: null, canvas: false };
  if (width >= WIDE_MIN_WIDTH) return { kind: 'wide', sideWidth: SIDE_WIDE, canvas: true };
  return { kind: 'compact', sideWidth: SIDE_COMPACT, canvas: true };
}

/** Parses the "1920x1080" key the page keeps for the window size. null when it is not a size. */
export function parseSize(key: string | null): { width: number; height: number } | null {
  if (!key) return null;
  const match = /^(\d+)x(\d+)$/.exec(key);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

export type BrainSlotKind = 'live-brain' | 'decoder';

/**
 * What fills the brain slot. The live brain only when Screen 1 is on this build (`liveBrainOnBuild`, from
 * components/stage/live-brain.ts) and the address does not say `brain=0`. Everything else gets the decoder panel,
 * which shows only rows that exist (the input, the last command and when). Nothing here draws brain activity.
 */
export function brainSlotKind(liveBrainOnBuild: boolean, search: string | null): BrainSlotKind {
  if (!liveBrainOnBuild) return 'decoder';
  const param = search ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('brain') : null;
  return param === '0' ? 'decoder' : 'live-brain';
}
