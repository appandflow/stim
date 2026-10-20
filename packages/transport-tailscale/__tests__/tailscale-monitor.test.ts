import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TailscaleState } from '../src/tailscale.ts';
import { watchTailscale, type TailscaleSnapshot } from '../src/tailscale-monitor.ts';

const timedOut: TailscaleState = { state: 'unavailable', reason: 'it timed out' };
const running: TailscaleState = { state: 'running', ips: ['100.64.0.1'], dnsName: 'mac.tail1.ts.net', hostName: 'mac' };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function watch(reads: TailscaleState[], find: () => string | null = () => 'tailscale') {
  const seen: TailscaleState[] = [];
  const read = vi.fn<() => Promise<TailscaleState>>(async () => {
    const state = reads.shift() ?? reads.at(-1) ?? timedOut;
    seen.push(state);
    return state;
  });
  const changes: TailscaleSnapshot[] = [];
  const monitor = watchTailscale({
    env: {},
    initial: { binary: 'tailscale', state: timedOut },
    find,
    read,
    backoffMs: 1000,
    maxMs: 8000,
  });
  monitor.onChange((snapshot) => changes.push(snapshot));
  return { monitor, read, changes };
}

describe('watchTailscale', () => {
  it('backs off while Tailscale does not answer, then reports it once it runs', async () => {
    const { monitor, read, changes } = watch([timedOut, timedOut, running]);
    await vi.advanceTimersByTimeAsync(999);
    expect(read).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(changes).toEqual([]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(read).toHaveBeenCalledTimes(3);
    expect(changes).toEqual([{ binary: 'tailscale', state: running }]);
    expect(monitor.current().state).toEqual(running);
    monitor.stop();
  });

  it('caps the wait, keeps checking while running, and reports it going away and coming back', async () => {
    const stopped: TailscaleState = { state: 'not-running', backendState: 'Stopped' };
    const { monitor, read, changes } = watch([running, running, stopped, running]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(changes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(changes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8000);
    expect(changes.map((change) => change.state.state)).toEqual(['running', 'not-running']);
    await vi.advanceTimersByTimeAsync(2000);
    expect(changes.map((change) => change.state.state)).toEqual(['running', 'not-running', 'running']);
    monitor.stop();
  });

  it('keeps a running state through a single timeout and drops it after three in a row', async () => {
    const { monitor, changes } = watch([running, timedOut, running, timedOut, timedOut, timedOut]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(changes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8000 + 2000);
    expect(monitor.current().state).toEqual(running);
    expect(changes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8000 + 2000);
    expect(monitor.current().state).toEqual(running);
    await vi.advanceTimersByTimeAsync(4000);
    expect(changes.map((change) => change.state.state)).toEqual(['running', 'unavailable']);
    monitor.stop();
  });

  it('does not report a repeated timeout with a new reason, and stops on stop()', async () => {
    const { monitor, read, changes } = watch([
      { state: 'unavailable', reason: 'a' },
      { state: 'unavailable', reason: 'b' },
    ]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(changes).toEqual([]);
    monitor.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('looks the tailscale binary up again while none was found', async () => {
    const found = [null, '/usr/local/bin/tailscale'];
    const seenBinaries: (string | null)[] = [];
    const monitor = watchTailscale({
      env: {},
      initial: { binary: null, state: { state: 'unavailable', reason: 'the tailscale command was not found' } },
      find: () => found.shift() ?? null,
      read: async (binary) => {
        seenBinaries.push(binary);
        return binary ? running : { state: 'unavailable', reason: 'the tailscale command was not found' };
      },
      backoffMs: 1000,
      maxMs: 8000,
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(seenBinaries).toEqual([null, '/usr/local/bin/tailscale']);
    expect(monitor.current()).toEqual({ binary: '/usr/local/bin/tailscale', state: running });
    monitor.stop();
  });
});
