import type { StimContext } from '@stim-cli/core';
import { readDiskUsage, readDiskUsagePartial, readGcMark, readGcMarks, type DaemonMode } from '@stim-cli/core/state';
import { resolveMaintenanceSettings, type MaintenanceSettings } from '../stimd/passes/settings.ts';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { defineOp, type Op } from '../cli/define-op.ts';
import { runProcessOperation } from '../cli-operation.ts';
import { freshMeasure, refreshMeasure, trustedMeasure } from '../disk-usage.ts';
import { daemonMode } from '../daemon/mode.ts';
import { formatLongDuration, plural } from '../command-output.ts';
import { formatSize } from '../fs-util.ts';
import {
  insideGitCheckout,
  listWorktreesAsync,
  resolveSourceCheckoutAsync,
  type WorktreeEntry,
} from '../workspace/worktree.ts';
import { canonicalPath } from './gc/paths.ts';
import { eachLimited, sizeConcurrency } from './gc/limited.ts';
import { phase } from './gc/progress.ts';
import { ARTIFACT_DIRS } from '../workspace/regenerable-dirs.ts';

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
  /** Set when a walk left part of the worktree out, so `realBytes` and `apparentBytes` are lower bounds. */
  partial?: true;
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
  realPartial?: true;
  unmeasured: number;
  unchecked: number;
  removeBytes: number;
  removePartial?: true;
  keptBytes: number;
  keptPartial?: true;
  kept: { reason: string; count: number; realBytes: number; partial?: true }[];
}

function applyRemovalSettings(entry: ListingEntry, finished: boolean, settings: MaintenanceSettings): void {
  if (!entry.willRemove) return;
  const setting = !settings.removeFinishedWorktrees
    ? 'maintenance.removeFinishedWorktrees is off'
    : finished
      ? null
      : !settings.removeIdleWorktrees
        ? 'maintenance.removeIdleWorktrees is off'
        : settings.olderThanDays <= 0
          ? 'maintenance.olderThanDays is 0'
          : null;
  if (!setting) return;
  entry.willRemove = false;
  entry.reason = 'removal-off';
  entry.detail = `${entry.detail}; cleanup would remove it but ${setting}`;
}

function lowerBound(entry: ListingEntry): boolean {
  return entry.partial === true && entry.realBytes !== null;
}

function summarize(entries: ListingEntry[]): Summary {
  const kept = new Map<string, Summary['kept'][number]>();
  for (const entry of entries) {
    if (entry.willRemove !== false || !entry.reason) continue;
    const group = kept.get(entry.reason) ?? { reason: entry.reason, count: 0, realBytes: 0 };
    group.count++;
    group.realBytes += entry.realBytes ?? 0;
    if (lowerBound(entry)) group.partial = true;
    kept.set(entry.reason, group);
  }
  const sum = (select: (entry: ListingEntry) => boolean) =>
    entries.filter(select).reduce((bytes, entry) => bytes + (entry.realBytes ?? 0), 0);
  const bound = (select: (entry: ListingEntry) => boolean) =>
    entries.some((entry) => select(entry) && lowerBound(entry));
  return {
    count: entries.length,
    realBytes: sum(() => true),
    ...(bound(() => true) ? { realPartial: true as const } : {}),
    unmeasured: entries.filter((entry) => entry.realBytes === null).length,
    unchecked: entries.filter((entry) => entry.willRemove === null).length,
    removeBytes: sum((entry) => entry.willRemove === true),
    ...(bound((entry) => entry.willRemove === true) ? { removePartial: true as const } : {}),
    keptBytes: sum((entry) => entry.willRemove === false),
    ...(bound((entry) => entry.willRemove === false) ? { keptPartial: true as const } : {}),
    kept: [...kept.values()].toSorted((a, b) => b.realBytes - a.realBytes || a.reason.localeCompare(b.reason)),
  };
}

function restKey(root: string): string {
  return root + sep + '.';
}

function dependencies(root: string): string[] {
  return ARTIFACT_DIRS.dependencies.map((dir) => join(root, dir));
}

function wholeWalk(root: string): boolean {
  // real-size counts a file shared between two measured paths as private in neither, as a store and node_modules are.
  if (existsSync(join(root, '.pnpm-store'))) return true;
  try {
    return ![join(root, 'ios'), ...dependencies(root)].every(
      (path) => lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ?? true,
    );
  } catch {
    return true;
  }
}

function restTargets(root: string): string[] {
  const skip = new Set(dependencies(root));
  const visit = (dir: string): string[] => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [dir];
    }
    return names.flatMap((name) => {
      const path = join(dir, name);
      if (skip.has(path)) return [];
      return [...skip].some((tree) => tree.startsWith(path + sep)) ? visit(path) : [path];
    });
  };
  return visit(root);
}

