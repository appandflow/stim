import { existsSync, readdirSync, statSync } from 'fs';
import { isAbsolute, join } from 'path';
import chalk from 'chalk';
import { machineNumber } from '../../budget.ts';
import { formatLongDuration, plural } from '../../command-output.ts';
import { ownedAvdSerialResolver } from '../../devices/android.ts';
import { projectDeviceSlots } from '../../devices/device-slots.ts';
import { listAllIosSims, type IosSimRecord } from '../../devices/ios.ts';
import { leaseIsExpired, listLeaseFiles } from '../../engine/device-lease.ts';
import { getExecutor } from '../../exec.ts';
import { settingDefinition } from '@stim-cli/core/state';
import { getProject, loadConfig } from '../../workspace/config.ts';
import { workspaceLogsDir, workspaceStateFile } from '../../workspace/paths.ts';
import { workspaceInUse } from '../../workspace/in-use.ts';
import { workspaceLastUsed } from '../../workspace/workspace-state.ts';
import { fetchDefaultBranch, mergeState, type MergeState } from '../../workspace/merge-state.ts';
import {
  describePullRequest,
  endedPullRequest,
  pullRequestLookups,
  type PullRequestLookup,
  type PullRequestQuery,
} from '../../workspace/pull-request.ts';
import {
  dirtyPaths,
  hasPopulatedSubmodules,
  hasUncommittedWork,
  listWorktrees,
  resolveFullRef,
  sourceCheckoutOf,
  unpushedCommits,
} from '../../workspace/worktree.ts';
import { excludePodChurn, matchWorktreeEntry, reclaimKeys, removeWorktreeTarget } from '../worktree.ts';
import { DEVICE_LIST_TIMEOUT_MS } from './devices.ts';
import { canonicalPath } from './paths.ts';
import { listWorkspaceDirs } from './workspaces.ts';
import { recordGcResult } from './results.ts';

const DEFAULT_WORKTREE_IDLE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const GRACE_SETTING = 'gc.worktreeGraceMinutes';

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
  porcelain: string[] | null;
  unpushed: string[] | null;
  submodules: boolean;
  inUse: string[];
  idleDays: number | null;
  merge: MergeState | null;
  pullRequest: PullRequestLookup | null;
  activity: WorktreeActivity | null;
}

export type WorktreeSkipCode =
  | 'not-a-worktree'
  | 'bare-repository'
  | 'source-checkout-unknown'
  | 'source-checkout'
  | 'locked'
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
}

