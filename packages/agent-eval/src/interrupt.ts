import type { EventEmitter } from 'node:events';
import { constants } from 'node:os';

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

export interface Interrupt {
  signal: AbortSignal;
  received(): number | null;
  release(): void;
}

export function trapSignals(target: EventEmitter, exit: (code: number) => void): Interrupt {
  const controller = new AbortController();
  let first: number | null = null;
  const handlers = SIGNALS.map((name) => {
    const handler = (): void => {
      const code = 128 + constants.signals[name];
      if (first !== null) {
        exit(code);
        return;
      }
      first = code;
      controller.abort();
    };
    target.on(name, handler);
    return [name, handler] as const;
  });
  return {
    signal: controller.signal,
    received: () => first,
    release: () => handlers.forEach(([name, handler]) => target.off(name, handler)),
  };
}
