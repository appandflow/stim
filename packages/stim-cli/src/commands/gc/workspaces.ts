import { existsSync, lstatSync, readdirSync, statSync } from 'fs';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'path';
import chalk from 'chalk';
import { formatBytes, isOnMountedVolume, listMountedVolumes, measuredDirectorySizeAsync } from '../../fs-util.ts';
import { isJsonObject, lastNativeUseFrom, readJsonFile } from '@stim-cli/core/state';
import { getConfigDir, isPathPrefix, loadConfig } from '../../workspace/config.ts';
import { teardownOwnedBrowser } from '../../devices/teardown.ts';
import { emptyWorkspaceDir, workspaceInUse, workspaceInUseAsync, withIdleWorkspace } from '../../workspace/in-use.ts';
import { workspaceName } from '../../workspace/paths.ts';
import { readWorkspaceState, workspaceLastUsed } from '../../workspace/workspace-state.ts';
import { ARTIFACT_DIRS, existingDirsOf, regenerableDirProblem } from '../../workspace/regenerable-dirs.ts';
import { workspaceBuildInProgress } from './idle.ts';
import { mapLimited, sizeConcurrency } from './limited.ts';
import { canonicalPath } from './paths.ts';
import { lockReason, worktreeLock, worktreeLockAsync, type WorktreeLock } from '../../workspace/worktree.ts';
import type { GcSkip } from './types.ts';
import { GC_OUTPUT, type GcOutput } from './results.ts';
import type { StimContext } from '@stim-cli/core';
import { WorkspaceProcessCleanupError } from '../../engine/workspace-process-lock.ts';

export interface WorkspaceDirEntry {
  dir: string;
  projectRoot: string | null;
  problem: string | null;
}

export interface OrphanedWorkspace {
  dir: string;
  projectRoot: string;
  bytes?: number | null;
}

function workspacesRoot(): string {
  return join(getConfigDir(), 'workspaces');
}

export function isInsideWorkspaces(dir: string): boolean {
  const rel = relative(canonicalPath(workspacesRoot()), canonicalPath(dir));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function readRecordedRoot(dir: string, name: string): Pick<WorkspaceDirEntry, 'projectRoot' | 'problem'> {
  let parsed: unknown;
  try {
    parsed = readJsonFile(join(dir, 'workspace.json'));
  } catch (error) {
    return unreadableRecordedRoot(error);
  }
  return recordedRoot(parsed, name);
}

function unreadableRecordedRoot(error: unknown): Pick<WorkspaceDirEntry, 'projectRoot' | 'problem'> {
  return {
    projectRoot: null,
    problem:
      (error as NodeJS.ErrnoException)?.code === 'ENOENT'
        ? 'it has no workspace.json'
        : 'its workspace.json does not parse',
  };
}

function recordedRoot(parsed: unknown, name: string): Pick<WorkspaceDirEntry, 'projectRoot' | 'problem'> {
  const projectRoot = isJsonObject(parsed) ? parsed.projectRoot : undefined;
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot)) {
    return { projectRoot: null, problem: 'its workspace.json records no absolute project root' };
  }
  if (workspaceName(projectRoot) !== name) {
    return {
      projectRoot: null,
      problem: `its workspace.json records ${projectRoot}, whose workspace directory has another name`,
    };
  }
  return { projectRoot, problem: null };
}

export function listWorkspaceDirs(): WorkspaceDirEntry[] {
  const root = workspacesRoot();
  let names: string[];
  try {
    names = readdirSync(root).toSorted();
  } catch {
    return [];
  }
  const entries: WorkspaceDirEntry[] = [];
  for (const name of names) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    entries.push({ dir, ...readRecordedRoot(dir, name) });
  }
  return entries;
}

async function listWorkspaceDirsAsync(signal?: AbortSignal): Promise<WorkspaceDirEntry[]> {
  signal?.throwIfAborted();
  const root = workspacesRoot();
  let names: string[];
  try {
    names = (await readdir(root)).toSorted();
  } catch {
    signal?.throwIfAborted();
    return [];
  }
  const entries: WorkspaceDirEntry[] = [];
  for (const name of names) {
    signal?.throwIfAborted();
    const dir = join(root, name);
    try {
      if (!(await stat(dir)).isDirectory()) continue;
    } catch {
      signal?.throwIfAborted();
      continue;
    }
    signal?.throwIfAborted();
    let recorded: Pick<WorkspaceDirEntry, 'projectRoot' | 'problem'>;
    try {
      recorded = recordedRoot(JSON.parse(await readFile(join(dir, 'workspace.json'), 'utf8')), name);
    } catch (error) {
      signal?.throwIfAborted();
      recorded = unreadableRecordedRoot(error);
    }
    signal?.throwIfAborted();
    entries.push({ dir, ...recorded });
  }
  return entries;
}

