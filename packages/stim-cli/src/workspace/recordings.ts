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

/** Every registered workspace's `recording.enabled` from the settings files alone, without `STIM_RECORDING`. */
export function recordingLayers(): Map<string, boolean> {
  const config = loadConfig();
  return new Map(
    Object.entries(config?.projects ?? {}).map(([path, project]) => [
      path,
      workspaceRecordingEnabled(path, project, config, {}),
    ]),
  );
}

/**
 * Deletes the recordings of every workspace a settings write turned off, comparing the settings files before
 * (`before`, from {@link recordingLayers}) and after it, and returns those workspaces. stim-server stops
 * recording them once `stim status` shows the change.
 */
export function deleteTurnedOffRecordings(before: ReadonlyMap<string, boolean>): string[] {
  return [...recordingLayers()].flatMap(([path, enabled]) => {
    if (enabled || before.get(path) === false) return [];
    const dir = workspaceRecordingsDir(path);
    if (!existsSync(dir)) return [];
    rmSync(dir, { recursive: true, force: true });
    return [path];
  });
}
