import { lstatSync, realpathSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { configDir } from '@stim-cli/core';
import { buildWorkerRoot } from '@stim-cli/core/state';
import { canonicalPath } from '../commands/gc/paths.ts';
import { answered, hungRead, Unanswered } from './bounded-read.ts';
import { declaresAppDependency } from './project-files.ts';
import { loadConfig } from './config.ts';

export const MAX_DEPTH = 7;

const within = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}${sep}`);

/** Folders directly in the home folder the scan never reads: system, media and the two the maintainer excluded. */
const HOME_SKIPPED = new Set([
  'Library',
  'Applications',
  'Desktop',
  'Downloads',
  'Movies',
  'Music',
  'Pictures',
  'Public',
]);

// @ref LLP 0004#tool-folders-and-the-full-scan -- the home dot-folders the scan does not enter
/**
 * Dot-folders directly in the home folder that hold many files and no projects: tool homes, package and build caches,
 * runtimes, editor state and other tools' own state. Counted on one machine (entries to depth four): .gradle 67k,
 * .agent-device 45k, .member-app-metro-cache 25k, .dartwords-metro-cache 17k, .npm 16k, .bun 16k, .rvm 15k, .yarn 15k,
 * .android 7k, .vscode 6k, .cursor 5k, .claude 3k, .cache 2k, .ivy2 2k, .cargo 2k. `.codex` is reached through its
 * worktrees folder. `.volta`, `.asdf`, `.mise`, `.fnm`, `.pyenv`, `.rbenv`, `.sdkman`, `.deno`, `.pub-cache` and `.fvm` are
 * version managers and package caches whose installs hold thousands of files and no checkouts of the user's. Every other home dot-folder is entered, such as `.exact`, except those starting with `.stim`: the
 * Stim home and every other Stim state folder (`.stim-agent`, `.stim-release`, `.stim-npm`) hold no checkouts the user owns,
 * and the build worker's client checkouts must never become reduce-only.
 */
const HOME_DOT_PRUNED = new Set([
  '.git',
  '.Trash',
  '.codex',
  '.claude',
  '.gradle',
  '.agent-device',
  '.npm',
  '.pnpm-store',
  '.yarn',
  '.bun',
  '.cargo',
  '.rustup',
  '.nvm',
  '.rvm',
  '.cache',
  '.android',
  '.cocoapods',
  '.vscode',
  '.cursor',
  '.antigravity',
  '.local',
  '.config',
  '.docker',
  '.m2',
  '.ivy2',
  '.gem',
  '.expo',
  '.zplug',
  '.virtualenvs',
  '.wrangler',
  '.foundry',
  '.pw-profiles',
  '.swiftpm',
  '.volta',
  '.asdf',
  '.mise',
  '.fnm',
  '.pyenv',
  '.rbenv',
  '.sdkman',
  '.deno',
  '.pub-cache',
  '.fvm',
]);

/** Folders at any depth that hold many files and no projects: dependencies, build output and tool caches. */
const PRUNED = new Set([
  'node_modules',
  'Pods',
  'Carthage',
  'build',
  'dist',
  'out',
  'target',
  'vendor',
  'DerivedData',
  'venv',
  '__pycache__',
  'site-packages',
  'coverage',
  'Library',
]);

// @ref LLP 0004#tool-folders-and-the-full-scan -- what the scan prunes
/**
 * Whether the scan descends into a folder named `name`, `depth` levels below the home folder (1 is a child of it).
 * Dot-folders are entered only directly in the home folder and not when they are in `HOME_DOT_PRUNED` or named like a
 * cache; deeper ones, such as `.worktrees`, are skipped because git reaches their worktrees.
 */
export function scanDescends(name: string, depth: number): boolean {
  if (name.startsWith('.'))
    return depth === 1 && !name.startsWith('.stim') && !HOME_DOT_PRUNED.has(name) && !name.endsWith('-cache');
  if (PRUNED.has(name)) return false;
  return depth !== 1 || !HOME_SKIPPED.has(name);
}

/**
 * The paths the scan never enters, by rule: the Stim home, the build worker root, and the system temporary directory
 * unless the home folder itself is under it. Computed once, with no per-folder realpath: the walk never follows a
 * symlink, so a path below the canonical home is already canonical.
 */
export function scanSkipper(home: string): (path: string) => boolean {
  const stim = [canonicalPath(configDir()), canonicalPath(buildWorkerRoot(loadConfig()))];
  const temps = [tmpdir(), '/tmp', '/var/tmp', '/var/folders'].map(canonicalPath);
  const homeIsTemporary = temps.some((temp) => within(home, temp));
  return (path) =>
    stim.some((folder) => within(path, folder)) || (!homeIsTemporary && temps.some((temp) => within(path, temp)));
}

/** The files of a folder that project detection reads or stats: the manifests every integration's `inspect` looks at. */
const DETECTION_FILES = new Set([
  'package.json',
  'settings.gradle',
  'settings.gradle.kts',
  'gradlew',
  'gradlew.bat',
  'Package.swift',
  'exact.mjs',
  'app.json',
]);
const PROJECT_FOLDERS = ['apps', 'examples', 'packages'];
const PROJECT_FOLDER_ENTRIES = 50;
const XCODE_CONTAINER = /\.(xcodeproj|xcworkspace)$/;

interface Entry {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** How the recognition gate reads the disk; injected by tests. */
export interface RecognitionIo {
  readEntries: (path: string) => Promise<Entry[]>;
  readText: (path: string) => Promise<string>;
}

export const REAL_RECOGNITION_IO: RecognitionIo = {
  readEntries: (path) => readdir(path, { withFileTypes: true }),
  readText: (path) => readFile(path, 'utf8'),
};

/**
 * Whether `recognises` can be called on `folder` without a read that could block: `safe`; `unsafe` when it could (a
 * detection file that is not a regular file, such as a FIFO or a symlink into a stalled mount, or an Xcode container,
 * whose project files `containers()` follows by the paths they name), so the folder is not treated as a checkout;
 * `unreadable` when a read did not answer in time, or another read is still pending (`bounded-read.ts`). `entries` is
 * the folder's listing. A regular `package.json`, the one detection file project detection reads rather than stats, is
 * read here first through the bounded reader, so an evicted or stalled file is found out before the synchronous read.
 * `apps`, `examples` and `packages` children are checked the same way, because `recognises` looks inside them.
 */
export async function recognitionReads(
  folder: string,
  entries: readonly Entry[],
  timeoutMs: number,
  io: RecognitionIo = REAL_RECOGNITION_IO,
  nested = true,
): Promise<'safe' | 'unsafe' | 'unreadable'> {
  if (hungRead() !== null) return 'unreadable';
  const detection = entries.filter((entry) => DETECTION_FILES.has(entry.name));
  if (detection.some((entry) => !entry.isFile())) return 'unsafe';
  const hasContainer = entries.some((entry) => XCODE_CONTAINER.test(entry.name));
  try {
    if (detection.some((entry) => entry.name === 'package.json')) {
      const text = await answered(folder, () => io.readText(join(folder, 'package.json')), timeoutMs);
      let declares = false;
      try {
        declares = declaresAppDependency(JSON.parse(text));
      } catch {}
      if (hasContainer && !declares) return 'unsafe';
    } else if (hasContainer) return 'unsafe';
    if (!nested) return 'safe';
    for (const name of PROJECT_FOLDERS) {
      const entry = entries.find((candidate) => candidate.name === name);
      if (!entry) continue;
      if (entry.isSymbolicLink()) return 'unsafe';
      if (!entry.isDirectory()) continue;
      const children = (await answered(folder, () => io.readEntries(join(folder, name)), timeoutMs))
        .filter((child) => child.isDirectory() && !child.isSymbolicLink())
        .slice(0, PROJECT_FOLDER_ENTRIES);
      for (const child of children) {
        const path = join(folder, name, child.name);
        const inner = await answered(folder, () => io.readEntries(path), timeoutMs).catch((error: unknown) => {
          if (error instanceof Unanswered) throw error;
          return null;
        });
        if (inner === null) continue;
        const result = await recognitionReads(path, inner, timeoutMs, io, false);
        if (result !== 'safe') return result;
      }
    }
    return 'safe';
  } catch (error) {
    if (error instanceof Unanswered) return 'unreadable';
    return 'unsafe';
  }
}

/** Whether detection in `entries`' folder walks up the ancestors: a native Android layout is a candidate root. */
export const needsAncestors = (entries: readonly Entry[]): boolean =>
  entries.some((entry) => entry.name === 'settings.gradle' || entry.name === 'settings.gradle.kts');

/**
 * Whether a checkout a scan recorded may still be used: it is a real directory (not a symlink), its canonical path is
 * the recorded one, it lies below the home folder on the home volume, no folder between the two is one the scan skips
 * (`scanDescends`, `skip`), its detection reads are bounded (`recognitionReads`) and `isCheckout` still recognises it.
 * `invalid` drops it, such as a checkout moved away with a symlink left behind; `pending` means a read did not answer,
 * so it is not selected this time and stays in the scan file.
 */
export async function scanEntryValid(
  path: string,
  {
    home,
    isCheckout,
    skip,
    timeoutMs = 3000,
    io = REAL_RECOGNITION_IO,
    ancestors = new Map(),
  }: {
    home: string;
    isCheckout: (path: string) => boolean;
    skip: (path: string) => boolean;
    timeoutMs?: number;
    io?: RecognitionIo;
    /** The gate results of folders above checkouts, shared by the entries of one revalidation. */
    ancestors?: Map<string, Promise<'safe' | 'unsafe' | 'unreadable'>>;
  },
): Promise<'valid' | 'invalid' | 'pending'> {
  try {
    if (!within(path, home) || path === home || lstatSync(path).isSymbolicLink() || !statSync(path).isDirectory())
      return 'invalid';
    if (realpathSync.native(path) !== path || statSync(path).dev !== statSync(home).dev || skip(path)) return 'invalid';
    const names = relative(home, path).split(sep);
    if (names.length > MAX_DEPTH || !names.every((name, i) => scanDescends(name, i + 1))) return 'invalid';
  } catch {
    return 'invalid';
  }
  if (hungRead() !== null) return 'pending';
  let entries: Entry[];
  try {
    entries = await answered(path, () => io.readEntries(path), timeoutMs);
  } catch (error) {
    return error instanceof Unanswered ? 'pending' : 'invalid';
  }
  const reads = await recognitionReads(path, entries, timeoutMs, io);
  if (reads === 'unreadable') return 'pending';
  if (reads !== 'safe') return 'invalid';
  if (needsAncestors(entries)) {
    const above = [
      home,
      ...relative(home, dirname(path))
        .split(sep)
        .filter(Boolean)
        .map((_, i, names) => join(home, ...names.slice(0, i + 1))),
    ];
    for (const folder of above) {
      let result = ancestors.get(folder);
      if (!result) {
        result = answered(folder, () => io.readEntries(folder), timeoutMs).then(
          (listing) => recognitionReads(folder, listing, timeoutMs, io, false),
          (error: unknown) => (error instanceof Unanswered ? ('unreadable' as const) : ('unsafe' as const)),
        );
        ancestors.set(folder, result);
      }
      const gate = await result;
      if (gate === 'unreadable') return 'pending';
      if (gate === 'unsafe') return 'invalid';
    }
  }
  return isCheckout(path) ? 'valid' : 'invalid';
}
