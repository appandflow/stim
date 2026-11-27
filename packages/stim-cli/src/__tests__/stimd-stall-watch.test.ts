import { afterEach, describe, expect, test, vi } from 'vitest';
import type { DaemonLog } from '../daemon/step-timing.ts';
import { markSegment, watchStalls } from '../stimd/stall-watch.ts';

describe('stimd stall watch', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  test('a blocked loop writes one daemon_stall naming the code marked before the timer was due, the code after, and the CPU it used', () => {
    let clock = 0;
    let cpu = 0;
    const log = vi.fn<DaemonLog>();
    stop = watchStalls(log, { thresholdMs: 1000, intervalMs: 100, now: () => clock, threadCpuMs: () => cpu });
    markSegment('tick passes');
    clock = 50;
    markSegment('tick engine dirs');
    clock = 4600;
    cpu = 30;
    markSegment('tick engine check');
    vi.advanceTimersByTime(100);
    clock = 4700;
    vi.advanceTimersByTime(100);
    clock = 5300;
    vi.advanceTimersByTime(100);

    expect(log.mock.calls).toEqual([
      [
        'info',
        'daemon_stall',
        'the event loop was blocked for 4500ms after tick engine dirs',
        { stallMs: 4500, cpuMs: 30, after: 'tick engine dirs', before: 'tick engine check' },
      ],
    ]);
  });
});
