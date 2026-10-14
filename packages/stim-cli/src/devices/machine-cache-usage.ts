import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  machineCacheUsageFile,
  readMachineCacheUsage,
  type AgentDeviceUsage,
  type MachineCacheUsage,
  type SimRuntimeUsage,
} from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import { loadConfig } from '../workspace/config.ts';
import { androidLayoutSetting, resolveProjectSettingsAsync } from '../workspace/settings.ts';
import { canonical, measureDu, writeUsageCache } from './report-only-usage.ts';
import { parseSimctlList } from './ios.ts';
import { envDir } from './activity.ts';
import { describeError } from '../commands/gc/eas-sessions.ts';
import { parseSimRuntimeList } from '../commands/gc/inventory.ts';
import { DEVICE_LIST_TIMEOUT_MS } from '../commands/gc/devices.ts';

const MAX_AGE_MS = 10 * 60_000;
const TOOL_TIMEOUT_MS = DEVICE_LIST_TIMEOUT_MS;
const GRADLE_VERSION = /^\d+\.\d+(?:\.\d+)?(?:-[\w.-]+)?$/;
const GRADLE_DIST = /^gradle-(\d+\.\d+(?:\.\d+)?(?:-[\w.-]+)?)-(?:bin|all)$/;

interface SizedDir {
  dir: string;
  bytes: number | null;
}

export interface MachineCacheReport {
  measuredAt: string;
  complete: boolean;
  notices: string[];
  gradle: {
    home: string;
    unusedVersions: { version: string; bytes: number | null; dirs: SizedDir[]; remedy: string }[];
    usedVersions: { version: string; projects: string[] }[];
    unreadableProjects: string[];
    modules: (SizedDir & { remedy: string }) | null;
  };
  simRuntimes: {
    checked: boolean;
    runtimes: (SimRuntimeUsage & { remedy: string | null })[];
  };
  deviceSupport: { entries: SizedDir[]; remedy: string };
  runnerBuilds: {
    agentDeviceVersion: string | null;
    xcodeBuildVersion: string | null;
    groups: {
      packageVersion: string | null;
      xcodeBuildVersion: string | null;
      current: boolean | null;
      entries: number;
      inUse: number;
      bytes: number | null;
      oldestUseAt: string | null;
    }[];
    remedy: string;
  };
}

interface Discovery {
  gradleHome: string;
  versionDirs: Map<string, string[]>;
  modulesDir: string | null;
  deviceSupportEntries: string[];
  notices: string[];
}

function missing(error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? error.code : null;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function directories(dir: string, notices: string[]): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (!missing(error)) notices.push(`${dir} not listed: ${describeError(error)}`);
    return [];
  }
}

function gradleUserHome(): string {
  return canonical(envDir('GRADLE_USER_HOME') ?? join(homedir(), '.gradle'));
}

function discover(): Discovery {
  const gradleHome = gradleUserHome();
  const notices: string[] = [];
  const versionDirs = new Map<string, string[]>();
  const add = (version: string, dir: string) => versionDirs.set(version, [...(versionDirs.get(version) ?? []), dir]);
  const caches = join(gradleHome, 'caches');
  const cacheNames = directories(caches, notices);
  for (const name of cacheNames) if (GRADLE_VERSION.test(name)) add(name, join(caches, name));
  const dists = join(gradleHome, 'wrapper', 'dists');
  for (const name of directories(dists, notices)) {
    const match = GRADLE_DIST.exec(name);
    const version = match?.[1];
    if (version) add(version, join(dists, name));
  }
  const xcode = join(homedir(), 'Library', 'Developer', 'Xcode');
  const deviceSupportEntries =
    process.platform === 'darwin'
      ? directories(xcode, notices)
          .filter((name) => name.endsWith(' DeviceSupport'))
          .flatMap((name) => directories(join(xcode, name), notices).map((entry) => join(xcode, name, entry)))
      : [];
  return {
    gradleHome,
    versionDirs,
    modulesDir: cacheNames.includes('modules-2') ? join(caches, 'modules-2') : null,
    deviceSupportEntries,
    notices,
  };
}

function parseWrapperVersion(properties: string): string | null {
  const url = /^\s*distributionUrl\s*[=:]\s*(.+?)\s*$/m.exec(properties)?.[1];
  return url ? (/gradle-([^/]+?)-(?:bin|all)\.zip$/.exec(url)?.[1] ?? null) : null;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readWrapper(path: string): string | null | 'unreadable' {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    return missing(error) ? null : 'unreadable';
  }
}

interface GradleVersionUse {
  used: Map<string, string[]>;
  unreadable: string[];
}

