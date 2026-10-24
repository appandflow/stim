import type { StimContext } from '@stim-cli/core';
import { existsSync, readdirSync, statSync } from 'fs';
import { isAbsolute, join } from 'path';
import chalk from 'chalk';
import { machineNumber } from '../../budget.ts';
import { formatLongDuration, plural } from '../../command-output.ts';
import { ownedAvdSerialResolver, ownedAvdSerialResolverAsync, type ResolvedAvdSerial } from '../../devices/android.ts';
import { projectDeviceSlots } from '../../devices/device-slots.ts';
import { listAllIosSimsAsync, type IosSimRecord } from '../../devices/ios.ts';
import { leaseIsExpired, listLeaseFiles } from '../../engine/device-lease.ts';
import { getExecutor, isTimeoutError, type ExecOptions } from '../../exec.ts';
import { WorkspaceProcessCleanupError } from '../../engine/workspace-process-lock.ts';
import { gitQuiet, gitQuietAsync } from '../../workspace/git.ts';
import { childEnvironment } from '../../workspace/git-read.ts';
import {
  MAINTENANCE_LOG_NAME,
  readPullRequestCache,
  settingDefinition,
  type PullRequestCacheEntry,
} from '@stim-cli/core/state';
import { getProject, loadConfig } from '../../workspace/config.ts';
import { workspaceLogsDir, workspaceStateFile } from '../../workspace/paths.ts';
import { workspaceInUseAsync } from '../../workspace/in-use.ts';
import { workspaceLastUsed } from '../../workspace/workspace-state.ts';
import {
  FETCH_FRESH_MS,
  fetchDefaultBranchAsync,
  lastFetchedAtAsync,
  localDefaultBranchAsync,
  mergeStateAsync,
  type MergeState,
} from '../../workspace/merge-state.ts';
import {
  describePullRequest,
  endedPullRequest,
  pullRequestLookups,
  type PullRequestLookup,
  type PullRequestQuery,
} from '../../workspace/pull-request.ts';
import {
  dirtyPathsAsync,
  hasPopulatedSubmodulesAsync,
  hasUncommittedWorkAsync,
  listWorktrees,
  listWorktreesAsync,
  resolveSourceCheckoutAsync,
  resolveFullRefAsync,
  sourceCheckoutOf,
  unpushedCommitsAsync,
} from '../../workspace/worktree.ts';
import {
  excludePodChurn,
  excludeWatchmanCookies,
  matchWorktreeEntry,
  nestedWorktrees,
  porcelainPath,
  reclaimKeys,
  removeWorktreeTarget,
} from '../worktree.ts';
import { recordPullRequestLookup } from '../../status-measures.ts';
import { worktreeArchiveLimits } from '../../archive.ts';
import { stimCliEntries, stimCliUseOf } from '../../workspace/service-guard.ts';
import { uncommittedActivityOf, type WorktreeArchive } from '../../workspace/worktree-archive.ts';
import { DEVICE_LIST_TIMEOUT_MS } from './devices.ts';
import { canonicalPath } from './paths.ts';
import { listWorkspaceDirs } from './workspaces.ts';
import { eachLimited, readConcurrency } from './limited.ts';
import { phase } from './progress.ts';
import { GC_OUTPUT, type GcOutput } from './results.ts';

const DEFAULT_WORKTREE_IDLE_DAYS = 7;
const DIRTY_PATHS_SHOWN = 3;

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const GRACE_SETTING = 'gc.worktreeGraceMinutes';
const PROTECT_SETTING = 'maintenance.protectRecentHours';
const NO_OWN_COMMITS_PRESSURE_FLOOR_MS = 5 * MINUTE_MS;
const PULL_REQUEST_NOT_CHECKED = 'not checked since the last maintenance worktree check';
const WORKTREE_CHECK_SETTING = 'maintenance.worktreeCheckMinutes';

interface WorktreeActivity {
  at: number;
  basis: string;
}

export interface WorktreeGrace {
  ms: number;
  now: number;
}

export interface WorktreeFacts {
  source: 'source' | 'linked' | { refusal: string };
  bare: boolean;
  locked: boolean;
  nested?: string[];
  porcelain: string[] | null;
  unpushed: string[] | null;
  submodules: boolean | null;
  inUse: string[];
  idleDays: number | null;
  merge: MergeState | null;
  pullRequest: PullRequestLookup | null;
  activity: WorktreeActivity | null;
  /** Uncommitted work of a finished worktree is archived, then removed, instead of keeping the worktree. */
  archiveDirty?: boolean;
}

export type WorktreeSkipCode =
  | 'not-a-worktree'
  | 'bare-repository'
  | 'source-checkout-unknown'
  | 'source-checkout'
  | 'locked'
  | 'nested-worktree'
  | 'in-use'
  | 'status-unreadable'
  | 'dirty'
  | 'unpushed-unchecked'
  | 'unpushed'
  | 'submodules'
  | 'not-merged'
  | 'merge-unknown'
  | 'last-use-unknown'
  | 'recently-used'
  | 'activity-unknown'
  | 'recent-activity';

interface WorktreeSkip {
  code: WorktreeSkipCode;
  text: string;
  eligibleAt?: number;
}

export interface WorktreeBuildState {
  bytes: number | null;
  dirs: { path: string; bytes: number | null }[];
}

export interface UnlistedWorktreeDir {
  path: string;
  repository: string;
  bytes: number | null;
}

interface WorktreeCandidate {
  path: string;
  keys: string[];
  idleDays: number | null;
  merge: MergeState | null;
  head: string | null;
  pullRequest: PullRequestLookup | null;
  skipCode: WorktreeSkipCode | null;
  skipped: string | null;
  eligibleAt: number | null;
  activity: WorktreeActivity | null;
  /** How many uncommitted or untracked entries removal archives first; absent or 0 for a clean worktree. */
  dirty?: number;
  buildState?: WorktreeBuildState;
}

