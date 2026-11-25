import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'path';
import { ensurePrivateDir, workspaceName, workspaceStateDir as workspaceDir } from '@stim-cli/core';
import { readJsonObject, workspaceMetadataFile } from '@stim-cli/core/state';
import { withDirLock, withDirLockAsync } from '../dir-lock.ts';
import { noteStimHome } from '../engine/stim-home-registry.ts';

export { buildCacheRoot as sharedBuildCache, workspaceId } from '@stim-cli/core';
export { workspaceName, workspaceDir };
export {
  emulatorLogFile,
  sharedCcache,
  sharedCompilationCache,
  supervisorPidFile,
  workspaceDerivedData,
  workspaceLogErrorIndex,
  workspaceLogsDir,
  workspaceAgentDeviceDir,
  workspaceAgentDeviceStateDirs,
  workspaceStateFile,
  workspaceStateLock,
} from '@stim-cli/core/state';

interface WorkspaceMetadata {
  projectRoot: string;
  workspace: string;
  version: 1;
}

export function ensureWorkspaceStorage(projectRoot: string): string {
  const canonicalRoot = resolve(projectRoot);
  const dir = workspaceDir(canonicalRoot);
  const file = workspaceMetadataFile(canonicalRoot);
  ensurePrivateDir(dir);
  noteStimHome();
  return withDirLock(join(dir, 'metadata.lock'), () => {
    if (!existsSync(file)) {
      const metadata: WorkspaceMetadata = {
        projectRoot: canonicalRoot,
        workspace: workspaceName(canonicalRoot),
        version: 1,
      };
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(metadata, null, 2)}\n`);
      try {
        renameSync(tmp, file);
      } catch (error) {
        rmSync(tmp, { force: true });
        throw error;
      }
      return dir;
    }
    if (readJsonObject(file)?.projectRoot === canonicalRoot) return dir;
    const error = new Error(
      `Stim workspace collision at ${dir}: its workspace.json does not belong to ${canonicalRoot}. Do not overwrite it until you identify which workspace owns it.`,
    ) as Error & { code?: string; remedy?: string };
    error.code = 'STIM_WORKSPACE_COLLISION';
    error.remedy =
      'Read workspace.json in that directory to see which project path it names, and change nothing until you know.';
    throw error;
  });
}

export function workspaceStateRemedy(error: unknown, short = false): string {
  const remedy: unknown =
    error instanceof Error && Reflect.get(error, 'code') === 'STIM_WORKSPACE_COLLISION'
      ? Reflect.get(error, 'remedy')
      : undefined;
  if (typeof remedy === 'string') return remedy;
  const base = 'Check that STIM_HOME is writable and has free space.';
  return short
    ? base
    : `${base} An EPERM on a directory you can write is a sandbox: allow writes to STIM_HOME, or run Stim with the sandbox disabled (\`stim guide errors sandbox\`).`;
}

/** Initializes or validates workspace storage after asynchronously acquiring its metadata lock. */
export function ensureWorkspaceStorageAsync(projectRoot: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const dir = workspaceDir(resolve(projectRoot));
  ensurePrivateDir(dir);
  return withDirLockAsync(join(dir, 'metadata.lock'), () => ensureWorkspaceStorage(projectRoot), { signal });
}
