import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import {
  agentSessionsCacheFile,
  diskUsageCacheFile,
  gitMergeCacheFile,
  diskUsageFailureFile,
  pullRequestCacheFile,
  ENDED_AGENT_RETENTION_MS,
  readAgentSessionsCache,
  readDiskUsage,
  readEndedAgentSessions,
  readPullRequestCache,
  readWorkspaceAgent,
  readWorkspaceState,
  workspaceEndedAgentsFile,
  workspaceEndedAgentsLock,
  workspaceMetadataFile,
  type AgentSession,
  type DiskMeasure,
  type EnvironmentDisk,
  type EndedAgentSession,
  type EnvironmentState,
  type PullRequestCacheEntry,
  type WorktreeFacts,
  type WorktreePullRequest,
} from '@stim-cli/core/state';
import { agentKey, attributeAgentSessions, discoverAgentSessions, type AgentWorkspace } from './agent-sessions.ts';
import { withDirLock } from './dir-lock.ts';
import { ownedAvdDirectory } from './devices/android.ts';
import { gitAsync } from './workspace/git.ts';
import { workspaceDir } from './workspace/paths.ts';
import { gitCommonDirOnDisk, linkedWorktreesOnDisk } from './workspace/worktree.ts';
import { writeCacheFile } from './cache-file.ts';
import { refreshMeasure, trustedMeasure } from './disk-usage.ts';
import { pullRequestLookups, type PullRequestFact, type PullRequestQuery } from './workspace/pull-request.ts';

const LIVE_DISK_MAX_AGE_MS = 5 * 60_000;
const IDLE_DISK_MAX_AGE_MS = 60 * 60_000;
const DU_TIMEOUT_MS = 120_000;
const PULL_REQUEST_MAX_AGE_MS = 5 * 60_000;
const PULL_REQUEST_CHECK_MS = 60_000;
const GIT_TIMEOUT_MS = 5000;
const AGENT_DISCOVERY_MS = 15_000;
const AGENT_CACHE_MAX_AGE_MS = 2 * 60_000;

export function forgetStatusMeasures(worktree: string, workspaces: readonly string[]): void {
  const roots = [...new Set([worktree, ...workspaces])];
  const files = [
    pullRequestCacheFile(worktree),
    gitMergeCacheFile(worktree),
    ...roots.flatMap((root) => [
      diskUsageCacheFile(root),
      diskUsageFailureFile(root),
      diskUsageCacheFile(join(root, 'node_modules')),
      diskUsageFailureFile(join(root, 'node_modules')),
      diskUsageCacheFile(join(root, 'ios', 'Pods')),
      diskUsageFailureFile(join(root, 'ios', 'Pods')),
      diskUsageCacheFile(workspaceDir(root)),
      diskUsageFailureFile(workspaceDir(root)),
    ]),
  ];
  for (const file of files) {
    try {
      rmSync(file, { force: true });
    } catch {}
  }
}

