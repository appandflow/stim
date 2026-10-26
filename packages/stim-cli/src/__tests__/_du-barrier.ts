import { getExecutor, setExecutor } from '../exec.ts';

export function holdDuUntilOverlapped(
  expected: number,
  sizeOf: (dir: string) => number = () => 1,
  waitMs = 3000,
): {
  peak: () => number;
  started: () => number;
} {
  let started = 0;
  let inFlight = 0;
  let peak = 0;
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileAsync: async (file, args, options) => {
      if (file !== 'du') return real.runFileAsync(file, args, options);
      const dir = args?.[1] ?? '';
      started++;
      inFlight++;
      peak = Math.max(peak, inFlight);
      if (started === expected) release?.();
      await Promise.race([barrier, new Promise((resolve) => setTimeout(resolve, waitMs))]);
      inFlight--;
      return `${sizeOf(dir)}\t${dir}`;
    },
  });
  return { peak: () => peak, started: () => started };
}
