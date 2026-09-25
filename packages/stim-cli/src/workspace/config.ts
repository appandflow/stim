import {
  assignSlotDevice,
  deviceSlotPlatforms,
  projectDeviceSlots,
  removeSlotDevice,
} from '../devices/device-slots.ts';
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { isAbsolute, join, sep } from 'path';
import { configDir } from '@stim-cli/core';
import { isOnMountedVolume } from '../fs-util.ts';
import { isJsonObject, readJsonFile } from '../json-file.ts';
import { withDirLock } from '../dir-lock.ts';
import { acquireAvdClaim } from '../devices/avd-claim.ts';
import { releaseClaim } from '../ownership-claim.ts';

import type {
  Config,
  ConcurrencyLimits,
  DeviceRecord,
  ProjectRecord,
  RepoRecord,
  SupervisorRecord,
} from './config-types.ts';
import { sameProcessRecord, type ProcessRecord } from '../process-identity.ts';
export type { Config, ConcurrencyLimits, DeviceRecord, ProjectRecord, RepoRecord, SupervisorRecord };

export function getConfigDir(): string {
  return configDir();
}

export function refuseRelativeStimPaths(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of ['STIM_HOME', 'STIM_BUILD_CACHE', 'STIM_METRO_CACHE']) {
    const value = env[name];
    if (!value || isAbsolute(value)) continue;
    const error = new Error(
      `${name}=${value} is not an absolute path. Set it to an absolute path, or unset it to use the default.`,
    ) as Error & { code?: string };
    error.code = 'STIM_RELATIVE_PATH';
    throw error;
  }
}

export function getConfigPath(): string {
  return join(getConfigDir(), 'config.json');
}

