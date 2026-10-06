import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { configDir } from '@stim-cli/core';
import {
  agentDeviceUsageFile,
  readAgentDeviceUsageCache,
  type AgentDeviceUsage,
  type AgentDeviceUsageRoots,
} from '@stim-cli/core/state';
import { canonical, measureDu, writeUsageCache } from './report-only-usage.ts';
import { inspectProcessStart, type ProcessStart } from '../process-identity.ts';
import { listWorkspaceDirs } from '../commands/gc/workspaces.ts';
import { envDir, parseAgentDeviceRecord, processMatches, type AgentDeviceRecord } from './activity.ts';

const MAX_AGE_MS = 10 * 60_000;

function contains(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function parseRunnerMetadata(raw: string | null): {
  packageVersion: string | null;
  xcodeBuildVersion: string | null;
} {
  let value: Record<string, unknown> | null = null;
  try {
    value = raw === null ? null : JSON.parse(raw);
  } catch {}
  return {
    packageVersion: typeof value?.packageVersion === 'string' ? value.packageVersion : null,
    xcodeBuildVersion: typeof value?.xcodeBuildVersion === 'string' ? value.xcodeBuildVersion : null,
  };
}

export function runnerLastUsedAt(plist: string | null, mtimeMs: number | null): string | null {
  const match = plist?.match(/<key>LastAccessedDate<\/key>\s*<date>([^<]+)<\/date>/);
  const date = match ? Date.parse(match[1]!) : NaN;
  const at = Number.isFinite(date) ? date : mtimeMs;
  return at !== null && Number.isFinite(at) ? new Date(at).toISOString() : null;
}

export function runnerInUse(
  dir: string,
  leases: readonly AgentDeviceRecord[],
  unreadable: boolean,
  lock: boolean,
  startOf: (pid: number) => ProcessStart,
): Pick<AgentDeviceUsage['runnerBuilds']['platforms'][number]['entries'][number], 'inUse' | 'inUseReason'> {
  if (unreadable || leases.some((lease) => !lease.readable)) return { inUse: true, inUseReason: 'unreadable' };
  for (const lease of leases) {
    if (!lease.xctestrunPath || !contains(dir, lease.xctestrunPath)) continue;
    if ([lease.owner, lease.runner].some((process) => process && processMatches(process, startOf) === 'live'))
      return { inUse: true, inUseReason: 'lease' };
  }
  return lock ? { inUse: true, inUseReason: 'lock' } : { inUse: false, inUseReason: null };
}

interface UsageTree {
  roots: AgentDeviceUsageRoots;
  statePresent: boolean;
  runnerPresent: boolean;
  sessionsCount: number;
  otherChildren: { name: string; bytes: number | null }[];
  platforms: AgentDeviceUsage['runnerBuilds']['platforms'];
  workspaces: AgentDeviceUsage['workspaces'];
  hosted: AgentDeviceUsage['hosted'];
  absent: Set<string>;
}

function subtract(total: number | null, parts: (number | null)[]): number | null {
  return total === null || parts.some((part) => part === null)
    ? null
    : Math.max(0, total - parts.reduce<number>((sum, part) => sum + part!, 0));
}

function largest<T extends { bytes: number | null }>(entries: T[]): T[] {
  return entries.toSorted((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
}

function assembleAgentDeviceUsage(
  tree: UsageTree,
  sizes: ReadonlyMap<string, number>,
  complete: boolean,
  measuredAt: string,
): AgentDeviceUsage {
  const size = (dir: string) => (tree.absent.has(dir) ? 0 : (sizes.get(dir) ?? null));
  const { stateDir, runnerRoot } = tree.roots;
  const sessions = join(stateDir, 'sessions');
  const logs = join(stateDir, 'logs');
  const runnerBytes = tree.runnerPresent ? size(runnerRoot) : 0;
  const platforms = largest(
    tree.platforms.map((platform) => ({
      ...platform,
      bytes: size(platform.dir),
      entries: largest(platform.entries.map((entry) => ({ ...entry, bytes: size(entry.dir) }))),
    })),
  );
  const stateBytes = tree.statePresent ? size(stateDir) : 0;
  const sessionsBytes = tree.statePresent ? size(sessions) : 0;
  const logsBytes = tree.statePresent ? size(logs) : 0;
  const workspaces = largest(tree.workspaces.map((entry) => ({ ...entry, bytes: size(entry.dir) })));
  const hosted = tree.hosted ? { ...tree.hosted, bytes: size(tree.hosted.dir) } : null;
  return {
    version: 1,
    measuredAt,
    complete,
    bytes:
      (stateBytes ?? 0) +
      (contains(stateDir, runnerRoot) ? 0 : (runnerBytes ?? 0)) +
      workspaces.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0) +
      (hosted?.bytes ?? 0),
    stateDir: {
      dir: stateDir,
      present: tree.statePresent,
      bytes: stateBytes,
      sessions: { dir: sessions, bytes: sessionsBytes, count: tree.sessionsCount },
      logs: { dir: logs, bytes: logsBytes },
      other: {
        bytes: subtract(stateBytes, [
          sessionsBytes,
          logsBytes,
          ...(contains(stateDir, runnerRoot) ? [runnerBytes] : []),
        ]),
        largest: largest(
          tree.otherChildren.map((entry) => ({
            ...entry,
            bytes: sizes.get(join(stateDir, entry.name)) ?? entry.bytes,
          })),
        ).slice(0, 5),
      },
    },
    runnerBuilds: {
      dir: runnerRoot,
      present: tree.runnerPresent,
      bytes: runnerBytes,
      sharedBytes: tree.runnerPresent
        ? subtract(
            size(join(runnerRoot, 'derived')),
            platforms.map((entry) => entry.bytes),
          )
        : 0,
      platforms,
    },
    workspaces,
    hosted,
  };
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function children(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function directories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function workspaceAgentDeviceDir(dir: string): string {
  return join(dir, 'agent-device');
}

function discover(): UsageTree {
  const stateDir = canonical(envDir('AGENT_DEVICE_STATE_DIR') ?? join(homedir(), '.agent-device'));
  const runnerRoot = canonical(join(homedir(), '.agent-device', 'apple-runner'));
  const hostedDir = canonical(join(configDir(), 'server', 'agent-device'));
  const workspaces = listWorkspaceDirs()
    .map(({ dir, projectRoot }) => ({ dir: canonical(workspaceAgentDeviceDir(dir)), projectRoot, bytes: null }))
    .filter(({ dir }) => existsSync(dir));
  const roots = { stateDir, runnerRoot, hostedDir, workspaceDirs: workspaces.map(({ dir }) => dir).toSorted() };
  const leaseDir = envDir('AGENT_DEVICE_IOS_RUNNER_LEASE_DIR') ?? join(runnerRoot, 'leases');
  let leases: AgentDeviceRecord[] = [];
  let unreadable = false;
  try {
    leases = readdirSync(leaseDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const path = join(leaseDir, name);
        const record = parseAgentDeviceRecord('runner-lease', path, readText(path));
        if (record.xctestrunPath) record.xctestrunPath = canonical(record.xctestrunPath);
        return record;
      });
  } catch (error) {
    unreadable = (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  const starts = new Map<number, ProcessStart>();
  const startOf = (pid: number) => {
    if (!starts.has(pid)) starts.set(pid, inspectProcessStart(pid));
    return starts.get(pid)!;
  };
  const derived = join(runnerRoot, 'derived');
  const platforms = directories(derived).flatMap((platform) => {
    const dir = join(derived, platform);
    const entries = directories(dir)
      .filter((name) => name.startsWith('cache-') && !name.endsWith('.lock'))
      .map((name) => {
        const entryDir = join(dir, name);
        let mtime: number | null = null;
        try {
          mtime = statSync(entryDir).mtimeMs;
        } catch {}
        return Object.assign(
          {
            name,
            dir: entryDir,
            bytes: null,
            lastUsedAt: runnerLastUsedAt(readText(join(entryDir, 'info.plist')), mtime),
          },
          parseRunnerMetadata(readText(join(entryDir, '.agent-device-runner-cache.json'))),
          runnerInUse(canonical(entryDir), leases, unreadable, existsSync(`${entryDir}.lock`), startOf),
        );
      });
    return entries.length ? [{ platform, dir, bytes: null, entries }] : [];
  });
  const statePresent = existsSync(stateDir);
  const runnerPresent = existsSync(runnerRoot);
  const absent = new Set(
    [join(stateDir, 'sessions'), join(stateDir, 'logs'), derived].filter((dir) => !existsSync(dir)),
  );
  const otherChildren = children(stateDir)
    .filter((name) => !['sessions', 'logs', 'apple-runner'].includes(name))
    .map((name) => {
      let bytes: number | null = null;
      try {
        const stat = statSync(join(stateDir, name));
        if (stat.isFile() && typeof stat.blocks === 'number') bytes = stat.blocks * 512;
      } catch {}
      return { name, bytes };
    });
  return {
    roots,
    statePresent,
    runnerPresent,
    sessionsCount: directories(join(stateDir, 'sessions')).length,
    otherChildren,
    platforms,
    workspaces,
    hosted: existsSync(hostedDir) ? { dir: hostedDir, bytes: null, sessions: children(hostedDir).length } : null,
    absent,
  };
}

export async function getAgentDeviceUsage({
  maxAgeMs = MAX_AGE_MS,
}: { maxAgeMs?: number } = {}): Promise<AgentDeviceUsage> {
  const tree = discover();
  const cached = readAgentDeviceUsageCache();
  const age = cached ? Date.now() - Date.parse(cached.usage.measuredAt) : Infinity;
  if (cached && age >= 0 && age < maxAgeMs && JSON.stringify(cached.roots) === JSON.stringify(tree.roots))
    return cached.usage;
  const sizes = new Map<string, number>();
  let complete = true;
  const measure = async (args: string[]) => {
    const result = await measureDu(args);
    complete &&= result.complete;
    for (const [dir, bytes] of result.sizes) sizes.set(dir, bytes);
  };
  if (tree.statePresent) await measure(['-k', '-d', '4', tree.roots.stateDir]);
  if (tree.runnerPresent && !contains(tree.roots.stateDir, tree.roots.runnerRoot))
    await measure(['-k', '-d', '4', tree.roots.runnerRoot]);
  const extra = [...tree.roots.workspaceDirs, ...(tree.hosted ? [tree.hosted.dir] : [])];
  if (extra.length) await measure(['-sk', ...extra]);
  const usage = assembleAgentDeviceUsage(tree, sizes, complete, new Date().toISOString());
  writeUsageCache(agentDeviceUsageFile(), { ...usage, roots: tree.roots });
  return usage;
}
