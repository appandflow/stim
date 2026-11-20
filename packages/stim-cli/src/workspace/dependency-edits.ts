import { existsSync, lstatSync, readdirSync, type Stats } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { lstat, readdir, readFile, stat as statFile } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  readDependencyInstall,
  readJsonObject,
  type DependencyEditFile,
  type DependencyEditsStatus,
  type DependencyInstallRecord,
  type PressureLevel,
} from '@stim-cli/core/state';
import { canonicalPath } from '../commands/gc/paths.ts';
import { treeSignature } from '../private-size.ts';
import { gitQuietAsync } from './git.ts';
import { updateDependencyInstall as updateRecord } from './dependency-install-records.ts';
import { ARTIFACT_DIRS, existingDirsOf } from './regenerable-dirs.ts';
import { absent } from './scan-rules.ts';
import { answered } from './bounded-read.ts';
import { yamlBlock } from '../fingerprint/inputs.ts';
import { field as jsonField } from '../fingerprint/walk.ts';

/**
 * How long after a package manager's stamp the root project's own install-time script (`preinstall`, `install`,
 * `postinstall`, `prepare`) may still write into node_modules; applied only when the root `package.json` declares one.
 */
const SCRIPT_GRACE_MS = 10 * 60_000;
/** `pod install` writes the Pods project and xcconfigs up to 2 s after `Manifest.lock` (measured on an Expo app). */
const POD_GRACE_MS = 60_000;
/**
 * A tree no stamp covers takes its reference from its own directory's modification time, which an install changes
 * when it links a package but before it writes that package's files.
 */
const LINKED_GRACE_MS = 60_000;
/**
 * How long after a package's `package.json` was created an install still writes that package's files: 0.5 s at most
 * measured with npm, pnpm, Yarn and Bun, esbuild's postinstall included, and 1 ms for a pod. A later change inside a
 * package added since the previous reference is an edit.
 */
const PACKAGE_WRITE_MS = 5_000;
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];
/** Changed files listed before a walk stops listing. */
const LISTED_EDITS = 1000;
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
export const TREE_DOT_DIRS: readonly string[] = ['.pnpm', '.bun', '.deno'];
const GRADLE_SCRIPTS = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'];
/** What Gradle writes inside its `build` directory; a JS `build` directory holds none of them. */
const GRADLE_BUILD_ENTRIES = ['intermediates', 'generated', 'outputs', 'tmp', '.transforms', 'kotlin', 'classes'];
const PACKAGE_ENTRY_FIELDS = ['main', 'module', 'types', 'typings', 'react-native', 'browser', 'source'];

function kindOf(tree: string): TreeKind {
  return basename(tree) === 'Pods' ? 'Pods' : 'node_modules';
}

/**
 * Whether `segments` lies in a `.bin` directory of a node_modules tree, which package managers regenerate on every
 * install: pnpm 11 writes its shell shims there about 90 ms after `.modules.yaml`.
 */
function inBinDir(segments: readonly string[]): boolean {
  return segments.some((name, i) => name === '.bin' && (i === 0 || segments[i - 1] === 'node_modules'));
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
 * a package's `ios/build`; `.bin` at the root or in any nested node_modules; `xcuserdata` in Pods. Files: the package manager's own state at the tree's root.
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
  if (inBinDir(segments)) return true;
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
  /** False when the listing stopped at LISTED_EDITS. */
  complete: boolean;
}

