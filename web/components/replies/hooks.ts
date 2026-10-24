'use client';

/**
 * Small hooks for the Suggested replies screen: one update per animation frame, a media query, reduced motion.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

/**
 * `value`, at most once per animation frame. A burst of row callbacks (six web results in one transaction) draws
 * once, on the next frame, and never later: coalescing by frame, not by a timer, so the screen never lags the room.
 */
export function useFrameValue<T>(value: T): T {
  const [shown, setShown] = useState(value);
  const latest = useRef(value);
  const pending = useRef<number | null>(null);
  latest.current = value;
  useEffect(() => {
    if (pending.current !== null) return;
    pending.current = requestAnimationFrame(() => {
      pending.current = null;
      setShown(latest.current);
    });
  }, [value]);
  useEffect(
    () => () => {
      if (pending.current !== null) cancelAnimationFrame(pending.current);
    },
    [],
  );
  return shown;
}

/** Whether a media query matches. false during the server render. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', notify);
      return () => list.removeEventListener('change', notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}
