import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setExecutor, resetExecutor } from '../exec.ts';
import { discoverCaches } from '../cache/caches.ts';

const foreign = vi.hoisted(() => ({ path: '' }));
vi.mock('fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs')>();
  return {
    ...fs,
    statSync: (...args: Parameters<typeof fs.statSync>) => {
      const stat = fs.statSync(...args);
      if (stat && typeof stat.uid === 'number' && foreign.path && String(args[0]) === foreign.path) stat.uid += 1;
      return stat;
    },
  };
});

let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-metro-owner-')));
  mkdirSync(join(base, 'tmp'));
  vi.stubEnv('TMPDIR', join(base, 'tmp'));
  vi.stubEnv('STIM_HOME', join(base, 'home'));
  setExecutor({ run: () => '', runQuiet: () => null, runFileQuiet: () => null, spawn: () => {} });
});
afterEach(() => {
  resetExecutor();
  vi.unstubAllEnvs();
  foreign.path = '';
  rmSync(base, { recursive: true, force: true });
});

test.skipIf(process.platform === 'win32')(
  "Metro file maps leave out another user's map in a shared tmpdir (POSIX uid; skipped on win32)",
  () => {
    const mine = join(base, 'tmp', 'metro-file-map-mine');
    foreign.path = join(base, 'tmp', 'metro-file-map-theirs');
    writeFileSync(mine, 'x'.repeat(10));
    writeFileSync(foreign.path, 'y'.repeat(1000));

    const found = discoverCaches().find((c) => c.name === 'Metro file maps');

    expect(found?.files).toEqual([mine]);
    expect(found?.bytes).toBe(10);
  },
);
