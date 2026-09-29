import { findTailscale, readTailscaleStatus, type TailscaleState } from './tailscale.ts';

export interface TailscaleSnapshot {
  binary: string | null;
  state: TailscaleState;
}

export interface TailscaleMonitor {
  current(): TailscaleSnapshot;
  onChange(listener: (snapshot: TailscaleSnapshot, previous: TailscaleSnapshot) => void): () => void;
  stop(): void;
}

export interface TailscaleMonitorOptions {
  env: NodeJS.ProcessEnv;
  initial: TailscaleSnapshot;
  find?: (env: NodeJS.ProcessEnv) => string | null;
  read?: (binary: string | null, env: NodeJS.ProcessEnv) => Promise<TailscaleState>;
  backoffMs?: number;
  maxMs?: number;
}

const STATUS_TIMEOUT_MS = 10_000;
const MISSES_BEFORE_DOWN = 3;

function sameState(a: TailscaleState, b: TailscaleState): boolean {
  if (a.state !== b.state) return false;
  if (a.state === 'running' && b.state === 'running') {
    return (
      a.dnsName === b.dnsName &&
      a.hostName === b.hostName &&
      a.ips.length === b.ips.length &&
      a.ips.every((ip, i) => ip === b.ips[i])
    );
  }
  if (a.state === 'not-running' && b.state === 'not-running') return a.backendState === b.backendState;
  return true;
}

export function watchTailscale(options: TailscaleMonitorOptions): TailscaleMonitor {
  const find = options.find ?? findTailscale;
  const read = options.read ?? ((binary, env) => readTailscaleStatus(binary, env, STATUS_TIMEOUT_MS));
  const backoffMs = options.backoffMs ?? 2000;
  const maxMs = options.maxMs ?? 30_000;
  const listeners = new Set<(snapshot: TailscaleSnapshot, previous: TailscaleSnapshot) => void>();
  let snapshot = options.initial;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let misses = 0;
  let silent = 0;

  const schedule = () => {
    if (stopped) return;
    const wait =
      snapshot.state.state === 'running' && silent === 0
        ? maxMs
        : Math.min(backoffMs * 2 ** Math.max(misses, silent), maxMs);
    timer = setTimeout(() => void check(), wait);
    timer.unref();
  };

  async function check(): Promise<void> {
    try {
      const binary = snapshot.binary ?? find(options.env);
      const state = await read(binary, options.env);
      if (stopped) return;
      if (state.state === 'unavailable' && snapshot.state.state === 'running' && ++silent < MISSES_BEFORE_DOWN) return;
      silent = 0;
      misses = state.state === 'running' ? 0 : misses + 1;
      if (binary !== snapshot.binary || !sameState(state, snapshot.state)) {
        const previous = snapshot;
        snapshot = { binary, state };
        for (const listener of listeners) listener(snapshot, previous);
      }
    } catch (error) {
      console.error(`stim-server: checking Tailscale failed: ${(error as Error).message}`);
    } finally {
      schedule();
    }
  }

  schedule();
  return {
    current: () => snapshot,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