interface ScanWindow {
  /** Files changed after it are candidates. */
  since: number;
  /** Files changed after it are edits; between `since` and it, install-script output. */
  graceEnd: number;
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
  let entries = 0;
  let directories = 0;
  const pending: { segments: string[]; unitBorn: number; packageRoot: string | null }[] = [
    { segments: [], unitBorn: -Infinity, packageRoot: null },
  ];
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
      const edited =
        stat.mtimeMs > window.graceEnd ||
        (window.before !== null &&
          stat.mtimeMs > window.before &&
          (unitBorn <= window.before || stat.mtimeMs > unitBorn + PACKAGE_WRITE_MS));
      if (!edited) continue;
      if (edits.length === LISTED_EDITS) return { edits, complete: false };
      edits.push({ rel: path.join('/'), mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }
  return { edits: edits.toSorted(byPath), complete: true };
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
 * for a tree no stamp covers (Bun writes none) its own and its `.bin` directory's modification times.
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
    return { since: recorded, graceEnd: recorded, before: null, born: null, unstamped: false };
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
  return { since: stampedAt, graceEnd: stampedAt + grace, before: null, born, unstamped: linkedOnly };
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
  return `${countText(edits.count, edits.complete)} in it ${after} (${shown}${more}), so maintenance and stim gc keep it at every disk pressure and its disk is not freed; make the change a patch (pnpm patch, yarn patch or patch-package), or reinstall the dependencies, to release it`;
}

const PATCH_PROBE_MS = 5_000;
const MAX_PATCH_ENTRIES = 5_000;

/** The patch file of each key of pnpm's `patchedDependencies` declared at the project `root`. */
async function patchFiles(root: string, read: <T>(path: string, start: () => Promise<T>) => Promise<T>) {
  const files = new Map<string, string>();
  const text = async (name: string) => {
    try {
      return await read(join(root, name), () => readFile(join(root, name), 'utf8'));
    } catch (error) {
      if (absent(error)) return null;
      throw error;
    }
  };
  for (const line of yamlBlock(await text('pnpm-workspace.yaml'), 'patchedDependencies')) {
    const entry = /^(['"]?)(.+)\1:\s*(['"]?)(.+\.patch)\3$/.exec(line);
    if (entry?.[2] && entry[4]) files.set(entry[2], resolve(root, entry[4]));
  }
  const manifest = await text('package.json');
  const declared: unknown = manifest ? JSON.parse(manifest)?.pnpm?.patchedDependencies : null;
  for (const [key, file] of Object.entries(declared && typeof declared === 'object' ? declared : {}))
    if (typeof file === 'string') files.set(key, resolve(root, file));
  return files;
}

/** The nearest folder above `project` that holds a `pnpm-workspace.yaml`, or null. */
async function workspaceRoot(
  project: string,
  read: <T>(path: string, start: () => Promise<T>) => Promise<T>,
): Promise<string | null> {
  for (let dir = dirname(project); dir !== dirname(dir); dir = dirname(dir)) {
    const file = join(dir, 'pnpm-workspace.yaml');
    const found = await read(file, () => lstat(file)).catch((error: unknown) => {
      if (absent(error)) return null;
      throw error;
    });
    if (found) return dir;
  }
  return null;
}

/**
 * The `patchedDependencies` key `pnpm patch-commit` writes for the edit folder `edit` (`folder` in `.pnpm_patches`): its
 * package's `name@version`, or `name` alone when pnpm recorded the edit as applying to every version. Empty when
 * `state.json` holds no single record of it, which leaves the folder uncommitted.
 */
async function patchKey(
  edit: string,
  folder: string,
  states: unknown,
  read: <T>(path: string, start: () => Promise<T>) => Promise<T>,
): Promise<string> {
  const records = Object.entries(states && typeof states === 'object' ? states : {}).filter(
    ([key]) => key === edit || key.endsWith(`${sep}.pnpm_patches${sep}${folder}`),
  );
  const all = new Set(records.map(([, record]: [string, unknown]) => jsonField(record, 'applyToAll')));
  const [applyToAll] = all;
  if (all.size !== 1 || typeof applyToAll !== 'boolean') return '';
  const manifest: unknown = JSON.parse(await read(edit, () => readFile(join(edit, 'package.json'), 'utf8')));
  const name = jsonField(manifest, 'name');
  const version = jsonField(manifest, 'version');
  if (typeof name !== 'string' || typeof version !== 'string') return '';
  return applyToAll ? name : `${name}@${version}`;
}

/**
 * Why a `pnpm patch` not yet committed keeps the node_modules `tree`, or null. `pnpm patch` copies a package into an
 * edit folder in `.pnpm_patches`, which the edit scan skips with the tools' caches, and `pnpm patch-commit` writes the
 * patch file `patchedDependencies` names, in the project or its workspace root, but leaves the edit folder and
 * `state.json` in place (pnpm/pnpm#8401). An edit folder with no patch file under the exact key pnpm writes for it, or
 * with anything modified after its patch file, keeps the tree; a hand-written range key does not count. Never follows a
 * link; a read that does not answer within PATCH_PROBE_MS, or more than MAX_PATCH_ENTRIES entries, keeps it too.
 */
export async function pnpmPatchHold(tree: string, signal?: AbortSignal): Promise<string | null> {
  const dir = join(tree, '.pnpm_patches');
  const where = `${basename(tree)}/.pnpm_patches`;
  const started = performance.now();
  const read = <T>(path: string, start: () => Promise<T>) =>
    answered(path, start, Math.max(1, PATCH_PROBE_MS - (performance.now() - started)), signal);
  const list = (path: string) => read(path, () => readdir(path, { withFileTypes: true }));
  try {
    if (!(await read(dir, () => lstat(dir))).isDirectory()) return null;
  } catch (error) {
    if (absent(error)) return null;
    signal?.throwIfAborted();
    return `${where} cannot be read`;
  }
  try {
    const folders: string[] = [];
    for (const entry of await list(dir)) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith('@')) folders.push(entry.name);
      else
        for (const inner of await list(join(dir, entry.name)))
          if (inner.isDirectory()) folders.push(`${entry.name}/${inner.name}`);
    }
    if (!folders.length) return null;
    const files = await patchFiles(dirname(tree), read);
    const shared = await workspaceRoot(dirname(tree), read);
    if (shared) for (const [key, file] of await patchFiles(shared, read)) if (!files.has(key)) files.set(key, file);
    const states = await read(join(dir, 'state.json'), () => readFile(join(dir, 'state.json'), 'utf8'))
      .then((text): unknown => JSON.parse(text))
      .catch((error: unknown) => {
        if (absent(error) || error instanceof SyntaxError) return null;
        throw error;
      });
    let entries = 0;
    for (const folder of folders) {
      const file = files.get(await patchKey(join(dir, folder), folder, states, read));
      const committed = file
        ? await read(file, () => statFile(file)).catch((error: unknown) => {
            if (absent(error)) return null;
            throw error;
          })
        : null;
      if (!file || !committed)
        return `it has a pnpm patch not yet committed in ${where}/${folder}; run pnpm patch-commit`;
      const queue = [join(dir, folder)];
      for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
        if (++entries > MAX_PATCH_ENTRIES)
          return `${where} holds over ${MAX_PATCH_ENTRIES} entries to check for a pnpm patch not yet committed`;
        const at = path;
        const info = await read(at, () => lstat(at));
        if (info.mtimeMs > committed.mtimeMs)
          return `it has pnpm patch edits in ${where}/${folder} newer than ${relative(dirname(tree), file)}; run pnpm patch-commit`;
        if (info.isDirectory()) for (const entry of await list(at)) queue.push(join(at, entry.name));
      }
    }
    return null;
  } catch {
    signal?.throwIfAborted();
    return `${where} cannot be checked for a pnpm patch not yet committed`;
  }
}

