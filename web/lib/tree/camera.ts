/**
 * Where the Suggested replies camera looks, as plain math over the layout's rectangles. Pure, so the projector
 * sizes can be checked without a browser.
 *
 * The titles and option words are 29 canvas units tall, so the zoom never goes below 0.69 (20 px on screen).
 *
 * No card is ever cut by the screen's edge: `cameraFraming` frames the target whole at the largest zoom where every
 * card is either fully on screen or fully off it, so the edge of the picture always falls in a gap between cards. A
 * card on the far side of a gap simply is not shown. When no zoom down to the floor allows that, it frames the
 * target's tighter rectangle the same way, and only then falls back to centering it.
 */
import type { Rect } from './layout';
import type { CameraTarget, TreeNode } from './model';

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

/** The picked option is drawn 1.1 times its size, growing from its left center (ReplyTree.module.css .option_picked). */
export const PICK_SCALE = 1.1;
/** Room kept around the framed target, in screen pixels (small, so the four options still fit at 1280 x 720). */
const TARGET_MARGIN_PX = 10;
/** Canvas units below which two edges count as touching. */
const EPS = 0.01;

/** A node's rectangle as drawn: the picked option is larger than its slot. */
export function drawnRect(node: TreeNode): Rect {
  if (node.kind !== 'option' || node.state !== 'picked') return node.rect;
  const { x, y, width, height } = node.rect;
  return { x, y: y - (height * (PICK_SCALE - 1)) / 2, width: width * PICK_SCALE, height: height * PICK_SCALE };
}

/** The cards a framing must not cut: every node but the soft region boxes behind them. */
export function cardRects(nodes: readonly TreeNode[]): Rect[] {
  return nodes.filter((node) => node.kind !== 'region').map(drawnRect);
}

interface Gap {
  lo: number;
  hi: number;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** The point of [lo, hi] nearest `preferred` that lies in none of the open intervals `forbidden`, or null. */
function nearestAllowed(preferred: number, lo: number, hi: number, forbidden: readonly Gap[]): number | null {
  const allowed = (v: number) => v >= lo - EPS && v <= hi + EPS && !forbidden.some((f) => v > f.lo + EPS && v < f.hi - EPS);
  const candidates = [preferred, lo, hi];
  for (const f of forbidden) candidates.push(f.lo, f.hi);
  let best: number | null = null;
  for (const v of candidates) {
    if (!allowed(v)) continue;
    if (best === null || Math.abs(v - preferred) < Math.abs(best - preferred)) best = v;
  }
  return best;
}

/**
 * The viewport that shows `target` whole, with a small margin, at the largest zoom in [minZoom, maxZoom] where no card
 * is cut by an edge of the `width` x `height` screen: each card is fully on screen or fully off it. Of the clean
 * placements at that zoom, the one whose center is nearest the target's center. null when no zoom in range allows it.
 */
export function cleanViewport(target: Rect, cards: readonly Rect[], width: number, height: number, minZoom: number, maxZoom: number, step: number = 0.01): Viewport | null {
  if (width <= 0 || height <= 0) return null;
  const cx = target.x + target.width / 2;
  const cy = target.y + target.height / 2;
  for (let i = 0; ; i++) {
    const zoom = Math.round((maxZoom - i * step) * 10_000) / 10_000;
    if (zoom < minZoom - 1e-9) break;
    const vw = width / zoom;
    const vh = height / zoom;
    const margin = TARGET_MARGIN_PX / zoom;
    // Where the view's top left corner may sit while the target stays whole inside it.
    const xMin = target.x + target.width + margin - vw;
    const xMax = target.x - margin;
    const yMin = target.y + target.height + margin - vh;
    const yMax = target.y - margin;
    if (xMin > xMax || yMin > yMax) continue;
    const yPreferred = clamp(cy - vh / 2, yMin, yMax);
    // A clean left edge sits at a card's edge (or one view width from it); try those, and the centered spot.
    const xs = new Set<number>([clamp(cx - vw / 2, xMin, xMax), xMin, xMax]);
    for (const c of cards) {
      for (const v of [c.x, c.x + c.width, c.x - vw, c.x + c.width - vw]) if (v >= xMin - EPS && v <= xMax + EPS) xs.add(clamp(v, xMin, xMax));
    }
    let best: { x0: number; y0: number; d: number } | null = null;
    for (const x0 of xs) {
      // For this left edge, the tops that would cut a card: cards cut by a side edge must be off screen vertically;
      // cards wholly between the side edges must be fully in or fully out vertically.
      const forbidden: Gap[] = [];
      for (const c of cards) {
        const right = c.x + c.width;
        if (!(c.x < x0 + vw - EPS && right > x0 + EPS)) continue;
        const bottom = c.y + c.height;
        const sidesInside = c.x >= x0 - EPS && right <= x0 + vw + EPS;
        if (sidesInside && vh + EPS >= c.height) forbidden.push({ lo: c.y - vh, hi: bottom - vh }, { lo: c.y, hi: bottom });
        else forbidden.push({ lo: c.y - vh, hi: bottom });
      }
      const y0 = nearestAllowed(yPreferred, yMin, yMax, forbidden);
      if (y0 === null) continue;
      const d = Math.hypot(x0 + vw / 2 - cx, y0 + vh / 2 - cy);
      if (best === null || d < best.d - EPS) best = { x0, y0, d };
    }
    if (best) return { x: -best.x0 * zoom, y: -best.y0 * zoom, zoom };
  }
  return null;
}

/**
 * The whole camera rule for one target on one screen. A pick or a confirm frames its nodes as drawn and may come in
 * to MAX_ZOOM; every other target frames its rectangle at up to 1:1. Each tries a clean framing of the preferred
 * rectangle, then of the tight one, and only then centers it as before.
 */
export function cameraFraming(camera: CameraTarget, nodes: readonly TreeNode[], width: number, height: number): Viewport {
  const close = camera.intent === 'pick' || camera.intent === 'confirm';
  const maxZoom = close ? MAX_ZOOM : 1;
  const cards = cardRects(nodes);
  const framed = camera.nodeIds ? nodes.filter((node) => camera.nodeIds!.includes(node.id)).map(drawnRect) : [];
  const preferred = framed.length > 0 ? unionOf(framed) : camera.rect;
  const tight = framed.length > 0 ? preferred : camera.tight;
  return (
    cleanViewport(preferred, cards, width, height, READABLE_ZOOM, maxZoom) ??
    cleanViewport(tight, cards, width, height, READABLE_ZOOM, maxZoom) ??
    (framed.length > 0 ? viewportFor(preferred, width, height, READABLE_ZOOM, maxZoom) : cameraViewport(camera, width, height))
  );
}

function unionOf(rects: readonly Rect[]): Rect {
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}
