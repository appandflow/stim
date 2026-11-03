import { lstatSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { canonicalPath } from '../commands/gc/paths.ts';
import { gitQuietAsync } from './git.ts';

export type ArtifactKind = 'build' | 'dependencies';

/**
 * Directories that hold only what a build or an install regenerates, relative to an app or package root. ios/build is
 * not one: `pod install` writes the codegen output (build/generated/ios) and, on React Native 0.88, the podspec
 * facades (scripts/cocoapods/rncore_facades.rb) there, the Pods project references them, and only `pod install`
 * recreates them.
 */
export const ARTIFACT_DIRS: Record<ArtifactKind, readonly string[]> = {
  build: ['android/app/build', 'android/build', 'android/.gradle', '.build'],
  dependencies: ['node_modules', 'ios/Pods'],
};

/** The existing real directories among `dirs` under `root`, never through a link. */
export function existingDirsOf(root: string, dirs: readonly string[]): string[] {
  return dirs
    .map((dir) => join(root, dir))
    .filter((path) => {
      try {
        return lstatSync(path).isDirectory();
      } catch {
        return false;
      }
    });
}

const DERIVED_DATA_NAME = '.dd';
const CXX_NAME = '.cxx';
const NOT_SCANNED = new Set(['node_modules', 'Pods', '.git', '.worktrees', ...ARTIFACT_DIRS.build]);
const ANDROID_OUTPUT = new Set(['build', '.gradle']);

function realDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function namesIn(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/**
 * Whether `dir` is laid out like an Xcode DerivedData directory: a `Build/` directory holding `Products` or
 * `Intermediates.noindex`, beside a `ModuleCache.noindex` or `Logs` directory. xcodebuild writes this layout under
 * `-derivedDataPath`, whatever the directory is called.
 */
export function isDerivedDataLayout(dir: string): boolean {
  const names = namesIn(dir);
  if (!names.includes('Build') || !realDirectory(join(dir, 'Build'))) return false;
  const build = namesIn(join(dir, 'Build'));
  if (!build.includes('Products') && !build.includes('Intermediates.noindex')) return false;
  return names.some((name) => (name === 'ModuleCache.noindex' || name === 'Logs') && realDirectory(join(dir, name)));
}

function cxxDirs(root: string): string[] {
  const android = join(root, 'android');
  const modules = namesIn(android)
    .filter((name) => !ANDROID_OUTPUT.has(name) && name !== CXX_NAME)
    .map((name) => join(android, name, CXX_NAME));
  return [join(android, CXX_NAME), ...modules].filter(realDirectory);
}

function derivedDataDirs(root: string): { path: string; named: boolean }[] {
  return namesIn(root)
    .filter((name) => !NOT_SCANNED.has(name))
    .map((name) => ({
      path: join(root, name),
      named: name === DERIVED_DATA_NAME,
    }))
    .filter(({ path }) => realDirectory(path) && isDerivedDataLayout(path));
}

/**
 * The directories under `root` that hold only what a build regenerates and that the fixed `ARTIFACT_DIRS.build` names
 * cannot list: the Android CMake directories `android/.cxx` and `android/<module>/.cxx`, and a `.dd` directory laid
 * out as DerivedData. A `.dd` that is not laid out as DerivedData is not one.
 */
export function discoveredBuildDirs(root: string): string[] {
  return [
    ...cxxDirs(root),
    ...derivedDataDirs(root)
      .filter(({ named }) => named)
      .map(({ path }) => path),
  ];
}

/** Every existing regenerable build directory under `root`: the fixed names and the discovered ones. */
export function existingBuildDirs(root: string): string[] {
  return [...existingDirsOf(root, ARTIFACT_DIRS.build), ...discoveredBuildDirs(root)];
}

/**
 * The xcodebuild output directly under `root` that is laid out as DerivedData under a name other than `.dd`, such as
 * a rn-tester `build-device`. The project chose the name and what else uses it, so Stim reports it and never deletes it.
 */
export function xcodebuildOutputDirs(root: string): string[] {
  return derivedDataDirs(root)
    .filter(({ named }) => !named)
    .map(({ path }) => path);
}

/** Whether `path` is a directory that `existingBuildDirs` lists for the checkout or app containing it. */
export function isBuildDirPath(path: string): boolean {
  if (ARTIFACT_DIRS.build.some((dir) => path.endsWith(`${sep}${dir.split('/').join(sep)}`))) return true;
  const name = basename(path);
  if (name === CXX_NAME) {
    const parent = dirname(path);
    return basename(parent) === 'android' || basename(dirname(parent)) === 'android';
  }
  return name === DERIVED_DATA_NAME && isDerivedDataLayout(path);
}

/**
 * Why `path`, inside the checkout at `root`, must not be deleted as a regenerable directory, or null when it is a real
 * directory inside `root` whose every file git ignores.
 */
export async function regenerableDirProblem(root: string, path: string, signal?: AbortSignal): Promise<string | null> {
  const rel = relative(root, path);
  try {
    if (!lstatSync(path).isDirectory()) return 'it is not a directory';
  } catch {
    return 'it is gone';
  }
  if (canonicalPath(path) !== join(canonicalPath(root), rel))
    return 'it or a directory above it is a link, or it lies outside its project';
  const tracked = await gitQuietAsync(root, ['ls-files', '--', rel], { signal });
  if (tracked === null) return 'git cannot tell whether it holds tracked files';
  if (tracked.trim()) return 'it holds files git tracks';
  const unignored = await gitQuietAsync(root, ['ls-files', '--others', '--exclude-standard', '--', rel], { signal });
  if (unignored === null) return 'git cannot tell whether it ignores every file in it';
  if (unignored.trim()) return 'it holds files git does not ignore';
  return null;
}
