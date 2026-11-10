import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { basename, join } from 'path';
import type { Input } from '../fingerprint/key.ts';
import { buildUploadTimeoutMs, type BuildCacheCapability, type ProviderCallResult } from '@stim-cli/cache/tiers';
import { resolveArtifact, storeArtifactAsync, type StimContext } from '@stim-cli/core';
import { rename, rm, writeFile } from 'node:fs/promises';
import { withDrainingCancellation } from '../engine/operation-state.ts';
import { throwIfCancelled } from '../cancellation.ts';
import { childEnvironment, killOnAbort } from '../workspace/git-read.ts';
import { getExecutor } from '../exec.ts';
import { git } from '../workspace/git.ts';
import { register } from './cache-manifest.ts';
import { computeSignedTail, writeSignedTail } from '../engine/apk-signed-tail.ts';
import { ASSET_MANIFEST_FILE, parseAssetManifest, type AssetManifest } from '../engine/asset-manifest.ts';
import { sharedBuildCache as cacheRoot } from '../workspace/paths.ts';
import { DEFAULT_IOS_PROJECT_PATH } from '../workspace/settings.ts';

export { artifactIn, buildCacheKey } from '@stim-cli/core';
export { cacheRoot };

export function entryDir(platform: string, key: string, root: string = cacheRoot()): string {
  return join(root, platform, key);
}

function registerOnce(root: string, registeredBy?: string): void {
  try {
    register({
      dir: root,
      registeredBy,
      name: 'Build cache',
      prune: 'entries',
      entriesDepth: 2,
      note: 'built .app/.apk keyed on the native fingerprint',
    });
  } catch {}
}

export function resolveBuild(platform: string, key: string, root: string = cacheRoot()): string | null {
  return resolveArtifact(entryDir(platform, key, root));
}

export async function storeBuild(
  platform: string,
  key: string,
  buildPath: string,
  rootOrOptions:
    | string
    | {
        root?: string;
        overwrite?: boolean;
        sources?: unknown[] | null;
        inputs?: { schema: number; hash: string; inputs: readonly Input[] } | null;
        assetManifest?: AssetManifest | null;
        readAppId?: AppIdReader;
        signal?: AbortSignal;
        context?: StimContext;
      } = {},
): Promise<string | null> {
  const options = typeof rootOrOptions === 'string' ? { root: rootOrOptions } : rootOrOptions || {};
  const root = options.root || cacheRoot();
  const signal = options.signal ?? options.context?.signal;
  const env = options.context?.env;
  throwIfCancelled(signal, 'build cache copy');
  if (!buildPath || !existsSync(buildPath)) {
    throw new Error(`No build to store at ${buildPath}`);
  }
  registerOnce(root, options.context?.cwd);

  try {
    return await withDrainingCancellation(options.context, signal, () =>
      storeArtifactAsync(entryDir(platform, key, root), buildPath, {
        signal,
        runFile: (file, args) =>
          getExecutor().runFileAsync(file, args, {
            timeoutMs: 'unbounded',
            ...(env ? childEnvironment(env) : {}),
            onSpawn: killOnAbort(signal),
            declareFor: options.context,
          }),
        overwrite: Boolean(options.overwrite),
        writeMetadata: async (staging) => {
          if (platform === 'android' && buildPath.endsWith('.apk')) {
            try {
              const tail = await computeSignedTail(join(staging, basename(buildPath)), (file, args) =>
                getExecutor().runFileAsync(file, args, {
                  timeoutMs: 120_000,
                  ...(env ? childEnvironment(env) : {}),
                  onSpawn: killOnAbort(signal),
                  declareFor: options.context,
                }),
              );
              if (tail) await writeSignedTail(staging, tail);
            } catch {
              throwIfCancelled(signal, 'build cache copy');
            }
          }
          if (options.inputs) {
            try {
              await writeFile(join(staging, INPUTS_FILE), JSON.stringify(options.inputs));
            } catch {}
          }
          if (Array.isArray(options.sources)) {
            try {
              await writeFile(join(staging, SOURCES_FILE), JSON.stringify(options.sources.map(withoutContents)));
            } catch {}
          }
          if (options.assetManifest) {
            try {
              await writeFile(join(staging, ASSET_MANIFEST_FILE), JSON.stringify(options.assetManifest));
            } catch {}
          }
          if (options.readAppId) {
            try {
              const appId = await options.readAppId(buildPath);
              if (appId) await writeFile(join(staging, APP_ID_FILE), JSON.stringify({ appId }));
            } catch {
              throwIfCancelled(signal, 'build cache copy');
            }
          }
        },
      }),
    );
  } catch (error) {
    throwIfCancelled(signal, 'build cache copy');
    throw error;
  }
}

export type BuildStore = (...args: Parameters<typeof storeBuild>) => string | null | ReturnType<typeof storeBuild>;

export type AppIdReader = (artifactPath: string) => string | null | Promise<string | null>;