export function classifyWorkspaceDirs(
  entries: readonly WorkspaceDirEntry[],
  {
    registryKeys,
    exists,
    isMounted,
    inUse,
  }: {
    registryKeys: readonly string[];
    exists: (path: string) => boolean | null;
    isMounted: (path: string) => boolean;
    inUse: (root: string) => string[];
  },
): { orphaned: OrphanedWorkspace[]; skipped: GcSkip[] } {
  const orphaned: OrphanedWorkspace[] = [];
  const skipped: GcSkip[] = [];
  for (const { dir, projectRoot, problem } of entries) {
    if (projectRoot === null) {
      skipped.push({ dir, reason: `workspace directory not resolved: ${problem ?? 'unknown project root'}` });
      continue;
    }
    const present = exists(projectRoot);
    if (present === null) {
      skipped.push({ dir, reason: `cannot tell whether its project root ${projectRoot} still exists` });
      continue;
    }
    if (present) continue;
    if (registryKeys.some((key) => isPathPrefix(projectRoot, key))) continue;
    if (!isMounted(projectRoot)) {
      skipped.push({ dir, reason: `the volume of its project root ${projectRoot} is not mounted` });
      continue;
    }
    const reasons = inUse(projectRoot);
    if (reasons.length) {
      skipped.push({ dir, reason: `its project root ${projectRoot} is gone, but ${reasons.join('; ')}` });
      continue;
    }
    orphaned.push({ dir, projectRoot });
  }
  return { orphaned, skipped };
}

export function rootPresence(path: string): boolean | null {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? false : null;
  }
}

export function workspaceDirRemoved(dir: string): boolean {
  return (
    existsSync(workspacesRoot()) &&
    canonicalPath(dirname(dir)) === canonicalPath(workspacesRoot()) &&
    rootPresence(dir) === false
  );
}

export async function collectOrphanedWorkspaces(
  registryKeys: readonly string[],
  mountedVolumes: string[],
  { measure = true, operation }: { measure?: boolean; operation?: StimContext } = {},
): Promise<ReturnType<typeof classifyWorkspaceDirs>> {
  const classified: ReturnType<typeof classifyWorkspaceDirs> = { orphaned: [], skipped: [] };
  for (const entry of await listWorkspaceDirsAsync(operation?.signal)) {
    operation?.signal.throwIfAborted();
    const current = classifyWorkspaceDirs([entry], {
      registryKeys,
      exists: rootPresence,
      isMounted: (path) => isOnMountedVolume(path, mountedVolumes),
      inUse: () => [],
    });
    classified.skipped.push(...current.skipped);
    for (const orphan of current.orphaned) {
      const reasons = operation
        ? await workspaceInUseAsync(orphan.projectRoot, {}, operation.signal, operation)
        : workspaceInUse(orphan.projectRoot);
      if (reasons.length)
        classified.skipped.push({
          dir: orphan.dir,
          reason: `its project root ${orphan.projectRoot} is gone, but ${reasons.join('; ')}`,
        });
      else classified.orphaned.push(orphan);
    }
  }
  if (!measure) return classified;
  const orphaned = await mapLimited(classified.orphaned, sizeConcurrency(operation), async (entry) => {
    operation?.signal.throwIfAborted();
    const bytes = await measuredDirectorySizeAsync(entry.dir, {
      timeoutMs: SIZE_TIMEOUT_MS,
      operation,
      signal: operation?.signal,
    });
    return { ...entry, bytes };
  });
  return { orphaned, skipped: classified.skipped };
}

export const REBUILD_COST: string =
  'The next build of an unchanged app installs from the shared build cache; after a native change the ' +
  'compilation cache speeds the rebuild, but on React Native 0.86 Swift does not use it (explicit modules ' +
  'are off), so that build recompiles Swift. The next stim macos in a cleared workspace is a full Swift build.';

/** How long after its last ios, android or macos run a workspace keeps its build outputs. */
export const LIGHTEN_AFTER_MS: number = 15 * 60_000;

