import type { BuildPlan, BuildReport, DeviceActivity, LastBuild, WorktreeGit } from '@/protocol/types';

const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

/** The `h`/`m` form apps/desktop uses on activity badges. */
export function shortDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d`;
}

export function clockDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(seconds / 60);
  return `${m}:${String(seconds % 60).padStart(2, '0')}`;
}

export type ActivityBadge = { kind: 'driven' | 'idle' | 'unknown'; text: string };

/** Matches apps/desktop ActivityBadge: nothing for a device used in the last 10 minutes. */
export function activityBadge(activity: DeviceActivity | undefined, now: number): ActivityBadge | null {
  if (!activity) return null;
  switch (activity.state) {
    case 'driven': {
      const tool = activity.driver?.tool ?? 'an unknown tool';
      const since = activity.driver?.since ? Date.parse(activity.driver.since) : NaN;
      const text = Number.isFinite(since)
        ? `Driven by ${tool} \u00B7 ${shortDuration(Math.max(0, now - since))}`
        : `Driven by ${tool}`;
      return { kind: 'driven', text };
    }
    case 'idle': {
      const last = activity.lastActivityAt ? Date.parse(activity.lastActivityAt) : NaN;
      if (Number.isFinite(last) && now - last < ACTIVE_WINDOW_MS) return null;
      return { kind: 'idle', text: Number.isFinite(last) ? `Idle ${shortDuration(Math.max(0, now - last))}` : 'Idle' };
    }
    case 'unknown':
      return { kind: 'unknown', text: 'Activity unknown' };
    default:
      return null;
  }
}

export interface BuildProgress {
  elapsedMs: number;
  /** Elapsed over the median of comparable runs, capped below 1; null without history. */
  fraction: number | null;
  remaining: string | null;
}

export function buildProgress(build: BuildReport, now: number): BuildProgress {
  const started = Date.parse(build.startedAt);
  const elapsedMs = Math.max(0, now - (Number.isFinite(started) ? started : now));
  const expected = build.expectedMs;
  if (!expected || expected <= 0) return { elapsedMs, fraction: null, remaining: null };
  const remainingMs = expected - elapsedMs;
  const remaining =
    remainingMs <= 0
      ? 'longer than usual'
      : remainingMs < 60_000
        ? 'under a minute left'
        : `about ${Math.ceil(remainingMs / 60_000)} min left`;
  return { elapsedMs, fraction: Math.min(elapsedMs / expected, 0.99), remaining };
}

/** Before prebuild, pods, compile or install, `stim status` reports the outcome of the project's previous run. */
export function outcomeLabel(build: Pick<BuildReport, 'outcome' | 'phase'>): string | null {
  if (!build.outcome) return null;
  const settled = !['prepare', 'cache-lookup', 'wait'].includes(build.phase);
  if (build.outcome === 'hit') return settled ? 'Cache hit' : 'Likely cache hit';
  return settled ? 'Cold build' : 'Likely cold';
}

export function lastBuildSummary(last: LastBuild, now: number): string {
  const ended = Date.parse(last.finishedAt ?? last.startedAt);
  const took = `${last.durationMs === null ? '' : ` in ${clockDuration(last.durationMs)}`}${
    Number.isNaN(ended) ? '' : ` \u00B7 ${shortDuration(now - ended)} ago`
  }`;
  if (last.status !== 'ok') return `Failed (${last.errorCode ?? 'error'})${took}`;
  if (last.cacheHit === 'local') return `Local cache${took}`;
  if (last.cacheHit === 'remote') return `Remote cache${took}`;
  return `${last.cacheSkipped ? 'Compiled' : 'Cache miss, compiled'}${took}`;
}

/** What the next build would do, worded to follow "Next build: ". */
export function nextBuild(plan: BuildPlan): string {
  if (plan.refusal) return `would refuse (${plan.refusal.code})`;
  const took = plan.expectedMs === null ? '' : `, ~${clockDuration(plan.expectedMs)}`;
  if (plan.cacheHit === 'local') return `cache hit (local)${took}`;
  if (plan.cacheHit === 'remote') return `cache hit (remote)${took}`;
  const off = plan.cacheSkipped ? ' (cache reads off)' : '';
  const native =
    plan.prebuild === 'generate' || plan.prebuild === 'regenerate' ? `, ${plan.prebuild}s the native dir` : '';
  return `cold build${off}${native}${took}`;
}

/** The remote provider and the runs behind the estimate. */
export function planDetail(plan: BuildPlan): string | null {
  if (plan.refusal || !plan.outcome) return null;
  const runs =
    plan.expectedMs === null
      ? `No ${plan.outcome} run of this project recorded yet`
      : `Median of ${plan.basis} ${plan.outcome} run${plan.basis === 1 ? '' : 's'}`;
  return plan.cacheHit === 'remote' ? `From ${plan.provider ?? 'the cache provider'}. ${runs}` : runs;
}

export interface GitBadges {
  uncommitted: number;
  arrows: string | null;
  merged: boolean;
  label: string;
}

/** What a workspace's git indicator shows, or null for a clean branch level with its upstream. */
export function gitBadges(git: WorktreeGit | null | undefined): GitBadges | null {
  if (!git) return null;
  const uncommitted = git.changed + git.untracked;
  const ahead = git.ahead ?? 0;
  const behind = git.behind ?? 0;
  const merged = git.mergedInto !== null;
  if (!uncommitted && !ahead && !behind && !merged) return null;
  const arrows = [ahead ? `\u2191${ahead}` : '', behind ? `\u2193${behind}` : ''].filter(Boolean).join(' ');
  const label = [
    uncommitted ? `${uncommitted} uncommitted ${uncommitted === 1 ? 'change' : 'changes'}` : '',
    ahead ? `${ahead} ahead` : '',
    behind ? `${behind} behind` : '',
    merged ? `merged into ${git.mergedInto}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return { uncommitted, arrows: arrows || null, merged, label };
}
