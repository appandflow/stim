import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  agentSessionsCacheFile,
  diskUsageCacheFile,
  pullRequestCacheFile,
  readAgentSessionsCache,
  readDiskUsage,
  readPullRequestCache,
  readWorkspaceAgent,
  readWorkspaceState,
  type DiskMeasure,
  type EnvironmentDisk,
  type EnvironmentState,
  type PullRequestCacheEntry,
  type WorktreeFacts,
  type WorktreePullRequest,
} from '@stim-cli/core/state';
import { attributeAgentSessions, discoverAgentSessions } from './agent-sessions.ts';
import { ownedAvdDirectory } from './devices/android.ts';
import { getExecutor } from './exec.ts';
import { workspaceDir } from './workspace/paths.ts';
import { gitCommonDirOnDisk } from './workspace/worktree.ts';
import { pullRequestLookups, type PullRequestFact, type PullRequestQuery } from './workspace/pull-request.ts';

const LIVE_DISK_MAX_AGE_MS = 5 * 60_000;
const IDLE_DISK_MAX_AGE_MS = 60 * 60_000;
const DU_TIMEOUT_MS = 120_000;
const PULL_REQUEST_MAX_AGE_MS = 5 * 60_000;
const PULL_REQUEST_CHECK_MS = 60_000;
const GIT_TIMEOUT_MS = 5000;
const AGENT_DISCOVERY_MS = 15_000;
const AGENT_CACHE_MAX_AGE_MS = 2 * 60_000;

function writeCacheFile(file: string, entry: object): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temporary, JSON.stringify(entry));
    renameSync(temporary, file);
  } catch {
    rmSync(temporary, { force: true });
  }
}