export interface WorktreeSweep {
  idle: { olderThan: number; defaulted: boolean } | null;
  graceMs: number;
  now: number;
  noOwnCommitsIdleMs: number | null;
  /** The sweep removes worktrees with no commits of their own on the disk pressure window. */
  underPressure?: boolean;
  worktrees: WorktreeCandidate[];
  unlisted?: UnlistedWorktreeDir[];
}

const MERGE_DECIDES: ReadonlySet<WorktreeSkipCode> = new Set([
  'unpushed',
  'not-merged',
  'last-use-unknown',
  'recently-used',
]);

function skip(code: WorktreeSkipCode, text: string): WorktreeSkip {
  return { code, text };
}

function pullRequestNote(lookup: PullRequestLookup | null): string | null {
  const pr = lookup && 'pullRequest' in lookup ? lookup.pullRequest : null;
  if (!pr) return null;
  return pr.containsHead ? describePullRequest(pr) : `${describePullRequest(pr)}, and HEAD has commits it does not`;
}

/**
 * Why gc keeps a worktree, or null when it removes it. A worktree that would be removed is still kept while its last
 * activity, or its merge into the default branch, is less than `grace.ms` old, and kept when that activity is unknown.
 * A worktree with no commits of its own beyond the default branch is removable when idle for `olderThan` days, by its
 * last Stim use or, when no Stim use is recorded, its last activity; with `noOwnCommitsIdleMs`, as under disk
 * pressure, once its last activity is that old.
 */
export function worktreeSkipReason(
  facts: WorktreeFacts,
  olderThan: number | null,
  grace: WorktreeGrace = { ms: 0, now: 0 },
  noOwnCommitsIdleMs: number | null = null,
): WorktreeSkip | null {
  return removalBlocker(facts, olderThan, grace.now, noOwnCommitsIdleMs) ?? graceBlocker(facts, grace);
}

function noOwnCommitsActivityBlocker(
  activity: WorktreeActivity | null,
  idleMs: number,
  now: number,
): WorktreeSkip | null {
  if (!activity) return skip('activity-unknown', 'its last activity could not be read');
  const eligibleAt = activity.at + idleMs;
  if (now >= eligibleAt) return null;
  const ago = formatLongDuration(Math.max(0, now - activity.at));
  return {
    code: 'recent-activity',
    text: `recent activity: ${activity.basis} ${ago} ago; removable after ${new Date(eligibleAt).toISOString()}`,
    eligibleAt,
  };
}

function dirtyLines(porcelain: string[] | null): string[] {
  return excludePodChurn(excludeWatchmanCookies(porcelain).lines).lines;
}

function finished(facts: Pick<WorktreeFacts, 'merge' | 'pullRequest'>): boolean {
  return Boolean(facts.merge?.merged || endedPullRequest(facts.pullRequest));
}

function openPullRequest(lookup: PullRequestLookup | null): boolean {
  return Boolean(lookup && 'pullRequest' in lookup && lookup.pullRequest?.state === 'open');
}

function newerActivity(a: WorktreeActivity | null, b: WorktreeActivity | null): WorktreeActivity | null {
  return a && b ? (b.at > a.at ? b : a) : (a ?? b);
}

function hasNoOwnCommits(merge: MergeState | null): boolean {
  return merge?.merged === false && merge.noOwnCommits === true;
}

function activityIdleDays(activity: WorktreeActivity, now: number): number {
  return Math.max(0, Math.floor((now - activity.at) / DAY_MS));
}

function graceBlocker(
  facts: Pick<WorktreeFacts, 'merge' | 'pullRequest' | 'activity'>,
  grace: WorktreeGrace,
): WorktreeSkip | null {
  if (grace.ms <= 0) return null;
  if (!facts.activity) return skip('activity-unknown', 'its last activity could not be read');
  const merged = facts.merge?.merged ? facts.merge : null;
  const ended = endedPullRequest(facts.pullRequest);
  const events: WorktreeActivity[] = [facts.activity];
  if (merged) events.push({ at: merged.mergedAt, basis: `merged into ${merged.into}` });
  if (ended?.endedAt) events.push({ at: ended.endedAt, basis: describePullRequest(ended) });
  const latest = events.reduce((a, b) => (b.at > a.at ? b : a));
  const eligibleAt = latest.at + grace.ms;
  if (grace.now >= eligibleAt) return null;
  const ago = formatLongDuration(Math.max(0, grace.now - latest.at));
  return {
    code: 'recent-activity',
    text: `recent activity: ${latest.basis} ${ago} ago; removable after ${new Date(eligibleAt).toISOString()}`,
    eligibleAt,
  };
}

