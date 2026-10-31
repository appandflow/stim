import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { register, readManifest } from '../cache/cache-manifest.ts';

let tmpHome: string;
let cacheDir: string;
beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-manifest-'));
  process.env.STIM_HOME = tmpHome;
  cacheDir = mkdtempSync(join(tmpdir(), 'stim-cachedir-'));
});
afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(cacheDir, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test('a registration refuses a directory that pruning would turn into deleting the home, temp or Stim config directory', () => {
  const refused = [
    '~',
    '.',
    'relative-cache',
    homedir(),
    dirname(homedir()),
    tmpdir(),
    dirname(realpathSync(tmpdir())),
    tmpHome,
    sep,
  ];
  for (const dir of refused) expect(() => register({ dir })).toThrow(/^cannot register this cache/);
  expect(readManifest().caches).toEqual([]);
});
