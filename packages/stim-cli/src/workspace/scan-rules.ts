import { lstatSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, sep } from 'node:path';
import { configDir } from '@stim-cli/core';
import { buildWorkerRoot } from '@stim-cli/core/state';
import { canonicalPath } from '../commands/gc/paths.ts';
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

/**
 * Whether a checkout a scan recorded may still be used: it is a real directory (not a symlink), its canonical path is
 * the recorded one, it lies below the home folder on the home volume, no folder between the two is one the scan skips
 * (`scanDescends`, `skip`), and `isCheckout` still recognises it. Anything else, such as a checkout moved away with a
 * symlink left behind, is dropped.
 */
export function scanEntryValid(
  path: string,
  { home, isCheckout, skip }: { home: string; isCheckout: (path: string) => boolean; skip: (path: string) => boolean },
): boolean {
  try {
    if (!within(path, home) || path === home || lstatSync(path).isSymbolicLink() || !statSync(path).isDirectory())
      return false;
    if (realpathSync.native(path) !== path || statSync(path).dev !== statSync(home).dev || skip(path)) return false;
    const names = relative(home, path).split(sep);
    if (names.length > MAX_DEPTH) return false;
    return names.every((name, i) => scanDescends(name, i + 1)) && isCheckout(path);
  } catch {
    return false;
  }
}
