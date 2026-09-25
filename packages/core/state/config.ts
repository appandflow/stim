import { existsSync, mkdirSync } from 'node:fs';
import { sep } from 'node:path';
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

export function loadConfig(): Config | null {
  const p = getConfigPath();
  if (!existsSync(p)) return null;
  let parsed: unknown;
  try {
    parsed = readJsonFile(p);
  } catch (err) {
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
