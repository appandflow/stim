// compat C20 permanent
/** What a removed flag of `command` was replaced by, or null when it was never a flag of that command. */
export function removedFlagReplacement(command: string, flag: string): string | null {
  return REMOVED_FLAGS[command]?.[flag.split('=')[0] ?? flag] ?? null;
}
// compat end

// compat C32 until 2.1.0
const REMOVED_FLAGS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  gc: {
    '--delete': 'stim gc deletes by default; use --dry-run to report what it would delete',
    '--older-than': 'age limits are the maintenance.olderThanDays and idle.dormantDays settings',
    '--cache':
      'no flag selects one cache now; stim gc runs one pass at the measured level, and stim gc --dry-run --pressure critical shows what the widest pass would remove',
    '--worktrees':
      'the maintenance.removeFinishedWorktrees and maintenance.removeIdleWorktrees settings decide which worktrees the pass removes; use stim worktree remove for one worktree',
  },
};
// compat end