function removalBlocker(
  facts: WorktreeFacts,
  olderThan: number | null,
  now: number,
  noOwnCommitsIdleMs: number | null,
): WorktreeSkip | null {
  if (facts.bare) return skip('bare-repository', 'bare repository');
  if (typeof facts.source === 'object') {
    return skip('source-checkout-unknown', `source checkout unknown: ${facts.source.refusal}`);
  }
  if (facts.source === 'source') return skip('source-checkout', 'source checkout');
  if (facts.locked) return skip('locked', 'locked with git worktree lock');
  if (facts.nested?.length) return skip('nested-worktree', `contains the worktree ${facts.nested.join(', ')}`);
  if (facts.inUse.length) return skip('in-use', `in use: ${facts.inUse.join('; ')}`);
  if (facts.porcelain === null) return skip('status-unreadable', 'git status could not be read');
  const dirty = dirtyLines(facts.porcelain);
  if (dirty.length) {
    const paths = dirty.slice(0, DIRTY_PATHS_SHOWN).flatMap((line) => porcelainPath(line) ?? []);
    const more = dirty.length > DIRTY_PATHS_SHOWN ? ', ...' : '';
    const kept = skip(
      'dirty',
      `dirty: ${plural(dirty.length, 'uncommitted or untracked file')} (${paths.join(', ')}${more})`,
    );
    if (!facts.archiveDirty) return kept;
    const clean = removalBlocker({ ...facts, porcelain: [] }, olderThan, now, noOwnCommitsIdleMs);
    return clean === null && finished(facts) ? null : kept;
  }
  if (facts.unpushed === null) return skip('unpushed-unchecked', 'unpushed commits could not be checked');
  const merged = facts.merge?.merged ? facts.merge : null;
  const ended = endedPullRequest(facts.pullRequest);
  if (facts.unpushed.length && !merged?.coversUnpushed && ended?.state !== 'merged') {
    return skip('unpushed', `unpushed: ${plural(facts.unpushed.length, 'commit')} on no remote or other branch`);
  }
  if (facts.submodules === null) return skip('submodules', 'initialized submodules could not be checked');
  if (facts.submodules) return skip('submodules', 'initialized submodules');
  if (merged || ended) return null;
  const notMerged = facts.merge && !facts.merge.merged ? facts.merge : null;
  const details = [notMerged?.detail, pullRequestNote(facts.pullRequest)].filter(Boolean);
  const noOwnCommits = hasNoOwnCommits(notMerged) && !openPullRequest(facts.pullRequest);
  if (noOwnCommits && noOwnCommitsIdleMs !== null) {
    return noOwnCommitsActivityBlocker(facts.activity, noOwnCommitsIdleMs, now);
  }
  if (olderThan === null) {
    return skip(notMerged?.unknown ? 'merge-unknown' : 'not-merged', details.join('; ') || 'not merged');
  }
  const also = details.map((detail) => `; ${detail}`).join('');
  if (facts.idleDays === null) return skip('last-use-unknown', `recently used: its last use is unknown${also}`);
  if (facts.idleDays < olderThan) return skip('recently-used', `recently used ${facts.idleDays}d ago${also}`);
  return null;
}

/**
 * Why gc removes a worktree it did not skip: `merged into origin/main`, `PR #12 closed`, `idle 9d`,
 * `no commits of its own beyond origin/main, idle 9d`, or, under disk pressure,
 * `no commits of its own beyond origin/main, inactive for 12m under disk pressure`.
 */
export function worktreeRemovalReason(
  candidate: Pick<WorktreeCandidate, 'merge' | 'pullRequest' | 'idleDays' | 'activity' | 'dirty'>,
  sweep: Pick<WorktreeSweep, 'now' | 'noOwnCommitsIdleMs' | 'underPressure'>,
): string {
  const { merge, activity } = candidate;
  const archived = candidate.dirty ? `, ${plural(candidate.dirty, 'uncommitted file')} archived first` : '';
  if (merge?.merged) return `merged into ${merge.into}${archived}`;
  const ended = endedPullRequest(candidate.pullRequest);
  if (ended) return `${describePullRequest(ended)}${archived}`;
  if (merge && hasNoOwnCommits(merge)) {
    if (sweep.noOwnCommitsIdleMs !== null && activity) {
      const age = Math.max(0, sweep.now - activity.at);
      if (sweep.underPressure) return `${merge.detail}, inactive for ${formatLongDuration(age)} under disk pressure`;
      return age >= DAY_MS
        ? `${merge.detail}, idle ${activityIdleDays(activity, sweep.now)}d`
        : `${merge.detail}, inactive for ${formatLongDuration(age)}`;
    }
    const days = candidate.idleDays ?? (activity ? activityIdleDays(activity, sweep.now) : null);
    return days === null ? merge.detail : `${merge.detail}, idle ${days}d`;
  }
  return `idle ${candidate.idleDays ?? 0}d`;
}

/** The pull request note a kept worktree's report line carries, such as `PR #12 merged`, or null. */
export function worktreePullRequestNote(candidate: Pick<WorktreeCandidate, 'pullRequest'>): string | null {
  return pullRequestNote(candidate.pullRequest);
}

function lastUsedOf(keys: readonly string[]): number {
  const times = keys.map(workspaceLastUsed).filter(Number.isFinite);
  return times.length ? Math.max(...times) : NaN;
}

function idleDaysOf(keys: readonly string[], now: number): number | null {
  const last = lastUsedOf(keys);
  return Number.isFinite(last) ? Math.max(0, Math.floor((now - last) / DAY_MS)) : null;
}

interface DeviceReads {
  sims: (udid: string) => IosSimRecord[] | null;
  avdSerial: ReturnType<typeof ownedAvdSerialResolver>;
}

async function reportDeviceReads(keys: readonly string[], operation?: StimContext): Promise<DeviceReads> {
  const signal = operation?.signal;
  signal?.throwIfAborted();
  const slots = keys.flatMap((key) => {
    try {
      return projectDeviceSlots(getProject(key));
    } catch {
      return [];
    }
  });
  const requestedSims = new Set(
    slots.flatMap(({ platforms }) => {
      const ios = platforms.ios;
      return ios?.owned && ios.deviceUdid ? [ios.deviceUdid] : [];
    }),
  );
  let sims: IosSimRecord[] | null = null;
  if (requestedSims.size) {
    try {
      sims = await listAllIosSimsAsync({ timeoutMs: DEVICE_LIST_TIMEOUT_MS, operation, signal });
    } catch (error) {
      if (error instanceof WorkspaceProcessCleanupError) throw error;
      signal?.throwIfAborted();
    }
  }
  const names = new Set(
    slots.flatMap(({ platforms }) => {
      const android = platforms.android;
      return android?.owned && android.avdName ? [android.avdName] : [];
    }),
  );
  const avds = new Map<string, { value: ResolvedAvdSerial } | { error: unknown }>();
  const resolver = ownedAvdSerialResolverAsync({ timeoutMs: DEVICE_LIST_TIMEOUT_MS, operation, signal });
  for (const name of names) {
    signal?.throwIfAborted();
    try {
      avds.set(name, { value: await resolver(name) });
    } catch (error) {
      if (error instanceof WorkspaceProcessCleanupError) throw error;
      signal?.throwIfAborted();
      avds.set(name, { error });
    }
  }
  return {
    sims: (udid) => (requestedSims.has(udid) || sims?.some((sim) => sim.udid === udid) ? sims : null),
    avdSerial: (name) => {
      const result = avds.get(name);
      if (!result) throw new Error('The workspace device record changed during inspection.');
      if ('error' in result) throw result.error;
      return result.value;
    },
  };
}

