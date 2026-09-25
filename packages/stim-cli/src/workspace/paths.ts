import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'path';
import { workspaceName, workspaceStateDir as workspaceDir } from '@stim-cli/core';
import { readJsonObject, workspaceMetadataFile } from '@stim-cli/core/state';
import { withDirLock } from '../dir-lock.ts';

export { buildCacheRoot as sharedBuildCache, metroCacheRoot as sharedMetroCache, workspaceId } from '@stim-cli/core';
export { workspaceName, workspaceDir };
export {
  emulatorLogFile,
  sharedCcache,
  sharedCompilationCache,
  supervisorLogFile,
  supervisorPidFile,
  workspaceDerivedData,
  workspaceLogErrorIndex,
  workspaceLogsDir,
  workspaceMetadataFile,
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
  mkdirSync(dir, { recursive: true });
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
      `Stim workspace collision at ${dir}: its workspace.json does not belong to ${canonicalRoot}.`,
    ) as Error & { code?: string };
    error.code = 'STIM_WORKSPACE_COLLISION';
    throw error;
  });
}
