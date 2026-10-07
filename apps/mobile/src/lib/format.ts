import { plural, t } from '@lingui/core/macro';

import { formatDuration } from '@/intl/format';
import type {
  BuildHistoryEntry,
  BuildPlan,
  BuildReport,
  DeviceActivity,
  LastBuild,
  MacosAppState,
  PullRequestFacts,
  WorktreeGit,
} from '@/protocol/types';

export const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

export function clockDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(seconds / 60);
  return `${m}:${String(seconds % 60).padStart(2, '0')}`;
}

/** A moment's time of day, `HH:mm:ss`, following the device's 12- or 24-hour setting. Stable: it does not age. */
export function clockTime(at: number, locale?: string): string {
  return new Date(at).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

export type ActivityBadge = { kind: 'driven' | 'idle' | 'unknown'; text: string };

/** Matches apps/desktop ActivityBadge: nothing for a device used in the last 10 minutes. */
export function activityBadge(activity: DeviceActivity | undefined, now: number): ActivityBadge | null {
  if (!activity) return null;
  switch (activity.state) {
    case 'driven': {
      const tool = activity.driver?.tool ?? t`an unknown tool`;
      const since = activity.driver?.since ? Date.parse(activity.driver.since) : NaN;
      const duration = formatDuration(Math.max(0, now - since));
      const text = Number.isFinite(since) ? t`Driven by ${tool} \u00B7 ${duration}` : t`Driven by ${tool}`;
      return { kind: 'driven', text };
    }
    case 'idle': {
      const last = activity.lastActivityAt ? Date.parse(activity.lastActivityAt) : NaN;
      if (Number.isFinite(last) && now - last < ACTIVE_WINDOW_MS) return null;
      const duration = formatDuration(Math.max(0, now - last));
      return { kind: 'idle', text: Number.isFinite(last) ? t`Idle ${duration}` : t`Idle` };
    }
    case 'active':
      return null;
    default:
      return { kind: 'unknown', text: t`Activity unknown` };
  }
}

export function spokenDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return t`less than a minute`;
  const minuteCount = (n: number) => plural(n, { one: '# minute', other: '# minutes' });
  const hourCount = (n: number) => plural(n, { one: '# hour', other: '# hours' });
  if (minutes < 60) return minuteCount(minutes);
  const hours = Math.floor(minutes / 60);
  if (minutes % 60 === 0) return hourCount(hours);
  const hoursText = hourCount(hours);
  const minutesText = minuteCount(minutes % 60);
  return `${hoursText} ${minutesText}`;
}

/** How long a device has been driven or idle, such as "driven by agent-device for 47 minutes", for assistive technology. */
export function activityLabel(activity: DeviceActivity | undefined, now: number): string | null {
  const badge = activityBadge(activity, now);
  if (!activity || !badge) return null;
  switch (badge.kind) {
    case 'driven': {
      const tool = activity.driver?.tool ?? t`an unknown tool`;
      const since = activity.driver?.since ? Date.parse(activity.driver.since) : NaN;
      const spoken = spokenDuration(Math.max(0, now - since));
      return Number.isFinite(since) ? t`driven by ${tool} for ${spoken}` : t`driven by ${tool}`;
    }
    case 'idle': {
      const last = activity.lastActivityAt ? Date.parse(activity.lastActivityAt) : NaN;
      const spoken = spokenDuration(Math.max(0, now - last));
      return Number.isFinite(last) ? t`idle for ${spoken}` : t`idle`;
    }
    case 'unknown':
      return t`activity unknown`;
  }
}

export interface BuildProgress {
  elapsedMs: number;
  /**
   * Elapsed over the median of comparable runs, capped below 1, and never below what it was for the same build
   * before the run revised its estimate; null without history.
   */
  fraction: number | null;
  remaining: string | null;
}

const SHOWN_LIMIT = 64;
const shown = new Map<string, number>();

/** The larger of `fraction` and the largest one returned for `key` so far, so a bar never moves backwards. */
export function steadyFraction(key: string, fraction: number): number {
  const value = Math.max(shown.get(key) ?? 0, fraction);
  shown.delete(key);
  shown.set(key, value);
  if (shown.size > SHOWN_LIMIT) shown.delete(shown.keys().next().value!);
  return value;
}

/** Identifies one run: a new run in the same slot has a new `startedAt`. */
export const buildKey = (build: Pick<BuildReport, 'platform' | 'slot' | 'startedAt'>) =>
  `${build.platform}|${build.slot}|${build.startedAt}`;