function ensureDir() {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

const LOCK_DIR_NAME = 'config.lock';

function lockPath() {
  return join(getConfigDir(), LOCK_DIR_NAME);
}

export function withConfigLock<T>(fn: () => T): T {
  return withDirLock(lockPath(), fn, { ensureParent: ensureDir });
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

export function saveConfig(config: Config): void {
  ensureDir();
  const target = getConfigPath();
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  try {
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

const CONFIG_VERSION = 2;

export function ensureConfig(): Config {
  return withConfigLock(() => {
    const existing = loadConfig();
    if (existing) {
      if (existing.version !== CONFIG_VERSION) {
        existing.version = CONFIG_VERSION;
        saveConfig(existing);
      }
      return existing;
    }
    const fresh = { version: CONFIG_VERSION, projects: {}, repos: {} };
    saveConfig(fresh);
    return fresh;
  });
}

export function getProject(projectPath: string): ProjectRecord | null {
  const cfg = loadConfig();
  return cfg?.projects?.[projectPath] || null;
}

function requireAbsoluteProjectPath(projectPath: string): void {
  if (isAbsolute(projectPath)) return;
  throw new Error(
    `Project key "${projectPath}" is not an absolute path. ` +
      'The registry is keyed by the realpath of a workspace root, so a relative key can never resolve.',
  );
}

export function upsertProject(
  projectPath: string,
  fields: Partial<ProjectRecord> | ((existing: ProjectRecord) => Partial<ProjectRecord>),
): ProjectRecord {
  requireAbsoluteProjectPath(projectPath);
  return withConfigLock(() => {
    const cfg = ensureConfig();
    const existing = cfg.projects[projectPath] || {
      metroPort: null,
      platforms: {},
    };
    cfg.projects[projectPath] = {
      ...existing,
      ...(typeof fields === 'function' ? fields(existing) : fields),
    };
    saveConfig(cfg);
    return cfg.projects[projectPath];
  });
}

export function removeProject(projectPath: string): void {
  withConfigLock(() => {
    const cfg = loadConfig();
    if (!cfg?.projects?.[projectPath]) return;
    if (Object.keys(cfg.projects[projectPath].ports ?? {}).length) {
      throw new Error(
        `Named ports remain for ${projectPath}; stop or release them before removing its registry entry.`,
      );
    }
    for (const { platforms } of projectDeviceSlots(cfg.projects[projectPath])) {
      if (platforms.android?.owned && platforms.android.avdName) {
        releaseClaim(acquireAvdClaim(platforms.android.avdName));
      }
    }
    delete cfg.projects[projectPath];
    saveConfig(cfg);
  });
}

export function claimMetroPort(projectPath: string, port: number): number | null {
  return withConfigLock(() => {
    const cfg = ensureConfig();
    if (!cfg.projects[projectPath]) {
      throw new Error(`Project not registered: ${projectPath}`);
    }
    for (const [path, proj] of Object.entries(cfg.projects)) {
      if (path !== projectPath && proj?.metroPort === port) return null;
      if (Object.values(proj?.ports ?? {}).includes(port)) return null;
    }
    cfg.projects[projectPath].metroPort = port;
    saveConfig(cfg);
    return port;
  });
}

export function releaseMetroPort(projectPath: string, port: number): void {
  withConfigLock(() => {
    const cfg = loadConfig();
    const project = cfg?.projects?.[projectPath];
    if (!cfg || project?.metroPort !== port) return;
    project.metroPort = null;
    saveConfig(cfg);
  });
}

export function setDevice(projectPath: string, platform: string, deviceFields: DeviceRecord, slot = 'default'): void {
  requireAbsoluteProjectPath(projectPath);
  withConfigLock(() => {
    const cfg = ensureConfig();
    if (!cfg.projects[projectPath]) {
      throw new Error(`Project not registered: ${projectPath}`);
    }
    assignSlotDevice(cfg.projects[projectPath], platform, deviceFields, slot);
    saveConfig(cfg);
  });
}

export function releaseAndroidConsolePort(projectPath: string, consolePort: number, slot = 'default'): boolean {
  return withConfigLock(() => {
    const cfg = loadConfig();
    const android = deviceSlotPlatforms(cfg?.projects?.[projectPath], slot)?.android;
    if (!cfg || !android || android.consolePort !== consolePort) return false;
    delete android.consolePort;
    saveConfig(cfg);
    return true;
  });
}

export function clearDevice(projectPath: string, platform: string, slot = 'default', expectedId?: string): boolean {
  return withConfigLock(() => {
    const cfg = loadConfig();
    const project = cfg?.projects?.[projectPath];
    if (!cfg || !project) return false;
    const current = deviceSlotPlatforms(project, slot)?.[platform];
    if (expectedId !== undefined && (platform === 'ios' ? current?.deviceUdid : current?.avdName) !== expectedId)
      return false;
    removeSlotDevice(project, platform, slot);
    saveConfig(cfg);
    return true;
  });
}

export function setSupervisor(
  projectPath: string,
  { pid, port, startedAt, processToken }: SupervisorRecord,
): SupervisorRecord {
  requireAbsoluteProjectPath(projectPath);
  return withConfigLock(() => {
    const cfg = ensureConfig();
    if (!cfg.projects[projectPath]) {
      cfg.projects[projectPath] = { metroPort: null, platforms: {} };
    }
    cfg.projects[projectPath].supervisor = { pid, port, startedAt, processToken };
    saveConfig(cfg);
    return cfg.projects[projectPath].supervisor;
  });
}

export function clearSupervisor(projectPath: string, expected?: ProcessRecord | null): boolean {
  return withConfigLock(() => {
    const cfg = loadConfig();
    const current = cfg?.projects?.[projectPath]?.supervisor;
    if (!current) return true;
    if (expected !== undefined && !sameProcessRecord(current, expected)) return false;
    delete cfg.projects[projectPath]!.supervisor;
    saveConfig(cfg);
    return true;
  });
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

export function setProjectSetting(projectPath: string, dottedKey: string, value: unknown): void {
  withConfigLock(() => {
    const cfg = ensureConfig();
    const proj = cfg.projects[projectPath];
    if (!proj) throw new Error(`Project not registered: ${projectPath}`);
    proj.settings = proj.settings || {};
    writeNested(proj.settings, dottedKey, value);
    saveConfig(cfg);
  });
}

export function unsetProjectSetting(projectPath: string, dottedKey: string): boolean {
  return withConfigLock(() => {
    const cfg = loadConfig();
    const proj = cfg?.projects?.[projectPath];
    if (!proj?.settings) return false;
    const removed = deleteNested(proj.settings, dottedKey);
    if (removed && cfg) saveConfig(cfg);
    return removed;
  });
}

export function getRepoSettings(gitCommonDir: string): Record<string, unknown> {
  const cfg = loadConfig();
  return cfg?.repos?.[gitCommonDir]?.settings || {};
}

export function setRepoSetting(gitCommonDir: string, dottedKey: string, value: unknown): void {
  withConfigLock(() => {
    const cfg = ensureConfig();
    cfg.repos[gitCommonDir] = cfg.repos[gitCommonDir] || {};
    cfg.repos[gitCommonDir].settings = cfg.repos[gitCommonDir].settings || {};
    writeNested(cfg.repos[gitCommonDir].settings, dottedKey, value);
    saveConfig(cfg);
  });
}

export function unsetRepoSetting(gitCommonDir: string, dottedKey: string): boolean {
  return withConfigLock(() => {
    const cfg = loadConfig();
    const settings = cfg?.repos?.[gitCommonDir]?.settings;
    if (!settings) return false;
    const removed = deleteNested(settings, dottedKey);
    if (removed && cfg) saveConfig(cfg);
    return removed;
  });
}

export type ConfigSettingsTarget =
  | { scope: 'machine' }
  | { scope: 'workspace'; projectPath: string }
  | { scope: 'repo'; gitCommonDir: string };

function targetSettings(cfg: Config, target: ConfigSettingsTarget, create: boolean): Record<string, unknown> | null {
  if (target.scope === 'machine') return cfg;
  if (target.scope === 'workspace') {
    if (!cfg.projects[target.projectPath]) {
      if (!create) return null;
      cfg.projects[target.projectPath] = { metroPort: null, platforms: {} };
    }
    const project = cfg.projects[target.projectPath]!;
    if (!project.settings && create) project.settings = {};
    return project.settings ?? null;
  }
  if (!cfg.repos[target.gitCommonDir]) {
    if (!create) return null;
    cfg.repos[target.gitCommonDir] = {};
  }
  const repo = cfg.repos[target.gitCommonDir]!;
  if (!repo.settings && create) repo.settings = {};
  return repo.settings ?? null;
}

export function writeConfigSetting(target: ConfigSettingsTarget, dottedKey: string, value: unknown): boolean {
  if (target.scope === 'workspace') requireAbsoluteProjectPath(target.projectPath);
  return withConfigLock(() => {
    const cfg = value === undefined ? loadConfig() : ensureConfig();
    const settings = cfg ? targetSettings(cfg, target, value !== undefined) : null;
    if (!cfg || !settings) return false;
    if (value === undefined) {
      if (!deleteNested(settings, dottedKey)) return false;
    } else {
      writeNested(settings, dottedKey, value);
    }
    saveConfig(cfg);
    return true;
  });
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

function writeNested(obj: Record<string, unknown>, dottedKey: string, value: unknown): void {
  const keys = dottedKey.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (k === undefined) continue;
    const next = cur[k];
    if (typeof next !== 'object' || next === null) {
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  const leaf = keys[keys.length - 1];
  if (leaf !== undefined) cur[leaf] = value;
}

function deleteNested(obj: Record<string, unknown>, dottedKey: string): boolean {
  const keys = dottedKey.split('.');
  const chain: Record<string, unknown>[] = [obj];
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (k === undefined) return false;
    const next = cur[k];
    if (next == null || typeof next !== 'object') return false;
    cur = next as Record<string, unknown>;
    chain.push(cur);
  }
  const leaf = keys[keys.length - 1];
  if (leaf === undefined) return false;
  if (!(leaf in cur)) return false;
  delete cur[leaf];
  for (let i = chain.length - 2; i >= 0; i--) {
    const parent = chain[i];
    const key = keys[i];
    const child = chain[i + 1];
    if (parent === undefined || key === undefined || child === undefined) break;
    if (Object.keys(child).length === 0) {
      delete parent[key];
    } else {
      break;
    }
  }
  return true;
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

export function allConsolePortsAndSerials({
  isMounted = isOnMountedVolume,
}: { isMounted?: (p: string) => boolean } = {}): { androidConsolePorts: number[]; androidPhysicalSerials: string[] } {
  const cfg = loadConfig();
  const result: { androidConsolePorts: number[]; androidPhysicalSerials: string[] } = {
    androidConsolePorts: [],
    androidPhysicalSerials: [],
  };
  if (!cfg) return result;
  for (const [path, proj] of Object.entries(cfg.projects || {})) {
    if (!existsSync(path) && isMounted(path)) continue;
    for (const { platforms } of projectDeviceSlots(proj)) {
      const android = platforms.android;
      if (typeof android?.consolePort === 'number') {
        result.androidConsolePorts.push(android.consolePort);
      }
      if (android?.serial && !android.avdName) {
        result.androidPhysicalSerials.push(android.serial);
      }
    }
  }
  return result;
}
