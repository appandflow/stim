import { existsSync, lstatSync, readdirSync, rmSync, statSync } from 'fs';
import { basename, isAbsolute, join, relative } from 'path';
import chalk from 'chalk';
import { formatBytes, isOnMountedVolume, listMountedVolumes, measuredDirectorySize } from '../../fs-util.ts';
import { isJsonObject, readJsonFile } from '../../json-file.ts';
import { getConfigDir, isPathPrefix, loadConfig } from '../../workspace/config.ts';
import { emptyWorkspaceDir, workspaceInUse, withIdleWorkspace } from '../../workspace/in-use.ts';
import { workspaceName } from '../../workspace/paths.ts';
import { workspaceLastUsed } from '../../workspace/workspace-state.ts';
import { canonicalPath } from './paths.ts';
import type { GcSkip } from './types.ts';

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
    const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT';
    return {
      projectRoot: null,
      problem: missing ? 'it has no workspace.json' : 'its workspace.json does not parse',
    };
  }
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

function rootPresence(path: string): boolean | null {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? false : null;
  }
}

export function collectOrphanedWorkspaces(
  registryKeys: readonly string[],
  mountedVolumes: string[],
): { orphaned: OrphanedWorkspace[]; skipped: GcSkip[] } {
  const classified = classifyWorkspaceDirs(listWorkspaceDirs(), {
    registryKeys,
    exists: rootPresence,
    isMounted: (path) => isOnMountedVolume(path, mountedVolumes),
    inUse: (root) => workspaceInUse(root),
  });
  return {
    orphaned: classified.orphaned.map((entry) => Object.assign({}, entry, { bytes: sizeOf(entry.dir) })),
    skipped: classified.skipped,
  };
}

export const REBUILD_COST: string =
  'The next build of an unchanged app installs from the shared build cache; after a native change the ' +
  'compilation cache speeds the rebuild, but on React Native 0.86 Swift does not use it (explicit modules ' +
  'are off), so that build recompiles Swift.';

export const WORKSPACE_OUTPUT_DIRS: readonly string[] = [
  'derived-data',
  'gradle-build',
  'android-cas',
  'cache-provider',
];

const DAY_MS = 24 * 60 * 60 * 1000;

export interface WorkspaceOutputs {
  dir: string;
  projectRoot: string | null;
  bytes: number | null;
  idleDays: number | null;
  willClear: boolean;
  keptReason: string | null;
}

export interface WorkspaceOutputsReport {
  root: string;
  workspaces: WorkspaceOutputs[];
}

export function planWorkspaceOutputs(
  entries: readonly (WorkspaceDirEntry & { bytes: number | null; lastUsed: number; inUse: string[] })[],
  { olderThan, now }: { olderThan: number | null; now: number },
): WorkspaceOutputs[] {
  return entries.map(({ dir, projectRoot, problem, bytes, lastUsed, inUse }) => {
    const idleDays = Number.isFinite(lastUsed) ? Math.max(0, Math.floor((now - lastUsed) / DAY_MS)) : null;
    const keptReason =
      projectRoot === null
        ? `workspace directory not resolved: ${problem ?? 'unknown project root'}`
        : inUse.length
          ? `in use: ${inUse.join('; ')}`
          : olderThan === null
            ? null
            : idleDays === null
              ? 'its last use is unknown'
              : idleDays < olderThan
                ? `used ${idleDays}d ago, within --older-than ${olderThan}`
                : null;
    return { dir, projectRoot, bytes, idleDays, willClear: keptReason === null, keptReason };
  });
}

const SIZE_TIMEOUT_MS = 60_000;

function sizeOf(dir: string): number | null {
  return measuredDirectorySize(dir, { timeoutMs: SIZE_TIMEOUT_MS });
}

function outputPaths(dir: string): string[] {
  return WORKSPACE_OUTPUT_DIRS.map((name) => join(dir, name)).filter((path) => existsSync(path));
}

function outputBytes(paths: readonly string[]): number | null {
  let total = 0;
  for (const path of paths) {
    const size = sizeOf(path);
    if (size === null) return null;
    total += size;
  }
  return total;
}