async function projectWrapperRoots(project: string): Promise<{ roots: string[]; resolved: boolean }> {
  try {
    const { context, settings } = await resolveProjectSettingsAsync(project);
    return {
      roots: [project, androidLayoutSetting(settings, project, context.repoRoot ?? project).gradleRoot],
      resolved: true,
    };
  } catch {
    return { roots: [project], resolved: false };
  }
}

async function projectPins(project: string): Promise<{ versions: string[]; unreadable: boolean }> {
  if (!isDirectory(project)) return { versions: [], unreadable: true };
  const { roots, resolved } = await projectWrapperRoots(project);
  let unreadable = !resolved;
  const versions: string[] = [];
  for (const root of roots) {
    const text = readWrapper(join(root, 'gradle', 'wrapper', 'gradle-wrapper.properties'));
    if (text === null) continue;
    const version = text === 'unreadable' ? null : parseWrapperVersion(text);
    if (version === null) unreadable = true;
    else versions.push(version);
  }
  return { versions, unreadable };
}

async function projectGradleVersions(projects: readonly string[]): Promise<GradleVersionUse> {
  const used = new Map<string, string[]>();
  const unreadable: string[] = [];
  const pins = await Promise.all(projects.map(async (project) => ({ project, ...(await projectPins(project)) })));
  for (const { project, versions, unreadable: partial } of pins) {
    if (partial) unreadable.push(project);
    for (const version of new Set(versions)) used.set(version, [...(used.get(version) ?? []), project]);
  }
  return { used, unreadable };
}

function parseSimRuntimes(runtimeList: string, deviceList: string): SimRuntimeUsage[] | null {
  try {
    const counts = new Map<string, number>();
    for (const sim of parseSimctlList(deviceList, { includeUnavailable: true }))
      counts.set(sim.runtime, (counts.get(sim.runtime) ?? 0) + 1);
    return parseSimRuntimeList(runtimeList).flatMap(({ sizeBytes, runtimeIdentifier, ...runtime }) =>
      runtimeIdentifier
        ? [{ ...runtime, runtimeIdentifier, bytes: sizeBytes, devices: counts.get(runtimeIdentifier) ?? 0 }]
        : [],
    );
  } catch {
    return null;
  }
}

function parseXcodeBuildVersion(output: string | null): string | null {
  return output ? (/^Build version (\S+)/m.exec(output)?.[1] ?? null) : null;
}

async function quiet(file: string, args: string[]): Promise<string | null> {
  try {
    return await getExecutor().runFileAsync(file, args, { timeoutMs: TOOL_TIMEOUT_MS, killSignal: 'SIGKILL' });
  } catch {
    return null;
  }
}

async function measure(dirs: string[]): Promise<MachineCacheUsage> {
  const darwin = process.platform === 'darwin';
  const [sizes, runtimeList, deviceList, agentDevice, xcode] = await Promise.all([
    Promise.all(
      dirs.map(async (dir) => {
        const result = await measureDu(['-sk', dir]);
        return { dir, bytes: result.complete ? (result.sizes.get(dir) ?? null) : null };
      }),
    ),
    darwin ? quiet('xcrun', ['simctl', 'runtime', 'list', '-j']) : null,
    darwin ? quiet('xcrun', ['simctl', 'list', 'devices', '--json']) : null,
    quiet('agent-device', ['--version']),
    darwin ? quiet('xcodebuild', ['-version']) : null,
  ]);
  return {
    version: 1,
    measuredAt: new Date().toISOString(),
    roots: dirs,
    sizes,
    runtimes: !darwin ? [] : runtimeList && deviceList ? parseSimRuntimes(runtimeList, deviceList) : null,
    agentDeviceVersion: agentDevice?.trim().split('\n').pop()?.trim() || null,
    xcodeBuildVersion: parseXcodeBuildVersion(xcode),
  };
}

