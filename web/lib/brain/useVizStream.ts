'use client';

/**
 * React side of the Screen 1 stream. The 3D scene and the strip read `stream.state` directly inside
 * requestAnimationFrame; React re-renders the badges and labels 10 times a second at most, with the browser clock in
 * `now`, so NO SIGNAL appears on time even when no message arrives.
 */
import { useEffect, useState } from 'react';
import { DEFAULT_VIZ_URL } from './protocol';
import { VizStream } from './stream';

export const UI_TICK_MS = 100;

export interface VizTick {
  stream: VizStream;
  /** stream.state.version at the last tick. */
  version: number;
  /** performance.now() at the last tick. */
  now: number;
}

export function useVizStream(url: string = DEFAULT_VIZ_URL): VizTick {
  const [stream] = useState(() => new VizStream(url));
  const [tick, setTick] = useState(() => ({ version: 0, now: 0 }));

  useEffect(() => {
    stream.start();
    const id = window.setInterval(() => {
      setTick((prev) => {
        const now = performance.now();
        // Re-render on new data, and while data is aging so the stale rule can fire.
        if (prev.version === stream.state.version && now - prev.now < UI_TICK_MS) return prev;
        return { version: stream.state.version, now };
      });
    }, UI_TICK_MS);
    return () => {
      window.clearInterval(id);
      stream.stop();
    };
  }, [stream]);

  return { stream, version: tick.version, now: tick.now };
}
