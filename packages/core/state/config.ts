import { createHash } from 'node:crypto';
import { availableParallelism, totalmem } from 'node:os';
import { isAbsolute, join, sep, win32 } from 'node:path';
import { ambientEnv } from '../context.ts';
import { configDir, ensurePrivateDir, withDirLock, withDirLockAsync } from '../index.ts';
import type { Config, ConcurrencyLimits, PlatformDeviceLimits, ProjectRecord } from './config-types.ts';
import { machineSettingValue } from './settings-registry.ts';
import { isJsonObject, readJsonFile } from './json-file.ts';
import { configLockPath, getConfigPath } from './paths.ts';

export function withConfigLock<T>(fn: () => T): T {
  return withDirLock(configLockPath(), fn, {
    ensureParent: () => ensurePrivateDir(configDir()),
  });
}

/** Waits for the config lock without blocking the event loop. The signal cancels acquisition; `fn` runs synchronously. */
export function withConfigLockAsync<T>(fn: () => T, signal?: AbortSignal): Promise<T> {
  return withDirLockAsync(configLockPath(), fn, {
    ensureParent: () => ensurePrivateDir(configDir()),
    signal,
  });
}

export function configCorruptRepair(path: string = getConfigPath()): string {
  return `Repair the file, or move it aside to start over: mv "${path}" "${path}.broken"`;
}

function configCorrupt(reason: string, path: string = getConfigPath()): Error {
  const corrupt = new Error(
    `Stim config at ${path} ${reason}\n` +
      'It holds the records of the simulators and emulators Stim owns, so it is never reset automatically.\n' +
      configCorruptRepair(path),
  );
  (corrupt as Error & { code?: string }).code = 'STIM_CONFIG_CORRUPT';
  return corrupt;
}

/** The build worker root: `server.workerRoot` when it is absolute, else `$STIM_HOME/build-worker`. */
export function buildWorkerRoot(config: Config | null = loadConfig()): string {
  const configured = config?.server?.workerRoot;
  return typeof configured === 'string' && isAbsolute(configured) ? configured : join(configDir(), 'build-worker');
}

/**
 * A short directory at the drive root that stands in for the build worker directory `path` on Windows. The NDK's
 * ninja is not long-path aware (STIM_PATH_TOO_LONG), and it opens paths under the checkout and under the Gradle user
 * home's transforms cache, both of which are too long under the worker root. A subst drive does not help: Node's
 * native realpath, which expo-modules-autolinking uses, resolves it back to the long path.
 */
export function windowsShortDir(path: string, systemDrive: string = process.env.SystemDrive ?? 'C:'): string {
  const id = createHash('sha256').update(path.toLowerCase()).digest('hex').slice(0, 6);
  return win32.join(`${systemDrive}\\`, 'sw', id);
}

/** The ASCII key a Windows build worker records beside a `windowsShortDir` to tell which `kind` and `path` it serves. */
export function windowsShortDirKey(kind: 'checkout' | 'gradle', path: string): string {
  return createHash('sha256').update(`${kind}:${path.toLowerCase()}`).digest('hex');
}

export function loadConfig(p: string = getConfigPath()): Config | null {
  let parsed: unknown;
  try {
    parsed = readJsonFile(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    if (!(err instanceof SyntaxError)) throw err;
    throw configCorrupt(`is not valid JSON: ${err.message}`, p);
  }
  return configFromJson(parsed, p);
}

function configFromJson(value: unknown, path: string): Config {
  if (!isJsonObject(value)) throw configCorrupt(`is not a JSON object: ${JSON.stringify(value)}`, path);
  return {
    ...value,
    projects: registryFromJson(value, 'projects', path),
    repos: registryFromJson(value, 'repos', path),
  };
}

/**
 * An array or scalar container swallows every write silently: `JSON.stringify` drops a string key set on
 * an array, so the record is gone by the time the file is written. Absent or null is read as empty; an
 * unusable container or entry is refused.
 */
function registryFromJson(
  config: Record<string, unknown>,
  key: 'projects' | 'repos',
  path: string,
): Record<string, Record<string, unknown>> {
  const value = config[key];
  if (value === undefined || value === null) return {};
  if (!isJsonObject(value)) throw configCorrupt(`has a ${key} that is not an object: ${JSON.stringify(value)}`, path);
  const registry: Record<string, Record<string, unknown>> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (name === '__proto__') continue;
    if (!isJsonObject(entry)) {
      throw configCorrupt(
        `has a ${key} entry ${JSON.stringify(name)} that is not an object: ${JSON.stringify(entry)}`,
        path,
      );
    }
    registry[name] = entry;
  }
  return registry;
}

export function getProject(projectPath: string): ProjectRecord | null {
  const cfg = loadConfig();
  return cfg?.projects?.[projectPath] || null;
}

