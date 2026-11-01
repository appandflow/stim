import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { withAmbientContext } from '@stim-cli/core';
import { filesystemDevice, makeTemporaryDirectory, removeTemporaryEntryAsync, temporaryRoot } from '../temporary.ts';
import { testContext } from './_context.ts';

const volume = vi.hoisted(() => ({ path: '' }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    statSync: (...args: Parameters<typeof fs.statSync>) => {
      const stat = fs.statSync(...args);
      if (
        stat &&
        typeof stat.dev === 'number' &&
        volume.path &&
        !relative(volume.path, String(args[0])).startsWith('..')
      )
        stat.dev += 1;
      return stat;
    },
  };
});

let base: string;
let near: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-temporary-test-')));
  const internal = join(base, 'internal');
  volume.path = join(base, 'volume');
  near = join(volume.path, 'main', 'nested', 'linked');
  mkdirSync(internal);
  mkdirSync(near, { recursive: true });
  writeFileSync(join(volume.path, 'main', '.git'), 'gitdir: elsewhere');
  writeFileSync(join(near, '.git'), 'gitdir: elsewhere');
  vi.stubEnv('TMPDIR', internal);
  vi.stubEnv('STIM_HOME', join(base, 'home'));
  vi.stubEnv('STIM_TMPDIR', undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  volume.path = '';
  rmSync(base, { recursive: true, force: true });
});

test('overrides and symlinks into a working tree cannot expose staged secrets', () => {
  const alias = join(base, 'alias');
  symlinkSync(near, alias);
  vi.stubEnv('STIM_TMPDIR', join(alias, 'new-temp'));
  expect(() => temporaryRoot(near)).toThrow(/outside Git working trees/);
  expect(filesystemDevice(join(alias, 'missing', 'file'))).toBe(filesystemDevice(near));
});

test('a dangling symlink cannot be mistaken for its parent filesystem', () => {
  const alias = join(base, 'unmounted');
  symlinkSync(join(base, 'absent-volume'), alias);
  expect(() => filesystemDevice(join(alias, 'file'))).toThrow(/ENOENT/);
});

test('app staging cannot modify or recursively copy the source bundle', () => {
  const app = join(volume.path, 'Fixture.app');
  mkdirSync(app);
  const staging = makeTemporaryDirectory(app, 'stim-app-');
  expect(temporaryRoot(app)).toBe(volume.path);
  expect(relative(app, staging).startsWith('..')).toBe(true);
  vi.stubEnv('STIM_TMPDIR', join(app, 'temp'));
  expect(() => temporaryRoot(app)).toThrow(/must not be inside/);
});

test('swap staging for a cached artifact stays outside the build cache', () => {
  const cache = join(volume.path, 'build-cache');
  vi.stubEnv('STIM_BUILD_CACHE', cache);
  const app = join(cache, 'ios', 'key', 'Fixture.app');
  mkdirSync(app, { recursive: true });
  expect(temporaryRoot(app)).toBe(volume.path);
  expect(temporaryRoot(join(cache, 'android', 'key', 'app.apk'))).toBe(volume.path);
});

test("an operation's STIM_TMPDIR wins over the host process's", () => {
  vi.stubEnv('STIM_TMPDIR', join(volume.path, 'host'));
  const context = testContext({ env: { ...process.env, STIM_TMPDIR: tmpdir() } });
  expect(withAmbientContext(context, () => temporaryRoot(near))).toBe(tmpdir());
});

test('artifact cleanup yields to other work, removes read-only directories and leaves symlink targets intact', async () => {
  const staged = join(base, 'staged');
  const retained = join(base, 'retained');
  mkdirSync(retained);
  writeFileSync(join(retained, 'keep'), 'untouched');
  for (let index = 0; index < 32; index++) {
    const directory = join(staged, `assets-${index}`);
    mkdirSync(directory, { recursive: true });
    for (let file = 0; file < 16; file++) writeFileSync(join(directory, `${file}.asset`), 'asset');
    chmodSync(directory, 0o500);
  }
  symlinkSync(retained, join(staged, 'linked-assets'), 'junction');
  const removed = removeTemporaryEntryAsync(staged);
  const responsive = await Promise.race([
    new Promise<true>((resolve) => setImmediate(() => resolve(true))),
    removed.then(() => false),
  ]);
  await removed;
  expect(responsive).toBe(true);
  expect(existsSync(staged)).toBe(false);
  expect(readFileSync(join(retained, 'keep'), 'utf8')).toBe('untouched');
});
