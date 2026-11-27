import { mkdirSync } from 'node:fs';
import { configDir } from '@stim-cli/core';
import { getExecutor, windowsDetachedLaunchArgs } from '../exec.ts';
import { spawnEntry } from '../spawn-entry.ts';

/**
 * Starts `stim __job worktree-sizes <repository>...` detached, so the sizes `stim worktree list` lacks are measured
 * after it returns. Resolves nothing: the job writes the disk-usage cache the next listing reads. False when the
 * process could not be started.
 */
export function startWorktreeSizes(repositories: readonly string[], env: NodeJS.ProcessEnv): boolean {
  const entry = spawnEntry('cli');
  const args = [entry, '__job', 'worktree-sizes', ...repositories];
  const cwd = configDir();
  try {
    mkdirSync(cwd, { recursive: true });
    const launcher =
      process.platform === 'win32'
        ? windowsDetachedLaunchArgs({ file: process.execPath, args, cwd, console: 'hidden' })
        : null;
    const child = getExecutor().spawn(launcher?.file ?? process.execPath, launcher?.args ?? args, {
      cwd,
      detached: !launcher,
      stdio: 'ignore',
      env: { ...env, ...launcher?.env },
      windowsHide: true,
    });
    child.once?.('error', () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}
