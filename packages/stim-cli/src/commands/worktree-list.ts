import type { StimContext } from '@stim-cli/core';
import { readDiskUsage, readDiskUsagePartial, readGcMark, readGcMarks, type DaemonMode } from '@stim-cli/core/state';
import { existsSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { defineOp, type Op } from '../cli/define-op.ts';
import { runProcessOperation } from '../cli-operation.ts';
import { freshMeasure, refreshMeasure } from '../disk-usage.ts';
import { daemonMode } from '../daemon/mode.ts';
import { formatLongDuration, plural } from '../command-output.ts';
import { formatBytes } from '../fs-util.ts';
import { listWorktreesAsync, resolveSourceCheckoutAsync, type WorktreeEntry } from '../workspace/worktree.ts';
import { canonicalPath } from './gc/paths.ts';
import { eachLimited, sizeConcurrency } from './gc/limited.ts';
import { phase } from './gc/progress.ts';

const DAY = 86_400_000;
const OLD_DAYS = 30;
const LARGE_BYTES = 1024 ** 3;
const BUDGET_MS = 120_000;
const MEASURE_OPTIONS = { private: true, maxAgeMs: 60 * 60_000 };

interface ListingEntry {
  path: string;
  branch: string | null;
  idleDays: number | null;
  realBytes: number | null;
  apparentBytes: number | null;
  measuredAt: string | null;
  willRemove: boolean | null;
  reason: string | null;
  detail: string | null;
  checkedAt: string | null;
  old: boolean;
  large: boolean;
}

interface Summary {
  count: number;
  realBytes: number;
  unmeasured: number;
  unchecked: number;
  removeBytes: number;
  keptBytes: number;
  kept: { reason: string; count: number; realBytes: number }[];
}

function summarize(entries: ListingEntry[]): Summary {
  const kept = new Map<string, Summary['kept'][number]>();
  for (const entry of entries) {
    if (entry.willRemove !== false || !entry.reason) continue;
    const group = kept.get(entry.reason) ?? { reason: entry.reason, count: 0, realBytes: 0 };
    group.count++;
    group.realBytes += entry.realBytes ?? 0;
    kept.set(entry.reason, group);
  }
  const sum = (select: (entry: ListingEntry) => boolean) =>
    entries.filter(select).reduce((bytes, entry) => bytes + (entry.realBytes ?? 0), 0);
  return {
    count: entries.length,
    realBytes: sum(() => true),
    unmeasured: entries.filter((entry) => entry.realBytes === null).length,
    unchecked: entries.filter((entry) => entry.willRemove === null).length,
    removeBytes: sum((entry) => entry.willRemove === true),
    keptBytes: sum((entry) => entry.willRemove === false),
    kept: [...kept.values()].toSorted((a, b) => b.realBytes - a.realBytes || a.reason.localeCompare(b.reason)),
  };
}

function sizes(root: string) {
  const measure = readDiskUsage(root);
  return {
    realBytes: readDiskUsagePartial(root) ? null : (measure?.privateBytes ?? null),
    apparentBytes: measure?.bytes ?? null,
    measuredAt: measure?.measuredAt ?? null,
  };
}

function linked(entries: WorktreeEntry[], repository: string): WorktreeEntry[] {
  return entries.filter((entry) => !entry.bare && !entry.prunable && canonicalPath(entry.path) !== repository);
}

function idleDays(times: (number | null | undefined)[], now: number): number | null {
  const known = times.filter((time): time is number => time != null && Number.isFinite(time));
  return known.length ? Math.max(0, Math.floor((now - Math.max(...known)) / DAY)) : null;
}

/**
 * Builds a listing from saved observations and measures. With `measure`, it first walks each worktree whose measure is
 * missing or over an hour old, under a two minute budget for the whole call.
 */
export async function worktreeListPayload(
  repositories: readonly string[],
  {
    measure = false,
    operation,
    scope = 'repository',
  }: { measure?: boolean; operation?: StimContext; scope?: 'repository' | 'machine' } = {},
): Promise<{
  scope: 'repository' | 'machine';
  daemonMode: DaemonMode;
  repositories: {
    repository: string;
    checkedAt: string | null;
    oldestCheckedAt: string | null;
    worktrees: ListingEntry[];
    summary: Summary;
  }[];
  total: Summary;
}> {
  const deadline = Date.now() + BUDGET_MS;
  const listed = await Promise.all(
    [...new Set(repositories.map(canonicalPath))].toSorted().map(async (repository) => ({
      repository,
      entries: linked(
        await listWorktreesAsync(repository, { env: operation?.env, signal: operation?.signal, declareFor: operation }),
        repository,
      ),
    })),
  );
  if (measure) {
    const jobs = listed
      .flatMap(({ entries }) => entries.map(({ path }) => canonicalPath(path)))
      .filter((path) => !freshMeasure(path, MEASURE_OPTIONS));
    if (jobs.length) phase('measuring', plural(jobs.length, 'worktree'), operation);
    await eachLimited(jobs, sizeConcurrency(operation), async (path) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await refreshMeasure(path, {
        ...MEASURE_OPTIONS,
        timeoutMs: Math.min(30_000, remaining),
        operation,
        admit: () => Date.now() < deadline,
      });
    });
  }
  const now = Date.now();
  const result = listed.map(({ repository, entries }) => {
    const worktrees: ListingEntry[] = entries.map((entry) => {
      const path = canonicalPath(entry.path);
      const observation = (readGcMark(entry.path) ?? readGcMark(path))?.worktree;
      const idle = idleDays(
        [
          observation?.lastUsedAt ? Date.parse(observation.lastUsedAt) : null,
          observation?.activity ? Date.parse(observation.activity.at) : null,
        ],
        now,
      );
      const disk = sizes(path);
      return {
        path,
        branch: entry.branch ?? null,
        idleDays: idle,
        ...disk,
        willRemove: observation ? !observation.keep : null,
        reason: observation?.keep?.code ?? null,
        detail: observation
          ? (observation.keep?.reason.replace(/^kept: /, '') ?? observation.finished?.reason ?? 'no reason to keep it')
          : null,
        checkedAt: observation?.markedAt ?? null,
        old: idle !== null && idle >= OLD_DAYS,
        large: disk.realBytes !== null && disk.realBytes >= LARGE_BYTES,
      };
    });
    sortEntries(worktrees);
    const checks = worktrees
      .flatMap((entry) => (entry.checkedAt ? [entry.checkedAt] : []))
      .toSorted((a, b) => Date.parse(a) - Date.parse(b));
    return {
      repository,
      checkedAt: checks.at(-1) ?? null,
      oldestCheckedAt: checks[0] ?? null,
      worktrees,
      summary: summarize(worktrees),
    };
  });
  return {
    scope,
    daemonMode: daemonMode(operation?.env),
    repositories: result,
    total: summarize(result.flatMap((repo) => repo.worktrees)),
  };
}

