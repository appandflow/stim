import { formatBytes } from '../../fs-util.ts';
import type { LevelRun, LevelRunAction } from '../../stimd/passes/level-run.ts';

const CATEGORIES: Record<string, string> = {
  'clear-outputs': 'Workspace build outputs',
  'delete-build-outputs': 'Workspace build outputs',
  'idle-stage': 'Idle dev servers and their build outputs',
  'clear-build-dirs': 'Workspace build outputs',
  'trim-cargo': 'Cargo target of Exact apps',
  'trim-cache': 'Shared caches',
  'empty-cache': 'Shared caches',
  'unregister-cache': 'Shared caches',
  'remove-worktree': 'Linked worktrees',
  'delete-dependencies': 'node_modules and Pods of idle worktrees',
  'remove-orphan': 'Orphaned workspace directories',
  'prune-project': 'Registry entries of removed projects',
  'delete-parked-device': 'Parked devices',
  'booted-parked': 'Parked devices',
  'delete-hosted-devices': 'Parked devices',
  'delete-devices': 'Owned devices of idle workspaces',
  'dormant-stage': 'Owned devices of idle workspaces',
  'delete-orphaned-devices': 'Owned devices of removed projects',
  'forget-stale-records': 'Stale records',
  'delete-status-caches': 'Stale records',
  'delete-process-locks': 'Stale records',
  'delete-device-lease': 'Stale records',
  'delete-expired-archives': 'Archives',
  'delete-archives': 'Archives',
  'delete-recordings': 'Device recordings',
  'trim-workspace-logs': 'Workspace logs',
  'delete-eas-sessions': 'EAS sessions',
  'stop-gradle-daemons': 'Idle daemons',
  'stop-watchman': 'Idle daemons',
  'delete-gradle-version': 'Unpinned Gradle versions',
  'delete-temp-leftovers': 'Temporary leftovers and trash',
  'delete-trash': 'Temporary leftovers and trash',
  'delete-runtime': 'Unused simulator runtimes',
  'delete-unavailable-sim': 'Owned simulators whose runtime is gone',
  'clean-tool-cache': 'Caches of other tools',
};

const LARGEST_SHOWN = 3;

const categoryOf = (action: Pick<LevelRunAction, 'kind'>): string => CATEGORIES[action.kind] ?? 'Other';

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** One line per action, for the full report a plain run writes to a file. */
export function gcDetailLines(run: LevelRun): string[] {
  const lines = [
    `level ${run.level}; measured ${run.pressure.level}${run.pressure.reasons.length ? `: ${run.pressure.reasons.join('; ')}` : ''}`,
  ];
  for (const action of run.actions)
    lines.push(
      `${action.outcome}\t${formatBytes(action.bytes)}\t${action.rung === null ? 'maintenance' : `rung ${action.rung}`}\t${action.kind}\t${action.target}\t${[action.reason, action.detail].filter(Boolean).join('; ')}${action.restore ? `; restore with ${action.restore}` : ''}`,
    );
  for (const checkout of run.discovered)
    lines.push(
      `discovered\t${checkout.origin}\t${checkout.path}\tfrom ${checkout.from}${checkout.kept ? `; kept: ${checkout.kept}` : ''}`,
    );
  for (const reason of run.blocked) lines.push(`blocked\t${reason}`);
  return lines;
}

/**
 * The plain summary: the level, one line of what was or would be freed, per-category totals with the largest items,
 * then every failure and every reason the run could not decide, which a person has to look at.
 */
