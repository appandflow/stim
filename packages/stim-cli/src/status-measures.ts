import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import {
  agentSessionsCacheFile,
  buildEndMarkerFilesOf,
  diskUsageCacheFile,
  gitMergeCacheFile,
  diskUsageFailureFile,
  diskUsageLinksFile,
  diskUsageNativeFile,
  pullRequestCacheFile,
  ENDED_AGENT_RETENTION_MS,
  readAgentSessionsCache,
  readDiskUsage,
  readDiskUsageFailure,
  readDiskUsageFailureSignature,
  readDiskUsageWalkMs,
  readEndedAgentSessions,
  readPullRequestCache,
  readStatusWalkRest,
  statusWalkRestFile,
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
  type WorktreeFacts,
} from '@stim-cli/core/state';
import { agentKey, attributeAgentSessions, discoverAgentSessions, type AgentWorkspace } from './agent-sessions.ts';
import { withDirLock } from './dir-lock.ts';
import { ownedAvdDirectory } from './devices/android.ts';
import { gitAsync } from './workspace/git.ts';
import { workspaceDir } from './workspace/paths.ts';
import { gitCommonDirOnDisk, linkedWorktreesOnDisk } from './workspace/worktree.ts';
import { writeCacheFile } from './cache-file.ts';
import { isDependencyTree, refreshMeasure, trustedMeasure } from './disk-usage.ts';
import { treeSignature } from './private-size.ts';
import { PULL_REQUEST_MAX_AGE_MS, refreshPullRequests, type PullRequestRequest } from './pull-request-state.ts';

const LIVE_DISK_MAX_AGE_MS = 5 * 60_000;
const IDLE_DISK_MAX_AGE_MS = 60 * 60_000;
const DU_TIMEOUT_MS = 120_000;
const WALK_SPACING = 20;
const WALK_REST = 4;
const MAX_WALK_MS = DU_TIMEOUT_MS + 5000;
const PULL_REQUEST_CHECK_MS = 60_000;
const GIT_TIMEOUT_MS = 5000;
const AGENT_DISCOVERY_MS = 15_000;
const AGENT_CACHE_MAX_AGE_MS = 2 * 60_000;

/** The cache key of a checkout excluding dependency trees for the named app paths, separate from older size entries. */
function checkoutKey(checkout: string, apps: readonly string[]): string {
  return `${checkout}${sep}${sep}${apps
    .map((app) => relative(checkout, app) || '.')
    .toSorted()
    .join(',')}`;
}

/** The paths of the environments in each checkout, by checkout. */
function checkoutApps(states: EnvironmentState[]): Map<string, string[]> {
  const apps = new Map<string, string[]>();
  for (const state of states) {
    const checkout = checkoutDir(state);
    const known = apps.get(checkout) ?? [];
    if (!known.includes(state.path)) apps.set(checkout, [...known, state.path]);
  }
  return apps;
}

function dependencyTrees(checkout: string, apps: readonly string[]): string[] {
  return [...new Set([checkout, ...apps])].flatMap((root) => [join(root, 'node_modules'), join(root, 'ios', 'Pods')]);
}