/** `edited` when the keep is for changed files rather than a tree that could not be checked. */
export type EditCheck = { keep: string; edited?: true } | { delete: true };

// @ref LLP 0002#edits-inside-dependency-folders -- a tree with hand edits is never deleted by maintenance or gc
/**
 * The edit check automatic maintenance and `stim gc` run before deleting a dependency tree. Files changed after the
 * tree's reference are edits, and so are files found changed before that are still unchanged, whatever a later
 * install did to the stamp; when an install Stim did not run moved the reference, files changed after the old one in
 * a package or pod that install did not reinstall, or well after that package was installed, stay edits. Any edit
 * keeps the tree at every pressure level. A tree kept for edits is not walked again while its install signature and
 * its known edits are unchanged, except at critical. An unfinished `pnpm patch` keeps a node_modules tree too. With
 * `readOnly` nothing is written.
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
  const patch = kindOf(tree) === 'node_modules' ? await pnpmPatchHold(tree, signal) : null;
  return patch ? { keep: patch, edited: true } : recordedEdits(path, { level, worktree, readOnly, signal });
}

async function recordedEdits(
  path: string,
  {
    level,
    worktree,
    readOnly,
    signal,
  }: { level: PressureLevel; worktree: string; readOnly: boolean; signal?: AbortSignal },
): Promise<EditCheck> {
  const tree = canonicalOr(path);
  const record = readDependencyInstall(tree);
  const signature = treeSignature(tree);
  const known = (record?.edits?.files ?? []).filter(
    (file) => unchanged(tree, file) && !(kindOf(tree) === 'node_modules' && inBinDir(file.rel.split('/'))),
  );
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
  if (record?.reference !== null && record?.reference !== undefined) {
    if (window.since > record.reference) window.before = record.reference;
  } else if (window.born !== null) window.before = window.born + (window.graceEnd - window.since);
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
  return edits.length
    ? {
        keep: editsKeptReason({ count: edits.length, complete, files: edits.map((f) => f.rel) }, afterWhat(window)),
        edited: true,
      }
    : { delete: true };
}

/**
 * Before an install or pod install Stim runs into existing `trees`: records the files changed since the current
 * reference, so the install moving the reference does not hide them.
 */