export function getConcurrencyLimits({ env = ambientEnv() }: { env?: NodeJS.ProcessEnv } = {}): ConcurrencyLimits {
  const cfg = loadConfig();
  return {
    maxBuilds: limit('concurrency.maxBuilds', cfg, env),
    maxDevices: limit('concurrency.maxDevices', cfg, env),
  };
}

const GIB = 1024 ** 3;

/** The derived `concurrency.maxBuilds`: one native build per six cores, at least one. */
export function derivedBuildCap(cores: number = availableParallelism()): number {
  return Math.max(1, Math.floor(cores / 6));
}

/** The derived `concurrency.maxDevices`: one booted simulator or emulator per 1.5 GB of RAM above 4 GB, at least two. */
export function derivedDeviceCap(totalBytes: number = totalmem()): number {
  return Math.max(2, Math.floor((totalBytes - 4 * GIB) / (1.5 * GIB)));
}

/**
 * The build and device caps admission enforces: `concurrency.maxBuilds` and `concurrency.maxDevices` when set above 0,
 * else the derived caps. `derived` names the caps that were derived.
 */
export function admissionLimits({
  env = ambientEnv(),
  cores,
  totalBytes,
}: { env?: NodeJS.ProcessEnv; cores?: number; totalBytes?: number } = {}): ConcurrencyLimits & {
  derived: { builds: boolean; devices: boolean };
} {
  const set = getConcurrencyLimits({ env });
  return {
    maxBuilds: set.maxBuilds || derivedBuildCap(cores),
    maxDevices: set.maxDevices || derivedDeviceCap(totalBytes),
    derived: { builds: set.maxBuilds === 0, devices: set.maxDevices === 0 },
  };
}

export function getPlatformDeviceLimits({
  env = ambientEnv(),
}: { env?: NodeJS.ProcessEnv } = {}): PlatformDeviceLimits {
  const config = loadConfig();
  return {
    ios: limit('concurrency.maxIosDevices', config, env),
    android: limit('concurrency.maxAndroidDevices', config, env),
    macos: limit('concurrency.maxMacosApps', config, env),
  };
}

export interface ParkedMax {
  max: number;
  error: string | null;
}

export function getParkedMax(
  platform: 'ios' | 'android',
  { config = loadConfig(), env = ambientEnv() }: { config?: Config | null; env?: NodeJS.ProcessEnv } = {},
): ParkedMax {
  const { value, error } = machineSettingValue(`pool.${platform}ParkedMax`, { config, env });
  return { max: error ? 0 : Number(value), error };
}

/** `pool.bootedGraceMinutes`: a scoped home keeps it at 0 unless the environment sets it. */
export function getBootedGraceMinutes({
  config = loadConfig(),
  env = ambientEnv(),
}: { config?: Config | null; env?: NodeJS.ProcessEnv } = {}): ParkedMax {
  const { value, error } = machineSettingValue('pool.bootedGraceMinutes', { config, env });
  return { max: error ? 0 : Number(value), error };
}

function limit(key: string, config: Config | null, env: NodeJS.ProcessEnv): number {
  const { value, error } = machineSettingValue(key, { config, env });
  if (error) throw Object.assign(new Error(error), { code: 'STIM_BAD_ARG' });
  return Number(value);
}

export function getProjectSettings(projectPath: string): Record<string, unknown> {
  return getProject(projectPath)?.settings || {};
}

export function getRepoSettings(gitCommonDir: string): Record<string, unknown> {
  const cfg = loadConfig();
  return cfg?.repos?.[gitCommonDir]?.settings || {};
}

export function isPathPrefix(prefix: string, path: string): boolean {
  const head = comparablePath(prefix);
  const candidate = comparablePath(path);
  if (head === candidate) return true;
  return candidate.startsWith(head.endsWith('/') ? head : `${head}/`);
}

// A backslash is a separator on Windows and an ordinary filename character elsewhere.
function comparablePath(path: string): string {
  return sep === '/' ? path : path.replaceAll(sep, '/');
}

export function findEnclosingWorktreeRoot(projectPath: string): string | null {
  const cfg = loadConfig();
  if (!cfg?.projects) return null;
  let best: string | null = null;
  for (const [path, proj] of Object.entries(cfg.projects)) {
    if (!proj?.worktreeRoot) continue;
    if (!isPathPrefix(path, projectPath)) continue;
    if (!best || path.length > best.length) best = path;
  }
  return best;
}

export function allMetroPorts(): number[] {
  const cfg = loadConfig();
  if (!cfg?.projects) return [];
  return Object.values(cfg.projects)
    .map((p) => p.metroPort)
    .filter((p) => typeof p === 'number');
}