const BUILD_CHECKS = { devServer: false, hosted: false, managedLocks: false } as const;
const BUILD_IN_PROGRESS = 'a build is in progress';

/** Why the build outputs of the workspace at `root` are in use: it is building or running a macOS app. */
export function workspaceBuildReasons(root: string, { nativeRun = true }: { nativeRun?: boolean } = {}): string[] {
  const reasons = workspaceInUse(root, { ...BUILD_CHECKS, nativeRun });
  return workspaceBuildInProgress(root) ? [...reasons, BUILD_IN_PROGRESS] : reasons;
}

async function workspaceBuildReasonsAsync(
  root: string,
  signal: AbortSignal,
  operation?: StimContext,
): Promise<string[]> {
  const reasons = await workspaceInUseAsync(root, BUILD_CHECKS, signal, operation);
  return workspaceBuildInProgress(root) ? [...reasons, BUILD_IN_PROGRESS] : reasons;
}

async function inTreeBuildDirs(root: string, signal?: AbortSignal): Promise<string[]> {
  const dirs: string[] = [];
  for (const path of existingDirsOf(root, ARTIFACT_DIRS.build))
    if (!(await regenerableDirProblem(root, path, signal))) dirs.push(path);
  return dirs;
}

export const WORKSPACE_OUTPUT_DIRS: readonly string[] = [
  'derived-data',
  'gradle-build',
  'android-cas',
  'cache-provider',
  'js-swap-tmp',
];