function sizes(root: string): Pick<ListingEntry, 'realBytes' | 'apparentBytes' | 'partial' | 'measuredAt'> {
  const whole = readDiskUsage(root);
  if (!wholeWalk(root)) {
    const paths = [...dependencies(root), restKey(root)];
    const parts = paths.map((path) => trustedMeasure(path));
    if (parts.every((part) => part !== null)) {
      const measuredAt = parts.map((part) => part.measuredAt).toSorted()[0] ?? null;
      const rest = parts.at(-1);
      if (measuredAt !== null && rest && (!whole || Date.parse(whole.measuredAt) <= Date.parse(rest.measuredAt)))
        return {
          realBytes: parts.some((part) => part.privateBytes == null)
            ? null
            : parts.reduce((sum, part) => sum + (part.privateBytes ?? 0), 0),
          apparentBytes: parts.reduce((sum, part) => sum + part.bytes, 0),
          ...(paths.some((path) => readDiskUsagePartial(path)) ? { partial: true as const } : {}),
          measuredAt,
        };
    }
  }
  return {
    realBytes: whole?.privateBytes ?? null,
    apparentBytes: whole?.bytes ?? null,
    ...(whole && readDiskUsagePartial(root) ? { partial: true as const } : {}),
    measuredAt: whole?.measuredAt ?? null,
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
 * Builds a listing from saved observations and measures. With `measure`, dependency trees follow their install and clone-group
 * validity rule; the rest is walked hourly. A project-local .pnpm-store requires a whole hourly walk.
 * All walks share a two minute budget for the whole call.
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
  const settings = resolveMaintenanceSettings(undefined, operation?.env ?? process.env);
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
    const roots = listed.flatMap(({ entries }) => entries.map(({ path }) => canonicalPath(path)));
    const jobs = roots.flatMap((root) =>
      (wholeWalk(root)
        ? [{ path: root, options: MEASURE_OPTIONS }]
        : [
            ...dependencies(root).map((path) => ({ path, options: {} })),
            { path: restKey(root), options: { ...MEASURE_OPTIONS, targets: () => restTargets(root) } },
          ]
      ).map((job) => ({ path: job.path, options: job.options, root })),
    );
    const due = jobs.filter(({ path, options }) => !freshMeasure(path, options));
    if (due.length) phase('measuring', plural(new Set(due.map(({ root }) => root)).size, 'worktree'), operation);
    await eachLimited(due, sizeConcurrency(operation), async ({ path, options }) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await refreshMeasure(path, {
        ...options,
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
      const item: ListingEntry = {
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
      applyRemovalSettings(item, observation?.finished != null || observation?.emptyBranch === true, settings);
      return item;
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

export function worktreeCheckAgeLine(
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

export function summaryLine(summary: Summary): string {
  return `${plural(summary.count, 'worktree')}; ${formatSize({ bytes: summary.realBytes, partial: summary.realPartial })} real; ${summary.unmeasured} without a known real size; cleanup removes ${formatSize({ bytes: summary.removeBytes, partial: summary.removePartial })}; reclaimable kept ${formatSize({ bytes: summary.keptBytes, partial: summary.keptPartial })}${summary.kept.length ? ` (${summary.kept.map((group) => `${group.reason}: ${group.count}, ${formatSize({ bytes: group.realBytes, partial: group.partial })}`).join('; ')})` : ''}${summary.unchecked ? `; ${summary.unchecked} not checked` : ''}`;
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
        const noRepository = !source.entries.length;
        const gitFailed = noRepository && insideGitCheckout(operation.cwd);
        const message = gitFailed
          ? `git could not list the worktrees of the repository at ${operation.cwd}.`
          : noRepository
            ? 'No git repository was found from this directory.'
            : source.refusal;
        const remedy = gitFailed
          ? 'Run git worktree list here to see why, fix it, then run stim worktree list again.'
          : noRepository
            ? 'Run stim worktree list inside a git repository, or pass --all.'
            : 'Run the commands in the message, then run it again.';
        console.error(noRepository ? `${message} ${remedy}` : message);
        if (options.json) console.log(JSON.stringify({ code: 'STIM_BAD_ARG', message, remedy }));
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
        const settings = resolveMaintenanceSettings(undefined, operation.env);
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
            applyRemovalSettings(entry, true, settings);
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
                : `${entry.realBytes === null ? 'real unknown' : `${formatSize({ bytes: entry.realBytes, partial: entry.partial })} real`}, ${formatSize({ bytes: entry.apparentBytes, partial: entry.partial })} apparent`;
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
