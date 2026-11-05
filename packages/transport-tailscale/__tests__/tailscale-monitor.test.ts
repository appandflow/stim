import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TailscaleState } from '../src/tailscale.ts';
import { watchTailscale, type TailscaleSnapshot } from '../src/tailscale-monitor.ts';

const timedOut: TailscaleState = { state: 'unavailable', reason: 'it timed out' };
const running: TailscaleState = { state: 'running', ips: ['100.64.0.1'], dnsName: 'mac.tail1.ts.net', hostName: 'mac' };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.clearAllTimers());

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
});