/** Why a workspace whose last ios, android or macos run was at `nativeUsed` keeps its build outputs, or null. */
export function recentNativeUseReason(nativeUsed: number, now: number): string | null {
  return now - nativeUsed < LIGHTEN_AFTER_MS
    ? `ran ios, android or macos within the last ${LIGHTEN_AFTER_MS / 60_000} minutes`
    : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export type WorkspaceKeptCode =
  | 'unresolved'
  | 'locked'
  | 'lock-unknown'
  | 'in-use'
  | 'last-use-unknown'
  | 'recently-used';

export function keptByLock(entry: Pick<WorkspaceOutputs, 'keptCode'>): boolean {
  return entry.keptCode === 'locked' || entry.keptCode === 'lock-unknown';
}

export interface WorkspaceOutputs {
  dir: string;
  projectRoot: string | null;
  /** The project's own build directories (android/app/build and the like) cleared with the outputs. */
  inTreeDirs: string[];
  bytes: number | null;
  idleDays: number | null;
  willClear: boolean;
  keptCode: WorkspaceKeptCode | null;
  keptReason: string | null;
}

export interface WorkspaceOutputsReport {
  root: string;
  workspaces: WorkspaceOutputs[];
}

export function planWorkspaceOutputs(
  entries: readonly (WorkspaceDirEntry & {
    inTreeDirs?: string[];
    bytes: number | null;
    lastUsed: number;
    nativeUsed: number;
    inUse: string[];
    lock?: WorktreeLock | null;
  })[],
  { olderThan, now }: { olderThan: number | null; now: number },
): WorkspaceOutputs[] {
  return entries.map(({ dir, projectRoot, problem, inTreeDirs = [], bytes, lastUsed, nativeUsed, inUse, lock }) => {
    const recentNative = recentNativeUseReason(nativeUsed, now);
    const idleDays = Number.isFinite(lastUsed) ? Math.max(0, Math.floor((now - lastUsed) / DAY_MS)) : null;
    const [keptCode, keptReason]: [WorkspaceKeptCode | null, string | null] =
      projectRoot === null
        ? ['unresolved', `workspace directory not resolved: ${problem ?? 'unknown project root'}`]
        : lock
          ? [lock === 'locked' ? 'locked' : 'lock-unknown', lockReason(lock)]
          : inUse.length
            ? ['in-use', `in use: ${inUse.join('; ')}`]
            : recentNative
              ? ['recently-used', recentNative]
              : olderThan === null
                ? [null, null]
                : idleDays === null
                  ? ['last-use-unknown', 'its last use is unknown']
                  : idleDays < olderThan
                    ? ['recently-used', `used ${idleDays}d ago, within --older-than ${olderThan}`]
                    : [null, null];
    return { dir, projectRoot, inTreeDirs, bytes, idleDays, willClear: keptCode === null, keptCode, keptReason };
  });
}

const SIZE_TIMEOUT_MS = 60_000;

const gitRead = (operation?: StimContext, signal?: AbortSignal) => ({
  env: operation?.env,
  signal: signal ?? operation?.signal,
  declareFor: operation,
});

function outputPaths(dir: string): string[] {
  const paths = WORKSPACE_OUTPUT_DIRS.map((name) => join(dir, name)).filter((path) => existsSync(path));
  const macos = join(dir, 'macos');
  try {
    if (!lstatSync(macos).isDirectory()) return paths;
    for (const entry of readdirSync(macos, { withFileTypes: true })) {
      if (
        entry.name === 'build' ||
        entry.name.endsWith('.app') ||
        (entry.name.startsWith('staging-') && entry.isDirectory())
      ) {
        paths.push(join(macos, entry.name));
      }
    }
  } catch {}
  return paths;
}

async function outputBytes(
  entries: readonly (readonly string[])[],
  timeoutMs: number,
  signal?: AbortSignal,
  operation?: StimContext,
): Promise<(number | null)[]> {
  const sizes = await mapLimited(
    entries.flatMap((paths, index) => paths.map((path) => ({ path, index }))),
    sizeConcurrency(operation),
    async ({ path, index }) => ({
      index,
      size: await measuredDirectorySizeAsync(path, { timeoutMs, signal, operation }),
    }),
  );
  return entries.map((_, index) => {
    const own = sizes.filter((size) => size.index === index).map((size) => size.size);
    return own.includes(null) ? null : own.reduce<number>((total, size) => total + (size ?? 0), 0);
  });
}

interface WorkspaceOutputsOptions {
  olderThan: number | null;
  now: number;
  exclude?: readonly string[];
  only?: string;
  measure?: boolean;
  sizeTimeoutMs?: number;
  signal?: AbortSignal;
  operation?: StimContext;
  /**
   * Lighten workspaces for `gc --delete`: include the project's in-tree build directories, keep only a workspace
   * that is building or ran a native command within LIGHTEN_AFTER_MS, and ignore its dev server and devices.
   */
  lighten?: boolean;
}

export function collectWorkspaceOutputs(
  options: WorkspaceOutputsOptions & { measure: false; signal?: undefined },
): WorkspaceOutputsReport;
export function collectWorkspaceOutputs(options: WorkspaceOutputsOptions): Promise<WorkspaceOutputsReport>;
export function collectWorkspaceOutputs({
  olderThan,
  now,
  exclude = [],
  only,
  measure = true,
  sizeTimeoutMs = SIZE_TIMEOUT_MS,
  signal,
  operation,
  lighten = false,
}: WorkspaceOutputsOptions): WorkspaceOutputsReport | Promise<WorkspaceOutputsReport> {
  const mountedVolumes = listMountedVolumes();
  const outputEntries = (entries: WorkspaceDirEntry[], inTree: ReadonlyMap<string, string[]> = new Map()) =>
    entries
      .filter((entry) => !exclude.includes(entry.dir))
      .filter(
        (entry) => only === undefined || (entry.projectRoot !== null && canonicalPath(entry.projectRoot) === only),
      )
      .filter((entry) => entry.projectRoot === null || isOnMountedVolume(entry.projectRoot, mountedVolumes))
      .map((entry) => {
        const inTreeDirs = inTree.get(entry.dir) ?? [];
        return Object.assign({}, entry, { inTreeDirs, paths: [...outputPaths(entry.dir), ...inTreeDirs] });
      })
      .filter((entry) => entry.paths.length > 0);
  const report = (
    sizes: (WorkspaceDirEntry & {
      inTreeDirs: string[];
      bytes: number | null;
      inUse: string[];
      lock: WorktreeLock | null;
    })[],
  ): WorkspaceOutputsReport => ({
    root: workspacesRoot(),
    workspaces: planWorkspaceOutputs(
      sizes.map((entry) =>
        Object.assign({}, entry, {
          lastUsed: entry.projectRoot === null ? NaN : workspaceLastUsed(entry.projectRoot),
          nativeUsed:
            lighten && entry.projectRoot !== null ? lastNativeUseFrom(readWorkspaceState(entry.projectRoot)) : NaN,
        }),
      ),
      { olderThan, now },
    ),
  });
  const inUseOf = (root: string) => (lighten ? workspaceBuildReasons(root) : workspaceInUse(root));
  if (!measure && !signal)
    return report(
      outputEntries(listWorkspaceDirs()).map(({ paths: _paths, ...entry }) =>
        Object.assign({}, entry, {
          bytes: null,
          inUse: entry.projectRoot === null ? [] : inUseOf(entry.projectRoot),
          lock: entry.projectRoot === null ? null : worktreeLock(entry.projectRoot),
        }),
      ),
    );
  return (async () => {
    const sizes: (WorkspaceDirEntry & {
      inTreeDirs: string[];
      bytes: number | null;
      inUse: string[];
      lock: WorktreeLock | null;
    })[] = [];
    const listed = await listWorkspaceDirsAsync(signal);
    const inTree = new Map<string, string[]>();
    if (lighten)
      for (const { dir, projectRoot } of listed)
        if (projectRoot !== null && !exclude.includes(dir)) inTree.set(dir, await inTreeBuildDirs(projectRoot, signal));
    const entries = outputEntries(listed, inTree);
    const bytes = measure
      ? await outputBytes(
          entries.map((entry) => entry.paths),
          sizeTimeoutMs,
          signal,
          operation,
        )
      : [];
    const locks = await mapLimited(entries, sizeConcurrency(operation), async ({ projectRoot }) =>
      projectRoot === null ? null : worktreeLockAsync(projectRoot, gitRead(operation, signal)),
    );
    for (const [index, { paths: _paths, ...entry }] of entries.entries()) {
      signal?.throwIfAborted();
      sizes.push({
        ...entry,
        bytes: bytes[index] ?? null,
        lock: locks[index] ?? null,
        inUse:
          entry.projectRoot === null
            ? []
            : !signal
              ? inUseOf(entry.projectRoot)
              : lighten
                ? await workspaceBuildReasonsAsync(entry.projectRoot, signal, operation)
                : await workspaceInUseAsync(entry.projectRoot, {}, signal, operation),
      });
    }
    return report(sizes);
  })();
}

export async function clearWorkspaceOutputs(
  report: WorkspaceOutputsReport,
  {
    olderThan,
    now = Date.now(),
    operation,
    signal = operation?.signal,
    lighten = false,
  }: { olderThan: number | null; now?: number; signal?: AbortSignal; operation?: StimContext; lighten?: boolean },
  { log, record }: GcOutput = GC_OUTPUT,
): Promise<{ failures: number; cleared: string[] }> {
  let failures = 0;
  let cleared = 0;
  const clearedRoots: string[] = [];
  for (const entry of report.workspaces) {
    signal?.throwIfAborted();
    const root = entry.projectRoot;
    if (!entry.willClear || root === null) {
      if (entry.keptReason) {
        log(chalk.dim(`Kept the build outputs of ${root ?? entry.dir}: ${entry.keptReason}`));
        record('workspaceOutputs', 'kept', root ?? entry.dir, { bytes: entry.bytes, detail: entry.keptReason });
      }
      continue;
    }
    let run;
    try {
      run = await withIdleWorkspace(
        root,
        async () => {
          const [again] = planWorkspaceOutputs(
            [
              {
                ...entry,
                problem: null,
                lastUsed: workspaceLastUsed(root),
                nativeUsed: lighten ? lastNativeUseFrom(readWorkspaceState(root)) : NaN,
                inUse: lighten && workspaceBuildInProgress(root) ? [BUILD_IN_PROGRESS] : [],
                lock: await worktreeLockAsync(root, gitRead(operation, signal)),
              },
            ],
            { olderThan, now },
          );
          if (again?.keptReason) return again.keptReason;
          const inTree: { path: string; problem: string | null }[] = [];
          for (const path of lighten ? existingDirsOf(root, ARTIFACT_DIRS.build) : [])
            inTree.push({ path, problem: await regenerableDirProblem(root, path, signal) });
          for (const path of [
            ...outputPaths(entry.dir),
            ...inTree.filter((dir) => !dir.problem).map((dir) => dir.path),
          ]) {
            signal?.throwIfAborted();
            await rm(path, { recursive: true, force: true });
          }
          signal?.throwIfAborted();
          for (const { path, problem } of inTree) if (problem) log(chalk.yellow(`Kept ${path}: ${problem}`));
          return null;
        },
        { purpose: 'gc', signal, operation, ...(lighten ? BUILD_CHECKS : {}) },
      );
    } catch (error) {
      if (error instanceof WorkspaceProcessCleanupError) throw error;
      signal?.throwIfAborted();
      failures++;
      log(chalk.red(`Could not clear the build outputs of ${root}: ${(error as Error)?.message || String(error)}`));
      record('workspaceOutputs', 'failed', root, {
        bytes: entry.bytes,
        detail: (error as Error)?.message || String(error),
      });
      continue;
    }
    const kept = run.ran ? run.value : `in use: ${run.reasons.join('; ')}`;
    if (kept) {
      log(chalk.yellow(`Kept the build outputs of ${root}: ${kept}`));
      record('workspaceOutputs', 'kept', root, { bytes: entry.bytes, detail: kept });
      continue;
    }
    cleared += entry.bytes ?? 0;
    clearedRoots.push(root);
    log(
      chalk.green(
        lighten
          ? `Lightened ${root}: freed ${sizeText(entry.bytes)} of build outputs`
          : `Cleared the build outputs of ${root} (${sizeText(entry.bytes)})`,
      ),
    );
    record('workspaceOutputs', 'done', root, { bytes: entry.bytes });
  }
  if (cleared) {
    const count = `${clearedRoots.length} workspace${clearedRoots.length === 1 ? '' : 's'}`;
    log(
      chalk.dim(
        `${lighten ? `Lightened ${count}, freeing` : 'Cleared'} ${formatBytes(cleared)} of workspace build outputs. ${REBUILD_COST}`,
      ),
    );
  }
  return { failures, cleared: clearedRoots };
}

function stillOrphaned({ dir, projectRoot }: OrphanedWorkspace): boolean {
  const recorded = readRecordedRoot(dir, basename(dir));
  if (recorded.projectRoot !== projectRoot || rootPresence(projectRoot) !== false || !isOnMountedVolume(projectRoot)) {
    return false;
  }
  return !Object.keys(loadConfig()?.projects ?? {}).some((key) => isPathPrefix(projectRoot, key));
}

export async function deleteOrphanedWorkspaces(
  orphaned: readonly OrphanedWorkspace[],
  output: GcOutput = GC_OUTPUT,
  operation?: StimContext,
): Promise<number> {
  let failures = 0;
  for (const entry of orphaned) {
    operation?.signal.throwIfAborted();
    if (!existsSync(entry.dir)) continue;
    let run;
    try {
      run = await withIdleWorkspace(
        entry.projectRoot,
        async () => {
          if (!stillOrphaned(entry)) return false;
          const browser = await teardownOwnedBrowser(entry.projectRoot, {
            deleteProfile: true,
            ...(operation ? { operation } : {}),
          });
          if (browser.status === 'failed' || browser.status === 'skipped') {
            throw new Error(`its owned Chrome profile was kept: ${browser.reason}`);
          }
          await emptyWorkspaceDir(entry.dir, operation?.signal);
          return true;
        },
        { purpose: 'gc', operation },
      );
    } catch (error) {
      if (error instanceof WorkspaceProcessCleanupError) throw error;
      operation?.signal.throwIfAborted();
      failures++;
      output.log(chalk.red(`Could not remove ${entry.dir}: ${(error as Error)?.message || error}`));
      output.record('workspaceDirectory', 'failed', entry.dir, {
        bytes: entry.bytes ?? null,
        detail: (error as Error)?.message || String(error),
      });
      continue;
    }
    if (!run.ran) {
      output.log(chalk.yellow(`Kept ${entry.dir}: ${run.reasons.join('; ')}`));
      output.record('workspaceDirectory', 'kept', entry.dir, {
        bytes: entry.bytes ?? null,
        detail: run.reasons.join('; '),
      });
      continue;
    }
    if (!run.value) {
      output.log(chalk.yellow(`Kept ${entry.dir}: it can no longer be confirmed orphaned.`));
      output.record('workspaceDirectory', 'kept', entry.dir, {
        bytes: entry.bytes ?? null,
        detail: 'it can no longer be confirmed orphaned',
      });
      continue;
    }
    const size = entry.bytes === undefined ? '' : ` (${sizeText(entry.bytes)})`;
    output.log(chalk.green(`Removed the orphaned workspace directory ${entry.dir}${size}`));
    output.record('workspaceDirectory', 'done', entry.dir, { bytes: entry.bytes ?? null });
  }
  return failures;
}

export function sizeText(bytes: number | null): string {
  return bytes === null ? 'size unknown' : formatBytes(bytes);
}