export function forgetStatusMeasures(worktree: string, workspaces: readonly string[]): void {
  const roots = [...new Set([worktree, ...workspaces])];
  const files = [
    pullRequestCacheFile(worktree),
    gitMergeCacheFile(worktree),
    ...roots.flatMap(buildEndMarkerFilesOf),
    ...[roots, workspaces].flatMap((apps) => [
      diskUsageCacheFile(checkoutKey(worktree, apps)),
      diskUsageFailureFile(checkoutKey(worktree, apps)),
    ]),
    ...roots.flatMap((root) => [
      diskUsageCacheFile(root),
      diskUsageFailureFile(root),
      diskUsageCacheFile(`${root}${sep}`),
      diskUsageFailureFile(`${root}${sep}`),
      diskUsageCacheFile(join(root, 'node_modules')),
      diskUsageFailureFile(join(root, 'node_modules')),
      diskUsageLinksFile(join(root, 'node_modules')),
      diskUsageNativeFile(join(root, 'node_modules')),
      diskUsageCacheFile(join(root, 'ios', 'Pods')),
      diskUsageFailureFile(join(root, 'ios', 'Pods')),
      diskUsageLinksFile(join(root, 'ios', 'Pods')),
      diskUsageNativeFile(join(root, 'ios', 'Pods')),
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

/**
 * The environment's disk use from the cached measurements; null before any folder was measured. The checkout's walk
 * leaves out dependency trees, so `worktreeBytes` adds their trusted sizes back.
 */
function environmentDisk(folders: ReturnType<typeof environmentFolders>, apps: string[]): EnvironmentDisk | null {
  const whole = readDiskUsage(folders.worktree);
  const rest = readDiskUsage(checkoutKey(folders.worktree, apps));
  const trees = dependencyTrees(folders.worktree, apps).map((path) => trustedMeasure(path));
  const counted =
    rest && trees.every((tree) => tree !== null)
      ? { ...rest, bytes: rest.bytes + trees.reduce((sum, tree) => sum + tree.bytes, 0) }
      : null;
  const worktree =
    counted && (!whole || Date.parse(counted.measuredAt) >= Date.parse(whole.measuredAt)) ? counted : whole;
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
  const apps = checkoutApps(states);
  for (const state of states) {
    const folders = environmentFolders(state);
    const disk = environmentDisk(folders, apps.get(folders.worktree) ?? [state.path]);
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

function nestedFolders(state: EnvironmentState, apps: string[]): string[] {
  const common = gitCommonDirOnDisk(state.path);
  return [
    ...apps.map(workspaceDir),
    ...dependencyTrees(canonicalPath(checkoutDir(state)), apps.map(canonicalPath)),
    ...(common ? linkedWorktreesOnDisk(common).map((entry) => entry.path) : []),
  ];
}

/**
 * When the last walk of `path` failed, or null when a walk succeeded since, or when the failure was of a dependency
 * tree's earlier install, as `refreshMeasure` reads it.
 */
function lastFailure(path: string): { at: number } | null {
  const failedAt = readDiskUsageFailure(path);
  if (failedAt === null) return null;
  const at = Date.parse(failedAt);
  const measure = readDiskUsage(path);
  if (measure && Date.parse(measure.measuredAt) >= at) return null;
  if (isDependencyTree(path) && readDiskUsageFailureSignature(path) !== treeSignature(path)) return null;
  return { at };
}

/**
 * How long after its last walk `path` is due again: `maxAgeMs` after that walk ended, or WALK_SPACING times as long as
 * it took when that is longer. A walk counts as MAX_WALK_MS at most, so a machine asleep during it does not stretch
 * the spacing. A failed walk is due `maxAgeMs` after it failed.
 */
function spacedMaxAgeMs(path: string, maxAgeMs: number): number {
  if (lastFailure(path)) return maxAgeMs;
  const walkMs = Math.min(MAX_WALK_MS, readDiskUsageWalkMs(path) ?? 0);
  return Math.max(maxAgeMs, WALK_SPACING * walkMs) + walkMs;
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
  knownToExist?: true;
  /** The entries to sum instead of `path`; read only when the walk is due. */
  targets?: () => string[];
}

export interface StatusMeasurer {
  /** Starts measuring the stale folders and looking up stale pull requests, unless a pass is already running. */
  schedule(states: EnvironmentState[], worktrees: WorktreeFacts[]): void;
  /** Starts no further walk; a walk already running finishes. */
  stop(): void;
}

/**
 * Keeps the disk use, pull request and agent session caches fresh for `status --watch`, off its refresh path: one agent
 * session discovery at most every 15 seconds, which status ignores once it is over 2 minutes old, one disk walk at a
 * time on the whole machine through `refreshMeasure` (an ownership claim; a failed walk is recorded so other watchers
 * do not repeat it), at low priority, the folder whose last walk or failed walk is oldest first, a checkout without the
 * linked worktrees nested in it, workspace folders and its dependency trees; each folder other than a dependency tree again 5 minutes
 * after its last walk ended while its environment is live and an hour after otherwise, or 20 times as long as that walk
 * took when that is longer (a failed walk is retried after the same 5 minutes or hour), no walk by any status measurer on the machine sooner after the previous one ended than 4 times as long as it
 * took, and one `gh api graphql` per repository for worktrees whose lookup is over 5 minutes old or whose branch or
 * HEAD moved. It runs git only in the repository, never in a worktree, and only for worktrees whose git state status
 * read. It rechecks a folder's cache right before measuring, so two watchers rarely measure the same folder. A session
 * the previous discovery found and this one does not is recorded as ended in the workspaces it worked in. `updated`
 * runs after each write.
 */
export function createStatusMeasurer({
  updated,
  now = Date.now,
}: {
  updated: () => void;
  now?: () => number;
}): StatusMeasurer {
  let measuring = false;
  let waking: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let latest: EnvironmentState[] = [];
  let checking = false;
  let checkedAt = -Infinity;
  let discovering = false;
  let discoveredAt = -Infinity;

  async function measure(folders: MeasuredFolder[]): Promise<void> {
    for (const { path, maxAgeMs, targets, knownToExist } of folders) {
      if (stopped) return;
      let startedAt: number | null = null;
      const rest = () => {
        if (startedAt === null) return;
        const walkMs = Math.min(MAX_WALK_MS, now() - startedAt);
        writeCacheFile(statusWalkRestFile(), { writtenAt: now(), until: now() + WALK_REST * walkMs });
      };
      const { outcome } = await refreshMeasure(path, {
        timeoutMs: DU_TIMEOUT_MS,
        maxAgeMs: spacedMaxAgeMs(path, maxAgeMs),
        now,
        claim: true,
        failures: true,
        knownToExist,
        ...(targets ? { targets } : {}),
        admit: () => {
          if (now() < restUntil()) return false;
          startedAt = now();
          writeCacheFile(statusWalkRestFile(), { writtenAt: startedAt, until: startedAt + 2 * DU_TIMEOUT_MS });
          return true;
        },
        settled: rest,
      });
      if (outcome === 'busy') {
        wakeAfterRest();
        return;
      }
      if (outcome === 'measured') updated();
      if (startedAt === null) continue;
      if (now() > startedAt) {
        wakeAfterRest();
        return;
      }
    }
  }

  /** The shared rest's end, ignored when it was written in the future, as after the clock went back. */
  function restUntil(): number {
    const rest = readStatusWalkRest();
    return rest && rest.writtenAt <= now() ? rest.until : -Infinity;
  }

  function wakeAfterRest(): void {
    const wait = restUntil() - now();
    if (waking || wait <= 0) return;
    waking = setTimeout(() => {
      waking = null;
      measureDue();
    }, wait);
    waking.unref();
  }

  function measureDue(): void {
    if (measuring || stopped) return;
    if (now() < restUntil()) {
      wakeAfterRest();
      return;
    }
    const folders = new Map<string, MeasuredFolder>();
    const appsByCheckout = checkoutApps(latest);
    for (const state of latest.toSorted((a, b) => Number(b.live) - Number(a.live))) {
      if (!existsSync(state.path)) continue;
      const maxAgeMs = state.live ? LIVE_DISK_MAX_AGE_MS : IDLE_DISK_MAX_AGE_MS;
      const { worktree, build } = environmentFolders(state);
      const apps = appsByCheckout.get(worktree) ?? [state.path];
      const checkout = checkoutKey(worktree, apps);
      for (const path of [
        checkout,
        ...dependencyTrees(worktree, apps),
        build,
        ...deviceFolders(state).map((folder) => folder.path),
      ]) {
        const known = folders.get(path);
        folders.set(path, {
          path,
          knownToExist: path === checkout ? true : undefined,
          maxAgeMs: Math.min(known?.maxAgeMs ?? Infinity, maxAgeMs),
          targets:
            known?.targets ?? (path === checkout ? () => walkTargets(worktree, nestedFolders(state, apps)) : undefined),
        });
      }
    }
    const order = [...folders.values()].map((folder) => {
      const entry = trustedMeasure(folder.path);
      return {
        folder,
        at: lastFailure(folder.path)?.at ?? (entry ? Date.parse(entry.measuredAt) : -Infinity),
      };
    });
    measuring = true;
    void measure(order.toSorted((a, b) => (a.at === b.at ? 0 : a.at - b.at)).map(({ folder }) => folder))
      .catch(() => {})
      .finally(() => {
        measuring = false;
      });
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
    const refresh = refreshPullRequests({
      maxAgeMs: PULL_REQUEST_MAX_AGE_MS,
      detail: true,
      now,
      onRecord: updated,
    });
    const byRepository = new Map<string, PullRequestRequest[]>();
    for (const { path, branch, repository, git } of worktrees) {
      if (!branch || !repository || !git) continue;
      const head = await branchHead(repository, branch);
      if (!head) continue;
      byRepository.set(repository, [...(byRepository.get(repository) ?? []), { path, cwd: repository, branch, head }]);
    }
    for (const [repository, requests] of byRepository) await refresh(repository, requests);
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
    stop() {
      stopped = true;
      if (waking) clearTimeout(waking);
      waking = null;
    },
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
      latest = states;
      measureDue();
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
