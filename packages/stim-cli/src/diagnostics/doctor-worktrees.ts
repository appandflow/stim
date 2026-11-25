import type { StimContext } from '@stim-cli/core';
import { readGcMarks } from '@stim-cli/core/state';
import { existsSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { plural, formatLongDuration } from '../command-output.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { summaryLine, worktreeCheckAgeLine, worktreeListPayload } from '../commands/worktree-list.ts';
import { formatBytes } from '../fs-util.ts';
import { resolveMaintenanceSettings } from '../stimd/passes/settings.ts';
import { resolveSourceCheckoutAsync } from '../workspace/worktree.ts';
import type { Finding } from './doctor.ts';

export async function linkedWorktreeFindings(
  root: string,
  operation?: StimContext,
  now: number = Date.now(),
): Promise<Finding[]> {
  try {
    const source = await resolveSourceCheckoutAsync(root, {
      env: operation?.env,
      signal: operation?.signal,
      declareFor: operation,
    });
    const repositories = new Set<string>('refusal' in source ? [] : [source.path]);
    for (const mark of readGcMarks())
      if (mark.worktree?.source && existsSync(mark.worktree.source)) repositories.add(mark.worktree.source);
    const payload = await worktreeListPayload([...repositories], { measure: false, scope: 'machine', operation });
    operation?.signal.throwIfAborted();
    const repo =
      'refusal' in source
        ? undefined
        : payload.repositories.find((entry) => entry.repository === canonicalPath(source.path));
    const total = payload.total;
    if (!repo?.summary.count && !total.count) return [];
    const detail: string[] = [];
    if (repo?.summary.count) detail.push(`${summaryLine(repo.summary)}.`);
    const kept = repo?.worktrees.filter((entry) => entry.willRemove === false && (entry.old || entry.large)) ?? [];
    if (kept.length) {
      const names = kept.slice(0, 3).map((entry) => {
        const rel = relative(repo?.repository ?? root, entry.path);
        const path = rel && rel !== '..' && !rel.startsWith(`..${sep}`) ? rel : entry.path;
        return `${path} (${entry.reason}, ${entry.realBytes === null ? 'size not measured' : formatBytes(entry.realBytes)}, idle ${entry.idleDays === null ? 'unknown' : `${entry.idleDays}d`})`;
      });
      detail.push(
        `Old or large kept worktrees: ${names.join('; ')}${kept.length > 3 ? `; and ${kept.length - 3} more` : ''}.`,
      );
    }
    if (repo) {
      const age = worktreeCheckAgeLine(repo.checkedAt, repo.oldestCheckedAt, now);
      detail.push(age.startsWith('checked ') ? `Verdicts ${age}.` : age);
    }
    if (payload.daemonMode === 'off')
      detail.push(
        'Automatic maintenance is off on this machine (daemon.mode), so these saved verdicts and sizes are not refreshed.',
      );
    else if (!resolveMaintenanceSettings(undefined, operation?.env).removeFinishedWorktrees)
      detail.push(
        'The worktree check does not run while maintenance.removeFinishedWorktrees is off, so saved verdicts are not refreshed.',
      );
    if (repo) {
      const times = repo.worktrees.flatMap((entry) => (entry.measuredAt ? [Date.parse(entry.measuredAt)] : []));
      if (times.length)
        detail.push(`Sizes measured up to ${formatLongDuration(Math.max(0, now - Math.min(...times)))} ago.`);
    }
    detail.push(
      `On this machine: ${plural(total.count, 'linked worktree')} in ${plural(payload.repositories.filter((entry) => entry.summary.count > 0).length, 'repository', 'repositories')}, ${formatBytes(total.realBytes)} real, ${formatBytes(total.keptBytes)} held by kept ones${total.unmeasured ? `, ${total.unmeasured} not measured` : ''}${total.unchecked ? `, ${total.unchecked} not checked` : ''}.`,
    );
    return [
      {
        code: 'linked-worktrees',
        level: 'note',
        title: repo?.summary.count
          ? `${plural(repo.summary.count, 'linked worktree')} here use ${formatBytes(repo.summary.realBytes)} real; kept ones hold ${formatBytes(repo.summary.keptBytes)}`
          : `No linked worktrees here; ${plural(total.count, 'linked worktree')} on this machine use ${formatBytes(total.realBytes)} real`,
        detail: detail.join(' '),
        fix: 'Run `stim worktree list` here for current verdicts and sizes, or `stim worktree list --all` for every repository. Doctor reads only saved verdicts and saved sizes; it measures nothing.',
      },
    ];
  } catch {
    operation?.signal.throwIfAborted();
    return [];
  }
}
