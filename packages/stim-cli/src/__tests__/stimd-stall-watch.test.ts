import { afterEach, describe, expect, test, vi } from 'vitest';
import type { DaemonLog } from '../daemon/step-timing.ts';
import { markSegment, watchStalls } from '../stimd/stall-watch.ts';

describe('stimd stall watch', () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  test('a blocked loop writes one daemon_stall naming the marked code that held it longest, the code after, and the CPU it used, however many marks follow', () => {
    let clock = 0;
    let cpu = 0;
    const log = vi.fn<DaemonLog>();
    stop = watchStalls(log, { thresholdMs: 1000, intervalMs: 100, now: () => clock, threadCpuMs: () => cpu });
    markSegment('tick state');
    clock = 120;
    markSegment('tick snapshot');
    clock = 1370;
    cpu = 30;
    markSegment('tick engine dirs');
    for (let op = 0; op < 40; op++) markSegment(`op ${op}`);
    clock = 1380;
    vi.advanceTimersByTime(100);
    clock = 1480;
    vi.advanceTimersByTime(100);
    clock = 2000;
    vi.advanceTimersByTime(100);

    expect(log.mock.calls).toEqual([
      [
        'info',
        'daemon_stall',
        'the event loop was blocked for 1280ms in tick snapshot',
        { stallMs: 1280, cpuMs: 30, segment: 'tick snapshot', segmentMs: 1250, next: 'tick engine dirs' },
      ],
    ]);
  });

  test('a stall record that takes long to write does not count as the next stall', () => {
    let clock = 0;
    const log = vi.fn<DaemonLog>(() => {
      clock += 1500;
    });
    stop = watchStalls(log, { thresholdMs: 1000, intervalMs: 100, now: () => clock, threadCpuMs: () => null });
    clock = 1200;
    vi.advanceTimersByTime(100);
    clock += 100;
    vi.advanceTimersByTime(100);

    expect(log).toHaveBeenCalledOnce();
  });
});
