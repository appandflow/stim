import { lstatSync, readdirSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { canonicalPath } from '../commands/gc/paths.ts';
import { gitQuietAsync } from './git.ts';
import { othersRunningAsync, readRunningProcessesAsync, runningFromReason } from './running-from.ts';

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

type DirRead = { names: string } | { directory: string };
type DirReads<T> = Generator<DirRead, T, string[] | boolean>;

function* namesIn(path: string): DirReads<string[]> {
  const names = yield { names: path };
  return Array.isArray(names) ? names : [];
}

function* realDirectory(path: string): DirReads<boolean> {
  return (yield { directory: path }) === true;
}

function answerSync(read: DirRead): string[] | boolean {
  try {
    return 'names' in read ? readdirSync(read.names) : lstatSync(read.directory).isDirectory();
  } catch {
    return 'names' in read ? [] : false;
  }
}

async function answerAsync(read: DirRead): Promise<string[] | boolean> {
  try {
    return 'names' in read ? await readdir(read.names) : (await lstat(read.directory)).isDirectory();
  } catch {
    return 'names' in read ? [] : false;
  }
}

function readSync<T>(reads: DirReads<T>): T {
  let step = reads.next();
  while (!step.done) step = reads.next(answerSync(step.value));
  return step.value;
}

async function readAsync<T>(reads: DirReads<T>): Promise<T> {
  let step = reads.next();
  while (!step.done) step = reads.next(await answerAsync(step.value));
  return step.value;
}

function* existingDirsReads(root: string, dirs: readonly string[]): DirReads<string[]> {
  const found: string[] = [];
  for (const path of dirs.map((dir) => join(root, dir))) if (yield* realDirectory(path)) found.push(path);
  return found;
}

/** The existing real directories among `dirs` under `root`, never through a link. */
export function existingDirsOf(root: string, dirs: readonly string[]): string[] {
  return readSync(existingDirsReads(root, dirs));
}

const DERIVED_DATA_NAME = '.dd';
const CXX_NAME = '.cxx';
const NOT_SCANNED = new Set(['node_modules', 'Pods', '.git', '.worktrees', ...ARTIFACT_DIRS.build]);
const ANDROID_OUTPUT = new Set(['build', '.gradle']);

function* derivedDataLayout(dir: string): DirReads<boolean> {
  const names = yield* namesIn(dir);
  if (!names.includes('Build') || !(yield* realDirectory(join(dir, 'Build')))) return false;
  const build = yield* namesIn(join(dir, 'Build'));
  if (!build.includes('Products') && !build.includes('Intermediates.noindex')) return false;
  for (const name of names)
    if ((name === 'ModuleCache.noindex' || name === 'Logs') && (yield* realDirectory(join(dir, name)))) return true;
  return false;
}

/**
 * Whether `dir` is laid out like an Xcode DerivedData directory: a `Build/` directory holding `Products` or
 * `Intermediates.noindex`, beside a `ModuleCache.noindex` or `Logs` directory. xcodebuild writes this layout under
 * `-derivedDataPath`, whatever the directory is called.
 */
export function isDerivedDataLayout(dir: string): boolean {
  return readSync(derivedDataLayout(dir));
}

function* cxxDirs(root: string): DirReads<string[]> {
  const android = join(root, 'android');
  const modules = (yield* namesIn(android))
    .filter((name) => !ANDROID_OUTPUT.has(name) && name !== CXX_NAME)
    .map((name) => join(android, name, CXX_NAME));
  const found: string[] = [];
  for (const path of [join(android, CXX_NAME), ...modules]) if (yield* realDirectory(path)) found.push(path);
  return found;
}

function* derivedDataDirs(root: string): DirReads<{ path: string; named: boolean }[]> {
  const found: { path: string; named: boolean }[] = [];
  for (const name of yield* namesIn(root)) {
    if (NOT_SCANNED.has(name)) continue;
    const path = join(root, name);
    if ((yield* realDirectory(path)) && (yield* derivedDataLayout(path)))
      found.push({ path, named: name === DERIVED_DATA_NAME });
  }
  return found;
}

const CARGO_TARGET = 'target';
const EXACT_APP_FILES = ['exact.mjs'];

function* exactTargetDirs(root: string): DirReads<string[]> {
  const names = yield* namesIn(root);
  if (!EXACT_APP_FILES.every((name) => names.includes(name))) return [];
  const path = join(root, CARGO_TARGET);
  return (yield* realDirectory(path)) ? [path] : [];
}

function* discoveredBuildDirsReads(root: string): DirReads<string[]> {
  const cxx = yield* cxxDirs(root);
  const derived = yield* derivedDataDirs(root);
  const cargo = yield* exactTargetDirs(root);
  return [...cxx, ...derived.filter(({ named }) => named).map(({ path }) => path), ...cargo];
}

/**
 * The directories under `root` that hold only what a build regenerates and that the fixed `ARTIFACT_DIRS.build` names
 * cannot list: the Android CMake directories `android/.cxx` and `android/<module>/.cxx`, a `.dd` directory laid
 * out as DerivedData, and an Exact app's Cargo `target/` (beside its `exact.mjs`). A `.dd` that is not
 * laid out as DerivedData is not one, nor is a `target/` anywhere else.
 */
export function discoveredBuildDirs(root: string): string[] {
  return readSync(discoveredBuildDirsReads(root));
}

/** `discoveredBuildDirs` without blocking the event loop. */
export function discoveredBuildDirsAsync(root: string): Promise<string[]> {
  return readAsync(discoveredBuildDirsReads(root));
}

function* existingBuildDirsReads(root: string): DirReads<string[]> {
  const fixed = yield* existingDirsReads(root, ARTIFACT_DIRS.build);
  return [...fixed, ...(yield* discoveredBuildDirsReads(root))];
}

/** Every existing regenerable build directory under `root`: the fixed names and the discovered ones. */
export function existingBuildDirsAsync(root: string): Promise<string[]> {
  return readAsync(existingBuildDirsReads(root));
}

/**
 * The xcodebuild output directly under `root` that is laid out as DerivedData under a name other than `.dd`, such as
 * a rn-tester `build-device`. The project chose the name and what else uses it, so Stim reports it and never deletes it.
 */
export function xcodebuildOutputDirs(root: string): string[] {
  return readSync(derivedDataDirs(root))
    .filter(({ named }) => !named)
    .map(({ path }) => path);
}

/** Whether `path` is a directory that `existingBuildDirsAsync` lists for the checkout or app containing it. */
export function isBuildDirPath(path: string): boolean {
  if (ARTIFACT_DIRS.build.some((dir) => path.endsWith(`${sep}${dir.split('/').join(sep)}`))) return true;
  const name = basename(path);
  if (name === CXX_NAME) {
    const parent = dirname(path);
    return basename(parent) === 'android' || basename(dirname(parent)) === 'android';
  }
  if (name === CARGO_TARGET) return readSync(exactTargetDirs(dirname(path))).includes(path);
  return name === DERIVED_DATA_NAME && isDerivedDataLayout(path);
}

/**
 * Why `path`, inside the checkout at `root`, must not be deleted as a regenerable directory, or null when it is a real
 * directory inside `root` whose every file git ignores and, for an Exact app's `target/`, no other process runs from or
 * works in that app: Exact's own commands (web, Android, tests) build into the same directory without Stim seeing them.
 * Where the processes cannot be listed (Windows), that `target/` is kept.
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
  const tracked = await gitQuietAsync(root, ['ls-files', '--', rel], {
    signal,
  });
  if (tracked === null) return 'git cannot tell whether it holds tracked files';
  if (tracked.trim()) return 'it holds files git tracks';
  const unignored = await gitQuietAsync(root, ['ls-files', '--others', '--exclude-standard', '--', rel], { signal });
  if (unignored === null) return 'git cannot tell whether it ignores every file in it';
  if (unignored.trim()) return 'it holds files git does not ignore';
  if (basename(path) === CARGO_TARGET && (await readAsync(exactTargetDirs(dirname(path)))).includes(path)) {
    const others = await othersRunningAsync(await readRunningProcessesAsync(signal), signal);
    const running = runningFromReason(dirname(path), others);
    if (running) return `its app may be in use: ${running.replace(/ it\b/, ' its app')}`;
  }
  return null;
}