export function collectWorkspaceOutputs({
  olderThan,
  now,
  exclude = [],
}: {
  olderThan: number | null;
  now: number;
  exclude?: readonly string[];
}): WorkspaceOutputsReport {
  const mountedVolumes = listMountedVolumes();
  const entries = listWorkspaceDirs()
    .filter((entry) => !exclude.includes(entry.dir))
    .filter((entry) => entry.projectRoot === null || isOnMountedVolume(entry.projectRoot, mountedVolumes))
    .map((entry) => Object.assign({}, entry, { paths: outputPaths(entry.dir) }))
    .filter((entry) => entry.paths.length > 0)
    .map(({ paths, ...entry }) => Object.assign({}, entry, { bytes: outputBytes(paths) }))
    .map((entry) =>
      Object.assign({}, entry, {
        lastUsed: entry.projectRoot === null ? NaN : workspaceLastUsed(entry.projectRoot),
        inUse: entry.projectRoot === null ? [] : workspaceInUse(entry.projectRoot),
      }),
    );
  return { root: workspacesRoot(), workspaces: planWorkspaceOutputs(entries, { olderThan, now }) };
}

export async function clearWorkspaceOutputs(
  report: WorkspaceOutputsReport,
  { olderThan, now = Date.now() }: { olderThan: number | null; now?: number },
): Promise<number> {
  let failures = 0;
  let cleared = 0;
  for (const entry of report.workspaces) {
    const root = entry.projectRoot;
    if (!entry.willClear || root === null) {
      if (entry.keptReason) {
        console.log(chalk.dim(`Kept the build outputs of ${root ?? entry.dir}: ${entry.keptReason}`));
      }
      continue;
    }
    let run;
    try {
      run = await withIdleWorkspace(
        root,
        () => {
          const [again] = planWorkspaceOutputs(
            [{ ...entry, problem: null, lastUsed: workspaceLastUsed(root), inUse: [] }],
            { olderThan, now },
          );
          if (again?.keptReason) return again.keptReason;
          for (const name of WORKSPACE_OUTPUT_DIRS) rmSync(join(entry.dir, name), { recursive: true, force: true });
          return null;
        },
        { purpose: 'gc' },
      );
    } catch (error) {
      failures++;
      console.log(
        chalk.red(`Could not clear the build outputs of ${root}: ${(error as Error)?.message || String(error)}`),
      );
      continue;
    }
    const kept = run.ran ? run.value : `in use: ${run.reasons.join('; ')}`;
    if (kept) {
      console.log(chalk.yellow(`Kept the build outputs of ${root}: ${kept}`));
      continue;
    }
    cleared += entry.bytes ?? 0;
    console.log(chalk.green(`Cleared the build outputs of ${root} (${sizeText(entry.bytes)})`));
  }
  if (cleared) {
    console.log(chalk.dim(`Cleared ${formatBytes(cleared)} of workspace build outputs. ${REBUILD_COST}`));
  }
  return failures;
}

function stillOrphaned({ dir, projectRoot }: OrphanedWorkspace): boolean {
  const recorded = readRecordedRoot(dir, basename(dir));
  if (recorded.projectRoot !== projectRoot || rootPresence(projectRoot) !== false || !isOnMountedVolume(projectRoot)) {
    return false;
  }
  return !Object.keys(loadConfig()?.projects ?? {}).some((key) => isPathPrefix(projectRoot, key));
}

export async function deleteOrphanedWorkspaces(orphaned: readonly OrphanedWorkspace[]): Promise<number> {
  let failures = 0;
  for (const entry of orphaned) {
    if (!existsSync(entry.dir)) continue;
    let run;
    try {
      run = await withIdleWorkspace(
        entry.projectRoot,
        () => {
          if (!stillOrphaned(entry)) return false;
          emptyWorkspaceDir(entry.dir);
          return true;
        },
        { purpose: 'gc' },
      );
    } catch (error) {
      failures++;
      console.log(chalk.red(`Could not remove ${entry.dir}: ${(error as Error)?.message || error}`));
      continue;
    }
    if (!run.ran) {
      console.log(chalk.yellow(`Kept ${entry.dir}: ${run.reasons.join('; ')}`));
      continue;
    }
    if (!run.value) {
      console.log(chalk.yellow(`Kept ${entry.dir}: it can no longer be confirmed orphaned.`));
      continue;
    }
    const size = entry.bytes === undefined ? '' : ` (${sizeText(entry.bytes)})`;
    console.log(chalk.green(`Removed the orphaned workspace directory ${entry.dir}${size}`));
  }
  return failures;
}

export function sizeText(bytes: number | null): string {
  return bytes === null ? 'size unknown' : formatBytes(bytes);
}
