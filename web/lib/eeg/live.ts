/**
 * Frames from the headset decoder on ws://127.0.0.1:8765 for the /eeg page (eeg-data/eeg/server.py).
 * The decoder sends the station contract (gesture, health; parsed by lib/station/decoder.ts) plus an `eeg` frame
 * about ten times a second: each electrode's mu and beta power against the wearer's own resting level, the model's
 * left, right and rest bars, and the jaw level. Values only; no raw EEG reaches the browser.
 */
import { parseDecoderFrame, type DecoderFrame } from '../station/decoder';

export const EEG_PORT = 8765;

export interface EegChannel {
  name: string;
  /** Top view, x to the right, y to the front, 1 = ear level. */
  x: number;
  y: number;
  /** Percent change against the resting level; negative = that area is working (desynchronisation). */
  change: number;
  flat: boolean;
  noisy: boolean;
}

export interface EegFrame {
  t: number;
  channels: EegChannel[];
  hemispheres: { left: number; right: number };
  /** Which hand's area is clearly more active, or null. The left hemisphere moves the right hand. */
  activeHand: 'left' | 'right' | null;
  proba: Record<string, number>;
  status: string;
  jaw: number;
  jawThreshold: number;
  samplesPerSecond: number;
}

export type LiveFrame = { kind: 'eeg'; frame: EegFrame } | DecoderFrame;

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** One text frame from the decoder. Never throws; anything that is not an `eeg` frame goes to the station parser. */
export function parseLiveFrame(data: unknown): LiveFrame {
  if (typeof data === 'string' && data.includes('"eeg"')) {
    try {
      const m = JSON.parse(data) as Record<string, unknown>;
      if (m && m.type === 'eeg' && Array.isArray(m.channels)) {
        const channels = (m.channels as Record<string, unknown>[])
          .filter((c) => c && typeof c.name === 'string')
          .map((c) => ({
            name: String(c.name),
            x: Math.max(-1, Math.min(1, num(c.x))),
            y: Math.max(-1, Math.min(1, num(c.y))),
            change: num(c.change),
            flat: c.flat === true,
            noisy: c.noisy === true,
          }));
        const h = (m.hemispheres ?? {}) as Record<string, unknown>;
        const proba: Record<string, number> = {};
        for (const [k, v] of Object.entries((m.proba ?? {}) as Record<string, unknown>)) proba[k] = Math.max(0, Math.min(1, num(v)));
        return {
          kind: 'eeg',
          frame: {
            t: num(m.t),
            channels,
            hemispheres: { left: num(h.left), right: num(h.right) },
            activeHand: m.activeHand === 'left' || m.activeHand === 'right' ? m.activeHand : null,
            proba,
            status: typeof m.status === 'string' ? m.status : '',
            jaw: Math.max(0, num(m.jaw)),
            jawThreshold: Math.max(1, num(m.jawThreshold, 20)),
            samplesPerSecond: Math.max(0, num(m.samplesPerSecond)),
          },
        };
      }
    } catch {
      // not JSON: the station parser reports it
    }
  }
  return parseDecoderFrame(data);
}

/** -50% (blue, working) .. 0 (neutral) .. +50% (red). Returns an rgba() string for SVG fills. */
export function changeColor(change: number, span = 50): string {
  const t = Math.max(-1, Math.min(1, change / span));
  const a = (0.18 + 0.72 * Math.abs(t)).toFixed(2);
  return t < 0 ? `rgba(96, 160, 255, ${a})` : `rgba(240, 120, 110, ${a})`;
}
