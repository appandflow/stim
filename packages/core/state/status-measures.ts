import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readJsonObject } from './json-file.ts';
import {
  agentSessionsCacheFile,
  diskUsageCacheDir,
  pullRequestCacheDir,
  workspaceBuildDetailFile,
  workspaceEndedAgentsFile,
} from './paths.ts';
import {
  AGENT_TOOLS,
  NATIVE_BUILD_STEPS,
  type AgentSession,
  type BuildDetail,
  type DiskMeasure,
  type EndedAgentSession,
  type WorktreePullRequest,
} from './status.ts';

function cacheName(path: string): string {
  return `${createHash('sha256').update(path).digest('hex').slice(0, 32)}.json`;
}

/** The file that caches `path`'s measured size, one file per folder. */
export function diskUsageCacheFile(path: string): string {
  return join(diskUsageCacheDir(), cacheName(path));
}

/** The file that caches the pull request of the worktree at `path`. */
export function pullRequestCacheFile(path: string): string {
  return join(pullRequestCacheDir(), cacheName(path));
}

/** A worktree's cached pull request lookup: the branch and HEAD it was looked up for, and when. */
export interface PullRequestCacheEntry {
  path: string;
  branch: string;
  head: string;
  checkedAt: string;
  pullRequest: WorktreePullRequest | null;
}

const PR_STATES = new Set(['open', 'draft', 'merged', 'closed']);
const REVIEW_DECISIONS = new Set(['approved', 'changes-requested', 'review-required']);

function pullRequestOf(value: unknown): WorktreePullRequest | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const pr = value as Record<string, unknown>;
  if (!Number.isInteger(pr.number) || typeof pr.url !== 'string' || typeof pr.title !== 'string') return undefined;
  if (!PR_STATES.has(pr.state as string) || typeof pr.checkedAt !== 'string') return undefined;
  const checks = pr.checks as Record<string, unknown> | null | undefined;
  const counts =
    checks && typeof checks === 'object'
      ? [checks.passing, checks.failing, checks.pending].map((count) => countOrNull(count))
      : null;
  return {
    number: pr.number as number,
    url: pr.url,
    title: pr.title,
    state: pr.state as WorktreePullRequest['state'],
    checks:
      counts && counts.every((count) => count !== null)
        ? { passing: counts[0]!, failing: counts[1]!, pending: counts[2]! }
        : null,
    reviewDecision: REVIEW_DECISIONS.has(pr.reviewDecision as string)
      ? (pr.reviewDecision as WorktreePullRequest['reviewDecision'])
      : null,
    checkedAt: pr.checkedAt,
  };
}

/** The cached pull request lookup of the worktree at `path`, or null before one succeeded. */
export function readPullRequestCache(path: string): PullRequestCacheEntry | null {
  const entry = readJsonObject(pullRequestCacheFile(path));
  if (!entry || entry.path !== path || typeof entry.branch !== 'string' || typeof entry.head !== 'string') return null;
  if (typeof entry.checkedAt !== 'string') return null;
  const pullRequest = pullRequestOf(entry.pullRequest);
  if (pullRequest === undefined) return null;
  return { path, branch: entry.branch, head: entry.head, checkedAt: entry.checkedAt, pullRequest };
}

/** The cached size of the folder at `path`, or null before it was measured. */
export function readDiskUsage(path: string): DiskMeasure | null {
  const entry = readJsonObject(diskUsageCacheFile(path));
  if (!entry || entry.path !== path) return null;
  const { bytes, measuredAt } = entry;
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || typeof measuredAt !== 'string') return null;
  if (!Number.isFinite(Date.parse(measuredAt))) return null;
  return { bytes, measuredAt };
}

function countOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** The running build's tool detail its process last wrote, when the file belongs to the build with `claimId`. */
export function readBuildDetail(root: string, claimId: string): BuildDetail | null {
  const file = readJsonObject(workspaceBuildDetailFile(root));
  if (!file || file.claimId !== claimId) return null;
  const detail = file.detail;
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const raw = detail as Record<string, unknown>;
  if (typeof raw.updatedAt !== 'string') return null;
  return {
    step: (NATIVE_BUILD_STEPS as readonly unknown[]).includes(raw.step) ? (raw.step as BuildDetail['step']) : null,
    unit: raw.unit === 'targets' || raw.unit === 'tasks' ? raw.unit : null,
    done: countOrNull(raw.done),
    total: countOrNull(raw.total),
    line: typeof raw.line === 'string' ? raw.line : null,
    updatedAt: raw.updatedAt,
  };
}

/** The coding-agent sessions `status --watch` last found running on this Mac, and when it looked. */
export interface AgentSessionsCache {
  discoveredAt: string;
  sessions: AgentSession[];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** An agent session as Stim wrote it to its cache or workspace state, or null when it is not one. */
export function agentSessionOf(value: unknown): AgentSession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!(AGENT_TOOLS as readonly unknown[]).includes(raw.tool)) return null;
  if (typeof raw.sessionId !== 'string' || !raw.sessionId || typeof raw.cwd !== 'string' || !raw.cwd) return null;
  const session: AgentSession = { tool: raw.tool as AgentSession['tool'], sessionId: raw.sessionId, cwd: raw.cwd };
  const title = optionalString(raw.title);
  const startedAt = optionalString(raw.startedAt);
  const lastActiveAt = optionalString(raw.lastActiveAt);
  const openUrl = optionalString(raw.openUrl);
  const webUrl = optionalString(raw.webUrl);
  if (title) session.title = title;
  if (startedAt) session.startedAt = startedAt;
  if (lastActiveAt) session.lastActiveAt = lastActiveAt;
  if (Number.isInteger(raw.pid) && (raw.pid as number) > 0) session.pid = raw.pid as number;
  if (openUrl) session.openUrl = openUrl;
  if (webUrl) session.webUrl = webUrl;
  return session;
}

/** How long a workspace keeps an agent session after it stopped running. */
export const ENDED_AGENT_RETENTION_MS: number = 3 * 24 * 60 * 60_000;

/** An ended agent session as Stim wrote it, or null when it is not one. */
export function endedAgentSessionOf(value: unknown): EndedAgentSession | null {
  const session = agentSessionOf(value);
  const endedAt = optionalString((value as Record<string, unknown> | null)?.endedAt);
  if (!session || !endedAt || !Number.isFinite(Date.parse(endedAt))) return null;
  const { pid: _pid, ...ended } = session;
  return { ...ended, endedAt };
}

/** The workspace's agent sessions that ended within `ENDED_AGENT_RETENTION_MS` of `now`, most recently ended first. */
export function readEndedAgentSessions(root: string, now: number): EndedAgentSession[] {
  const entry = readJsonObject(workspaceEndedAgentsFile(root));
  if (!entry || !Array.isArray(entry.sessions)) return [];
  return entry.sessions
    .map(endedAgentSessionOf)
    .filter(
      (session): session is EndedAgentSession =>
        session !== null && now - Date.parse(session.endedAt) <= ENDED_AGENT_RETENTION_MS,
    )
    .toSorted((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt));
}

/** The agent sessions `status --watch` last cached, or null before it cached any. */
export function readAgentSessionsCache(): AgentSessionsCache | null {
  const entry = readJsonObject(agentSessionsCacheFile());
  if (!entry || typeof entry.discoveredAt !== 'string' || !Array.isArray(entry.sessions)) return null;
  return {
    discoveredAt: entry.discoveredAt,
    sessions: entry.sessions.map(agentSessionOf).filter((session): session is AgentSession => session !== null),
  };
}