async function inUseOf(
  keys: readonly string[],
  checks: { managedLocks: boolean },
  devices: DeviceReads,
  signal?: AbortSignal,
  operation?: StimContext,
): Promise<string[]> {
  const reasons: string[] = [];
  for (const key of keys) reasons.push(...(await workspaceInUseAsync(key, checks, signal, operation)));
  return [...new Set([...reasons, ...deviceUseOf(keys, devices)])];
}

function deviceUseOf(keys: readonly string[], devices: DeviceReads): string[] {
  const reasons: string[] = [];
  for (const key of keys) {
    let slots: ReturnType<typeof projectDeviceSlots>;
    try {
      slots = projectDeviceSlots(getProject(key));
    } catch (error) {
      reasons.push(`its device records cannot be read: ${(error as Error).message}`);
      continue;
    }
    for (const { platforms } of slots) {
      const ios = platforms.ios;
      if (ios?.owned && ios.deviceUdid) {
        const sims = devices.sims(ios.deviceUdid);
        const sim = sims?.find((entry) => entry.udid === ios.deviceUdid);
        if (sims === null) reasons.push(`the state of its owned simulator ${ios.deviceUdid} cannot be read`);
        else if (sim && sim.state !== 'Shutdown') {
          reasons.push(`its owned simulator ${sim.name} is ${sim.state}; \`stim stop\` in ${key} shuts it down`);
        }
      }
      const android = platforms.android;
      if (android?.owned && android.avdName) {
        try {
          if (devices.avdSerial(android.avdName).serial) {
            reasons.push(`its owned emulator ${android.avdName} is running; \`stim stop\` in ${key} shuts it down`);
          }
        } catch {
          reasons.push(`the state of its owned emulator ${android.avdName} cannot be read`);
        }
      }
    }
  }
  const holders = new Set(keys.map(canonicalPath));
  const now = Date.now();
  for (const { lease } of listLeaseFiles()) {
    if (lease && !leaseIsExpired(lease, now) && holders.has(canonicalPath(lease.holder))) {
      reasons.push(`it holds the ${lease.platform} device lease on ${lease.deviceName ?? lease.id}`);
    }
  }
  return reasons;
}

function newestMtime(paths: readonly { path: string; basis: string }[]): WorktreeActivity | null | 'unreadable' {
  let newest: WorktreeActivity | null = null;
  for (const { path, basis } of paths) {
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return 'unreadable';
    }
    if (!newest || mtime > newest.at) newest = { at: mtime, basis };
  }
  return newest;
}

function logFiles(key: string): { path: string; basis: string }[] | null {
  const dir = workspaceLogsDir(key);
  try {
    return readdirSync(dir)
      .filter((name) => !name.startsWith(MAINTENANCE_LOG_NAME))
      .map((name) => ({ path: join(dir, name), basis: 'a Stim log write' }));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
}

export function worktreeActivityOf(path: string, keys: readonly string[]): WorktreeActivity | null {
  const gitDir = gitQuiet(path, ['rev-parse', '--path-format=absolute', '--git-dir'])?.trim();
  return activityFromGitDir(gitDir, keys);
}

export async function worktreeActivityOfAsync(
  path: string,
  keys: readonly string[],
  operation?: StimContext,
): Promise<WorktreeActivity | null> {
  const gitDir = (
    await gitQuietAsync(path, ['rev-parse', '--path-format=absolute', '--git-dir'], {
      ...(operation ? childEnvironment(operation.env) : {}),
      signal: operation?.signal,
      declareFor: operation,
      cwd: operation?.cwd,
      killSignal: 'SIGKILL',
    })
  )?.trim();
  return activityFromGitDir(gitDir, keys);
}

function activityFromGitDir(gitDir: string | undefined, keys: readonly string[]): WorktreeActivity | null {
  if (!gitDir) return null;
  const paths = [
    { path: join(gitDir, 'index'), basis: 'a git index write' },
    { path: join(gitDir, 'HEAD'), basis: 'a git HEAD change' },
    { path: join(gitDir, 'logs', 'HEAD'), basis: 'a git reflog entry' },
  ];
  for (const key of keys) {
    const logs = logFiles(key);
    if (logs === null) return null;
    paths.push({ path: workspaceStateFile(key), basis: 'a Stim workspace state write' }, ...logs);
  }
  const newest = newestMtime(paths);
  return newest === 'unreadable' ? null : newest;
}

function protectRecentMs(operation?: StimContext): number {
  const { value, error } = machineNumber(PROTECT_SETTING, loadConfig(), operation?.env ?? process.env);
  return (error ? Number(settingDefinition(PROTECT_SETTING)?.default) : (value ?? 0)) * 60 * MINUTE_MS;
}

function graceMsSetting(operation?: StimContext): number {
  const { value, error } = machineNumber(GRACE_SETTING, loadConfig(), operation?.env ?? process.env);
  if (error) {
    const fallback = Number(settingDefinition(GRACE_SETTING)?.default);
    const line = chalk.yellow(`${error} gc uses the default of ${fallback} minutes.`);
    const context = operation;
    if (context) context.output('stderr', `${line}\n`);
    else console.error(line);
    return fallback * MINUTE_MS;
  }
  return (value ?? 0) * MINUTE_MS;
}

async function unlessTimedOut<T>(read: () => Promise<T>, unknown: T): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (isTimeoutError(error)) return unknown;
    throw error;
  }
}

