/**
 * Where the Suggested replies camera looks, as plain math over the layout's rectangles. Pure, so the projector
 * sizes can be checked without a browser.
 *
 * The labels are 29 canvas units tall at the smallest, so a zoom of 0.69 keeps them at 20 px on screen. When the
 * preferred view would need a smaller zoom (a 1280 x 720 screen showing the whole first round), the camera frames
 * the camera target's tighter rectangle instead, and never zooms below that floor.
 */
import type { Rect } from './layout';
import type { CameraTarget } from './model';

/** The smallest label is 29 units: 29 x 0.69 is 20 px. */
export const READABLE_ZOOM = 0.69;
/** A pick may come closer than 1:1, but not so close that the card fills the room. */
export const MAX_ZOOM = 1.3;
/** Room around a framed rectangle, as a share of its size. */
export const PADDING = 0.04;

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** The zoom that fits `rect` with its padding into a `width` x `height` screen. */
export function fitZoom(rect: Rect, width: number, height: number, padding: number = PADDING): number {
  const w = rect.width * (1 + 2 * padding);
  const h = rect.height * (1 + 2 * padding);
  if (w <= 0 || h <= 0 || width <= 0 || height <= 0) return 1;
  return Math.min(width / w, height / h);
}

/** The viewport that centers `rect` at the fitting zoom, clamped to `[minZoom, maxZoom]`. */
export function viewportFor(rect: Rect, width: number, height: number, minZoom: number, maxZoom: number, padding: number = PADDING): Viewport {
  const zoom = Math.min(maxZoom, Math.max(minZoom, fitZoom(rect, width, height, padding)));
  return {
    x: width / 2 - (rect.x + rect.width / 2) * zoom,
    y: height / 2 - (rect.y + rect.height / 2) * zoom,
    zoom,
  };
}

/** Moves `from` toward `to` by at most `limit` (never past it). */
function toward(from: number, to: number, limit: number): number {
  if (limit <= 0) return from;
  return from + Math.max(-limit, Math.min(limit, to - from));
}

/**
 * The viewport for a camera target on this screen: the preferred rectangle when its labels stay readable; else the
 * tight rectangle at the readable floor (never smaller), nudged toward the preferred one as far as the tight one stays
 * fully in view, so the spare room shows more of the tree instead of empty canvas.
 */
export function cameraViewport(target: Pick<CameraTarget, 'rect' | 'tight'>, width: number, height: number, maxZoom: number = 1): Viewport {
  if (fitZoom(target.rect, width, height) >= READABLE_ZOOM) return viewportFor(target.rect, width, height, READABLE_ZOOM, maxZoom);
  const tight = target.tight;
  const zoom = Math.min(maxZoom, Math.max(READABLE_ZOOM, fitZoom(tight, width, height)));
  // How far the view's center may move, in canvas units, before the tight rectangle's padded edge leaves the screen.
  const slackX = Math.max(0, (width / zoom - tight.width * (1 + 2 * PADDING)) / 2);
  const slackY = Math.max(0, (height / zoom - tight.height * (1 + 2 * PADDING)) / 2);
  const cx = toward(tight.x + tight.width / 2, target.rect.x + target.rect.width / 2, slackX);
  const cy = toward(tight.y + tight.height / 2, target.rect.y + target.rect.height / 2, slackY);
  return { x: width / 2 - cx * zoom, y: height / 2 - cy * zoom, zoom };
}
