'use client';

/**
 * A shared ticking clock for elapsed times and countdowns ("0.6 s so far", "6 s left", "0:42").
 * One interval per tick rate, shared by every component that asks for it, stopped when unused.
 * tube ticks its elapsed timers at 250 ms, so that is the default.
 *
 * The server render and the hydration render read 0, so no clock text can mismatch; the real time
 * arrives on the next render. Render time-based text only when you have rows to time.
 */
import { useSyncExternalStore } from 'react';

interface Clock {
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  subscribe(listener: () => void): () => void;
  get(): number;
}

const clocks = new Map<number, Clock>();

function clockFor(intervalMs: number): Clock {
  const existing = clocks.get(intervalMs);
  if (existing) return existing;
  const clock: Clock = {
    now: 0,
    listeners: new Set(),
    timer: null,
    subscribe(listener) {
      clock.listeners.add(listener);
      if (clock.timer === null) {
        clock.now = Date.now();
        clock.timer = setInterval(() => {
          clock.now = Date.now();
          for (const notify of [...clock.listeners]) notify();
        }, intervalMs);
      }
      return () => {
        clock.listeners.delete(listener);
        if (clock.listeners.size === 0 && clock.timer !== null) {
          clearInterval(clock.timer);
          clock.timer = null;
        }
      };
    },
    get() {
      // While nobody is subscribed the value can be old; refresh it once, then keep it stable.
      if (clock.timer === null && Date.now() - clock.now > intervalMs) clock.now = Date.now();
      return clock.now;
    },
  };
  clocks.set(intervalMs, clock);
  return clock;
}

const serverNow = () => 0;

/** The current time in epoch ms, updated every `intervalMs`. 0 during the server and hydration renders. */
export function useNow(intervalMs: number = 250): number {
  const clock = clockFor(Math.max(16, Math.round(intervalMs)));
  return useSyncExternalStore(clock.subscribe, clock.get, serverNow);
}
