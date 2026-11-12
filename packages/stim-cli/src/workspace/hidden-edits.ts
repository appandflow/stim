import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { quotedPath } from '@stim-cli/core';
import { gitQuietAsync } from './git.ts';

/**
 * A tracked file hidden from git status (assume-unchanged, or skip-worktree with the file on disk), whose edit removal
 * would lose silently. A sparse checkout tags the files it leaves out skip-worktree too, but they are absent from disk,
 * so no edit to them exists and they do not hold.
 */
export async function hiddenEditHold(path: string, signal?: AbortSignal): Promise<string | null> {
  const listed = await gitQuietAsync(path, ['ls-files', '-v', '-z'], { signal });
  if (listed === null) return 'git cannot list its tracked files';
  for (const record of listed.split('\0')) {
    const tag = record[0];
    if (tag === undefined || record.length <= 2) continue;
    const skipWorktree = tag === 'S';
    if (!skipWorktree && !(tag >= 'a' && tag <= 'z')) continue;
    const file = record.slice(2);
    if (
      skipWorktree &&
      !(await lstat(join(path, file)).then(
        () => true,
        () => false,
      ))
    )
      continue;
    const kind = skipWorktree ? 'skip-worktree' : 'assume-unchanged';
    return `its tracked file ${file} is marked ${kind}, so git status may not show an edit to it; show it with git -C ${quotedPath(path)} update-index --no-${kind} ${quotedPath(file)}, then commit or discard it`;
  }
  return null;
}