export function formatGcSummary(
  run: LevelRun,
  { act, chosen, detail }: { act: boolean; chosen: boolean; detail: string },
): string[] {
  const why = run.pressure.reasons.length ? ` (${run.pressure.reasons.join('; ')})` : '';
  const lines = [
    chosen
      ? `Ran at ${run.level} as --pressure asked; the machine measures ${run.pressure.level}${why}.`
      : `Pressure level ${run.level}${why}.`,
  ];
  const taken = run.actions.filter((action) => action.outcome === (act ? 'done' : 'would'));
  const failed = run.actions.filter((action) => action.outcome === 'failed');
  const kept = run.actions.filter((action) => action.outcome === 'kept');
  const bytes = taken.reduce((sum, action) => sum + action.bytes, 0);
  lines.push(
    act
      ? `Freed about ${formatBytes(bytes)} in ${plural(taken.length, 'action')}; kept ${kept.length}; ${failed.length} failed.`
      : `Dry run: would take ${plural(taken.length, 'action')}, about ${formatBytes(bytes)} where measured; ${kept.length} kept. Nothing was deleted.`,
  );
  const groups = new Map<string, LevelRunAction[]>();
  for (const action of taken) groups.set(categoryOf(action), [...(groups.get(categoryOf(action)) ?? []), action]);
  for (const [category, actions] of [...groups].toSorted(
    (a, b) => b[1].reduce((s, x) => s + x.bytes, 0) - a[1].reduce((s, x) => s + x.bytes, 0),
  )) {
    const total = actions.reduce((sum, action) => sum + action.bytes, 0);
    lines.push(`  ${category} (${actions.length}${total ? `, ${formatBytes(total)}` : ''})`);
    const largest = actions.toSorted((a, b) => b.bytes - a.bytes).slice(0, LARGEST_SHOWN);
    for (const action of largest)
      lines.push(`    ${action.bytes ? `${formatBytes(action.bytes)}  ` : ''}${action.target}`);
    if (actions.length > largest.length) lines.push(`    and ${actions.length - largest.length} more`);
  }
  if (run.discovered.length) {
    lines.push(`Discovered checkouts no stim command ran in (${run.discovered.length}), treated as workspaces:`);
    for (const checkout of run.discovered.slice(0, LARGEST_SHOWN * 4)) {
      const mine = checkout.actions.filter((action) => action.outcome === (act ? 'done' : 'would'));
      const freed = mine.reduce((sum, action) => sum + action.bytes, 0);
      const what = mine.length
        ? mine.map((action) => action.kind.replaceAll('-', ' ')).join(', ')
        : (checkout.actions.find((action) => action.outcome === 'kept')?.detail ??
          (checkout.kept ? `kept: ${checkout.kept}` : 'idle, with no regenerable output to clear'));
      lines.push(`  ${freed ? `${formatBytes(freed)}  ` : ''}${checkout.path} (${checkout.origin}): ${what}`);
    }
    if (run.discovered.length > LARGEST_SHOWN * 4)
      lines.push(`  and ${run.discovered.length - LARGEST_SHOWN * 4} more`);
  }
  const reported = run.actions.filter((action) => action.kind === 'report-tool-cache');
  if (failed.length || run.blocked.length || reported.length) {
    lines.push('Needs a person:');
    for (const action of failed)
      lines.push(`  failed: ${action.kind.replaceAll('-', ' ')} ${action.target}: ${action.detail}`);
    for (const reason of run.blocked) lines.push(`  ${reason}`);
    for (const action of reported) lines.push(`  ${action.target}: ${action.detail}`);
  }
  const usage = run.usage.slice(0, LARGEST_SHOWN + 2);
  const others = run.actions.filter((action) => action.kind === 'clean-tool-cache' && action.outcome === 'kept');
  if (usage.length || others.length) {
    lines.push('Where the disk goes:');
    for (const entry of usage)
      lines.push(`  ${formatBytes(entry.bytes)}  ${entry.name} (${entry.dir}), Stim reclaims it`);
    for (const action of others) lines.push(`  ${action.target}, not Stim's: ${action.detail}`);
  }
  lines.push(`Full detail, kept entries with their reasons included: ${detail}`);
  if (!act) lines.push(`Apply with: stim gc${chosen ? ` --pressure ${run.level}` : ''}`);
  return lines;
}