export async function noteEditsBeforeInstall(trees: readonly string[], signal?: AbortSignal): Promise<void> {
  for (const tree of trees) {
    if (!existsSync(tree)) continue;
    await recordedEdits(tree, { level: 'high', worktree: dirname(tree), readOnly: false, signal });
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

/** Forgets what Stim recorded about a tree it deleted. */
export function forgetDependencyInstall(path: string): void {
  try {
    updateRecord(canonicalOr(path), () => null);
  } catch {}
}

function inside(root: string, path: string): boolean {
  return path.startsWith(`${root}${sep}`);
}

/**
 * Every dependency tree removing `worktree` deletes: the git-ignored `node_modules` and `Pods` directories git
 * lists, which include the nested ones of npm and Yarn workspaces, and those the cleanup paths take at the worktree's
 * root and its workspaces `keys`.
 */
async function removedTrees(worktree: string, signal?: AbortSignal): Promise<string[]> {
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
  for (const base of [worktree])
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

/** Why a worktree that maintenance would remove keeps a dependency tree with files changed after its install, or null. */
export async function dependencyEditsHold(worktree: string, signal?: AbortSignal): Promise<string | null> {
  for (const tree of await removedTrees(worktree, signal)) {
    const check = await checkDependencyEdits(tree, { level: 'high', worktree, readOnly: true, signal });
    if ('keep' in check) return `its ${relative(worktree, tree)}: ${check.keep}`;
  }
  return null;
}

/** The trees at the root of the workspace `root` that maintenance keeps for hand edits, as last walked. */
export function dependencyEditsOf(root: string): { dependencyEdits?: DependencyEditsStatus[] } {
  const kept: DependencyEditsStatus[] = [];
  for (const path of ARTIFACT_DIRS.dependencies.map((dir) => join(root, dir))) {
    const tree = canonicalOr(path);
    const edits = readDependencyInstall(tree)?.edits;
    if (!edits || edits.signature !== treeSignature(tree)) continue;
    kept.push({
      tree,
      count: edits.files.length,
      complete: edits.complete,
      files: edits.files.slice(0, SHOWN).map((f) => f.rel),
      at: edits.at,
    });
  }
  return kept.length ? { dependencyEdits: kept } : {};
}
