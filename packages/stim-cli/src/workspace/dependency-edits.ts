import { randomUUID } from 'node:crypto';
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { ensurePrivateDir, quotedPath } from '@stim-cli/core';
import {
  readDependencyInstall,
  readJsonObject,
  worktreeArchiveRoot,
  type DependencyEditFile,
  type DependencyEditsSavedStatus,
  type DependencyEditsStatus,
  type DependencyInstallRecord,
  type DependencySavedEdits,
  type PressureLevel,
} from '@stim-cli/core/state';
import { canonicalPath } from '../commands/gc/paths.ts';
import { treeSignature } from '../private-size.ts';
import { worktreeArchiveBytes, worktreeArchiveLimits } from '../archive.ts';
import { readVolumeSpaceAsync } from '../stimd/passes/budget.ts';
import { gitQuietAsync } from './git.ts';
import { updateDependencyInstall as updateRecord } from './dependency-install-records.ts';
import { ARTIFACT_DIRS, existingDirsOf } from './regenerable-dirs.ts';
import { safeName, stamp } from './worktree-archive.ts';

/**
 * How long after a package manager's stamp the root project's own install-time script (`preinstall`, `install`,
 * `postinstall`, `prepare`) may still write into node_modules; applied only when the root `package.json` declares one.
 */
const SCRIPT_GRACE_MS = 10 * 60_000;
/** `pod install` writes the Pods project and xcconfigs up to 2 s after `Manifest.lock` (measured on an Expo app). */
const POD_GRACE_MS = 60_000;
/**
 * A tree no stamp covers takes its reference from its own directory's modification time, which an install changes
 * when it links a package but before it writes that package's files: changes in the minute after it do not keep the
 * tree, and are saved at critical.
 */
const LINKED_GRACE_MS = 60_000;
/**
 * How long after a package's `package.json` was created an install still writes that package's files: 0.5 s at most
 * measured with npm, pnpm, Yarn and Bun, esbuild's postinstall included, and 1 ms for a pod. A later change inside a
 * package added since the previous reference is an edit.
 */
const PACKAGE_WRITE_MS = 5_000;
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];
/** Changed files listed before a walk stops listing; a tree with more is kept even at critical. */
const LISTED_EDITS = 1000;
/** The most changed bytes saved before a tree is deleted at critical; a tree with more is kept. */
const SAVE_CAP_BYTES = 64 * 1024 ** 2;
const SHOWN = 3;
const WALK_ENTRIES = 2_000_000;
const YIELD_EVERY = 256;

type TreeKind = 'node_modules' | 'Pods';

const STAMPS: Record<TreeKind, readonly string[]> = {
  node_modules: ['.modules.yaml', '.package-lock.json', '.yarn-state.yml', '.yarn-integrity'],
  Pods: ['Manifest.lock'],
};

/** What `pod install` generates afresh for every pod, rather than a pod's own sources. */
const POD_GENERATED = ['Pods.xcodeproj', 'Target Support Files', 'Headers', 'Local Podspecs'];
/** The dot-directories at a node_modules root that hold packages; every other one is a tool's cache (`.cache`, `.vite`). */
const TREE_DOT_DIRS = ['.pnpm', '.bun', '.deno', '.bin'];
const GRADLE_SCRIPTS = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'];
/** What Gradle writes inside its `build` directory; a JS `build` directory holds none of them. */
const GRADLE_BUILD_ENTRIES = ['intermediates', 'generated', 'outputs', 'tmp', '.transforms', 'kotlin', 'classes'];
const PACKAGE_ENTRY_FIELDS = ['main', 'module', 'types', 'typings', 'react-native', 'browser', 'source'];

