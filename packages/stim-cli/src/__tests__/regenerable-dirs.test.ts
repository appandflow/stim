import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoveredBuildDirs,
  existingBuildDirsAsync,
  isBuildDirPath,
  isDerivedDataLayout,
  xcodebuildOutputDirs,
} from '../workspace/regenerable-dirs.ts';
import { writeDerivedData } from './_factories.ts';

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-regenerable-dirs-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function dir(...parts: string[]): string {
  const path = join(root, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

test('a directory is DerivedData by its Build and ModuleCache or Logs layout, whatever its name', () => {
  writeDerivedData(dir('anything'));
  expect(isDerivedDataLayout(join(root, 'anything'))).toBe(true);

  dir('build-only', 'Build', 'Products');
  expect(isDerivedDataLayout(join(root, 'build-only'))).toBe(false);

  dir('logs-only', 'Logs');
  expect(isDerivedDataLayout(join(root, 'logs-only'))).toBe(false);

  dir('plain-build', 'Build');
  dir('plain-build', 'Logs');
  expect(isDerivedDataLayout(join(root, 'plain-build'))).toBe(false);

  dir('module-cache', 'Build', 'Intermediates.noindex');
  dir('module-cache', 'ModuleCache.noindex');
  expect(isDerivedDataLayout(join(root, 'module-cache'))).toBe(true);
});

test('a .dd directory laid out as DerivedData and android CMake directories are build output to delete; the rest is not', () => {
  writeDerivedData(dir('.dd'));
  dir('android', '.cxx');
  dir('android', 'app', '.cxx');
  dir('android', 'mylib', '.cxx');
  dir('android', 'build', '.cxx');
  dir('ios', '.cxx');
  dir('.cxx');
  dir('node_modules', 'react-native', 'android', '.cxx');
  dir('other', '.dd', 'Build');

  expect(discoveredBuildDirs(root).toSorted()).toEqual(
    [
      join(root, '.dd'),
      join(root, 'android', '.cxx'),
      join(root, 'android', 'app', '.cxx'),
      join(root, 'android', 'mylib', '.cxx'),
    ].toSorted(),
  );
});

test('a .dd without the DerivedData layout, or a link to one, is not build output', () => {
  dir('.dd', 'notes');
  expect(discoveredBuildDirs(root)).toEqual([]);

  rmSync(join(root, '.dd'), { recursive: true });
  writeDerivedData(dir('elsewhere', 'real'));
  symlinkSync(join(root, 'elsewhere', 'real'), join(root, '.dd'));
  expect(discoveredBuildDirs(root)).toEqual([]);
  expect(xcodebuildOutputDirs(root)).toEqual([]);
});

test('xcodebuild output under another name is reported and never listed as deletable', async () => {
  writeDerivedData(dir('build'));
  writeDerivedData(dir('build-device'));
  writeDerivedData(dir('.dd'));
  writeDerivedData(dir('node_modules', 'cache'));
  dir('src', 'Build', 'Products');

  expect(xcodebuildOutputDirs(root).toSorted()).toEqual([join(root, 'build'), join(root, 'build-device')]);
  expect(await existingBuildDirsAsync(root)).toEqual([join(root, '.dd')]);
});

test('isBuildDirPath re-recognizes build output at the moment of deletion', () => {
  const dd = dir('.dd');
  writeDerivedData(dd);
  expect(isBuildDirPath(dd)).toBe(true);
  expect(isBuildDirPath(join(root, 'android', 'app', '.cxx'))).toBe(true);
  expect(isBuildDirPath(join(root, 'android', 'app', 'build'))).toBe(true);
  expect(isBuildDirPath(join(root, 'src', '.cxx'))).toBe(false);
  expect(isBuildDirPath(join(root, 'build-device'))).toBe(false);

  rmSync(join(dd, 'Build'), { recursive: true });
  expect(isBuildDirPath(dd)).toBe(false);
});
