import { existsSync, readdirSync, statSync } from 'fs';
import { basename, isAbsolute, join } from 'path';
import chalk from 'chalk';
import { directorySize, formatBytes, isOnMountedVolume } from '../../fs-util.ts';
import { isJsonObject, readJsonFile } from '../../json-file.ts';
import { getConfigDir, isPathPrefix, loadConfig } from '../../workspace/config.ts';
import { emptyWorkspaceDir, workspaceInUse, withIdleWorkspace } from '../../workspace/in-use.ts';
import { workspaceName } from '../../workspace/paths.ts';
import type { GcSkip } from './types.ts';

export interface WorkspaceDirEntry {
  dir: string;
  projectRoot: string | null;
  problem: string | null;
}

export interface OrphanedWorkspace {
  dir: string;
  projectRoot: string;
  bytes?: number;
}

function workspacesRoot(): string {
  return join(getConfigDir(), 'workspaces');
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
    exists: (path: string) => boolean;
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
    if (exists(projectRoot)) continue;
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

export function collectOrphanedWorkspaces(
  registryKeys: readonly string[],
  mountedVolumes: string[],
): { orphaned: OrphanedWorkspace[]; skipped: GcSkip[] } {
  const classified = classifyWorkspaceDirs(listWorkspaceDirs(), {
    registryKeys,
    exists: existsSync,
    isMounted: (path) => isOnMountedVolume(path, mountedVolumes),
    inUse: (root) => workspaceInUse(root),
  });
  return {
    orphaned: classified.orphaned.map((entry) => Object.assign({}, entry, { bytes: directorySize(entry.dir) })),
    skipped: classified.skipped,
  };
}

function stillOrphaned({ dir, projectRoot }: OrphanedWorkspace): boolean {
  const recorded = readRecordedRoot(dir, basename(dir));
  if (recorded.projectRoot !== projectRoot || existsSync(projectRoot) || !isOnMountedVolume(projectRoot)) {
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
    const size = entry.bytes === undefined ? '' : ` (${formatBytes(entry.bytes)})`;
    console.log(chalk.green(`Removed the orphaned workspace directory ${entry.dir}${size}`));
  }
  return failures;
}