async function porcelainOf(
  path: string,
  gitAnswered: boolean | null,
  operation?: StimContext,
): Promise<string[] | null> {
  if (gitAnswered === null) return null;
  if (!gitAnswered) return [];
  const lines = await unlessTimedOut(
    () =>
      dirtyPathsAsync(
        path,
        { limit: Infinity },
        { env: operation?.env, signal: operation?.signal, declareFor: operation },
      ),
    null,
  );
  return lines?.length ? lines : null;
}

export function candidateRoots(): string[] {
  const registered = Object.keys(loadConfig()?.projects ?? {}).filter(isAbsolute);
  const recorded = listWorkspaceDirs().flatMap((entry) => (entry.projectRoot ? [entry.projectRoot] : []));
  return [...new Set([...registered, ...recorded, ...linkedWorktreesOf(registered)])]
    .filter((root) => existsSync(root))
    .toSorted();
}

export async function candidateRootsAsync(operation?: StimContext): Promise<string[]> {
  operation?.signal.throwIfAborted();
  const options = { env: operation?.env, signal: operation?.signal, declareFor: operation };
  const registered = Object.keys(loadConfig()?.projects ?? {}).filter(isAbsolute);
  const recorded = listWorkspaceDirs().flatMap((entry) => (entry.projectRoot ? [entry.projectRoot] : []));
  const linked = new Set<string>();
  for (const root of registered) {
    operation?.signal.throwIfAborted();
    if (!existsSync(root)) continue;
    const { entries, ...source } = await resolveSourceCheckoutAsync(root, options);
    if ('refusal' in source) continue;
    for (const entry of entries)
      if (!entry.bare && !entry.prunable && entry.path !== source.path) linked.add(entry.path);
  }
  return [...new Set([...registered, ...recorded, ...linked])].filter((root) => existsSync(root)).toSorted();
}

function linkedWorktreesOf(roots: readonly string[]): string[] {
  const linked = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const entries = listWorktrees(root);
    const source = sourceCheckoutOf(entries);
    if ('refusal' in source) continue;
    for (const entry of entries)
      if (!entry.bare && !entry.prunable && entry.path !== source.path) linked.add(entry.path);
  }
  return [...linked];
}

interface PendingMerge {
  candidate: WorktreeCandidate;
  facts: WorktreeFacts;
  repo: string;
}

async function staleFetch(
  repo: string,
  now: number,
  freshMs: number,
  execution: Partial<ExecOptions>,
): Promise<string | null> {
  const at = await lastFetchedAtAsync(repo, execution);
  if (at !== null && now - at < freshMs) return null;
  return at === null
    ? 'the repository has no recorded fetch'
    : `the repository was last fetched ${formatLongDuration(Math.max(0, now - at))} ago`;
}

/**
 * How old a fetch or a cached pull request lookup can be and still count as fresh in a report: twice the maintenance
 * worktree check interval, which refreshes both, and never less than 10 minutes.
 */
function reportFreshMs(operation?: StimContext): number {
  const minutes =
    machineNumber(WORKTREE_CHECK_SETTING, loadConfig(), operation?.env ?? process.env).value ??
    Number(settingDefinition(WORKTREE_CHECK_SETTING)?.default);
  return Math.max(FETCH_FRESH_MS, 2 * minutes * MINUTE_MS);
}

function notRefreshedNote(fetch: string | null, facts: WorktreeFacts): string | null {
  const lookup = facts.pullRequest;
  const unchecked = lookup && 'unavailable' in lookup && lookup.unavailable === PULL_REQUEST_NOT_CHECKED;
  const stale = [fetch, unchecked ? 'its pull request was not checked' : null].filter(Boolean);
  return stale.length
    ? `merge state not refreshed: ${stale.join(', ')}; the next maintenance worktree check, which a stim command starts when it is due, or \`stim gc --delete\` checks again`
    : null;
}

async function checkMergeStates(
  pending: PendingMerge[],
  idle: number | null,
  grace: WorktreeGrace,
  noOwnCommitsIdleMs: number | null,
  refresh: boolean,
  freshMs: number,
  operation?: StimContext,
): Promise<void> {
  const repos = new Map<string, PendingMerge[]>();
  const execution: Pick<ExecOptions, 'env' | 'omitEnv' | 'signal' | 'declareFor' | 'cwd' | 'killSignal'> = {
    ...(operation ? childEnvironment(operation.env) : {}),
    signal: operation?.signal,
    declareFor: operation,
    cwd: operation?.cwd,
    killSignal: 'SIGKILL',
  };
  for (const entry of pending) repos.set(entry.repo, [...(repos.get(entry.repo) ?? []), entry]);
  for (const [repo, entries] of repos) {
    operation?.signal.throwIfAborted();
    const target = refresh
      ? await fetchDefaultBranchAsync(repo, grace.now, execution)
      : await localDefaultBranchAsync(repo, execution);
    // A report without refresh can still call a worktree removable after a force-push dropped its merge from the
    // default branch, after its cached closed pull request was reopened, or inside the grace window of a pull request
    // merged or closed after its merge commit was made. Only --delete acts, and it always refreshes first.
    const fetch = refresh ? null : await staleFetch(repo, grace.now, freshMs, execution);
    await eachLimited(entries, readConcurrency(operation), async ({ candidate, facts }) => {
      operation?.signal.throwIfAborted();
      const merge: MergeState =
        'error' in target
          ? { merged: false, unknown: true, detail: `merge state unknown: ${target.error}` }
          : await mergeStateAsync(candidate.path, target, execution);
      const verdict = worktreeSkipReason({ ...facts, merge }, idle, grace, noOwnCommitsIdleMs);
      const note =
        !refresh && verdict && MERGE_DECIDES.has(verdict.code)
          ? notRefreshedNote(hasNoOwnCommits(merge) ? null : fetch, facts)
          : null;
      Object.assign(candidate, {
        merge,
        skipCode: note && verdict?.code === 'not-merged' ? 'merge-unknown' : (verdict?.code ?? null),
        skipped: verdict ? (note ? `${verdict.text}; ${note}` : verdict.text) : null,
        eligibleAt: verdict?.eligibleAt ?? null,
      });
    });
  }
}

