import { useSyncExternalStore } from 'react';

interface Clock {
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | undefined;
  subscribe: (listener: () => void) => () => void;
  snapshot: () => number;
}

const clocks = new Map<number, Clock>();

function createClock(intervalMs: number): Clock {
  const schedule = () => {
    clock.timer = setTimeout(
      () => {
        clock.now = Date.now();
        schedule();
        for (const listener of clock.listeners) listener();
      },
      intervalMs - (Date.now() % intervalMs),
    );
  };
  const clock: Clock = {
    now: Date.now(),
    listeners: new Set(),
    timer: undefined,
    subscribe: (listener) => {
      clock.listeners.add(listener);
      if (clock.timer === undefined) {
        clock.now = Date.now();
        schedule();
      }
      return () => {
        clock.listeners.delete(listener);
        if (clock.listeners.size === 0) {
          clearTimeout(clock.timer);
          clock.timer = undefined;
        }
      };
    },
    snapshot: () => {
      if (clock.timer === undefined && Date.now() - clock.now >= intervalMs) clock.now = Date.now();
      return clock.now;
    },
  };
  return clock;
}

/** The current time, refreshed on each wall-clock multiple of `intervalMs`. Callers with the same interval share one timer and one tick. A component that mounts between ticks reads the last tick, at most one interval old. */
export function useNow(intervalMs: number): number {
  let clock = clocks.get(intervalMs);
  if (!clock) {
    clock = createClock(intervalMs);
    clocks.set(intervalMs, clock);
  }
  return useSyncExternalStore(clock.subscribe, clock.snapshot);
}