/** Removes a stored build by renaming its entry aside first, so no run sees a half-deleted entry. */
export async function evictBuild(platform: string, key: string, root: string = cacheRoot()): Promise<boolean> {
  const dir = entryDir(platform, key, root);
  const evicted = `${dir}.evicted-${process.pid}`;
  try {
    await rm(evicted, { recursive: true, force: true });
    await rename(dir, evicted);
  } catch {
    return false;
  }
  await rm(evicted, { recursive: true, force: true }).catch(() => {});
  return true;
}

export const PROVIDER_DOWNLOAD_DIR = 'cache-provider';

export function providerDownloadPath(workspacePath: string): string {
  return join(workspacePath, PROVIDER_DOWNLOAD_DIR);
}

/**
 * Empties and registers the scratch directory a provider downloads into. It is
 * created only when a provider is about to be asked, and registered so `gc`
 * reports what an interrupted run left behind.
 */
export function prepareProviderDownloadDir(dir: string, registeredBy?: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    register({
      dir,
      registeredBy,
      name: 'Cache provider downloads',
      prune: 'entries',
      entriesDepth: 1,
      note: 'artifacts fetched from the project cache provider; anything left here is from an interrupted run',
    });
  } catch {}
}

export interface FilesystemBuildCapabilityOptions {
  root?: string;
  context?: StimContext;
  sources?: unknown[] | null;
  inputs?: { schema: number; hash: string; inputs: readonly Input[] } | null;
  assetManifest?: AssetManifest | null;
  readAppId?: AppIdReader;
  resolve?: typeof resolveBuild;
  store?: BuildStore;
}

export function filesystemBuildCapability({
  root,
  context,
  sources,
  inputs,
  assetManifest,
  readAppId,
  resolve = resolveBuild,
  store = storeBuild,
}: FilesystemBuildCapabilityOptions = {}): BuildCacheCapability {
  const stored = {
    ...(context === undefined ? {} : { context }),
    ...(root === undefined ? {} : { root }),
    ...(sources === undefined ? {} : { sources }),
    ...(inputs === undefined ? {} : { inputs }),
    ...(assetManifest === undefined ? {} : { assetManifest }),
    ...(readAppId === undefined ? {} : { readAppId }),
  };
  return {
    resolve: ({ platform, key }) => (root === undefined ? resolve(platform, key) : resolve(platform, key, root)),
    store: ({ platform, key, sourcePath, overwrite, signal }) =>
      store(platform, key, sourcePath, { ...stored, overwrite, signal }),
  };
}

export interface ProviderUploadOutcome {
  line: string;
  warn: boolean;
}

export function providerUploadOutcome(
  result: ProviderCallResult<void> | null | undefined,
  name: string | null,
  env?: NodeJS.ProcessEnv,
): ProviderUploadOutcome | null {
  if (!result) return null;
  const label = name || 'the cache provider';
  if (result.timedOut) {
    return { line: `${label} upload was cancelled after ${buildUploadTimeoutMs(env)}ms`, warn: true };
  }
  if (result.failed) return { line: `${label} upload failed: ${result.failed}`, warn: true };
  return { line: `uploaded (${label})`, warn: false };
}

const SOURCES_FILE = 'fingerprint-sources.json';
const INPUTS_FILE = 'inputs.json';
const APP_ID_FILE = 'app-id.json';

function withoutContents(source: unknown): unknown {
  return source && typeof source === 'object' && 'type' in source && source.type === 'contents'
    ? { ...source, contents: '' }
    : source;
}

export function storedInputs(platform: string, key: string, root: string = cacheRoot()): unknown {
  try {
    return JSON.parse(readFileSync(join(entryDir(platform, key, root), INPUTS_FILE), 'utf-8'));
  } catch {
    return storedSources(platform, key, root);
  }
}

export function storedSources(platform: string, key: string, root: string = cacheRoot()): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(entryDir(platform, key, root), SOURCES_FILE), 'utf-8'));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The bundle id or Android package read from the entry's artifact when it was stored, or null for older entries. */
export function storedAppId(platform: string, key: string, root: string = cacheRoot()): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(entryDir(platform, key, root), APP_ID_FILE), 'utf-8'));
    if (parsed && typeof parsed === 'object' && 'appId' in parsed && typeof parsed.appId === 'string' && parsed.appId)
      return parsed.appId;
    return null;
  } catch {
    return null;
  }
}

export function storedAssetManifest(platform: string, key: string, root: string = cacheRoot()): AssetManifest | null {
  try {
    return parseAssetManifest(readFileSync(join(entryDir(platform, key, root), ASSET_MANIFEST_FILE), 'utf-8'));
  } catch {
    return null;
  }
}

function sourceName(source: unknown): string | null {
  const s = source as Record<string, unknown> | null | undefined;
  if (typeof s?.filePath === 'string' && s.filePath !== '') return s.filePath;
  if (typeof s?.id === 'string' && s.id !== '') return s.id;
  return null;
}

function sourceReasons(source: unknown): string[] {
  const reasons = (source as Record<string, unknown> | null | undefined)?.reasons;
  return Array.isArray(reasons) ? reasons.filter((reason): reason is string => typeof reason === 'string') : [];
}

