import { existsSync } from 'node:fs';
import type { StimContext } from '@stim-cli/core';
import { isJsonObject } from '@stim-cli/core/state';
import { phaseLine } from '../command-output.ts';
import { warmWorktreeTarget } from '../commands/worktree.ts';
import { readWorkspaceState, updateWorkspaceState } from './workspace-state.ts';

/** Workspace state key: the dependency directories gc deleted from the worktree, restored on the next native run. */
export const LIGHTENED_KEY = 'lightenedDependencies';

function lightenedDirs(root: string): string[] {
  const record = readWorkspaceState(root)?.[LIGHTENED_KEY];
  return isJsonObject(record) && Array.isArray(record.dirs)
    ? record.dirs.filter((dir): dir is string => typeof dir === 'string')
    : [];
}

/** Records in each workspace that `dir` was deleted to lighten its worktree. */
export function recordLightened(keys: readonly string[], dir: string, now: Date = new Date()): void {
  for (const key of keys)
    updateWorkspaceState(key, (state) => ({
      ...state,
      [LIGHTENED_KEY]: { at: now.toISOString(), dirs: [...new Set([...lightenedDirs(key), dir])] },
    }));
}

function clearLightened(root: string): void {
  updateWorkspaceState(root, (state) => {
    const { [LIGHTENED_KEY]: _dropped, ...rest } = state;
    return rest;
  });
}

/**
 * Restores the dependencies gc deleted from this workspace's worktree through `stim worktree warm`, or returns the
 * failure to report. A workspace gc never lightened is left alone.
 */
export async function restoreLightenedDependencies(
  root: string,
  operation: StimContext,
): Promise<{ code: string; message: string; remedy: string } | null> {
  const dirs = lightenedDirs(root);
  if (!dirs.length) return null;
  const missing = dirs.filter((dir) => !existsSync(dir));
  if (missing.length) {
    operation.output(
      'stderr',
      `${phaseLine('deps', `gc lightened this worktree; restoring ${missing.join(', ')} with worktree warm`)}\n`,
    );
    if ((await warmWorktreeTarget({ cwd: root, operation })).exitCode !== 0)
      return {
        code: 'STIM_DEPS_FAILED',
        message: `gc lightened this worktree, and worktree warm could not restore ${missing.join(', ')}.`,
        remedy: `Run \`stim worktree warm\` in ${root}, or install the project's dependencies, then retry.`,
      };
  }
  clearLightened(root);
  return null;
}

/** Prints a restore failure the way a native run reports a refusal, with the JSON line on stdout when asked. */
export function printLightenedFailure(
  operation: StimContext,
  failure: { code: string; message: string; remedy: string },
  json: boolean,
): void {
  operation.output('stderr', `${phaseLine('error', `${failure.code}: ${failure.message}`)}\n`);
  operation.output('stderr', `${phaseLine('remedy', failure.remedy)}\n`);
  if (json) operation.output('stdout', `${JSON.stringify(failure)}\n`);
}
