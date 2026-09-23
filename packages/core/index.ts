import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { withDirLock } from './dir-lock.ts';
export { withDirLock, type DirLockOptions } from './dir-lock.ts';
export { quotedPath } from './quoted-path.ts';
export { artifactIn, resolveArtifact, storeArtifact, type StoreArtifactOptions } from './artifact-store.ts';

export function configDir(): string {
  return process.env.STIM_HOME || path.join(os.homedir(), '.stim');
}

export function workspaceSlug(projectRoot: string): string {
  const name = path
    .basename(path.resolve(projectRoot))
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 48);
  return name || 'workspace';
}

export function workspaceId(projectRoot: string): string {
  return createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 16);
}

export function workspaceName(projectRoot: string): string {
  return `${workspaceSlug(projectRoot)}--${workspaceId(projectRoot)}`;
}

export function workspaceStateDir(projectRoot: string): string {
  return path.join(configDir(), 'workspaces', workspaceName(projectRoot));
}

export function workspaceLogDir(projectRoot: string): string {
  return path.join(workspaceStateDir(projectRoot), 'logs');
}

export function cachePathSetting(key: 'buildCache' | 'metroCache'): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(configDir(), 'config.json'), 'utf-8')) as {
      caches?: Record<string, unknown>;
    };
    const value = parsed?.caches?.[key];
    return typeof value === 'string' && path.isAbsolute(value) ? value : null;
  } catch {
    return null;
  }
}

export function cacheNameSegment(name: string | null | undefined): string {
  return (
    String(name)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^\.+/, '') || 'app'
  );
}

export function buildCacheRoot(): string {
  return process.env.STIM_BUILD_CACHE || cachePathSetting('buildCache') || path.join(configDir(), 'build-cache');
}

export function metroCacheRoot(name?: string | null): string {
  const root = process.env.STIM_METRO_CACHE || cachePathSetting('metroCache') || path.join(configDir(), 'metro-cache');
  return name === undefined || name === null || name === '' ? root : path.join(root, cacheNameSegment(name));
}

export const STORE_ROOT_TAG = 'stimStoreRoot';

export function tagSharedStore<T extends object>(store: T, root: string): T {
  try {
    Object.defineProperty(store, STORE_ROOT_TAG, { value: root, enumerable: false, configurable: true });
  } catch {}
  return store;
}

export function sharedStoreRoot(store: unknown): string | null {
  if (store === null || typeof store !== 'object') return null;
  const tagged = (store as Record<string, unknown>)[STORE_ROOT_TAG];
  if (typeof tagged === 'string') return tagged;
  const legacy = (store as { _root?: unknown })._root;
  return typeof legacy === 'string' ? legacy : null;
}

export interface BuildRunOptions {
  buildProfile?: string;
  compiler?: string;
  variant?: string;
  abi?: string;
  allArch?: boolean;
  configuration?: string;
  scheme?: string;
  buildConfiguration?: string;
  isSimulator?: boolean;
  device?: string | boolean | null;
}

const SIMULATOR_UDID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMULATOR_SERIAL = /^emulator-\d+$/;

