import { randomUUID } from 'node:crypto';
import { constants, copyFileSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { ensurePrivateDir, quotedPath, withDirLock } from '@stim-cli/core';
import {
  dependencyInstallFile,
  readDependencyInstall,
  worktreeArchiveRoot,
  type DependencyEdits,
  type DependencyEditsStatus,
  type DependencyInstallRecord,
  type PressureLevel,
} from '@stim-cli/core/state';
import { canonicalPath } from '../commands/gc/paths.ts';
import { treeSignature } from '../private-size.ts';
import { worktreeArchiveBytes, worktreeArchiveLimits } from '../archive.ts';
import { readVolumeSpaceAsync } from '../stimd/passes/budget.ts';
import { ARTIFACT_DIRS, existingDirsOf } from './regenerable-dirs.ts';
import { safeName, stamp } from './worktree-archive.ts';

/**
 * How long after an install stamp Stim did not write itself a file still counts as the install's own output: a root
 * `postinstall` (patch-package, a codegen step) writes into node_modules after the package manager's stamp.
 */
export const INSTALL_GRACE_MS: number = 10 * 60_000;
/** Changed files listed before a walk stops listing; a folder with more is kept even at critical. */
const LISTED_EDITS = 1000;
/** The most changed bytes saved before a folder is deleted at critical; a folder with more is kept. */
const SAVE_CAP_BYTES: number = 64 * 1024 ** 2;
const SHOWN = 3;
const WALK_ENTRIES = 2_000_000;
const YIELD_EVERY = 256;

type TreeKind = 'node_modules' | 'Pods';

const STAMPS: Record<TreeKind, readonly string[]> = {
  node_modules: ['.modules.yaml', '.package-lock.json', '.yarn-state.yml', '.yarn-integrity'],
  Pods: ['Manifest.lock'],
};

function kindOf(tree: string): TreeKind {
  return basename(tree) === 'Pods' ? 'Pods' : 'node_modules';
}

const GRADLE_SCRIPTS = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'];
const GRADLE_OUTPUT = ['build', '.gradle', '.kotlin', '.cxx'];

// @ref LLP 0002#edits-inside-dependency-folders -- what tools write inside a dependency folder is not an edit
/**
 * Whether the file or directory at `segments`, relative to a dependency tree of `kind` and beside `siblings`, holds
 * what package managers and native builds write there after an install rather than an edit: the package manager's own
 * state at the tree's root, `node_modules/.cache`, the output Gradle and CMake write beside a Gradle build script or
 * in a package's `android` directory, a package's `ios/build`, and Xcode's per-user data in Pods.
 */
function excludedFromEdits(
  kind: TreeKind,
  segments: readonly string[],
  directory: boolean,
  siblings: readonly string[] = [],
): boolean {
  const name = segments.at(-1) ?? '';
  const parent = segments.at(-2);
  if (!directory) {
    if (segments.length === 1)
      return (
        STAMPS[kind].includes(name) ||
        (kind === 'node_modules' && name.startsWith('.pnpm-workspace-state') && name.endsWith('.json'))
      );
    return kind === 'node_modules' && segments.length === 2 && segments[0] === '.pnpm' && name === 'lock.yaml';
  }
  if (kind === 'Pods') return name === 'xcuserdata';
  if (segments.length === 1 && name === '.cache') return true;
  if (parent === 'ios' && name === 'build') return true;
  return (
    GRADLE_OUTPUT.includes(name) &&
    (parent === 'android' || siblings.some((sibling) => GRADLE_SCRIPTS.includes(sibling)))
  );
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

interface EditScan {
  files: { rel: string; bytes: number }[];
  /** False when the listing stopped at LISTED_EDITS. */
  complete: boolean;
  bytes: number;
}

/**
 * The files under `tree` modified after `since`, outside `excludedFromEdits`, from metadata alone: no file is read.
 * A problem instead when the tree cannot be fully listed.
 */
async function scanEdits(
  tree: string,
  since: number,
  signal?: AbortSignal,
): Promise<EditScan | { problem: string }> {
  const kind = kindOf(tree);
  const files: EditScan['files'] = [];
  let bytes = 0;
  let entries = 0;
  let directories = 0;
  const pending: string[][] = [[]];
  for (let segments = pending.pop(); segments; segments = pending.pop()) {
    if (++directories % YIELD_EVERY === 0) {
      await nextTurn();
      signal?.throwIfAborted();
    }
    let names;
    try {
      names = readdirSync(join(tree, ...segments), { withFileTypes: true });
    } catch (error) {
      if (segments.length && isMissing(error)) continue;
      return { problem: `${join(tree, ...segments)} cannot be listed` };
    }
    const siblings = names.map(({ name }) => name);
    for (const entry of names) {
      if (++entries > WALK_ENTRIES) return { problem: `it holds more than ${WALK_ENTRIES} entries to check` };
      const path = [...segments, entry.name];
      if (entry.isDirectory()) {
        if (!excludedFromEdits(kind, path, true, siblings)) pending.push(path);
        continue;
      }
      if (!entry.isFile() || excludedFromEdits(kind, path, false)) continue;
      let stat;
      try {
        stat = lstatSync(join(tree, ...path));
      } catch (error) {
        if (isMissing(error)) continue;
        return { problem: `${join(tree, ...path)} cannot be read` };
      }
      if (stat.mtimeMs <= since) continue;
      if (files.length === LISTED_EDITS) return { files, complete: false, bytes };
      files.push({ rel: path.join('/'), bytes: stat.size });
      bytes += stat.size;
    }
  }
  return { files: files.toSorted((a, b) => a.rel.localeCompare(b.rel)), complete: true, bytes };
}

/**
 * The time a file in a dependency tree must be newer than to count as an edit: when the install or warm copy Stim ran
 * there finished, unless an install stamp is newer, then that stamp plus INSTALL_GRACE_MS. Null when there is neither.
 */
function editReference(recorded: number | null, stampedAt: number | null): number | null {
  if (recorded !== null && (stampedAt === null || recorded >= stampedAt)) return recorded;
  return stampedAt === null ? null : stampedAt + INSTALL_GRACE_MS;
}

function newestStamp(tree: string): number | null {
  let newest: number | null = null;
  for (const name of STAMPS[kindOf(tree)]) {
    try {
      const { mtimeMs } = lstatSync(join(tree, name));
      newest = Math.max(newest ?? 0, mtimeMs);
    } catch {}
  }
  return newest;
}

function mtimeOf(path: string): number | null {
  try {
    return lstatSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The install evidence that covers `tree`: its own record and stamp, or for a node_modules with neither, those of the
 * nearest node_modules above it inside `worktree`, since a workspace install (pnpm, Yarn, npm) writes a package's
 * node_modules without a stamp of its own. A node_modules no stamp covers (Bun writes none) falls back to the newest
 * of its own and its `.bin` directory's modification times, which an install changes when it links packages.
 */
function installEvidence(tree: string, worktree: string): { recorded: number | null; stampedAt: number | null } {
  const root = canonicalOr(worktree);
  if (kindOf(tree) === 'Pods')
    return { recorded: readDependencyInstall(tree)?.installedAt ?? null, stampedAt: newestStamp(tree) };
  for (let current = tree; ;) {
    const recorded = readDependencyInstall(current)?.installedAt ?? null;
    const stampedAt = newestStamp(current);
    if (recorded !== null || stampedAt !== null) return { recorded, stampedAt };
    const parent = dirname(dirname(current));
    if (parent === dirname(current) || !(parent === root || parent.startsWith(`${root}${sep}`))) break;
    current = join(parent, 'node_modules');
  }
  const linked = [mtimeOf(tree), mtimeOf(join(tree, '.bin'))].filter((at): at is number => at !== null);
  return { recorded: null, stampedAt: linked.length ? Math.max(...linked) : null };
}

function canonicalOr(path: string): string {
  try {
    return canonicalPath(path);
  } catch {
    return path;
  }
}

function updateRecord(tree: string, update: (record: DependencyInstallRecord) => DependencyInstallRecord): void {
  const file = dependencyInstallFile(tree);
  ensurePrivateDir(dirname(file));
  withDirLock(`${file}.lock`, () => {
    const next = update(readDependencyInstall(tree) ?? { tree, installedAt: null, edits: null });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  });
}

/**
 * Records that an install or warm copy Stim ran into each of `trees` finished now, after every script it ran, so later
 * writes into the tree count as edits. Best effort: a failure leaves the install stamp as the reference.
 */
export function recordDependencyInstall(trees: readonly string[], at: number = Date.now()): void {
  for (const path of trees) {
    try {
      lstatSync(path);
      const tree = canonicalPath(path);
      updateRecord(tree, (record) => ({ ...record, installedAt: at, edits: null }));
    } catch {}
  }
}

/** Forgets what Stim recorded about `tree` once it is deleted. */
export function forgetDependencyInstall(path: string): void {
  try {
    rmSync(dependencyInstallFile(canonicalOr(path)), { force: true });
  } catch {}
}

function countText(edits: Pick<DependencyEdits, 'count' | 'complete'>): string {
  return `${edits.complete ? '' : 'at least '}${edits.count} file${edits.count === 1 && edits.complete ? '' : 's'}`;
}

/** Why maintenance keeps a dependency tree whose files changed after its install. */
export function editsKeptReason(edits: Pick<DependencyEdits, 'count' | 'complete' | 'files'>): string {
  const shown = edits.files.slice(0, SHOWN).join(', ');
  const more = edits.count > SHOWN || !edits.complete ? ', ...' : '';
  return `${countText(edits)} in it changed after its install (${shown}${more}), so maintenance keeps it until critical pressure; make the change a patch (pnpm patch, yarn patch or patch-package) so a reinstall keeps it`;
}

export interface SavedEdits {
  dir: string;
  files: string[];
  restore: string;
}

/** `edited` when the keep is for changed files rather than a tree that could not be checked. */
export type EditCheck = { keep: string; edited?: true } | { delete: true; note?: string; saved?: SavedEdits };

/**
 * What deleting a dependency tree at `level` does with files changed after its install: below critical, any keeps it;
 * at critical they are saved first, and a tree whose changes cannot all be saved is kept. A tree that cannot be checked
 * is kept below critical and deleted at critical with a note, so it never blocks freeing disk there.
 */
function decideEdits(
  scan: EditScan | { problem: string },
  level: PressureLevel,
): { keep: string; edited?: true } | { delete: true; note?: string } | { save: EditScan } {
  if ('problem' in scan)
    return level === 'critical'
      ? { delete: true, note: `its files were not checked for edits: ${scan.problem}` }
      : { keep: `its files cannot be checked for edits: ${scan.problem}` };
  if (!scan.files.length) return { delete: true };
  const edits = { count: scan.files.length, complete: scan.complete, files: scan.files.map(({ rel }) => rel) };
  if (level !== 'critical') return { keep: editsKeptReason(edits), edited: true };
  if (!scan.complete || scan.bytes > SAVE_CAP_BYTES)
    return {
      edited: true,
      keep: `${countText(edits)} in it changed after its install, more than the ${SAVE_CAP_BYTES / 1024 ** 2} MB maintenance saves before deleting, so it stays even at critical pressure (${edits.files.slice(0, SHOWN).join(', ')}, ...)`,
    };
  return { save: scan };
}

async function saveEdits(
  tree: string,
  worktree: string,
  scan: EditScan,
  level: PressureLevel,
  signal?: AbortSignal,
): Promise<SavedEdits> {
  const limits = worktreeArchiveLimits(worktree);
  if ('refusal' in limits) throw new Error(limits.refusal);
  if ((await worktreeArchiveBytes(signal)) + scan.bytes > limits.maxBytes)
    throw new Error('they do not fit in archive.maxTotalGb beside the other archives');
  const [volume] = await readVolumeSpaceAsync([dirname(worktreeArchiveRoot())], signal);
  if (!volume || volume.freeMb * 1024 ** 2 < 2 * scan.bytes + 64 * 1024 ** 2)
    throw new Error('there is no free disk to copy them to');
  const at = Date.now();
  const label = relative(worktree, tree).split(sep).join('-') || basename(tree);
  const dir = join(
    worktreeArchiveRoot(),
    safeName(basename(worktree)),
    `${safeName(label)}-edits-${stamp(at)}-${randomUUID().slice(0, 8)}`,
  );
  const target = join(dir, 'files');
  try {
    ensurePrivateDir(dir);
    for (const { rel, bytes } of scan.files) {
      const to = join(target, ...rel.split('/'));
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      copyFileSync(join(tree, ...rel.split('/')), to, constants.COPYFILE_FICLONE);
      if (lstatSync(to).size !== bytes) throw new Error(`${rel} changed while it was copied`);
    }
    const restore = `cp -Rp ${quotedPath(`${target}/.`)} ${quotedPath(tree)}`;
    const manifest = {
      version: 1,
      kind: 'dependency-edits',
      createdAt: new Date(at).toISOString(),
      source: tree,
      worktree,
      pressure: level,
      files: scan.files.map(({ rel }) => rel),
      restore: [restore],
    };
    const tmp = join(dir, '.manifest.json.tmp');
    writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, join(dir, 'manifest.json'));
    return { dir, files: manifest.files, restore };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * The edit check a dependency tree passes before it is deleted at `level`: the files changed after its reference, read
 * from metadata alone. A tree kept for edits is not walked again until its install signature changes, except at
 * critical. With `dryRun` nothing is saved.
 */
export async function checkDependencyEdits(
  path: string,
  {
    level,
    worktree,
    dryRun = false,
    signal,
  }: { level: PressureLevel; worktree: string; dryRun?: boolean; signal?: AbortSignal },
): Promise<EditCheck> {
  const tree = canonicalOr(path);
  const record = readDependencyInstall(tree);
  const signature = treeSignature(tree);
  if (level !== 'critical' && record?.edits && signature !== null && record.edits.signature === signature)
    return { keep: editsKeptReason(record.edits), edited: true };
  const evidence = installEvidence(tree, worktree);
  const since = editReference(evidence.recorded, evidence.stampedAt);
  const scan =
    since === null
      ? { problem: 'it has no install stamp to compare its files with' }
      : await scanEdits(tree, since, signal);
  const decision = decideEdits(scan, level);
  if (signature !== null && !('problem' in scan)) {
    const edits = scan.files.length
      ? { count: scan.files.length, complete: scan.complete, files: scan.files.slice(0, SHOWN).map(({ rel }) => rel) }
      : null;
    if (edits || record?.edits)
      try {
        updateRecord(tree, (current) => ({
          ...current,
          edits: edits ? { signature, ...edits, at: new Date().toISOString() } : null,
        }));
      } catch {}
  }
  if (!('save' in decision)) return decision;
  if (dryRun)
    return {
      delete: true,
      note: `it would first save ${countText({ count: decision.save.files.length, complete: true })} changed after its install`,
    };
  try {
    const saved = await saveEdits(tree, worktree, decision.save, level, signal);
    return { delete: true, saved };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      edited: true,
      keep: `${countText({ count: decision.save.files.length, complete: true })} in it changed after its install and could not be saved: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** The detail of a deletion that saved changed files first: where they are and how to put them back. */
export function savedEditsDetail(saved: SavedEdits): string {
  return `saved ${saved.files.length} file${saved.files.length === 1 ? '' : 's'} changed after its install to ${saved.dir}; after reinstalling, put them back with ${saved.restore}`;
}

function dependencyTreesOf(worktree: string, bases: readonly string[]): string[] {
  const root = canonicalOr(worktree);
  const trees = new Set<string>();
  for (const base of new Set([worktree, ...bases]))
    for (const path of existingDirsOf(base, ARTIFACT_DIRS.dependencies)) {
      const tree = canonicalOr(path);
      if (tree.startsWith(`${root}${sep}`)) trees.add(tree);
    }
  return [...trees];
}

/**
 * Before a whole worktree is removed: saves the files changed after the install in each of its dependency trees, as
 * critical pressure does, or the reason the removal must stop because one tree's changes cannot be saved.
 */
export async function saveEditsBeforeRemoval(
  worktree: string,
  keys: readonly string[],
  signal?: AbortSignal,
): Promise<{ saved: SavedEdits[] } | { kept: string }> {
  const saved: SavedEdits[] = [];
  for (const tree of dependencyTreesOf(worktree, keys)) {
    const check = await checkDependencyEdits(tree, { level: 'critical', worktree, signal });
    if ('keep' in check) return { kept: `${relative(worktree, tree)}: ${check.keep}` };
    if (check.saved) saved.push(check.saved);
  }
  return { saved };
}

/** The dependency trees of `worktree` and the workspaces `keys` holding files changed after the install, with why they stay. */
export async function editedDependencyTrees(
  worktree: string,
  keys: readonly string[],
  signal?: AbortSignal,
): Promise<{ tree: string; reason: string; edited: boolean }[]> {
  const found: { tree: string; reason: string; edited: boolean }[] = [];
  for (const tree of dependencyTreesOf(worktree, keys)) {
    const check = await checkDependencyEdits(tree, { level: 'high', worktree, signal });
    if ('keep' in check) found.push({ tree, reason: check.keep, edited: check.edited === true });
  }
  return found;
}

/** Why a worktree that maintenance would remove keeps a dependency tree with files changed after its install, or null. */
export async function dependencyEditsHold(worktree: string, signal?: AbortSignal): Promise<string | null> {
  const [first] = await editedDependencyTrees(worktree, [], signal);
  return first ? `its ${relative(worktree, first.tree)}: ${first.reason}` : null;
}

/** The trees of the workspace at `root` that maintenance keeps for files changed after the install, as last walked. */
export function keptDependencyEdits(root: string): { dependencyEdits?: DependencyEditsStatus[] } {
  const kept: DependencyEditsStatus[] = [];
  for (const path of existingDirsOf(root, ARTIFACT_DIRS.dependencies)) {
    const tree = canonicalOr(path);
    const edits = readDependencyInstall(tree)?.edits;
    if (!edits || edits.signature !== treeSignature(tree)) continue;
    kept.push({ tree, count: edits.count, complete: edits.complete, files: edits.files, at: edits.at });
  }
  return kept.length ? { dependencyEdits: kept } : {};
}