function simulatorDataDir(udid: string): string {
  return join(homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices', udid);
}

function checkoutDir(state: EnvironmentState): string {
  if (state.worktree?.path) return state.worktree.path;
  const common = gitCommonDirOnDisk(state.path);
  return common && basename(common) === '.git' ? dirname(common) : state.path;
}

interface DeviceFolder {
  device: { disk?: DiskMeasure };
  path: string;
}

function deviceFolders(state: EnvironmentState): DeviceFolder[] {
  const folders: DeviceFolder[] = [];
  for (const { ios, android } of [state, ...(state.slots ?? [])]) {
    if (ios?.owned) folders.push({ device: ios, path: simulatorDataDir(ios.udid) });
    if (android?.owned && !android.physical && android.name) {
      const path = ownedAvdDirectory(android.name);
      if (path) folders.push({ device: android, path });
    }
  }
  return folders;
}

/** The folders an environment's disk use sums: its checkout, its node_modules folders and Stim's workspace folder. */
function environmentFolders(state: EnvironmentState): {
  worktree: string;
  nodeModules: string[];
  build: string;
} {
  const worktree = checkoutDir(state);
  const nodeModules = [...new Set([join(worktree, 'node_modules'), join(state.path, 'node_modules')])];
  return { worktree, nodeModules, build: workspaceDir(state.path) };
}

/** The environment's disk use from the cached measurements; null before any folder was measured. */
function environmentDisk(folders: ReturnType<typeof environmentFolders>): EnvironmentDisk | null {
  const worktree = readDiskUsage(folders.worktree);
  const modules = folders.nodeModules.map((path) => readDiskUsage(path));
  const build = readDiskUsage(folders.build);
  const measured = [worktree, ...modules, build].filter((entry): entry is DiskMeasure => entry !== null);
  if (!measured.length) return null;
  return {
    worktreeBytes: worktree?.bytes ?? null,
    nodeModulesBytes: modules.every((entry) => entry !== null)
      ? modules.reduce((sum, entry) => sum + entry!.bytes, 0)
      : null,
    buildBytes: build?.bytes ?? null,
    measuredAt: measured.map((entry) => entry.measuredAt).toSorted()[0]!,
  };
}

function statusPullRequest(fact: PullRequestFact, checkedAt: string): WorktreePullRequest {
  return {
    number: fact.number,
    url: fact.url,
    title: fact.title ?? '',
    state: fact.state === 'open' && fact.draft ? 'draft' : fact.state,
    checks: fact.checks ?? null,
    reviewDecision: fact.reviewDecision ?? null,
    checkedAt,
  };
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function applyAgentSessions(states: EnvironmentState[], now: number): void {
  const cache = readAgentSessionsCache();
  const fresh = cache && now - Date.parse(cache.discoveredAt) <= AGENT_CACHE_MAX_AGE_MS;
  const workspaces = states.map((state) => ({
    path: canonicalPath(state.path),
    root: canonicalPath(checkoutDir(state)),
    recorded: readWorkspaceAgent(readWorkspaceState(state.path)),
  }));
  attributeAgentSessions(workspaces, fresh ? cache.sessions : [], now).forEach((agents, i) => {
    if (agents.length) states[i]!.agents = agents;
  });
}

/**
 * Adds the cached measurements to a status read: each environment's `disk` and `agents`, each owned device's `disk`,
 * and each linked worktree's `pullRequest` when the cache holds a lookup for its current branch. Reads files only.
 */
export function applyStatusMeasures(states: EnvironmentState[], worktrees: WorktreeFacts[]): void {
  applyAgentSessions(states, Date.now());
  for (const state of states) {
    const disk = environmentDisk(environmentFolders(state));
    if (disk) state.disk = disk;
    for (const { device, path } of deviceFolders(state)) {
      const measure = readDiskUsage(path);
      if (measure) device.disk = measure;
    }
  }
  for (const worktree of worktrees) {
    const cached = worktree.branch ? readPullRequestCache(worktree.path) : null;
    if (cached && cached.branch === worktree.branch) worktree.pullRequest = cached.pullRequest;
  }
}

/** Kilobytes from `du -sk` output, or null when it printed none. */
function parseDuKilobytes(output: string): number | null {
  const kb = Number(/^(\d+)\s/.exec(output)?.[1]);
  return Number.isFinite(kb) ? kb : null;
}

function isStale(measure: DiskMeasure | null, maxAgeMs: number, now: number): boolean {
  return !measure || now - Date.parse(measure.measuredAt) >= maxAgeMs;
}

export interface StatusMeasurer {
  /** Starts measuring the stale folders and looking up stale pull requests, unless a pass is already running. */
  schedule(states: EnvironmentState[], worktrees: WorktreeFacts[]): void;
}

/**
 * Keeps the disk use, pull request and agent session caches fresh for `status --watch`, off its refresh path: one
 * agent session discovery at most every 15 seconds, which status ignores once it is over 2 minutes old, one `du -sk` at
 * a time, live environments first, each folder at most every 5 minutes while its environment is live and every hour otherwise, and one `gh api
 * graphql` per repository for worktrees whose lookup is over 5 minutes old or whose branch or HEAD moved. It
 * runs git only in the repository, never in a worktree, and only for worktrees whose git state status read. It rechecks
 * a folder's cache right before measuring, so two watchers rarely measure the same folder. `updated` runs after each
 * write.
 */
export function createStatusMeasurer({
  updated,
  now = Date.now,
}: {
  updated: () => void;
  now?: () => number;
}): StatusMeasurer {
  const exec = getExecutor();
  let measuring = false;
  let duMissing = false;
  let checking = false;
  let checkedAt = -Infinity;
  let discovering = false;
  let discoveredAt = -Infinity;
  const failedAt = new Map<string, number>();

  async function du(path: string): Promise<number | null> {
    try {
      return parseDuKilobytes(await exec.runFileAsync('du', ['-sk', path], { timeoutMs: DU_TIMEOUT_MS }));
    } catch (error) {
      const { code, status, stdout } = error as NodeJS.ErrnoException & { status?: number; stdout?: string };
      if (code === 'ENOENT') duMissing = true;
      return status === 1 && typeof stdout === 'string' ? parseDuKilobytes(stdout) : null;
    }
  }

  async function measure(folders: { path: string; maxAgeMs: number }[]): Promise<void> {
    for (const { path, maxAgeMs } of folders) {
      if (duMissing || !isStale(readDiskUsage(path), maxAgeMs, now())) continue;
      if (now() - (failedAt.get(path) ?? -Infinity) < maxAgeMs) continue;
      let bytes = 0;
      if (existsSync(path)) {
        const kb = await du(path);
        if (kb === null) {
          failedAt.set(path, now());
          continue;
        }
        bytes = kb * 1024;
      } else if (!basename(path).startsWith('node_modules')) {
        continue;
      }
      writeCacheFile(diskUsageCacheFile(path), { path, bytes, measuredAt: new Date(now()).toISOString() });
      updated();
    }
  }

  async function branchHead(repository: string, branch: string): Promise<string | null> {
    try {
      const out = await exec.runFileAsync('git', ['-C', repository, 'rev-parse', '--verify', `refs/heads/${branch}`], {
        timeoutMs: GIT_TIMEOUT_MS,
      });
      return out.trim() || null;
    } catch {
      return null;
    }
  }

  async function checkPullRequests(worktrees: WorktreeFacts[]): Promise<void> {
    const lookup = pullRequestLookups({ detail: true });
    const byRepository = new Map<string, (PullRequestQuery & { path: string })[]>();
    for (const { path, branch, repository, git } of worktrees) {
      if (!branch || !repository || !git) continue;
      const head = await branchHead(repository, branch);
      if (!head) continue;
      const cached = readPullRequestCache(path);
      const fresh =
        cached?.branch === branch &&
        cached.head === head &&
        now() - Date.parse(cached.checkedAt) < PULL_REQUEST_MAX_AGE_MS;
      if (!fresh) {
        byRepository.set(repository, [
          ...(byRepository.get(repository) ?? []),
          { path, cwd: repository, branch, head },
        ]);
      }
    }
    for (const [repository, queries] of byRepository) {
      const results = await lookup(repository, queries);
      const at = new Date(now()).toISOString();
      results.forEach((result, i) => {
        if (!('pullRequest' in result)) return;
        const { path, branch, head } = queries[i]!;
        const entry: PullRequestCacheEntry = {
          path,
          branch,
          head,
          checkedAt: at,
          pullRequest: result.pullRequest ? statusPullRequest(result.pullRequest, at) : null,
        };
        writeCacheFile(pullRequestCacheFile(path), entry);
      });
      if (results.some((result) => 'pullRequest' in result)) updated();
    }
  }

  async function discoverAgents(): Promise<void> {
    const at = now();
    const sessions = await discoverAgentSessions({ now: at });
    const previous = readAgentSessionsCache();
    writeCacheFile(agentSessionsCacheFile(), { discoveredAt: new Date(at).toISOString(), sessions });
    const shown = previous && at - Date.parse(previous.discoveredAt) <= AGENT_CACHE_MAX_AGE_MS;
    if (!shown || JSON.stringify(previous.sessions) !== JSON.stringify(sessions)) updated();
  }

  return {
    schedule(states, worktrees) {
      if (!discovering && now() - discoveredAt >= AGENT_DISCOVERY_MS) {
        discovering = true;
        discoveredAt = now();
        void discoverAgents()
          .catch(() => {})
          .finally(() => {
            discovering = false;
          });
      }
      if (!measuring) {
        const folders = new Map<string, number>();
        for (const state of states.toSorted((a, b) => Number(b.live) - Number(a.live))) {
          if (!existsSync(state.path)) continue;
          const maxAgeMs = state.live ? LIVE_DISK_MAX_AGE_MS : IDLE_DISK_MAX_AGE_MS;
          const { worktree, nodeModules, build } = environmentFolders(state);
          for (const path of [worktree, ...nodeModules, build, ...deviceFolders(state).map((folder) => folder.path)]) {
            folders.set(path, Math.min(folders.get(path) ?? Infinity, maxAgeMs));
          }
        }
        measuring = true;
        void measure([...folders].map(([path, maxAgeMs]) => ({ path, maxAgeMs })))
          .catch(() => {})
          .finally(() => {
            measuring = false;
          });
      }
      if (!checking && now() - checkedAt >= PULL_REQUEST_CHECK_MS) {
        checking = true;
        checkedAt = now();
        void checkPullRequests(worktrees)
          .catch(() => {})
          .finally(() => {
            checking = false;
          });
      }
    },
  };
}
