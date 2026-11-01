import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { register, readManifest, registeredCaches, manifestPath } from '../cache/cache-manifest.ts';

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

test('registeredCaches ignores a relative dir, which would resolve against the reader cwd', () => {
  mkdirSync(join(cacheDir, 'relative-cache'));
  writeFileSync(manifestPath(), JSON.stringify({ version: 1, caches: [{ dir: 'relative-cache', name: 'relative' }] }));
  const cwd = process.cwd();
  process.chdir(cacheDir);
  try {
    expect(registeredCaches()).toEqual([]);
  } finally {
    process.chdir(cwd);
  }
});

test('registeredCaches ignores a manifest entry for the home directory, so an old registration is never pruned', () => {
  mkdirSync(tmpHome, { recursive: true });
  writeFileSync(
    manifestPath(),
    JSON.stringify({
      version: 1,
      caches: [
        { dir: homedir(), name: 'home' },
        { dir: cacheDir, name: 'real' },
      ],
    }),
  );
  expect(registeredCaches().map((c) => c.name)).toEqual(['real']);
});