function worktreeCheckAgeLine(
  checkedAt: string | null,
  oldestCheckedAt: string | null,
  now: number = Date.now(),
): string {
  if (checkedAt === null)
    return 'The maintenance worktree check has not run for this repository; run stim worktree list in this repository for current verdicts.';
  const newest = Date.parse(checkedAt);
  const oldest = oldestCheckedAt === null ? newest : Date.parse(oldestCheckedAt);
  return `checked ${formatLongDuration(Math.max(0, now - newest))} ago${newest - oldest > DAY ? `, oldest ${formatLongDuration(Math.max(0, now - oldest))} ago` : ''}`;
}

function sortEntries(entries: ListingEntry[]): void {
  entries.sort((a, b) => (b.realBytes ?? -1) - (a.realBytes ?? -1) || a.path.localeCompare(b.path));
}

function summaryLine(summary: Summary): string {
  return `${plural(summary.count, 'worktree')}; ${formatBytes(summary.realBytes)} real; ${summary.unmeasured} without a known real size; cleanup removes ${formatBytes(summary.removeBytes)}; reclaimable kept ${formatBytes(summary.keptBytes)}${summary.kept.length ? ` (${summary.kept.map((group) => `${group.reason}: ${group.count}, ${formatBytes(group.realBytes)}`).join('; ')})` : ''}${summary.unchecked ? `; ${summary.unchecked} not checked` : ''}`;
}