function quote(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

function sum(values: (number | null)[]): number | null {
  return values.some((value) => value === null)
    ? null
    : values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function largest<T extends { bytes: number | null }>(entries: T[]): T[] {
  return entries.toSorted((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
}

function assembleMachineCacheReport(
  usage: MachineCacheUsage,
  discovery: Discovery,
  gradleUse: GradleVersionUse,
  agentDeviceUsage: AgentDeviceUsage | null,
): MachineCacheReport {
  const sizes = new Map(usage.sizes.map((entry) => [entry.dir, entry.bytes]));
  const sized = (dir: string): SizedDir => ({ dir, bytes: sizes.get(dir) ?? null });
  const unusedVersions = largest(
    [...discovery.versionDirs]
      .filter(([version]) => !gradleUse.used.has(version))
      .map(([version, dirs]) => {
        const measured = dirs.map(sized);
        return {
          version,
          bytes: sum(measured.map((entry) => entry.bytes)),
          dirs: measured,
          remedy: `rm -rf ${dirs.map(quote).join(' ')}`,
        };
      }),
  );
  const entries = agentDeviceUsage?.runnerBuilds.platforms.flatMap((platform) => platform.entries) ?? [];
  const groups = new Map<
    string,
    { packageVersion: string | null; xcodeBuildVersion: string | null; entries: typeof entries }
  >();
  for (const entry of entries) {
    const key = JSON.stringify([entry.packageVersion, entry.xcodeBuildVersion]);
    const group = groups.get(key) ?? {
      packageVersion: entry.packageVersion,
      xcodeBuildVersion: entry.xcodeBuildVersion,
      entries: [],
    };
    group.entries.push(entry);
    groups.set(key, group);
  }
  const current = (packageVersion: string | null, xcodeBuildVersion: string | null) =>
    [usage.agentDeviceVersion, usage.xcodeBuildVersion, packageVersion, xcodeBuildVersion].includes(null)
      ? null
      : packageVersion === usage.agentDeviceVersion && xcodeBuildVersion === usage.xcodeBuildVersion;
  return {
    measuredAt: usage.measuredAt,
    complete:
      discovery.notices.length === 0 && usage.runtimes !== null && usage.sizes.every((entry) => entry.bytes !== null),
    notices: discovery.notices,
    gradle: {
      home: discovery.gradleHome,
      unusedVersions,
      usedVersions: [...gradleUse.used]
        .map(([version, projects]) => ({ version, projects }))
        .toSorted((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true })),
      unreadableProjects: gradleUse.unreadable,
      modules: discovery.modulesDir
        ? {
            ...sized(discovery.modulesDir),
            remedy: `Gradle removes entries unused for 30 days on its own; rm -rf ${quote(discovery.modulesDir)} empties it and builds download again`,
          }
        : null,
    },
    simRuntimes: {
      checked: usage.runtimes !== null,
      runtimes: largest(
        (usage.runtimes ?? []).map((runtime) =>
          Object.assign({}, runtime, {
            remedy:
              runtime.devices === 0 && runtime.deletable ? `xcrun simctl runtime delete ${runtime.identifier}` : null,
          }),
        ),
      ),
    },
    deviceSupport: {
      entries: largest(discovery.deviceSupportEntries.map(sized)),
      remedy:
        'Xcode copies an entry again the next time that device connects; remove entries for devices you no longer debug',
    },
    runnerBuilds: {
      agentDeviceVersion: usage.agentDeviceVersion,
      xcodeBuildVersion: usage.xcodeBuildVersion,
      groups: [...groups.values()]
        .map(({ packageVersion, xcodeBuildVersion, entries: group }) => {
          const used = group.flatMap((entry) => (entry.lastUsedAt ? [entry.lastUsedAt] : [])).toSorted();
          return {
            packageVersion,
            xcodeBuildVersion,
            current: current(packageVersion, xcodeBuildVersion),
            entries: group.length,
            inUse: group.filter((entry) => entry.inUse).length,
            bytes: sum(group.map((entry) => entry.bytes)),
            oldestUseAt: used[0] ?? null,
          };
        })
        .toSorted((a, b) => (a.oldestUseAt ?? '').localeCompare(b.oldestUseAt ?? '')),
      remedy:
        'agent-device has no prune command; remove an entry not in use with rm -rf and agent-device rebuilds the runner on next use',
    },
  };
}

export async function getMachineCacheReport(
  agentDeviceUsage: AgentDeviceUsage | null,
  { maxAgeMs = MAX_AGE_MS }: { maxAgeMs?: number } = {},
): Promise<MachineCacheReport> {
  const discovery = discover();
  const gradleUse = await projectGradleVersions(Object.keys(loadConfig()?.projects ?? {}));
  const dirs = [
    ...[...discovery.versionDirs].filter(([version]) => !gradleUse.used.has(version)).flatMap(([, list]) => list),
    ...(discovery.modulesDir ? [discovery.modulesDir] : []),
    ...discovery.deviceSupportEntries,
  ].toSorted();
  const cached = readMachineCacheUsage();
  const age = cached ? Date.now() - Date.parse(cached.measuredAt) : Infinity;
  let usage = cached;
  if (!usage || age < 0 || age >= maxAgeMs || JSON.stringify(usage.roots) !== JSON.stringify(dirs)) {
    usage = await measure(dirs);
    writeUsageCache(machineCacheUsageFile(), usage);
  }
  return assembleMachineCacheReport(usage, discovery, gradleUse, agentDeviceUsage);
}