function simulatorDataDir(udid: string): string {
  return join(homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices', udid);
}

function checkoutDir(state: EnvironmentState): string {
  if (state.checkout) return state.checkout;
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
  const modules = folders.nodeModules.map((path) => trustedMeasure(path));
  const build = readDiskUsage(folders.build);
  const modulesPrivate = modules.map((entry) => entry?.privateBytes);
  const measured = [worktree, ...modules, build].filter((entry): entry is DiskMeasure => entry !== null);
  if (!measured.length) return null;
  return {
    worktreeBytes: worktree?.bytes ?? null,
    nodeModulesBytes: modules.every((entry) => entry !== null)
      ? modules.reduce((sum, entry) => sum + entry!.bytes, 0)
      : null,
    nodeModulesPrivateBytes: modulesPrivate.every((bytes) => bytes !== undefined)
      ? modulesPrivate.reduce((sum: number, bytes) => sum + (bytes ?? 0), 0)
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

/**
 * Writes a pull request lookup into the cache `status` and report-only `gc` read. A lookup made without detail is
 * marked `partial`, so `status` asks again for the title, checks and review decision; until then it keeps the title
 * cached for the same pull request, and the checks and review decision cached for the same HEAD.
 */
export function recordPullRequestLookup(
  { path, branch, head }: { path: string; branch: string; head: string },
  fact: PullRequestFact | null,
  checkedAt: string,
): void {
  let pullRequest = fact ? statusPullRequest(fact, checkedAt) : null;
  const partial = pullRequest !== null && fact?.title === undefined;
  const previous = partial ? readPullRequestCache(path) : null;
  if (pullRequest && previous?.pullRequest?.number === pullRequest.number) {
    const same = previous.head === head;
    pullRequest = {
      ...pullRequest,
      title: previous.pullRequest.title,
      checks: same ? previous.pullRequest.checks : null,
      reviewDecision: same ? previous.pullRequest.reviewDecision : null,
    };
  }
  const entry: PullRequestCacheEntry = {
    path,
    branch,
    head,
    checkedAt,
    pullRequest,
    ...(fact ? { containsHead: fact.containsHead, endedAt: fact.endedAt } : {}),
    ...(partial ? { partial: true as const } : {}),
  };
  writeCacheFile(pullRequestCacheFile(path), entry);
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function agentWorkspaces(states: EnvironmentState[]): AgentWorkspace[] {
  return states.map((state) => ({
    path: canonicalPath(state.path),
    root: canonicalPath(checkoutDir(state)),
    recorded: readWorkspaceAgent(readWorkspaceState(state.path)),
  }));
}

function applyAgentSessions(states: EnvironmentState[], now: number): void {
  const cache = readAgentSessionsCache();
  const sessions = cache && now - Date.parse(cache.discoveredAt) <= AGENT_CACHE_MAX_AGE_MS ? cache.sessions : [];
  const discovered = new Set(sessions.map(agentKey));
  const ended = states.map((state) => readEndedAgentSessions(state.path, now));
  const workspaces = agentWorkspaces(states);
  workspaces.forEach((workspace, i) => {
    const { recorded } = workspace;
    if (!recorded || discovered.has(agentKey(recorded))) return;
    if (ended[i]!.some((session) => agentKey(session) === agentKey(recorded))) workspace.recorded = null;
  });
  attributeAgentSessions(workspaces, sessions, now).forEach((agents, i) => {
    if (agents.length) states[i]!.agents = agents;
    const running = new Set(agents.map(agentKey));
    const endedAgents = ended[i]!.filter((session) => !running.has(agentKey(session)));
    if (endedAgents.length) states[i]!.endedAgents = endedAgents;
  });
}

function writeFileAtomic(file: string, entry: object): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(entry));
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function recordEndedAgents(
  states: EnvironmentState[],
  gone: AgentSession[],
  endedAt: string,
  now: number,
): { changed: boolean; failed: boolean } {
  const goneKeys = new Set(gone.map(agentKey));
  const result = { changed: false, failed: false };
  attributeAgentSessions(agentWorkspaces(states), gone, now).forEach((sessions, i) => {
    const root = states[i]!.path;
    const ended = sessions.filter((session) => goneKeys.has(agentKey(session)));
    if (!ended.length || !existsSync(workspaceMetadataFile(root))) return;
    try {
      withDirLock(workspaceEndedAgentsLock(root), () => {
        const kept = new Map<string, EndedAgentSession>(
          readEndedAgentSessions(root, now).map((session) => [agentKey(session), session]),
        );
        for (const { pid: _pid, ...session } of ended) kept.set(agentKey(session), { ...session, endedAt });
        writeFileAtomic(workspaceEndedAgentsFile(root), { sessions: [...kept.values()] });
      });
      result.changed = true;
    } catch {
      result.failed = true;
    }
  });
  return result;
}

/**
 * Adds the cached measurements to a status read: each environment's `disk`, `agents` and `endedAgents`, each owned
 * device's `disk`, and each linked worktree's `pullRequest` when the cache holds a lookup for its current branch.
 * Reads files only.
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

/** The folders inside a checkout that another measurement owns: its linked worktrees and Stim's workspace folder. */
function nestedFolders(state: EnvironmentState): string[] {
  const common = gitCommonDirOnDisk(state.path);
  return [workspaceDir(state.path), ...(common ? linkedWorktreesOnDisk(common).map((entry) => entry.path) : [])];
}

/** The entries to hand to `du` so it sums `root` without descending into `nested`; `[root]` when none is inside it. */
function walkTargets(root: string, nested: readonly string[]): string[] {
  const top = canonicalPath(root);
  const skip = new Set(nested.map(canonicalPath));
  const inside = [...skip].filter((path) => path.startsWith(top + sep));
  if (!inside.length) return [root];
  const targets: string[] = [];
  const visit = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      targets.push(dir);
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (skip.has(path)) continue;
      if (inside.some((nestedPath) => nestedPath.startsWith(path + sep))) visit(path);
      else targets.push(path);
    }
  };
  visit(top);
  return targets;
}

interface MeasuredFolder {
  path: string;
  maxAgeMs: number;
  /** Folders inside `path` to leave out of its size; read only when the walk is due. */
  nested?: () => string[];
}

export interface StatusMeasurer {
  /** Starts measuring the stale folders and looking up stale pull requests, unless a pass is already running. */
  schedule(states: EnvironmentState[], worktrees: WorktreeFacts[]): void;
}

/**
 * Keeps the disk use, pull request and agent session caches fresh for `status --watch`, off its refresh path: one
 * agent session discovery at most every 15 seconds, which status ignores once it is over 2 minutes old, one disk walk at
 * a time on the whole machine through `refreshMeasure` (an ownership claim; a failed walk is recorded so other watchers
 * do not repeat it), at low priority, live environments first, a checkout without the linked worktrees nested in it,
 * each folder other than node_modules at most every 5 minutes while its environment is live and every hour otherwise,
 * and one `gh api graphql` per repository for worktrees whose lookup is over 5 minutes old or whose branch or HEAD
 * moved. It runs git only in the repository, never in a worktree, and only for worktrees whose git state status read.
 * It rechecks a folder's cache right before measuring, so two watchers rarely measure the same folder. A session the previous
 * discovery found and this one does not is recorded as ended in the workspaces it worked in. `updated` runs after each
 * write.
 */
export function createStatusMeasurer({
  updated,
  now = Date.now,
}: {
  updated: () => void;
  now?: () => number;
}): StatusMeasurer {
  let measuring = false;
  let checking = false;
  let checkedAt = -Infinity;
  let discovering = false;
  let discoveredAt = -Infinity;

  async function measure(folders: MeasuredFolder[]): Promise<void> {
    for (const { path, maxAgeMs, nested } of folders) {
      const { outcome } = await refreshMeasure(path, {
        timeoutMs: DU_TIMEOUT_MS,
        maxAgeMs,
        now,
        claim: true,
        failures: true,
        ...(nested ? { targets: () => walkTargets(path, nested()) } : {}),
      });
      if (outcome === 'busy') return;
      if (outcome === 'measured') updated();
    }
  }

  async function branchHead(repository: string, branch: string): Promise<string | null> {
    try {
      const out = await gitAsync(repository, ['rev-parse', '--verify', `refs/heads/${branch}`], {
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
        !cached.partial &&
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
        recordPullRequestLookup({ path, branch, head }, result.pullRequest, at);
      });
      if (results.some((result) => 'pullRequest' in result)) updated();
    }
  }

  async function discoverAgents(states: EnvironmentState[]): Promise<void> {
    const at = now();
    const sessions = await discoverAgentSessions({ now: at });
    const previous = readAgentSessionsCache();
    const running = new Set(sessions.map(agentKey));
    const lastFound = previous ? Date.parse(previous.discoveredAt) : -Infinity;
    const gone =
      at - lastFound <= ENDED_AGENT_RETENTION_MS
        ? previous!.sessions.filter((session) => !running.has(agentKey(session)))
        : [];
    const ended = gone.length
      ? recordEndedAgents(states, gone, previous!.discoveredAt, at)
      : { changed: false, failed: false };
    if (ended.failed && at - lastFound <= AGENT_CACHE_MAX_AGE_MS) return;
    writeCacheFile(agentSessionsCacheFile(), { discoveredAt: new Date(at).toISOString(), sessions });
    const shown = previous && at - Date.parse(previous.discoveredAt) <= AGENT_CACHE_MAX_AGE_MS;
    if (ended.changed || !shown || JSON.stringify(previous.sessions) !== JSON.stringify(sessions)) updated();
  }

  return {
    schedule(states, worktrees) {
      if (!discovering && now() - discoveredAt >= AGENT_DISCOVERY_MS) {
        discovering = true;
        discoveredAt = now();
        void discoverAgents(states)
          .catch(() => {})
          .finally(() => {
            discovering = false;
          });
      }
      if (!measuring) {
        const folders = new Map<string, MeasuredFolder>();
        for (const state of states.toSorted((a, b) => Number(b.live) - Number(a.live))) {
          if (!existsSync(state.path)) continue;
          const maxAgeMs = state.live ? LIVE_DISK_MAX_AGE_MS : IDLE_DISK_MAX_AGE_MS;
          const { worktree, nodeModules, build } = environmentFolders(state);
          for (const path of [worktree, ...nodeModules, build, ...deviceFolders(state).map((folder) => folder.path)]) {
            const known = folders.get(path);
            folders.set(path, {
              path,
              maxAgeMs: Math.min(known?.maxAgeMs ?? Infinity, maxAgeMs),
              nested: known?.nested ?? (path === worktree ? () => nestedFolders(state) : undefined),
            });
          }
        }
        measuring = true;
        void measure([...folders.values()])
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