export interface WorktreeSweep {
  idle: { olderThan: number; defaulted: boolean } | null;
  graceMs: number;
  worktrees: WorktreeCandidate[];
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
 */
export function worktreeSkipReason(
  facts: WorktreeFacts,
  olderThan: number | null,
  grace: WorktreeGrace = { ms: 0, now: 0 },
): WorktreeSkip | null {
  return removalBlocker(facts, olderThan) ?? graceBlocker(facts, grace);
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

function removalBlocker(facts: WorktreeFacts, olderThan: number | null): WorktreeSkip | null {
  if (facts.bare) return skip('bare-repository', 'bare repository');
  if (typeof facts.source === 'object') {
    return skip('source-checkout-unknown', `source checkout unknown: ${facts.source.refusal}`);
  }
  if (facts.source === 'source') return skip('source-checkout', 'source checkout');
  if (facts.locked) return skip('locked', 'locked with git worktree lock');
  if (facts.inUse.length) return skip('in-use', `in use: ${facts.inUse.join('; ')}`);
  if (facts.porcelain === null) return skip('status-unreadable', 'git status could not be read');
  const dirty = excludePodChurn(facts.porcelain).lines.length;
  if (dirty) return skip('dirty', `dirty: ${plural(dirty, 'uncommitted or untracked file')}`);
  if (facts.unpushed === null) return skip('unpushed-unchecked', 'unpushed commits could not be checked');
  const merged = facts.merge?.merged ? facts.merge : null;
  const ended = endedPullRequest(facts.pullRequest);
  if (facts.unpushed.length && !merged?.coversUnpushed && ended?.state !== 'merged') {
    return skip('unpushed', `unpushed: ${plural(facts.unpushed.length, 'commit')} on no remote or other branch`);
  }
  if (facts.submodules) return skip('submodules', 'initialized submodules');
  if (merged || ended) return null;
  const notMerged = facts.merge && !facts.merge.merged ? facts.merge : null;
  const details = [notMerged?.detail, pullRequestNote(facts.pullRequest)].filter(Boolean);
  if (olderThan === null) {
    return skip(notMerged?.unknown ? 'merge-unknown' : 'not-merged', details.join('; ') || 'not merged');
  }
  const also = details.map((detail) => `; ${detail}`).join('');
  if (facts.idleDays === null) return skip('last-use-unknown', `recently used: its last use is unknown${also}`);
  if (facts.idleDays < olderThan) return skip('recently-used', `recently used ${facts.idleDays}d ago${also}`);
  return null;
}

/** Why gc removes a worktree it did not skip: `merged into origin/main`, `PR #12 closed` or `idle 9d`. */
export function worktreeRemovalReason(
  candidate: Pick<WorktreeCandidate, 'merge' | 'pullRequest' | 'idleDays'>,
): string {
  if (candidate.merge?.merged) return `merged into ${candidate.merge.into}`;
  const ended = endedPullRequest(candidate.pullRequest);
  return ended ? describePullRequest(ended) : `idle ${candidate.idleDays ?? 0}d`;
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
  sims: () => IosSimRecord[] | null;
  avdSerial: ReturnType<typeof ownedAvdSerialResolver>;
}

function deviceReads(): DeviceReads {
  let sims: IosSimRecord[] | null | undefined;
  let resolver: ReturnType<typeof ownedAvdSerialResolver> | undefined;
  return {
    sims: () => {
      if (sims === undefined) {
        try {
          sims = listAllIosSims({ timeoutMs: DEVICE_LIST_TIMEOUT_MS });
        } catch {
          sims = null;
        }
      }
      return sims;
    },
    avdSerial: (avdName) => (resolver ??= ownedAvdSerialResolver({ timeoutMs: DEVICE_LIST_TIMEOUT_MS }))(avdName),
  };
}

function inUseOf(
  keys: readonly string[],
  checks: { managedLocks: boolean },
  devices: DeviceReads = deviceReads(),
): string[] {
  return [...new Set([...keys.flatMap((key) => workspaceInUse(key, checks)), ...deviceUseOf(keys, devices)])];
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
        const sims = devices.sims();
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
    return readdirSync(dir).map((name) => ({ path: join(dir, name), basis: 'a Stim log write' }));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
}

function worktreeActivityOf(path: string, keys: readonly string[]): WorktreeActivity | null {
  const gitDir = getExecutor()
    .runFileQuiet('git', ['--no-optional-locks', '-C', path, 'rev-parse', '--path-format=absolute', '--git-dir'])
    ?.trim();
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

function graceMsSetting(): number {
  const { value, error } = machineNumber(GRACE_SETTING, loadConfig(), process.env);
  if (error) {
    const fallback = Number(settingDefinition(GRACE_SETTING)?.default);
    console.error(chalk.yellow(`${error} gc uses the default of ${fallback} minutes.`));
    return fallback * MINUTE_MS;
  }
  return (value ?? 0) * MINUTE_MS;
}

function porcelainOf(path: string, gitAnswered: boolean | null): string[] | null {
  if (gitAnswered === null) return null;
  if (!gitAnswered) return [];
  const lines = dirtyPaths(path, { limit: Infinity });
  return lines.length ? lines : null;
}

function candidateRoots(): string[] {
  const registered = Object.keys(loadConfig()?.projects ?? {}).filter(isAbsolute);
  const recorded = listWorkspaceDirs().flatMap((entry) => (entry.projectRoot ? [entry.projectRoot] : []));
  return [...new Set([...registered, ...recorded])].filter((root) => existsSync(root)).toSorted();
}

interface PendingMerge {
  candidate: WorktreeCandidate;
  facts: WorktreeFacts;
  repo: string;
}

function checkMergeStates(pending: PendingMerge[], idle: number | null, grace: WorktreeGrace): void {
  const repos = new Map<string, PendingMerge[]>();
  for (const entry of pending) repos.set(entry.repo, [...(repos.get(entry.repo) ?? []), entry]);
  for (const [repo, entries] of repos) {
    const target = fetchDefaultBranch(repo, grace.now);
    for (const { candidate, facts } of entries) {
      const merge: MergeState =
        'error' in target
          ? { merged: false, unknown: true, detail: `merge state unknown: ${target.error}` }
          : mergeState(candidate.path, target);
      const verdict = worktreeSkipReason({ ...facts, merge }, idle, grace);
      Object.assign(candidate, {
        merge,
        skipCode: verdict?.code ?? null,
        skipped: verdict?.text ?? null,
        eligibleAt: verdict?.eligibleAt ?? null,
      });
    }
  }
}

interface Inspected {
  candidate: WorktreeCandidate;
  facts: WorktreeFacts;
  repo: string | null;
  branch: string | null;
}

/**
 * Classifies each Stim-managed linked worktree. A merged one is removable; with `idle`, so is one unused for
 * `olderThan` days. Device use is read last, in one pass against one simulator list and one AVD resolver, so
 * the resolver's time budget covers only device reads. Pull requests are asked once per repository, all
 * repositories at once. Merge state is checked only where it decides the verdict, after one fetch per repository.
 */
export async function collectWorktreeSweep({
  idle,
  olderThan,
  now,
}: {
  idle: boolean;
  olderThan: number | null;
  now: number;
}): Promise<WorktreeSweep> {
  const days = idle ? (olderThan ?? DEFAULT_WORKTREE_IDLE_DAYS) : null;
  const grace: WorktreeGrace = { ms: graceMsSetting(), now };
  const groups = new Map<string, string[]>();
  const outside: WorktreeCandidate[] = [];
  for (const root of candidateRoots()) {
    const entry = matchWorktreeEntry(listWorktrees(root), root);
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
      });
      continue;
    }
    groups.set(entry.path, [...(groups.get(entry.path) ?? []), root]);
  }
  const inspected: Inspected[] = [];
  for (const [path, roots] of groups) {
    const entries = listWorktrees(path);
    const entry = matchWorktreeEntry(entries, path);
    const source = sourceCheckoutOf(entries);
    const keys = [...new Set([...roots, ...reclaimKeys(path)])];
    const idleDays = idleDaysOf(keys, now);
    const linked = !('refusal' in source) && entry !== null && source.path !== entry.path;
    const activity = linked && grace.ms > 0 ? worktreeActivityOf(path, keys) : null;
    const gitAnswered = linked ? hasUncommittedWork(path) : null;
    const head = linked ? resolveFullRef(path, 'HEAD') : null;
    const facts: WorktreeFacts = {
      source: 'refusal' in source ? source : linked ? 'linked' : 'source',
      bare: Boolean(entry?.bare),
      locked: Boolean(entry?.locked),
      porcelain: porcelainOf(path, gitAnswered),
      unpushed: linked ? unpushedCommits(path) : null,
      submodules: linked && hasPopulatedSubmodules(path),
      inUse: [],
      idleDays,
      merge: null,
      pullRequest: null,
      activity,
    };
    inspected.push({
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
      },
      facts,
      repo: 'refusal' in source ? null : source.path,
      branch: head && entry?.branch ? entry.branch : null,
    });
  }
  const linked = inspected.filter(({ facts }) => facts.source === 'linked');
  for (const { candidate, facts } of linked) {
    facts.inUse = candidate.keys.flatMap((key) => workspaceInUse(key, { managedLocks: true }));
  }
  const devices = deviceReads();
  for (const { candidate, facts } of linked) {
    facts.inUse = [...new Set([...facts.inUse, ...deviceUseOf(candidate.keys, devices)])];
  }
  await lookUpPullRequests(inspected);
  const worktrees: WorktreeCandidate[] = [];
  const pending: PendingMerge[] = [];
  for (const { candidate, facts, repo } of inspected) {
    const verdict = worktreeSkipReason(facts, days, grace);
    Object.assign(candidate, {
      pullRequest: facts.pullRequest,
      skipCode: verdict?.code ?? null,
      skipped: verdict?.text ?? null,
      eligibleAt: verdict?.eligibleAt ?? null,
    });
    if (verdict && MERGE_DECIDES.has(verdict.code) && repo !== null) pending.push({ candidate, facts, repo });
    worktrees.push(candidate);
  }
  checkMergeStates(pending, days, grace);
  const listed = [...worktrees, ...outside].filter(
    (w) => idle || (w.skipCode !== 'not-a-worktree' && w.skipCode !== 'source-checkout'),
  );
  return {
    idle: days === null ? null : { olderThan: days, defaulted: olderThan === null },
    graceMs: grace.ms,
    worktrees: listed,
  };
}

