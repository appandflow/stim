import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { sizeCaches } from '../cache/caches.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { planCacheEmptying } from '../commands/gc/caches.ts';
import { formatGcReport } from '../commands/gc/report.ts';
import { makeCacheDescriptor } from './_factories.ts';

let child: ChildProcess | undefined;

afterEach(async () => {
  if (child?.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'close');
    child.kill('SIGKILL');
    await closed;
  }
  child = undefined;
  vi.useRealTimers();
  resetExecutor();
});

test('a slow shared-cache measurement yields while retaining precounted bytes and descriptor order', async () => {
  const executor = getExecutor();
  const args = ['-e', 'setTimeout(() => process.stdout.write("2\\tcache"), 150)'];
  setExecutor({
    runFile: (_file, _args, options) => executor.runFile(process.execPath, args, options),
    runFileAsync: (_file, _args, options) => executor.runFileAsync(process.execPath, args, options),
  });
  const input = [
    makeCacheDescriptor({ name: 'known empty', bytes: 0 }),
    makeCacheDescriptor({ name: 'known size', bytes: 42 }),
    makeCacheDescriptor({ name: 'measured', dir: '/cache/measured' }),
  ];
  let ticked = false;
  const timer = setTimeout(() => (ticked = true), 25);
  try {
    const sized = await sizeCaches(input);
    expect(ticked).toBe(true);
    expect(sized.map(({ name, bytes }) => ({ name, bytes }))).toEqual([
      { name: 'known empty', bytes: 0 },
      { name: 'known size', bytes: 42 },
      { name: 'measured', bytes: 2048 },
    ]);
    expect(input[2]?.bytes).toBeUndefined();
  } finally {
    clearTimeout(timer);
  }
});

test('a failed cache probe remains unknown in JSON and text without changing emptying policy', async () => {
  const executor = getExecutor();
  setExecutor({
    runFileAsync: (_file, _args, options) =>
      executor.runFileAsync(process.execPath, ['-e', 'process.exit(1)'], options),
  });
  const cache = makeCacheDescriptor({ dir: '/cache/unreadable', source: 'registered', prune: 'atomic' });
  const sized = await sizeCaches([cache, makeCacheDescriptor({ name: 'known', bytes: 4096 })]);
  expect(sized[0]?.bytes).toBeUndefined();
  expect(sized[0]?.sizeError).toContain('Size unavailable');
  const wire = JSON.parse(JSON.stringify(sized)) as { bytes?: number; sizeError?: string }[];
  expect(wire[0]).not.toHaveProperty('bytes');
  expect(wire[0]?.sizeError).toContain('Size unavailable');
  expect(planCacheEmptying(sized, true).map(({ willEmpty, emptySkipped }) => ({ willEmpty, emptySkipped }))).toEqual(
    planCacheEmptying([cache, makeCacheDescriptor({ name: 'known', bytes: 4096 })], true).map(
      ({ willEmpty, emptySkipped }) => ({ willEmpty, emptySkipped }),
    ),
  );
  const text = formatGcReport({ caches: sized }).join('\n');
  expect(text).toContain('size unknown');
  expect(text).toContain('Size unavailable');
  expect(text).toContain('total: at least 4K');
});

test('a stalled cache probe kills its child at the finite budget and reports unknown instead of zero', async () => {
  const executor = getExecutor();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  vi.useFakeTimers();
  setExecutor({
    runFileAsync: (_file, _args, options) =>
      executor.runFileAsync(
        process.execPath,
        ['-e', 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)'],
        {
          ...options,
          onSpawn: (spawned) => {
            child = spawned;
            spawned.stdout?.once('data', started);
          },
        },
      ),
  });
  const pending = sizeCaches([makeCacheDescriptor({ dir: '/cache/stalled' })]);
  await ready;
  await vi.advanceTimersByTimeAsync(60_000);
  const sized = await pending;
  expect(child?.signalCode).toBe('SIGKILL');
  expect(sized[0]?.bytes).toBeUndefined();
  expect(sized[0]?.sizeError).toContain('exceeded 60 seconds');
});