export function buildProgress(build: BuildReport, now: number): BuildProgress {
  const started = Date.parse(build.startedAt);
  const elapsedMs = Math.max(0, now - (Number.isFinite(started) ? started : now));
  const expected = build.expectedMs;
  if (!expected || expected <= 0) return { elapsedMs, fraction: null, remaining: null };
  const remainingMs = expected - elapsedMs;
  const minutesLeft = Math.ceil(remainingMs / 60_000);
  const remaining =
    remainingMs <= 0
      ? t`longer than usual`
      : remainingMs < 60_000
        ? t`under a minute left`
        : t`about ${minutesLeft} min left`;
  const fraction = steadyFraction(`${buildKey(build)}|top`, Math.min(elapsedMs / expected, 0.99));
  return { elapsedMs, fraction, remaining };
}

export function buildTiming(build: BuildReport, now: number): { elapsed: string; estimate: string | null } {
  const progress = buildProgress(build, now);
  return {
    elapsed: clockDuration(progress.elapsedMs),
    estimate: build.expectedMs ? `~${clockDuration(build.expectedMs)}` : null,
  };
}

export function slotWait(build: BuildReport, now: number): string | null {
  const wait = build.waitingFor;
  if (!wait || (wait.kind !== 'build-slot' && wait.kind !== 'device-slot')) return null;
  const { inUse, max } = wait;
  const since = Date.parse(wait.since);
  const elapsed = Number.isFinite(since) ? clockDuration(now - since) : '';
  return wait.kind === 'build-slot'
    ? t`Waiting for a build slot (${inUse}/${max} in use) ${elapsed}`.trim()
    : t`Waiting for a device slot (${inUse}/${max} in use) ${elapsed}`.trim();
}

/**
 * Until the run knows its outcome, `stim status` reports the outcome of the project's previous run. An older stim
 * sends no `outcomeKnown`; its outcome is settled from prebuild, pods, compile or install on.
 */
export function outcomeLabel(
  build: Pick<BuildReport, 'outcome' | 'phase' | 'outcomeKnown' | 'missReason'>,
): string | null {
  if (build.outcome !== 'hit' && build.outcome !== 'cold') return null;
  const settled = build.outcomeKnown ?? !['prepare', 'cache-lookup', 'wait', 'device'].includes(build.phase);
  if (build.outcome === 'hit') return settled ? t`Cache hit` : t`Likely cache hit`;
  if (!settled) return t`Likely cold`;
  return build.missReason ? t`Cache miss` : t`Cold build`;
}

/** What a running build says while its cache miss is the first lookup's, which prebuild or pods can still turn into a hit. */
export function recheckNote(build: Pick<BuildReport, 'phase' | 'missProvisional'>): string | null {
  if (!build.missProvisional) return null;
  if (build.phase === 'prebuild') return t`Checks the cache again after prebuild`;
  if (build.phase === 'pods') return t`Checks the cache again after pods`;
  return t`Checks the cache again after prebuild or pods`;
}

export function lastBuildSummary(last: LastBuild, now: number, withReason = true): string {
  const ended = Date.parse(last.finishedAt ?? last.startedAt);
  const age = formatDuration(now - ended);
  const ago = t`${age} ago`;
  const took = `${last.durationMs === null ? '' : ` \u00B7 ${clockDuration(last.durationMs)}`}${
    Number.isNaN(ended) ? '' : ` \u00B7 ${ago}`
  }`;
  const code = last.errorCode ?? 'error';
  if (last.status !== 'ok' && last.status !== 'failed') return `${t`Unknown`}${took}`;
  if (last.status !== 'ok') return t`Failed (${code})${took}`;
  if (last.cacheHit === 'local') return t`Cache hit (local)${took}`;
  if (last.cacheHit === 'remote') return t`Cache hit (remote)${took}`;
  if (last.cacheHit !== false) return `${t`Unknown`}${took}`;
  const summary = last.missReason?.summary ?? '';
  const why = last.missReason ? (withReason ? t`: ${summary}` : '') : last.cacheSkipped ? t` (cache reads off)` : '';
  const machine = last.offloadedTo ? machineName(last.offloadedTo) : null;
  const built = machine ? t`Built on ${machine}` : t`Cold build`;
  return `${built}${why}${took}`;
}

/** A build machine's `offload.machines` entry without its `:port`. */
export const machineName = (entry: string) => entry.replace(/:\d+$/, '');

/** A history row's title: how the run ended, and for a finished run where its app came from. */
export function historyTitle(entry: BuildHistoryEntry): string {
  if (entry.result === 'interrupted') return t`Interrupted`;
  if (entry.result === 'cancelled') return t`Cancelled`;
  const code = entry.errorCode ?? 'error';
  if (entry.result === 'failed') return t`Failed (${code})`;
  if (
    entry.result !== 'succeeded' ||
    entry.status !== 'ok' ||
    (entry.cacheHit !== false && entry.cacheHit !== 'local' && entry.cacheHit !== 'remote')
  )
    return t`Unknown`;
  const { cacheHit } = entry;
  if (cacheHit) return t`Cache hit (${cacheHit})`;
  const machine = entry.offloadedTo ? machineName(entry.offloadedTo) : null;
  return machine ? t`Built on ${machine}` : t`Cold build`;
}

