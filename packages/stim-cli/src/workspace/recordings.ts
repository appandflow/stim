import { existsSync, rmSync } from 'node:fs';
import {
  loadConfig,
  recordingEnabled,
  workspaceRecordingsDir,
  type Config,
  type ProjectRecord,
} from '@stim-cli/core/state';
import { gitCommonDirOnDisk } from './worktree.ts';

/** `recording.enabled` for one registered workspace, from `STIM_RECORDING` and its workspace, repo and machine layers. */
export function workspaceRecordingEnabled(
  path: string,
  project: ProjectRecord,
  config: Config | null,
  env: NodeJS.ProcessEnv,
): boolean {
  const repo = gitCommonDirOnDisk(path);
  return recordingEnabled(env, [project.settings, repo ? config?.repos?.[repo]?.settings : undefined, config]);
}

/**
 * Deletes the recordings of every registered workspace whose `recording.enabled` is now false, and returns those
 * workspaces. stim-server stops recording such a workspace once its status shows the change.
 */
export function deleteDisabledRecordings(env: NodeJS.ProcessEnv): string[] {
  const config = loadConfig();
  return Object.entries(config?.projects ?? {}).flatMap(([path, project]) => {
    if (workspaceRecordingEnabled(path, project, config, env)) return [];
    const dir = workspaceRecordingsDir(path);
    if (!existsSync(dir)) return [];
    rmSync(dir, { recursive: true, force: true });
    return [path];
  });
}