function slug(value: unknown): string {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildVariant(platform: string, options: BuildRunOptions): string {
  const raw = platform === 'android' ? options.variant : (options.configuration ?? options.buildConfiguration);
  return (typeof raw === 'string' ? slug(raw) : '') || 'debug';
}

function buildTarget(options: BuildRunOptions): string {
  if (typeof options.isSimulator === 'boolean') return options.isSimulator ? 'sim' : 'device';
  const device = options.device;
  if (device === undefined || device === null || device === false) return 'sim';
  if (typeof device !== 'string') return 'prompted';
  const name = device.trim();
  if (name === '' || name === 'generic') return 'sim';
  if (SIMULATOR_UDID.test(name) || EMULATOR_SERIAL.test(name)) return 'sim';
  return `on-${slug(name)}`;
}

export function buildCacheKey(platform: string, fingerprintHash: string, options: unknown = {}): string {
  const opts = (options && typeof options === 'object' ? options : {}) as BuildRunOptions;
  const abi = platform === 'android' && typeof opts.abi === 'string' ? slug(opts.abi) : '';
  const allArch = platform === 'android' && opts.allArch === true ? '-all-arch' : '';
  const compiler = typeof opts.compiler === 'string' ? slug(opts.compiler) : '';
  const profile = typeof opts.buildProfile === 'string' ? slug(opts.buildProfile) : '';
  const scheme =
    platform === 'ios' && typeof opts.scheme === 'string' && opts.scheme
      ? createHash('sha256').update(opts.scheme).digest('hex')
      : '';
  return `${fingerprintHash}-${buildVariant(platform, opts)}-${buildTarget(opts)}${abi ? `-${abi}` : ''}${allArch}${compiler ? `-${compiler}` : ''}${profile ? `-${profile}` : ''}${scheme ? `-scheme-${scheme}` : ''}`;
}

export interface RegisterOptions {
  dir: string;
  name: string;
  prune: string;
  note: string;
  entriesDepth?: number;
  layout?: string;
  replaces?: CacheRegistrationMatch[];
}

export interface CacheRegistrationMatch {
  dir: string;
  name?: string;
  prune?: string;
  entriesDepth?: number;
  layout?: string | null;
}

export const METRO_NAMED_CACHE_LAYOUT = 'metro-named-v1';

export interface CacheManifest {
  version: number;
  caches: Array<Record<string, unknown>>;
}

export function cacheManifestLockPath(file: string): string {
  return `${file}.lock`;
}

export function readCacheManifest(file: string): CacheManifest {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { caches?: Array<Record<string, unknown>> };
    return { version: 1, caches: Array.isArray(parsed?.caches) ? parsed.caches : [] };
  } catch {
    return { version: 1, caches: [] };
  }
}

export function updateCacheManifest(
  file: string,
  mutate: (caches: Array<Record<string, unknown>>) => Array<Record<string, unknown>>,
): CacheManifest {
  const parent = path.dirname(file);
  return withDirLock(
    cacheManifestLockPath(file),
    () => {
      const next: CacheManifest = { version: 1, caches: mutate(readCacheManifest(file).caches) };
      const temporary = path.join(parent, `.${path.basename(file)}.${process.pid}.tmp`);
      try {
        fs.writeFileSync(temporary, JSON.stringify(next, null, 2));
        fs.renameSync(temporary, file);
      } catch (error) {
        fs.rmSync(temporary, { force: true });
        throw error;
      }
      return next;
    },
    { ensureParent: () => fs.mkdirSync(parent, { recursive: true }) },
  );
}

export function registerCache({ dir, name, prune, note, entriesDepth, layout, replaces = [] }: RegisterOptions): void {
  try {
    updateCacheManifest(path.join(configDir(), 'caches.json'), (caches) => {
      const others = caches.filter(
        (cache) => cache.dir !== dir && !replaces.some((match) => matchesCache(cache, match)),
      );
      const record: Record<string, unknown> = { dir, name, prune, note, registeredBy: process.cwd() };
      if (entriesDepth) record.entriesDepth = entriesDepth;
      if (layout) record.layout = layout;
      others.push(record);
      return others;
    });
  } catch {}
}

function matchesCache(cache: Record<string, unknown>, match: CacheRegistrationMatch): boolean {
  if (cache.dir !== match.dir) return false;
  if (match.name !== undefined && cache.name !== match.name) return false;
  if (match.prune !== undefined && cache.prune !== match.prune) return false;
  if (match.entriesDepth !== undefined && cache.entriesDepth !== match.entriesDepth) return false;
  if (match.layout === null) return !Object.hasOwn(cache, 'layout');
  return match.layout === undefined || cache.layout === match.layout;
}
