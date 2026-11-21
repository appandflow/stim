import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureDirectoryAsync } from '../fs-util.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';

const lookup = vi.hoisted((): { run?: (path: string) => Promise<void> } => ({}));
vi.mock('fs/promises', async (original) => {
  const fs = await original<typeof import('fs/promises')>();
  return {
    ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      await lookup.run?.(String(args[0]));
      return fs.lstat(...args);
    },
  };
});

test('a pending hard-link lookup leaves the event loop responsive and expiry prevents the next lookup', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-fsutil-'));
  const dir = join(home, 'output');
  mkdirSync(dir);
  for (const name of ['a', 'b']) writeFileSync(join(dir, name), 'data');
  let started!: () => void;
  const firstLookup = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const paths: string[] = [];
  lookup.run = async (path) => {
    if (path === dir) return;
    paths.push(path);
    if (path === join(dir, 'a')) {
      started();
      await held;
    }
  };
  const runFileAsync = vi.fn<(file: string, args: string[]) => Promise<string>>();
  setExecutor({ ...getExecutor(), runFileAsync });
  try {
    const walk = measureDirectoryAsync(dir, { timeoutMs: 100 });
    await firstLookup;
    vi.advanceTimersByTime(100);
    finish();
    expect(await walk).toEqual({ bytes: 0, partial: true });
    expect(paths).toEqual([join(dir, 'a')]);
    expect(runFileAsync).not.toHaveBeenCalled();
  } finally {
    finish();
    delete lookup.run;
    resetExecutor();
    rmSync(home, { recursive: true, force: true });
  }
});