interface Inspected {
  candidate: WorktreeCandidate;
  facts: WorktreeFacts;
  repo: string | null;
  branch: string | null;
}

/**
 * Classifies each linked worktree of a registered project or its repository. A merged one is removable, a dirty one
 * after archiving its uncommitted work when archives are on; with `idle`, so is one unused for `olderThan` days. One
 * with no commits of its own beyond the default branch is removable once its last activity is older than the grace
 * period and `maintenance.protectRecentHours`, or, `underPressure`, than the grace period alone; never younger than 5
 * minutes. Device use is read last, in one pass against one simulator list and one AVD resolver, so
 * the resolver's time budget covers only device reads. Pull requests are asked once per repository, sequentially
 * with an operation and concurrently otherwise. Merge state is checked only where it decides the verdict, after one fetch per repository.
 * Without `refresh`, it runs no fetch and no `gh`: merge state comes from the existing remote-tracking ref and pull
 * requests from the cache `status --watch` writes, and a kept verdict that fresher state could change says so.
 */
export async function collectWorktreeSweep({
  idle,
  olderThan,
  now,
  graceMs,
  underPressure = false,
  refresh = true,
  operation,
}: {
  idle: boolean;
  olderThan: number | null;
  now: number;
  graceMs?: number;
  underPressure?: boolean;
  refresh?: boolean;
  operation?: StimContext;
}): Promise<WorktreeSweep> {
  const days = idle ? (olderThan ?? DEFAULT_WORKTREE_IDLE_DAYS) : null;
  const grace: WorktreeGrace = { ms: graceMs ?? graceMsSetting(operation), now };
  const freshMs = refresh ? 0 : reportFreshMs(operation);
  const noOwnCommitsIdleMs = Math.max(
    grace.ms,
    underPressure ? 0 : protectRecentMs(operation),
    NO_OWN_COMMITS_PRESSURE_FLOOR_MS,
  );
  const cli = stimCliEntries(operation?.env);
  const groups = new Map<string, string[]>();
  operation?.signal.throwIfAborted();
  const read = { env: operation?.env, signal: operation?.signal, declareFor: operation };
  const outside: WorktreeCandidate[] = [];
  const candidates = await candidateRootsAsync(operation);
  if (candidates.length)
    phase('worktrees', `checking ${plural(candidates.length, 'project')} for merged or idle worktrees`, operation);
  const matched: ReturnType<typeof matchWorktreeEntry>[] = [];
  await eachLimited([...candidates.entries()], readConcurrency(operation), async ([index, root]) => {
    operation?.signal.throwIfAborted();
    matched[index] = matchWorktreeEntry(await listWorktreesAsync(root, read), root);
  });
  for (const [index, root] of candidates.entries()) {
    const entry = matched[index];
    if (!entry) {
      outside.push({
        path: root,
        keys: [root],
        idleDays: null,
        merge: null,
        head: null,
        pullRequest: null,
        skipCode: 'not-a-worktree',
        skipped: 'not inside a git worktree',
        eligibleAt: null,
        activity: null,
      });
      continue;
    }
    groups.set(entry.path, [...(groups.get(entry.path) ?? []), root]);
  }
  const inspected: Inspected[] = [];
  await eachLimited([...[...groups].entries()], readConcurrency(operation), async ([index, [path, roots]]) => {
    operation?.signal.throwIfAborted();
    const { entries, ...source } = await resolveSourceCheckoutAsync(path, read);
    const entry = matchWorktreeEntry(entries, path);
    const keys = [...new Set([...roots, ...reclaimKeys(path)])];
    const idleDays = idleDaysOf(keys, now);
    const linked = !('refusal' in source) && entry !== null && source.path !== entry.path;
    const gitAnswered = linked ? await unlessTimedOut(() => hasUncommittedWorkAsync(path, read), null) : null;
    const porcelain = await porcelainOf(path, gitAnswered, operation);
    const dirty = linked ? dirtyLines(porcelain).length : 0;
    const archiveDirty = dirty > 0 && !underPressure && !('refusal' in worktreeArchiveLimits(path, operation?.env));
    let activity = linked ? await worktreeActivityOfAsync(path, keys, operation) : null;
    if (activity && archiveDirty) {
      const edited = await uncommittedActivityOf(path, operation);
      activity = edited === 'unreadable' ? null : newerActivity(activity, edited);
    }
    const head = linked ? await resolveFullRefAsync(path, 'HEAD', read) : null;
    const facts: WorktreeFacts = {
      source: 'refusal' in source ? source : linked ? 'linked' : 'source',
      bare: Boolean(entry?.bare),
      locked: Boolean(entry?.locked),
      nested: entry ? nestedWorktrees(entries, entry.path) : [],
      porcelain,
      unpushed: linked ? await unlessTimedOut(() => unpushedCommitsAsync(path, read), null) : null,
      submodules: linked ? await unlessTimedOut(() => hasPopulatedSubmodulesAsync(path, read), null) : false,
      inUse: linked ? stimCliUseOf(path, canonicalPath, cli) : [],
      idleDays,
      merge: null,
      pullRequest: null,
      activity,
      archiveDirty,
    };
    inspected[index] = {
      candidate: {
        path,
        keys,
        idleDays,
        merge: null,
        head,
        pullRequest: null,
        skipCode: null,
        skipped: null,
        eligibleAt: null,
        activity,
        ...(archiveDirty ? { dirty } : {}),
      },
      facts,
      repo: 'refusal' in source ? null : source.path,
      branch: head && entry?.branch ? entry.branch : null,
    };
  });
  const linked = inspected.filter(({ facts }) => facts.source === 'linked');
  for (const { candidate, facts } of linked) {
    for (const key of candidate.keys)
      facts.inUse.push(...(await workspaceInUseAsync(key, { managedLocks: true }, operation?.signal, operation)));
  }
  const devices = await reportDeviceReads(
    linked.flatMap(({ candidate }) => candidate.keys),
    operation,
  );
  for (const { candidate, facts } of linked) {
    facts.inUse = [...new Set([...facts.inUse, ...deviceUseOf(candidate.keys, devices)])];
  }
  if (refresh) await lookUpPullRequests(inspected, operation);
  else readCachedPullRequests(inspected, now, freshMs);
  const worktrees: WorktreeCandidate[] = [];
  const pending: PendingMerge[] = [];
  for (const { candidate, facts, repo } of inspected) {
    const verdict = worktreeSkipReason(facts, days, grace, noOwnCommitsIdleMs);
    Object.assign(candidate, {
      pullRequest: facts.pullRequest,
      skipCode: verdict?.code ?? null,
      skipped: verdict?.text ?? null,
      eligibleAt: verdict?.eligibleAt ?? null,
    });
    if (
      verdict &&
      (MERGE_DECIDES.has(verdict.code) || (verdict.code === 'dirty' && facts.archiveDirty)) &&
      repo !== null
    )
      pending.push({ candidate, facts, repo });
    worktrees.push(candidate);
  }
  await checkMergeStates(pending, days, grace, noOwnCommitsIdleMs, refresh, freshMs, operation);
  const listed = [...worktrees, ...outside].filter(
    (w) => idle || (w.skipCode !== 'not-a-worktree' && w.skipCode !== 'source-checkout'),
  );
  return {
    idle: days === null ? null : { olderThan: days, defaulted: olderThan === null },
    graceMs: grace.ms,
    now,
    noOwnCommitsIdleMs,
    underPressure,
    worktrees: listed,
  };
}

