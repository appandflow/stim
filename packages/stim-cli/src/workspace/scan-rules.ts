import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { configDir } from '@stim-cli/core';
import { buildWorkerRoot } from '@stim-cli/core/state';
import { canonicalPath } from '../commands/gc/paths.ts';
import { answered, hungRead, Unanswered } from './bounded-read.ts';
import { declaresAppDependency } from './project-files.ts';
import { loadConfig } from './config.ts';

export const MAX_DEPTH = 7;

const within = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}${sep}`);

/** Folders directly in the home folder the scan never reads: system, media and the three the maintainer excluded. */
const HOME_SKIPPED = new Set([
  'Library',
  'Applications',
  'Desktop',
  'Documents',
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
/**
 * Compared case-insensitively on every volume: a case-insensitive one reads `Package.JSON` as `package.json`. On a case-
 * sensitive one detection reads only the exact `package.json`, so this can only reject a folder it could have accepted,
 * except that the Xcode exemption below must hold for every manifest that folds to `package.json`, since which one
 * detection reads depends on the volume.
 */
const DETECTION_FILES = new Set([
  'package.json',
  'settings.gradle',
  'settings.gradle.kts',
  'gradlew',
  'gradlew.bat',
  'package.swift',
  'exact.mjs',
  'app.json',
]);
const PROJECT_FOLDERS = ['apps', 'examples', 'packages'];
const PROJECT_FOLDER_ENTRIES = 50;
const XCODE_CONTAINER = /\.(xcodeproj|xcworkspace)$/i;
/** React Native's owned roots, which detection resolves with `realpath` when it walks up from a native layout. */
const OWNED_ROOTS = new Set(['ios', 'android']);
const folded = (name: string): string => name.toLowerCase();
/** The entry is not there: the only read failure that is not unsafe, and only for an entry a successful listing showed. */
export const absent = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');

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
  /** Metadata reads of a cached entry; `realpath` is the native one, which folds case on macOS. */
  lstat: (path: string) => Promise<{ isSymbolicLink(): boolean }>;
  stat: (path: string) => Promise<{ isDirectory(): boolean; dev: number }>;
  realpath: (path: string) => Promise<string>;
}

export const REAL_RECOGNITION_IO: RecognitionIo = {
  readEntries: (path) => readdir(path, { withFileTypes: true }),
  readText: (path) => readFile(path, 'utf8'),
  lstat: (path) => lstat(path),
  stat: (path) => stat(path),
  realpath: (path) => realpath(path),
};

/**
 * `unsafe`: a structural fact, the folder is not a checkout and there is nothing to record. `denied`: a read failed for a
 * reason that is neither a timeout nor "absent" (EACCES, EPERM, EIO), so the scan could not look, as when a folder's own
 * listing fails: it is recorded unreadable and its finds are kept. `unreadable`: a read timed out or another is pending.
 * `stopped`: the scan's limit ran out.
 */
type Safety = 'safe' | 'unsafe' | 'denied' | 'unreadable' | 'stopped';

/** Asked before every read the gate makes: true when the scan's own limit (abort, time budget, folder cap) has run out. */
type Stop = () => boolean;

/**
 * Whether project detection can read in `folder` without blocking, from the folder's own listing: `unsafe` when a
 * detection file is not a regular file (a FIFO, or a symlink into a stalled mount) or the folder holds an Xcode
 * container with no app dependency, whose project files `containers()` follows by the paths they name; `unreadable`
 * when a read did not answer in time or another read is still pending (`bounded-read.ts`). A regular `package.json`,
 * the one detection file detection reads rather than stats, is read here first through the bounded reader, so an
 * evicted or stalled file is found out before the synchronous read. Detection also inspects every ancestor of a folder,
 * so a folder is recognisable only when this holds for it and for each ancestor from the home folder down, with no
 * condition: the walk and the revalidation both apply it to every folder on the way.
 */
export async function folderSafety(
  folder: string,
  entries: readonly Entry[],
  timeoutMs: number,
  io: RecognitionIo = REAL_RECOGNITION_IO,
  stop?: Stop,
): Promise<Safety> {
  if (hungRead() !== null) return 'unreadable';
  const detection = entries.filter((entry) => DETECTION_FILES.has(folded(entry.name)));
  if (detection.some((entry) => !entry.isFile())) return 'unsafe';
  if (entries.some((entry) => OWNED_ROOTS.has(folded(entry.name)) && !entry.isDirectory())) return 'unsafe';
  const hasContainer = entries.some((entry) => XCODE_CONTAINER.test(entry.name));
  const manifests = detection.filter((entry) => folded(entry.name) === 'package.json');
  if (manifests.length === 0) return hasContainer ? 'unsafe' : 'safe';
  let declares = true;
  for (const manifest of manifests) {
    if (stop?.()) return 'stopped';
    let text: string;
    try {
      text = await answered(folder, () => io.readText(join(folder, manifest.name)), timeoutMs);
    } catch (error) {
      return error instanceof Unanswered ? 'unreadable' : 'denied';
    }
    try {
      declares &&= declaresAppDependency(JSON.parse(text));
    } catch {
      declares = false;
    }
  }
  return hasContainer && !declares ? 'unsafe' : 'safe';
}

/**
 * `folderSafety` for what detection inspects below `folder` itself: each of `apps`, `examples` and `packages` (the
 * container folder, with its own `package.json`) and up to 50 children of each. A symlinked container, or any unsafe or
 * unreadable member, makes the result that. The ancestors of `folder` are the caller's: they have passed `folderSafety`.
 * `stop` is asked before every read, so a scan's budget is honoured between them (`stopped`); revalidation passes none,
 * and is bounded per read and by detection's own caps (50 children per container; the chain is the home folder and up to seven below it).
 */
export async function nestedSafety(
  folder: string,
  entries: readonly Entry[],
  timeoutMs: number,
  io: RecognitionIo = REAL_RECOGNITION_IO,
  stop?: Stop,
): Promise<Safety> {
  /** The listing, or why it cannot be trusted; `stop` is never asked inside it, so an abort is never caught as a read error. */
  const list = async (path: string): Promise<Entry[] | Safety> => {
    try {
      return await answered(path, () => io.readEntries(path), timeoutMs);
    } catch (error) {
      return error instanceof Unanswered ? 'unreadable' : 'denied';
    }
  };
  for (const entry of entries.filter((candidate) => PROJECT_FOLDERS.includes(folded(candidate.name)))) {
    if (entry.isSymbolicLink()) return 'unsafe';
    if (!entry.isDirectory()) continue;
    const container = join(folder, entry.name);
    if (stop?.()) return 'stopped';
    const members = await list(container);
    if (typeof members === 'string') return members;
    const own = await folderSafety(container, members, timeoutMs, io, stop);
    if (own !== 'safe') return own;
    for (const child of members
      .filter((member) => member.isDirectory() && !member.isSymbolicLink())
      .slice(0, PROJECT_FOLDER_ENTRIES)) {
      const path = join(container, child.name);
      if (stop?.()) return 'stopped';
      let inner: Entry[];
      try {
        inner = await answered(path, () => io.readEntries(path), timeoutMs);
      } catch (error) {
        if (error instanceof Unanswered) return 'unreadable';
        if (absent(error)) continue;
        return 'denied';
      }
      const result = await folderSafety(path, inner, timeoutMs, io, stop);
      if (result !== 'safe') return result;
    }
  }
  return 'safe';
}

/** A folder's listing and `folderSafety`, for the chain of folders above a cached entry. */
async function gateOf(
  folder: string,
  timeoutMs: number,
  io: RecognitionIo,
): Promise<{ listing: Entry[]; safety: Safety }> {
  try {
    const listing = await answered(folder, () => io.readEntries(folder), timeoutMs);
    return { listing, safety: await folderSafety(folder, listing, timeoutMs, io) };
  } catch (error) {
    return { listing: [], safety: error instanceof Unanswered ? 'unreadable' : 'denied' };
  }
}

/**
 * Whether a checkout a scan recorded may still be used: it is a real directory (not a symlink), its canonical path is
 * the recorded one, it lies below the home folder on the home volume, no folder between the two is one the scan skips
 * (`scanDescends`, `skip`), every folder from the home folder down to it passes `folderSafety` (memoised in `ancestors`),
 * what it inspects below itself passes `nestedSafety`, and `isCheckout` still recognises it (an `isCheckout` that
 * could not read what decides it is `pending`, like a metadata read that did not answer).
 * `invalid` drops it, such as a checkout moved away with a symlink left behind (a metadata read that fails for any reason
 * but proven absence, ENOENT or ENOTDIR, such as a denied one, is `pending`, never `invalid`); `pending` means a read did not answer,
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
    /** `'unknown'`: a read that decides it failed, so the folder may still be a checkout. */
    isCheckout: (path: string) => boolean | 'unknown';
    skip: (path: string) => boolean;
    timeoutMs?: number;
    io?: RecognitionIo;
    /** The listing and safety of folders on the way to a checkout, shared by the entries of one revalidation. */
    ancestors?: Map<string, Promise<{ listing: Entry[]; safety: Safety }>>;
  },
): Promise<'valid' | 'invalid' | 'pending'> {
  if (hungRead() !== null) return 'pending';
  if (!within(path, home) || path === home || skip(path)) return 'invalid';
  const names = relative(home, path).split(sep);
  if (names.length > MAX_DEPTH || !names.every((name, i) => scanDescends(name, i + 1))) return 'invalid';
  try {
    if ((await answered(path, () => io.lstat(path), timeoutMs)).isSymbolicLink()) return 'invalid';
    const info = await answered(path, () => io.stat(path), timeoutMs);
    if (!info.isDirectory()) return 'invalid';
    if ((await answered(path, () => io.realpath(path), timeoutMs)) !== path) return 'invalid';
    if ((await answered(home, () => io.stat(home), timeoutMs)).dev !== info.dev) return 'invalid';
  } catch (error) {
    return absent(error) ? 'invalid' : 'pending';
  }
  const chain = [
    home,
    ...relative(home, path)
      .split(sep)
      .map((_, i, parts) => join(home, ...parts.slice(0, i + 1))),
  ];
  let own: Entry[] = [];
  for (const folder of chain) {
    let gate = ancestors.get(folder);
    if (!gate) {
      gate = gateOf(folder, timeoutMs, io);
      ancestors.set(folder, gate);
    }
    const { listing, safety } = await gate;
    if (safety !== 'safe') return safety === 'unsafe' ? 'invalid' : 'pending';
    if (folder === path) own = listing;
  }
  const nested = await nestedSafety(path, own, timeoutMs, io);
  if (nested !== 'safe') return nested === 'unsafe' ? 'invalid' : 'pending';
  const recognised = isCheckout(path);
  return recognised === 'unknown' ? 'pending' : recognised ? 'valid' : 'invalid';
}