export interface SourceChange {
  name: string;
  change: 'added' | 'removed' | 'changed';
  reasons: string[];
}

/** The installed package a source path lies in: the name after its last `node_modules/`. */
export function packageIn(path: string): string | null {
  const matches = [...path.matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/g)];
  return matches.at(-1)?.[1] ?? null;
}

/** A package that moved, such as a version bump of a pnpm store directory, is one change rather than a removal and an addition. */
function mergeMovedPackages(changes: SourceChange[]): SourceChange[] {
  const added = new Map<string, SourceChange>();
  for (const change of changes) {
    const pkg = change.change === 'added' ? packageIn(change.name) : null;
    if (pkg && !added.has(pkg)) added.set(pkg, change);
  }
  const moved = new Set<SourceChange>();
  const kept = changes.filter((change) => {
    const pkg = change.change === 'removed' ? packageIn(change.name) : null;
    const counterpart = pkg ? added.get(pkg) : undefined;
    if (!counterpart || moved.has(counterpart)) return true;
    moved.add(counterpart);
    return false;
  });
  for (const change of moved) change.change = 'changed';
  return kept;
}

export function compareSourceLists(previous: unknown[], current: unknown[]): SourceChange[] {
  return mergeMovedPackages(sourceListChanges(previous, current));
}

function sourceListChanges(previous: unknown[], current: unknown[]): SourceChange[] {
  const previousByName = new Map<string, { hash: string | null; reasons: string[] }>();
  for (const source of previous) {
    const name = sourceName(source);
    if (name !== null) {
      previousByName.set(name, {
        hash: ((source as Record<string, unknown>).hash as string | null) ?? null,
        reasons: sourceReasons(source),
      });
    }
  }
  const changes: SourceChange[] = [];
  const seen = new Set<string>();
  for (const source of current) {
    const name = sourceName(source);
    if (name === null || seen.has(name)) continue;
    seen.add(name);
    const hash = (source as Record<string, unknown>).hash ?? null;
    const before = previousByName.get(name);
    if (!before) changes.push({ name, change: 'added', reasons: sourceReasons(source) });
    else if (before.hash !== hash) changes.push({ name, change: 'changed', reasons: sourceReasons(source) });
  }
  for (const [name, before] of previousByName) {
    if (!seen.has(name)) changes.push({ name, change: 'removed', reasons: before.reasons });
  }
  return changes;
}

export function diffFingerprintSources({
  previous,
  current,
}: {
  previous: unknown[];
  previousHash?: string | null;
  current: { hash: string; sources: unknown[] };
}): SourceChange[] {
  return compareSourceLists(previous, current.sources);
}

export function changedDuringBuildLine(changed: string[]): string {
  const shown = changed.slice(0, UNTRACKED_MISS_CAP);
  const more = changed.length > shown.length ? `, and ${changed.length - shown.length} more` : '';
  return (
    `${shown.join(', ')}${more} changed while the build ran, so the artifact may not match its key; ` +
    'the build will be installed but not cached'
  );
}

export const UNTRACKED_MISS_CAP = 3;

export function untrackedNativeFiles({
  projectRoot,
  iosProjectPath = DEFAULT_IOS_PROJECT_PATH,
}: {
  projectRoot: string;
  iosProjectPath?: string;
}): string[] {
  let out: string;
  try {
    out = git(projectRoot, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '--',
      'ios',
      'android',
      ...(iosProjectPath !== DEFAULT_IOS_PROJECT_PATH ? [iosProjectPath] : []),
    ]);
  } catch {
    return [];
  }
  return String(out || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export function untrackedMissLine(files: string[], cap: number = UNTRACKED_MISS_CAP): string | null {
  if (!Array.isArray(files) || files.length === 0) return null;
  const shown = files.slice(0, cap);
  const more = files.length > shown.length ? `, and ${files.length - shown.length} more` : '';
  return (
    `no previous entry to diff against; ${files.length} untracked file${files.length === 1 ? '' : 's'} ` +
    `under ios/ or android/ are hashed like any other source: ${shown.join(', ')}${more}` +
    ' -- list the build-irrelevant ones in .fingerprintignore'
  );
}

export const FINGERPRINT_DIFF_LOG_CAP = 20;

export function fingerprintDiffRecord({
  changed,
  previousHash,
  hash,
}: {
  changed: string[];
  previousHash: string;
  hash: string;
}): Record<string, unknown> {
  const shown = changed.slice(0, FINGERPRINT_DIFF_LOG_CAP);
  return {
    src: 'build',
    level: 'info',
    event: 'fingerprint_diff',
    msg:
      `fingerprint ${previousHash} -> ${hash}: ${changed.length} source${changed.length === 1 ? '' : 's'} changed: ` +
      shown.join(', ') +
      (changed.length > shown.length ? `, and ${changed.length - shown.length} more` : ''),
    changed: changed.length,
    sources: shown,
  };
}