async function lookUpPullRequests(inspected: readonly Inspected[], operation?: StimContext): Promise<void> {
  const repos = new Map<string, { facts: WorktreeFacts; query: PullRequestQuery }[]>();
  for (const { candidate, facts, repo, branch } of inspected) {
    if (repo === null || branch === null || candidate.head === null) continue;
    const query = { cwd: candidate.path, branch, head: candidate.head };
    repos.set(repo, [...(repos.get(repo) ?? []), { facts, query }]);
  }
  const lookup = pullRequestLookups({ operation });
  const probes = [...repos].map(([repo, entries]) => async () => {
    const answers = await lookup(
      repo,
      entries.map(({ query }) => query),
    );
    const at = new Date().toISOString();
    entries.forEach(({ facts, query }, i) => {
      operation?.signal.throwIfAborted();
      const answer = answers[i] ?? null;
      facts.pullRequest = answer;
      if (answer && 'pullRequest' in answer) {
        recordPullRequestLookup({ path: query.cwd, branch: query.branch, head: query.head }, answer.pullRequest, at);
      }
    });
  });
  if (operation)
    for (const probe of probes) {
      operation.signal.throwIfAborted();
      await probe();
    }
  else await Promise.all(probes.map((probe) => probe()));
}

function readCachedPullRequests(inspected: readonly Inspected[], now: number, freshMs: number): void {
  let gh: boolean | undefined;
  for (const { candidate, facts, repo, branch } of inspected) {
    if (repo === null || branch === null || candidate.head === null) continue;
    const cached = cachedPullRequest(readPullRequestCache(candidate.path), branch, candidate.head, now, freshMs);
    if (!('pullRequest' in cached)) gh ??= getExecutor().findExecutable('gh') !== null;
    facts.pullRequest = 'pullRequest' in cached || gh ? cached : { unavailable: 'gh is not installed' };
  }
}

function cachedPullRequest(
  cached: PullRequestCacheEntry | null,
  branch: string,
  head: string,
  now: number,
  freshMs: number,
): PullRequestLookup {
  const notChecked = { unavailable: PULL_REQUEST_NOT_CHECKED };
  if (!cached || cached.branch !== branch || cached.head !== head) return notChecked;
  if (!(now - Date.parse(cached.checkedAt) < freshMs)) return notChecked;
  const { pullRequest: pr, containsHead, endedAt } = cached;
  if (pr === null) return { pullRequest: null };
  if (containsHead === undefined || (pr.state !== 'open' && pr.state !== 'draft' && typeof endedAt !== 'number')) {
    return notChecked;
  }
  const state = pr.state === 'draft' ? 'open' : pr.state;
  const open = state === 'open';
  return {
    pullRequest: {
      number: pr.number,
      url: pr.url,
      head,
      containsHead,
      state,
      draft: pr.state === 'draft',
      endedAt: open ? null : (endedAt ?? null),
    },
  };
}