function kindOf(tree: string): TreeKind {
  return basename(tree) === 'Pods' ? 'Pods' : 'node_modules';
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function canonicalOr(path: string): string {
  try {
    return canonicalPath(path);
  } catch {
    return path;
  }
}

/** Every string a package.json's entry fields and exports point at. */
function packageTargets(json: unknown): string[] {
  if (typeof json === 'string') return [json];
  if (Array.isArray(json)) return json.flatMap(packageTargets);
  if (json && typeof json === 'object') return Object.values(json).flatMap(packageTargets);
  return [];
}

/**
 * Whether `dir`, a `build` directory beside a Gradle build script or in an `android` directory, is Gradle's output:
 * it holds an entry Gradle writes there, and the package's own package.json at `packageRoot` points nothing into it.
 */
function gradleBuildDir(dir: string, packageRoot: string | null): boolean {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  if (!names.some((name) => GRADLE_BUILD_ENTRIES.includes(name))) return false;
  if (!packageRoot) return true;
  const json = readJsonObject(join(packageRoot, 'package.json'));
  const targets = [...PACKAGE_ENTRY_FIELDS.map((field) => json?.[field]), json?.exports].flatMap(packageTargets);
  const rel = relative(packageRoot, dir).split(sep).join('/');
  return !targets.some((target) => {
    const path = target.replace(/^\.\//, '');
    return path === rel || path.startsWith(`${rel}/`);
  });
}

// @ref LLP 0002#edits-inside-dependency-folders -- what tools write inside a dependency folder is not an edit
/**
 * Whether the entry at `segments`, relative to a dependency tree of `kind`, holds what package managers and native
 * builds write after an install rather than an edit. Directories: `node_modules/.cache`; `.gradle`, `.kotlin` and
 * `.cxx` in a package's `android` directory or beside a Gradle build script, and `build` there when Gradle wrote it;
 * a package's `ios/build`; `xcuserdata` in Pods. Files: the package manager's own state at the tree's root.
 */
function excludedFromEdits(
  kind: TreeKind,
  segments: readonly string[],
  directory: boolean,
  siblings: readonly string[],
  isGradleBuild: () => boolean,
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
  if (segments.length === 1 && name.startsWith('.') && !TREE_DOT_DIRS.includes(name)) return true;
  if (parent === 'ios' && name === 'build') return true;
  const gradleSide = parent === 'android' || siblings.some((sibling) => GRADLE_SCRIPTS.includes(sibling));
  if (!gradleSide) return false;
  if (name === '.gradle' || name === '.kotlin' || name === '.cxx') return true;
  return name === 'build' && isGradleBuild();
}

function bornAt(stat: Stats): number {
  return stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs;
}

function byPath(a: DependencyEditFile, b: DependencyEditFile): number {
  return a.rel.localeCompare(b.rel);
}

interface Scan {
  /** Files changed after the reference and outside the script grace window. */
  edits: DependencyEditFile[];
  /** Files changed inside the script grace window, saved at critical but not kept for. */
  grace: DependencyEditFile[];
  /** False when the listing stopped at LISTED_EDITS. */
  complete: boolean;
}

interface ScanWindow {
  /** Files changed after it are candidates. */
  since: number;
  /** Files changed after it are edits; between `since` and it, install-script output. */
  graceEnd: number;
  /** Install-script output changed after it is saved at critical. */
  saveFrom: number;
  /**
   * The reference before an install Stim did not run moved it: a file changed after it is still an edit when its
   * package (node_modules) or pod (Pods) was not reinstalled since, which a new package.json or pod directory shows.
   */
  before: number | null;
  /**
   * For a tree with no record yet: when its stamp file was created (an install rewrites a stamp in place, so this is
   * the first install's end), or for a tree without one its `.bin` or own directory's creation time.
   */
  born: number | null;
  /** Where the window that ends at `before` starts: a change after it in a package not reinstalled is saved at critical. */
  beforeFrom: number | null;
  /** True when no stamp covers the tree and its directory's modification time stands in for one. */
  unstamped: boolean;
}

/**
 * The files under `tree` changed inside `window`, outside `excludedFromEdits`, from metadata alone: only a Gradle
 * `build` directory's listing and its package's package.json are read. A problem when part of the tree cannot be
 * listed.
 */
async function scanEdits(tree: string, window: ScanWindow, signal?: AbortSignal): Promise<Scan | { problem: string }> {
  const kind = kindOf(tree);
  const edits: DependencyEditFile[] = [];
  const grace: DependencyEditFile[] = [];
  let entries = 0;
  let directories = 0;
  const pending: { segments: string[]; unitBorn: number; packageRoot: string | null }[] = [
    { segments: [], unitBorn: -Infinity, packageRoot: null },
  ];
  const full = () => edits.length + grace.length >= LISTED_EDITS;
  for (let next = pending.pop(); next; next = pending.pop()) {
    const { segments } = next;
    if (++directories % YIELD_EVERY === 0) {
      await nextTurn();
      signal?.throwIfAborted();
    }
    const dir = join(tree, ...segments);
    let names;
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (segments.length && isMissing(error)) continue;
      return { problem: `${dir} cannot be listed` };
    }
    const siblings = names.map(({ name }) => name);
    let { unitBorn, packageRoot } = next;
    if (kind === 'node_modules' && siblings.includes('package.json')) {
      packageRoot = dir;
      try {
        unitBorn = bornAt(lstatSync(join(dir, 'package.json')));
      } catch {}
    }
    if (kind === 'Pods' && segments.length === 1) {
      try {
        unitBorn = POD_GENERATED.includes(segments[0] ?? '') ? Infinity : bornAt(lstatSync(dir));
      } catch {}
    }
    for (const entry of names) {
      if (++entries > WALK_ENTRIES) return { problem: `it holds more than ${WALK_ENTRIES} entries to check` };
      const path = [...segments, entry.name];
      if (entry.isDirectory()) {
        const excluded = excludedFromEdits(kind, path, true, siblings, () =>
          gradleBuildDir(join(tree, ...path), packageRoot),
        );
        if (!excluded) pending.push({ segments: path, unitBorn, packageRoot });
        continue;
      }
      if (!entry.isFile() || excludedFromEdits(kind, path, false, siblings, () => false)) continue;
      let stat;
      try {
        stat = lstatSync(join(tree, ...path));
      } catch (error) {
        if (isMissing(error)) continue;
        return { problem: `${join(tree, ...path)} cannot be read` };
      }
      const file = { rel: path.join('/'), mtimeMs: stat.mtimeMs, size: stat.size };
      const kept =
        stat.mtimeMs > window.graceEnd ||
        (window.before !== null &&
          stat.mtimeMs > window.before &&
          (unitBorn <= window.before || stat.mtimeMs > unitBorn + PACKAGE_WRITE_MS));
      const carried =
        window.beforeFrom !== null &&
        window.before !== null &&
        stat.mtimeMs > window.beforeFrom &&
        unitBorn <= window.before;
      if (!kept && ((stat.mtimeMs <= window.saveFrom && !carried) || unitBorn === Infinity)) continue;
      if (full()) return { edits, grace, complete: false };
      (kept ? edits : grace).push(file);
    }
  }
  return { edits: edits.toSorted(byPath), grace: grace.toSorted(byPath), complete: true };
}

function newestStamp(tree: string): number | null {
  let newest: number | null = null;
  for (const name of STAMPS[kindOf(tree)]) {
    try {
      newest = Math.max(newest ?? 0, lstatSync(join(tree, name)).mtimeMs);
    } catch {}
  }
  return newest;
}

function stampFile(tree: string): string | null {
  let newest: { path: string; at: number } | null = null;
  for (const name of STAMPS[kindOf(tree)]) {
    const at = mtimeOf(join(tree, name));
    if (at !== null && (!newest || at > newest.at)) newest = { path: join(tree, name), at };
  }
  return newest?.path ?? null;
}

function birthOf(path: string): number | null {
  try {
    return bornAt(lstatSync(path));
  } catch {
    return null;
  }
}

function mtimeOf(path: string): number | null {
  try {
    return lstatSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function declaresInstallScript(dir: string): boolean {
  const scripts = readJsonObject(join(dir, 'package.json'))?.scripts;
  return Boolean(scripts && typeof scripts === 'object' && INSTALL_SCRIPTS.some((name) => name in scripts));
}

/**
 * The reference that covers `tree` and how long after it install-time scripts may still write. When Stim ran the
 * install there, its recorded end; otherwise the newest package-manager stamp of the tree, or of the nearest
 * node_modules above it inside `worktree` (a workspace install writes a package's node_modules without a stamp), or
 * for a tree no stamp covers (Bun writes none) its own and its `.bin` directory's modification times plus a minute.
 */
function reference(tree: string, worktree: string, record: DependencyInstallRecord | null): ScanWindow | null {
  const kind = kindOf(tree);
  const root = canonicalOr(worktree);
  let recorded = record?.installedAt ?? null;
  let stampedAt = newestStamp(tree);
  let installRoot = dirname(tree);
  let stampTree = tree;
  if (kind === 'node_modules')
    for (let current = tree; recorded === null && stampedAt === null;) {
      const parent = dirname(dirname(current));
      if (parent === dirname(current) || !(parent === root || parent.startsWith(`${root}${sep}`))) break;
      current = join(parent, 'node_modules');
      recorded = readDependencyInstall(current)?.installedAt ?? null;
      stampedAt = newestStamp(current);
      installRoot = parent;
      stampTree = current;
    }
  if (recorded !== null && (stampedAt === null || recorded >= stampedAt))
    return {
      since: recorded,
      graceEnd: recorded,
      saveFrom: recorded,
      before: null,
      born: null,
      beforeFrom: null,
      unstamped: false,
    };
  let linkedOnly = false;
  if (stampedAt === null) {
    const linked = [mtimeOf(tree), mtimeOf(join(tree, '.bin'))].filter((at): at is number => at !== null);
    if (linked.length) stampedAt = Math.max(...linked);
    linkedOnly = true;
  }
  if (stampedAt === null) return null;
  const scripts =
    kind === 'node_modules' && [installRoot, root].some((dir) => declaresInstallScript(dir)) ? SCRIPT_GRACE_MS : 0;
  const grace = Math.max(kind === 'Pods' ? POD_GRACE_MS : scripts, linkedOnly ? LINKED_GRACE_MS : 0);
  const born = linkedOnly ? (birthOf(join(tree, '.bin')) ?? birthOf(tree)) : birthOf(stampFile(stampTree) ?? tree);
  return {
    since: stampedAt,
    graceEnd: stampedAt + grace,
    saveFrom: stampedAt,
    before: null,
    born,
    beforeFrom: null,
    unstamped: linkedOnly,
  };
}

function unchanged(tree: string, file: DependencyEditFile): boolean {
  try {
    const stat = lstatSync(join(tree, ...file.rel.split('/')));
    return stat.isFile() && stat.mtimeMs === file.mtimeMs && stat.size === file.size;
  } catch {
    return false;
  }
}

function merge(...lists: DependencyEditFile[][]): DependencyEditFile[] {
  const files = new Map<string, DependencyEditFile>();
  for (const list of lists) for (const file of list) files.set(file.rel, file);
  return [...files.values()].toSorted(byPath);
}

const AFTER_INSTALL = 'changed after its install';

function afterWhat(window: ScanWindow): string {
  return window.unstamped ? 'changed after the tree itself last changed (it has no install stamp)' : AFTER_INSTALL;
}

function countText(count: number, complete: boolean): string {
  return `${complete ? '' : 'at least '}${count} file${count === 1 && complete ? '' : 's'}`;
}

/** Why maintenance keeps a dependency tree whose files changed after its install. */
export function editsKeptReason(
  edits: { count: number; complete: boolean; files: readonly string[] },
  after: string = AFTER_INSTALL,
): string {
  const shown = edits.files.slice(0, SHOWN).join(', ');
  const more = edits.count > SHOWN || !edits.complete ? ', ...' : '';
  return `${countText(edits.count, edits.complete)} in it ${after} (${shown}${more}), so maintenance keeps it until critical pressure; make the change a patch (pnpm patch, yarn patch or patch-package) so a reinstall keeps it`;
}

export interface SavedEdits {
  dir: string;
  files: string[];
  restore: string;
}

/** `edited` when the keep is for changed files rather than a tree that could not be checked. */
export type EditCheck = { keep: string; edited?: true } | { delete: true; note?: string; saved?: SavedEdits };

/**
 * Copies `files` of `tree` into the worktree archive with a manifest. Each copy is checked by size only; a file that
 * changed size while copied, an archive that is disabled or full, or a disk without room for it throws.
 */
async function saveEdits(
  tree: string,
  worktree: string,
  files: readonly DependencyEditFile[],
  level: PressureLevel,
  signal?: AbortSignal,
): Promise<SavedEdits> {
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  const limits = worktreeArchiveLimits(worktree);
  if ('refusal' in limits) throw new Error(limits.refusal);
  if ((await worktreeArchiveBytes(signal)) + bytes > limits.maxBytes)
    throw new Error('they do not fit in archive.maxTotalGb beside the other archives');
  const [volume] = await readVolumeSpaceAsync([dirname(worktreeArchiveRoot())], signal);
  if (!volume || volume.freeMb * 1024 ** 2 < 2 * bytes + 64 * 1024 ** 2)
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
    for (const { rel, size } of files) {
      const to = join(target, ...rel.split('/'));
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      copyFileSync(join(tree, ...rel.split('/')), to, constants.COPYFILE_FICLONE);
      if (lstatSync(to).size !== size) throw new Error(`${rel} changed while it was copied`);
    }
    const restore = `cp -R ${quotedPath(`${target}/.`)} ${quotedPath(tree)}`;
    const manifest = {
      version: 1,
      kind: 'dependency-edits',
      createdAt: new Date(at).toISOString(),
      source: tree,
      worktree,
      pressure: level,
      files: files.map(({ rel }) => rel),
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
 * The edit check a dependency tree passes before it is deleted at `level`. Files changed after the tree's reference
 * are edits, and so are files found changed before that are still unchanged, whatever a later install did to the
 * stamp; when an install Stim did not run moved the reference, files changed after the old one in a package or pod
 * that install did not reinstall stay edits. Below critical any edit keeps the tree; at critical the edits and the
 * install-script output are saved first. A tree kept for edits is not walked again while its install signature and
 * its known edits are unchanged, except at critical. With `readOnly` nothing is written or saved.
 */
export async function checkDependencyEdits(
  path: string,
  {
    level,
    worktree,
    readOnly = false,
    signal,
  }: { level: PressureLevel; worktree: string; readOnly?: boolean; signal?: AbortSignal },
): Promise<EditCheck> {
  const tree = canonicalOr(path);
  const record = readDependencyInstall(tree);
  const signature = treeSignature(tree);
  const known = (record?.edits?.files ?? []).filter((file) => unchanged(tree, file));
  if (
    level !== 'critical' &&
    known.length &&
    record?.edits &&
    record.edits.signature === signature &&
    known.length === record.edits.files.length
  )
    return {
      keep: editsKeptReason({ count: known.length, complete: record.edits.complete, files: known.map((f) => f.rel) }),
      edited: true,
    };
  const window = reference(tree, worktree, record);
  if (!window) return { keep: 'it has no install stamp to compare its files with, so its edits cannot be checked' };
  // @ref LLP 0002#edits-inside-dependency-folders -- a later install must not hide an edit
  if (record?.reference !== null && record?.reference !== undefined) {
    if (window.since > record.reference) window.before = window.beforeFrom = record.reference;
  } else if (window.born !== null) {
    window.beforeFrom = window.born;
    window.before = window.born + (window.graceEnd - window.since);
  }
  const scan = await scanEdits(tree, window, signal);
  if ('problem' in scan) return { keep: `its files cannot be checked for edits: ${scan.problem}` };
  const edits = merge(known, scan.edits);
  const complete = scan.complete && (record?.edits?.complete ?? true);
  if (!readOnly && signature !== null)
    try {
      updateRecord(tree, (current) => ({
        ...current,
        reference: window.graceEnd,
        edits: edits.length ? { signature, files: edits, complete, at: new Date().toISOString() } : null,
      }));
    } catch {}
  if (level !== 'critical')
    return edits.length
      ? {
          keep: editsKeptReason({ count: edits.length, complete, files: edits.map((f) => f.rel) }, afterWhat(window)),
          edited: true,
        }
      : { delete: true };
  const toSave = merge(edits, scan.grace);
  if (!toSave.length) return { delete: true };
  const bytes = toSave.reduce((sum, file) => sum + file.size, 0);
  if (!complete || bytes > SAVE_CAP_BYTES)
    return {
      edited: true,
      keep: `${countText(toSave.length, complete)} in it ${afterWhat(window)}, more than the ${LISTED_EDITS} files or ${SAVE_CAP_BYTES / 1024 ** 2} MB maintenance saves before deleting, so it stays even at critical pressure (${toSave
        .slice(0, SHOWN)
        .map((f) => f.rel)
        .join(', ')}, ...)`,
    };
  if (readOnly)
    return { delete: true, note: `it would first save ${countText(toSave.length, true)} ${afterWhat(window)}` };
  try {
    const saved = await saveEdits(tree, worktree, toSave, level, signal);
    try {
      updateRecord(tree, (current) => ({
        ...current,
        saved: [
          ...current.saved,
          { dir: saved.dir, restore: saved.restore, at: new Date().toISOString(), count: saved.files.length },
        ],
      }));
    } catch {}
    return { delete: true, saved };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      edited: true,
      keep: `${countText(toSave.length, true)} in it ${afterWhat(window)} and could not be saved: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Before an install or pod install Stim runs into existing `trees`: records the files changed since the current
 * reference, so the install moving the reference does not hide them.
 */
export async function noteEditsBeforeInstall(trees: readonly string[], signal?: AbortSignal): Promise<void> {
  for (const tree of trees) {
    if (!existsSync(tree)) continue;
    await checkDependencyEdits(tree, { level: 'high', worktree: dirname(tree), signal });
  }
}

/**
 * Records that an install or warm copy Stim ran into each of `trees` finished now, after every script it ran. Known
 * edits stay recorded and remain edits while unchanged. Best effort: a failure leaves the install stamp as the
 * reference.
 */
export function recordDependencyInstall(trees: readonly string[], at: number = Date.now()): void {
  for (const path of trees) {
    try {
      lstatSync(path);
      updateRecord(canonicalPath(path), (record) => ({ ...record, installedAt: at, reference: at }));
    } catch {}
  }
}

/** Forgets what Stim recorded about a deleted tree, except the copies it saved from it. */
export function forgetDependencyInstall(path: string): void {
  try {
    updateRecord(canonicalOr(path), (record) =>
      record.saved.length ? { ...record, installedAt: null, reference: null, edits: null } : null,
    );
  } catch {}
}

/** The detail of a deletion that saved changed files first: where they are and how to put them back. */
export function savedEditsDetail(saved: SavedEdits): string {
  return `saved ${saved.files.length} file${saved.files.length === 1 ? '' : 's'} changed after its install to ${saved.dir}; after reinstalling, put them back with ${saved.restore}`;
}

function inside(root: string, path: string): boolean {
  return path.startsWith(`${root}${sep}`);
}

/**
 * Every dependency tree a whole-worktree removal deletes: the git-ignored `node_modules` and `Pods` directories git
 * lists, which include the nested ones of npm and Yarn workspaces, and those the cleanup paths take at the worktree's
 * root and its workspaces `keys`.
 */
async function removedTrees(worktree: string, keys: readonly string[], signal?: AbortSignal): Promise<string[]> {
  const root = canonicalOr(worktree);
  const trees = new Set<string>();
  const listed = await gitQuietAsync(
    worktree,
    ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'],
    {
      signal,
    },
  );
  for (const entry of (listed ?? '').split('\0')) {
    const rel = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    if (basename(rel) === 'node_modules' || basename(rel) === 'Pods') {
      const tree = canonicalOr(join(worktree, rel));
      if (inside(root, tree)) trees.add(tree);
    }
  }
  for (const base of new Set([worktree, ...keys]))
    for (const path of existingDirsOf(base, ARTIFACT_DIRS.dependencies)) {
      const tree = canonicalOr(path);
      if (inside(root, tree)) trees.add(tree);
    }
  return [...trees].filter((tree) => {
    try {
      return lstatSync(tree).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Before a whole worktree is removed: saves the files changed after the install in each of its dependency trees, as
 * critical pressure does. `kept` names the first tree whose changes could not be saved.
 */
export async function saveEditsBeforeRemoval(
  worktree: string,
  keys: readonly string[],
  signal?: AbortSignal,
): Promise<{ saved: SavedEdits[]; kept: string | null }> {
  const saved: SavedEdits[] = [];
  let kept: string | null = null;
  for (const tree of await removedTrees(worktree, keys, signal)) {
    const check = await checkDependencyEdits(tree, { level: 'critical', worktree, signal });
    if ('keep' in check) kept ??= `${relative(worktree, tree)}: ${check.keep}`;
    else if (check.saved) saved.push(check.saved);
  }
  return { saved, kept };
}

/** Why a worktree that maintenance would remove keeps a dependency tree with files changed after its install, or null. */
export async function dependencyEditsHold(worktree: string, signal?: AbortSignal): Promise<string | null> {
  for (const tree of await removedTrees(worktree, [], signal)) {
    const check = await checkDependencyEdits(tree, { level: 'high', worktree, readOnly: true, signal });
    if ('keep' in check) return `its ${relative(worktree, tree)}: ${check.keep}`;
  }
  return null;
}

/** The saved copies still on disk; they stay listed until archive retention or a person removes them. */
function liveSaved(saved: readonly DependencySavedEdits[]): DependencySavedEdits[] {
  return saved.filter((entry) => existsSync(join(entry.dir, 'manifest.json')));
}

/**
 * What maintenance last found in the dependency trees at the root of the workspace `root`, without walking them: the
 * trees it keeps for files changed after the install, and the copies it saved before deleting one.
 */
export function dependencyEditsOf(root: string): {
  dependencyEdits?: DependencyEditsStatus[];
  dependencyEditsSaved?: DependencyEditsSavedStatus[];
} {
  const kept: DependencyEditsStatus[] = [];
  const saved: DependencyEditsSavedStatus[] = [];
  for (const path of ARTIFACT_DIRS.dependencies.map((dir) => join(root, dir))) {
    const tree = canonicalOr(path);
    const record = readDependencyInstall(tree);
    if (!record) continue;
    const edits = record.edits;
    if (edits && edits.signature === treeSignature(tree))
      kept.push({
        tree,
        count: edits.files.length,
        complete: edits.complete,
        files: edits.files.slice(0, SHOWN).map((f) => f.rel),
        at: edits.at,
      });
    for (const entry of liveSaved(record.saved)) saved.push({ tree, ...entry });
  }
  return {
    ...(kept.length ? { dependencyEdits: kept } : {}),
    ...(saved.length ? { dependencyEditsSaved: saved } : {}),
  };
}

/** One line per saved copy of `trees` still waiting to be put back, for a warm that installs them again. */
export function savedEditsLines(trees: readonly string[]): string[] {
  return trees.flatMap((path) => {
    const tree = canonicalOr(path);
    return liveSaved(readDependencyInstall(tree)?.saved ?? []).map(
      (entry) =>
        `${entry.count} file${entry.count === 1 ? '' : 's'} changed in ${tree} were saved to ${entry.dir} before it was deleted; put them back with ${entry.restore}`,
    );
  });
}
