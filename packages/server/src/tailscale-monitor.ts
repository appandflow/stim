import { findTailscale, readTailscaleStatus, type TailscaleState } from './tailscale.ts';

export interface TailscaleSnapshot {
  binary: string | null;
  state: TailscaleState;
}

export interface TailscaleMonitor {
  current(): TailscaleSnapshot;
  /** Calls `listener` after a check finds a different state; returns the unsubscribe function. */
  onChange(listener: (snapshot: TailscaleSnapshot, previous: TailscaleSnapshot) => void): () => void;
  stop(): void;
}

export interface TailscaleMonitorOptions {
  env: NodeJS.ProcessEnv;
  initial: TailscaleSnapshot;
  find?: (env: NodeJS.ProcessEnv) => string | null;
  read?: (binary: string | null, env: NodeJS.ProcessEnv) => Promise<TailscaleState>;
  /** The first wait while Tailscale is not running; it doubles up to `maxMs`. */
  backoffMs?: number;
  /** The longest wait between checks, and the wait between checks while Tailscale runs. */
  maxMs?: number;
}

const STATUS_TIMEOUT_MS = 10_000;

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

/**
 * Re-reads `tailscale status --json` off the request path: with a doubling wait while Tailscale is
 * not running or does not answer, and at the longest wait once it runs, so a Tailscale that goes away
 * or comes back is noticed without a restart. The tailscale binary is looked up again on each check
 * while none was found.
 */
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

  const schedule = () => {
    if (stopped) return;
    const wait = snapshot.state.state === 'running' ? maxMs : Math.min(backoffMs * 2 ** misses, maxMs);
    timer = setTimeout(() => void check(), wait);
    timer.unref();
  };

  async function check(): Promise<void> {
    const binary = snapshot.binary ?? find(options.env);
    const state = await read(binary, options.env);
    if (stopped) return;
    misses = state.state === 'running' ? 0 : misses + 1;
    if (binary !== snapshot.binary || !sameState(state, snapshot.state)) {
      const previous = snapshot;
      snapshot = { binary, state };
      for (const listener of listeners) listener(snapshot, previous);
    }
    schedule();
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