async function noOwnCommitsRecheck(
  sweep: WorktreeSweep,
  path: string,
  keys: readonly string[],
  now: number,
  operation?: StimContext,
): Promise<string | null> {
  if (sweep.noOwnCommitsIdleMs === null) return 'it has no commits of its own and is not idle';
  return (
    noOwnCommitsActivityBlocker(await worktreeActivityOfAsync(path, keys, operation), sweep.noOwnCommitsIdleMs, now)
      ?.text ?? null
  );
}

export async function removeWorktrees(
  sweep: WorktreeSweep,
  { now = Date.now(), operation }: { now?: number; operation?: StimContext } = {},
  output: GcOutput = GC_OUTPUT,
): Promise<number> {
  let failures = 0;
  for (const candidate of sweep.worktrees) {
    operation?.signal.throwIfAborted();
    if (candidate.skipped) continue;
    let kept: string[] = [];
    const guard = async (lockedKeys: readonly string[]): Promise<string[]> => {
      const keys = [...new Set([...candidate.keys, ...lockedKeys])];
      const unlocked = keys.filter((key) => !lockedKeys.includes(key));
      const devices = await reportDeviceReads(keys, operation);
      const reasons = [
        ...stimCliUseOf(candidate.path, canonicalPath, stimCliEntries(operation?.env)),
        ...(await inUseOf(lockedKeys, { managedLocks: false }, devices, operation?.signal, operation)),
        ...(await inUseOf(unlocked, { managedLocks: true }, devices, operation?.signal, operation)),
      ].map((r) => `in use: ${r}`);
      const mergedHead = candidate.merge?.merged
        ? candidate.merge.head
        : endedPullRequest(candidate.pullRequest)
          ? candidate.head
          : null;
      if (mergedHead) {
        if (
          (await resolveFullRefAsync(candidate.path, 'HEAD', {
            env: operation?.env,
            signal: operation?.signal,
            declareFor: operation,
          })) !== mergedHead
        ) {
          reasons.push('its HEAD moved since gc checked it');
        }
      } else if (hasNoOwnCommits(candidate.merge)) {
        if (
          (await resolveFullRefAsync(candidate.path, 'HEAD', {
            env: operation?.env,
            signal: operation?.signal,
            declareFor: operation,
          })) !== candidate.head
        ) {
          reasons.push('its HEAD moved since gc checked it');
        }
        const recent = await noOwnCommitsRecheck(sweep, candidate.path, keys, Date.now(), operation);
        if (recent) reasons.push(recent);
      } else {
        const idleDays = idleDaysOf(keys, now);
        if (idleDays === null || !sweep.idle || idleDays < sweep.idle.olderThan) {
          reasons.push(`used ${idleDays === null ? 'at an unknown time' : `${idleDays}d ago`} since gc checked it`);
        }
      }
      if (sweep.graceMs > 0) {
        const activity = await worktreeActivityOfAsync(candidate.path, keys, operation);
        const edited = candidate.dirty && activity ? await uncommittedActivityOf(candidate.path, operation) : null;
        const recent = graceBlocker(
          {
            merge: candidate.merge,
            pullRequest: candidate.pullRequest,
            activity: edited === 'unreadable' ? null : newerActivity(activity, edited),
          },
          { ms: sweep.graceMs, now: Date.now() },
        );
        if (recent) reasons.push(recent.text);
      }
      kept = reasons;
      return reasons;
    };
    let removed = false;
    let error: string | null = null;
    const archived: { archive: WorktreeArchive | null } = { archive: null };
    try {
      const ended = endedPullRequest(candidate.pullRequest);
      const mergedHead =
        candidate.merge?.merged && candidate.merge.coversUnpushed
          ? candidate.merge.head
          : ended?.state === 'merged'
            ? (candidate.head ?? undefined)
            : undefined;
      const expectedHead =
        candidate.merge?.merged || ended || hasNoOwnCommits(candidate.merge)
          ? (candidate.head ?? undefined)
          : undefined;
      removed = await removeWorktreeTarget(candidate.path, {
        linkedOnly: true,
        guard,
        mergedHead,
        expectedHead,
        output,
        operation,
        ...(candidate.dirty
          ? {
              archiveDirty: {
                pullRequest: ended ? { number: ended.number, url: ended.url, state: ended.state } : null,
                onArchived: (saved: WorktreeArchive) => {
                  archived.archive = saved;
                },
              },
            }
          : {}),
      });
    } catch (thrown) {
      if (thrown instanceof WorkspaceProcessCleanupError || (thrown instanceof Error && 'reportCleanup' in thrown))
        throw thrown;
      operation?.signal.throwIfAborted();
      error = (thrown as Error)?.message || String(thrown);
      output.error(chalk.red(`Could not remove ${candidate.path}: ${error}`));
    }
    if (removed) {
      const saved = archived.archive;
      const reason = saved
        ? `${worktreeRemovalReason({ ...candidate, dirty: 0 }, sweep)}; archived ${plural(saved.tracked.length + saved.untracked.length, 'uncommitted file')} to ${saved.dir}; restore: ${saved.restore.join(' && ')}`
        : worktreeRemovalReason({ ...candidate, dirty: 0 }, sweep);
      output.log(chalk.green(`Removed the worktree ${candidate.path} (${reason})`));
      output.record('worktree', 'done', candidate.path, { detail: reason });
    } else if (kept.length) {
      output.log(chalk.yellow(`Kept the worktree ${candidate.path}: ${kept.join('; ')}`));
      output.record('worktree', 'kept', candidate.path, { detail: kept.join('; ') });
    } else {
      failures++;
      output.error(chalk.yellow(`Kept the worktree ${candidate.path}; see the lines above for why.`));
      output.record('worktree', 'failed', candidate.path, {
        detail: error ?? 'stim worktree remove did not remove it; see the details',
      });
    }
  }
  return failures;
}