async function lookUpPullRequests(inspected: readonly Inspected[]): Promise<void> {
  const repos = new Map<string, { facts: WorktreeFacts; query: PullRequestQuery }[]>();
  for (const { candidate, facts, repo, branch } of inspected) {
    if (repo === null || branch === null || candidate.head === null) continue;
    const query = { cwd: candidate.path, branch, head: candidate.head };
    repos.set(repo, [...(repos.get(repo) ?? []), { facts, query }]);
  }
  const lookup = pullRequestLookups();
  await Promise.all(
    [...repos].map(async ([repo, entries]) => {
      const answers = await lookup(
        repo,
        entries.map(({ query }) => query),
      );
      entries.forEach(({ facts }, i) => (facts.pullRequest = answers[i] ?? null));
    }),
  );
}

export async function removeWorktrees(
  sweep: WorktreeSweep,
  { now = Date.now() }: { now?: number } = {},
): Promise<number> {
  let failures = 0;
  for (const candidate of sweep.worktrees) {
    if (candidate.skipped) continue;
    let kept: string[] = [];
    const guard = (lockedKeys: readonly string[]): string[] => {
      const keys = [...new Set([...candidate.keys, ...lockedKeys])];
      const unlocked = keys.filter((key) => !lockedKeys.includes(key));
      const reasons = [
        ...inUseOf(lockedKeys, { managedLocks: false }),
        ...inUseOf(unlocked, { managedLocks: true }),
      ].map((r) => `in use: ${r}`);
      const mergedHead = candidate.merge?.merged
        ? candidate.merge.head
        : endedPullRequest(candidate.pullRequest)
          ? candidate.head
          : null;
      if (mergedHead) {
        if (resolveFullRef(candidate.path, 'HEAD') !== mergedHead) {
          reasons.push('its HEAD moved since gc checked it');
        }
      } else {
        const idleDays = idleDaysOf(keys, now);
        if (idleDays === null || !sweep.idle || idleDays < sweep.idle.olderThan) {
          reasons.push(`used ${idleDays === null ? 'at an unknown time' : `${idleDays}d ago`} since gc checked it`);
        }
      }
      if (sweep.graceMs > 0) {
        const recent = graceBlocker(
          {
            merge: candidate.merge,
            pullRequest: candidate.pullRequest,
            activity: worktreeActivityOf(candidate.path, keys),
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
    try {
      const ended = endedPullRequest(candidate.pullRequest);
      const mergedHead =
        candidate.merge?.merged && candidate.merge.coversUnpushed
          ? candidate.merge.head
          : ended?.state === 'merged'
            ? (candidate.head ?? undefined)
            : undefined;
      removed = await removeWorktreeTarget(candidate.path, { linkedOnly: true, guard, mergedHead });
    } catch (thrown) {
      error = (thrown as Error)?.message || String(thrown);
      console.error(chalk.red(`Could not remove ${candidate.path}: ${error}`));
    }
    if (removed) {
      console.log(chalk.green(`Removed the worktree ${candidate.path} (${worktreeRemovalReason(candidate)})`));
      recordGcResult('worktree', 'done', candidate.path, { detail: worktreeRemovalReason(candidate) });
    } else if (kept.length) {
      console.log(chalk.yellow(`Kept the worktree ${candidate.path}: ${kept.join('; ')}`));
      recordGcResult('worktree', 'kept', candidate.path, { detail: kept.join('; ') });
    } else {
      failures++;
      console.error(chalk.yellow(`Kept the worktree ${candidate.path}; see the lines above for why.`));
      recordGcResult('worktree', 'failed', candidate.path, {
        detail: error ?? 'stim worktree remove did not remove it; see the details',
      });
    }
  }
  return failures;
}
