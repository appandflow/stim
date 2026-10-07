import { existsSync, mkdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { configDir, withDirLock } from '../index.ts';
import type { Config, ConcurrencyLimits, ProjectRecord } from './config-types.ts';
import { isJsonObject, readJsonFile } from './json-file.ts';
import { configLockPath, getConfigPath } from './paths.ts';

export function withConfigLock<T>(fn: () => T): T {
  return withDirLock(configLockPath(), fn, {
    ensureParent: () => {
      const dir = configDir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    },
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
  return typeof configured === 'string' && configured.startsWith('/') ? configured : join(configDir(), 'build-worker');
}

export function loadConfig(): Config | null {
  const p = getConfigPath();
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

export function getConcurrencyLimits({ env = process.env }: { env?: NodeJS.ProcessEnv } = {}): ConcurrencyLimits {
  const cfg = loadConfig();
  const c = cfg?.concurrency || {};
  return {
    maxBuilds: resolveLimit(env.STIM_MAX_BUILDS, c.maxBuilds),
    maxDevices: resolveLimit(env.STIM_MAX_DEVICES, c.maxDevices),
  };
}

const MAX_SETTING: Record<'ios' | 'android', { key: string; env: string }> = {
  ios: { key: 'iosParkedMax', env: 'STIM_POOL_IOS_PARKED_MAX' },
  android: { key: 'androidParkedMax', env: 'STIM_POOL_ANDROID_PARKED_MAX' },
};

export interface ParkedMax {
  max: number;
  error: string | null;
}

function parseMax(raw: unknown, strings: boolean): number | null {
  const value = strings && typeof raw === 'string' ? (/^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN) : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

export function getParkedMax(
  platform: 'ios' | 'android',
  { config, env = process.env }: { config?: Config | null; env?: NodeJS.ProcessEnv } = {},
): ParkedMax {
  const { key, env: envKey } = MAX_SETTING[platform];
  const fromEnv = env[envKey];
  const explicit = fromEnv !== undefined && fromEnv !== '';
  const cfg = config === undefined ? loadConfig() : config;
  const pool = cfg?.pool;
  if (!explicit && pool !== undefined && (pool === null || typeof pool !== 'object' || Array.isArray(pool))) {
    return { max: 0, error: 'Invalid pool value. Expected an object with simulator and emulator bounds.' };
  }
  const fromConfig =
    pool !== null && typeof pool === 'object' && !Array.isArray(pool)
      ? (pool as Record<string, unknown>)[key]
      : undefined;
  const raw = explicit ? fromEnv : fromConfig;
  if (raw === undefined) return { max: env.STIM_HOME ? 0 : 3, error: null };
  const parsed = parseMax(raw, explicit);
  if (parsed === null) {
    return {
      max: 0,
      error: `Invalid ${explicit ? envKey : `pool.${key}`} value ${JSON.stringify(raw)}. Expected a whole number of parked ${platform === 'ios' ? 'simulators' : 'emulators'}, 0 or more.`,
    };
  }
  return { max: explicit ? parsed : env.STIM_HOME ? 0 : parsed, error: null };
}

function resolveLimit(envVal: unknown, cfgVal: unknown): number {
  const hasEnv = envVal !== undefined && envVal !== null && envVal !== '';
  const raw = hasEnv ? Number(envVal) : typeof cfgVal === 'number' ? cfgVal : Number.NaN;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

export function getProjectSettings(projectPath: string): Record<string, unknown> {
  return getProject(projectPath)?.settings || {};
}

export function getProjectSetting(projectPath: string, dottedKey: string): unknown {
  return readNested(getProjectSettings(projectPath), dottedKey);
}

export function getRepoSettings(gitCommonDir: string): Record<string, unknown> {
  const cfg = loadConfig();
  return cfg?.repos?.[gitCommonDir]?.settings || {};
}

function readNested(obj: unknown, dottedKey: string): unknown {
  if (!obj) return undefined;
  const keys = dottedKey.split('.');
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
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

export function findProjectByMetroPort(port: number): string | null {
  const cfg = loadConfig();
  for (const [path, proj] of Object.entries(cfg?.projects || {})) {
    if (proj.metroPort === port) return path;
  }
  return null;
}
