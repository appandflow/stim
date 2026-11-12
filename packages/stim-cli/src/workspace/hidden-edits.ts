import { gitQuietAsync } from './git.ts';

/**
 * A tracked file hidden from git status (assume-unchanged or skip-worktree), whose edit removal would lose silently.
 * A sparse checkout tags the entries it leaves out the same way as skip-worktree, so those keep the worktree too.
 */
export async function hiddenEditHold(path: string, signal?: AbortSignal): Promise<string | null> {
  const listed = await gitQuietAsync(path, ['ls-files', '-v', '-z'], { signal });
  if (listed === null) return 'git cannot list its tracked files';
  for (const record of listed.split('\0')) {
    const tag = record[0];
    if (tag !== undefined && record.length > 2 && (tag === 'S' || (tag >= 'a' && tag <= 'z')))
      return `its tracked file ${record.slice(2)} is marked ${tag === 'S' ? 'skip-worktree (by a sparse checkout or by hand)' : 'assume-unchanged'}, so git status may not show an edit to it`;
  }
  return null;
}