export const listOp: Op = defineOp({
  name: 'list',
  description:
    "List this repository's linked worktrees with their real and apparent size, idle time and what cleanup does with each; reads only",
  options: {
    all: {
      flags: '--all',
      description:
        'list the linked worktrees of every repository the maintenance worktree check has observed on this machine, from its saved verdicts',
    },
    json: { flags: '--json', description: 'print the listing as one JSON payload' },
  },
  run: async ({ options }) => {
    const { value, interrupted } = await runProcessOperation(process.cwd(), async (operation) => {
      const source = await resolveSourceCheckoutAsync(operation.cwd, {
        env: operation.env,
        signal: operation.signal,
        declareFor: operation,
      });
      if (!options.all && 'refusal' in source) {
        console.error(source.refusal);
        return 1;
      }
      const repositories = new Set<string>('refusal' in source ? [] : [source.path]);
      if (options.all)
        for (const mark of readGcMarks())
          if (mark.worktree?.source && existsSync(mark.worktree.source)) repositories.add(mark.worktree.source);
      const payload = await worktreeListPayload([...repositories], {
        measure: true,
        operation,
        scope: options.all ? 'machine' : 'repository',
      });
      if (options.all && payload.daemonMode === 'off')
        console.error(
          'Automatic maintenance is off on this machine, so saved verdicts are not refreshed. Run stim worktree list in a repository to check it now.',
        );
      if (!options.all) {
        const roots = payload.repositories.flatMap((repo) => repo.worktrees.map((entry) => entry.path));
        const { collectWorktreeSweep, worktreeRemovalReason, worktreeActivityOfAsync } =
          await import('./gc/worktrees.ts');
        const sweep = await collectWorktreeSweep({
          idle: false,
          olderThan: null,
          refresh: false,
          now: Date.now(),
          operation,
          within: roots,
        });
        for (const repo of payload.repositories) {
          repo.checkedAt = new Date(sweep.now).toISOString();
          repo.oldestCheckedAt = repo.checkedAt;
          for (const entry of repo.worktrees) {
            const verdict = sweep.worktrees.find((candidate) => canonicalPath(candidate.path) === entry.path);
            if (!verdict) {
              Object.assign(entry, { willRemove: null, reason: null, detail: null, checkedAt: null });
              continue;
            }
            entry.willRemove = !verdict.skipped;
            entry.reason = verdict.skipCode;
            entry.detail = verdict.skipped?.replace(/^kept: /, '') ?? worktreeRemovalReason(verdict, sweep);
            entry.checkedAt = new Date(sweep.now).toISOString();
            const activity =
              verdict.idleDays === null && verdict.activity === null
                ? await worktreeActivityOfAsync(entry.path, [], operation)
                : verdict.activity;
            entry.idleDays = idleDays(
              [verdict.idleDays === null ? null : sweep.now - verdict.idleDays * DAY, activity?.at],
              sweep.now,
            );
            entry.old = entry.idleDays !== null && entry.idleDays >= OLD_DAYS;
          }
          repo.summary = summarize(repo.worktrees);
        }
        payload.total = summarize(payload.repositories.flatMap((repo) => repo.worktrees));
      }
      for (const repo of payload.repositories) sortEntries(repo.worktrees);
      if (options.json) console.log(JSON.stringify(payload));
      else {
        for (const repo of payload.repositories) {
          if (options.all)
            console.log(`${repo.repository} | ${worktreeCheckAgeLine(repo.checkedAt, repo.oldestCheckedAt)}`);
          for (const entry of repo.worktrees) {
            const rel = relative(repo.repository, entry.path);
            const path = rel && !rel.startsWith(`..${sep}`) && rel !== '..' ? rel : entry.path;
            const size =
              entry.apparentBytes === null
                ? 'not measured'
                : `${entry.realBytes === null ? 'real unknown' : `${formatBytes(entry.realBytes)} real`}, ${formatBytes(entry.apparentBytes)} apparent`;
            const state =
              entry.willRemove === null
                ? 'not checked'
                : `${entry.willRemove ? 'removed by cleanup' : 'kept'}: ${entry.detail}`;
            console.log(
              `${path} | ${entry.branch ?? 'detached'} | idle ${entry.idleDays === null ? '?' : `${entry.idleDays}d`} | ${size} | ${state}${entry.old ? ' | old' : ''}${entry.large ? ' | large' : ''}`,
            );
          }
          console.log(summaryLine(repo.summary));
        }
        if (options.all) console.log(`${payload.repositories.length} repositories; ${summaryLine(payload.total)}`);
      }
      return 0;
    });
    process.exitCode = interrupted ?? value ?? 1;
  },
});