/** A history row's detail line: the cache outcome of a run that looked one up, when it ran, and its slot. */
export function historyDetail(entry: BuildHistoryEntry, now: number): string {
  const { slot } = entry;
  const cacheHit = entry.cacheHit === 'local' || entry.cacheHit === 'remote' ? entry.cacheHit : false;
  const summary = entry.missReason?.summary ?? '';
  const cache =
    entry.result === 'interrupted'
      ? null
      : cacheHit
        ? entry.result === 'succeeded'
          ? null
          : t`${cacheHit} cache hit`
        : entry.missReason
          ? t`miss: ${summary}`
          : entry.cacheSkipped
            ? t`cache reads off`
            : null;
  const at = Date.parse(entry.finishedAt ?? entry.startedAt);
  const age = formatDuration(Math.max(0, now - at));
  return [cache, Number.isNaN(at) ? null : t`${age} ago`, slot === 'default' ? null : t`slot ${slot}`]
    .filter(Boolean)
    .join(' \u00B7 ');
}

/** One sparkline bar per run with a duration, oldest first, its height a fraction of the longest run. */
export function durationBars(
  entries: readonly BuildHistoryEntry[],
): { fraction: number; result: BuildHistoryEntry['result'] }[] {
  const timed = entries.filter((entry) => entry.durationMs !== null).reverse();
  const longest = Math.max(1, ...timed.map((entry) => entry.durationMs ?? 0));
  return timed.map((entry) => ({ fraction: (entry.durationMs ?? 0) / longest, result: entry.result }));
}

/** What the next build would do and why, worded to follow "Next: ". */
export function nextBuild(plan: BuildPlan, withReason = true): string {
  if (plan.refusal) {
    const { code } = plan.refusal;
    return t`would refuse (${code})`;
  }
  if (plan.cacheHit === 'local') return t`cache hit (local)`;
  if (plan.cacheHit === 'remote') return t`cache hit (remote)`;
  if (plan.cacheHit !== false) return t`Unknown`;
  const off = plan.cacheSkipped ? t` (cache reads off)` : '';
  const prebuilds = plan.missReason?.kind !== 'prebuild-pending';
  const native =
    prebuilds && plan.prebuild === 'generate'
      ? t`, generates the native dir`
      : prebuilds && plan.prebuild === 'regenerate'
        ? t`, regenerates the native dir`
        : '';
  const summary = plan.missReason?.summary ?? '';
  const why = withReason && plan.missReason ? t`, ${summary}` : '';
  return t`cold build${off}${native}${why}`;
}

/** The remote provider and the runs behind the estimate. */
export function planDetail(plan: BuildPlan): string | null {
  if (plan.refusal || (plan.outcome !== 'hit' && plan.outcome !== 'cold')) return null;
  const { outcome } = plan;
  const runs =
    plan.expectedMs === null
      ? t`No ${outcome} run of this project recorded yet`
      : plural(plan.basis, { one: `Median of # ${outcome} run`, other: `Median of # ${outcome} runs` });
  const provider = plan.provider ?? t`the cache provider`;
  return plan.cacheHit === 'remote' ? t`From ${provider}. ${runs}` : runs;
}

export interface GitBadges {
  uncommitted: number;
  ahead: number;
  behind: number;
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
  const mergedInto = git.mergedInto ?? '';
  const upstream = git.upstream ?? t`the upstream`;
  const label = [
    uncommitted ? plural(uncommitted, { one: '# uncommitted change', other: '# uncommitted changes' }) : '',
    ahead
      ? plural(ahead, { one: `# commit not pushed to ${upstream}`, other: `# commits not pushed to ${upstream}` })
      : '',
    behind ? plural(behind, { one: `# commit behind ${upstream}`, other: `# commits behind ${upstream}` }) : '',
    merged ? t`merged into ${mergedInto}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return { uncommitted, ahead, behind, arrows: arrows || null, merged, label };
}

export function pullRequestStateName(state: PullRequestFacts['state']): string {
  switch (state) {
    case 'open':
      return t`Open`;
    case 'draft':
      return t`Draft`;
    case 'merged':
      return t`Merged`;
    case 'closed':
      return t`Closed`;
    default:
      return t`Unknown`;
  }
}

export function pullRequestReviewName(decision: NonNullable<PullRequestFacts['reviewDecision']>): string {
  switch (decision) {
    case 'approved':
      return t`Approved`;
    case 'changes-requested':
      return t`Changes requested`;
    case 'review-required':
      return t`Review required`;
    default:
      return t`Unknown`;
  }
}

export function macosBuildLabel(app: MacosAppState): string {
  return app.build.state === 'running'
    ? t`Building`
    : app.build.state === 'failed'
      ? t`Build failed`
      : app.build.state === 'ok'
        ? t`Built`
        : t`Unknown`;
}
