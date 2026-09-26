import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { isDeepStrictEqual } from 'util';
import * as expoFingerprint from '@expo/fingerprint';
import type { Fingerprint, FingerprintSource, Options as FingerprintOptions } from '@expo/fingerprint';
import { buildUploadTimeoutMs, type BuildCacheCapability, type ProviderCallResult } from '@stim-cli/cache';
import { resolveArtifact, storeArtifact } from '@stim-cli/core';
import { getExecutor } from '../exec.ts';
import { register } from './cache-manifest.ts';
import { ASSET_MANIFEST_FILE, parseAssetManifest, type AssetManifest } from '../engine/asset-manifest.ts';
import { sharedBuildCache as cacheRoot } from '../workspace/paths.ts';

export { artifactIn, buildCacheKey } from '@stim-cli/core';
export { cacheRoot };

export interface BuildRunOptions {
  variant?: string;
  abi?: string;
  configuration?: string;
  buildConfiguration?: string;
  isSimulator?: boolean;
  device?: string | boolean | null;
}

export function entryDir(platform: string, key: string, root: string = cacheRoot()): string {
  return join(root, platform, key);
}

export type ProjectFingerprint = Fingerprint;

const FINGERPRINT_PLATFORMS = new Set(['ios', 'android']);

/**
 * Paths that exist in a working checkout and not in a fresh one, which
 * @expo/fingerprint does not ignore on its own. A fingerprint that counts them
 * cannot match across checkouts, which is the parity failure `doctor` reports.
 *
 * The list stays narrow on purpose: a path belongs here only when no native
 * build on any project can read it. Anything a single project can judge --
 * a lockfile with machine paths, a generated report -- belongs in that
 * project's `.fingerprintignore`, which still applies on top of this.
 */
export const DEFAULT_FINGERPRINT_IGNORES: string[] = [
  // Generated, and carries this machine's absolute sdk.dir.
  '**/android/local.properties',
  // Appears the first time someone opens the project in Android Studio.
  '**/android/.idea/**',
];

export async function fingerprintProject(
  projectRoot: string,
  {
    platform,
    createFingerprint = expoFingerprint.createFingerprintAsync,
    debug = false,
  }: { platform?: string; createFingerprint?: typeof expoFingerprint.createFingerprintAsync; debug?: boolean } = {},
): Promise<ProjectFingerprint | null> {
  const platforms =
    platform && FINGERPRINT_PLATFORMS.has(platform)
      ? { platforms: [platform] as FingerprintOptions['platforms'] }
      : undefined;
  // With DEBUG set, @expo/fingerprint profiles sourcers on stdout unless silent.
  const options: FingerprintOptions = {
    ...platforms,
    ...(debug ? { debug } : {}),
    ignorePaths: DEFAULT_FINGERPRINT_IGNORES,
    silent: true,
  };
  const result = await createFingerprint(projectRoot, options);
  const hash = result?.hash ?? null;
  if (!hash) return null;
  const sources = Array.isArray(result?.sources) ? (result.sources as FingerprintSource[]) : [];
  return { hash, sources };
}

function registerOnce(root: string): void {
  try {
    register({
      dir: root,
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

export function storeBuild(
  platform: string,
  key: string,
  buildPath: string,
  rootOrOptions:
    | string
    | {
        root?: string;
        overwrite?: boolean;
        sources?: FingerprintSource[] | null;
        assetManifest?: AssetManifest | null;
      } = {},
): string | null {
  const options = typeof rootOrOptions === 'string' ? { root: rootOrOptions } : rootOrOptions || {};
  const root = options.root || cacheRoot();
  if (!buildPath || !existsSync(buildPath)) {
    throw new Error(`No build to store at ${buildPath}`);
  }
  registerOnce(root);

  return storeArtifact(entryDir(platform, key, root), buildPath, {
    runFile: getExecutor().runFile,
    overwrite: Boolean(options.overwrite),
    writeMetadata: (staging) => {
      if (Array.isArray(options.sources)) {
        try {
          writeFileSync(join(staging, SOURCES_FILE), JSON.stringify(options.sources.map(withoutContents)));
        } catch {}
      }
      if (options.assetManifest) {
        try {
          writeFileSync(join(staging, ASSET_MANIFEST_FILE), JSON.stringify(options.assetManifest));
        } catch {}
      }
    },
  });
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
export function prepareProviderDownloadDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    register({
      dir,
      name: 'Cache provider downloads',
      prune: 'entries',
      entriesDepth: 1,
      note: 'artifacts fetched from the project cache provider; anything left here is from an interrupted run',
    });
  } catch {}
}

export interface FilesystemBuildCapabilityOptions {
  root?: string;
  sources?: FingerprintSource[] | null;
  assetManifest?: AssetManifest | null;
  resolve?: typeof resolveBuild;
  store?: typeof storeBuild;
}

export function filesystemBuildCapability({
  root,
  sources,
  assetManifest,
  resolve = resolveBuild,
  store = storeBuild,
}: FilesystemBuildCapabilityOptions = {}): BuildCacheCapability {
  const stored = {
    ...(root === undefined ? {} : { root }),
    ...(sources === undefined ? {} : { sources }),
    ...(assetManifest === undefined ? {} : { assetManifest }),
  };
  return {
    resolve: ({ platform, key }) => (root === undefined ? resolve(platform, key) : resolve(platform, key, root)),
    store: ({ platform, key, sourcePath, overwrite }) => store(platform, key, sourcePath, { ...stored, overwrite }),
  };
}

export interface ProviderUploadOutcome {
  line: string;
  warn: boolean;
}

export function providerUploadOutcome(
  result: ProviderCallResult<void> | null | undefined,
  name: string | null,
): ProviderUploadOutcome | null {
  if (!result) return null;
  const label = name || 'the cache provider';
  if (result.timedOut) {
    return { line: `${label} upload was cancelled after ${buildUploadTimeoutMs()}ms`, warn: true };
  }
  if (result.failed) return { line: `${label} upload failed: ${result.failed}`, warn: true };
  return { line: `uploaded (${label})`, warn: false };
}

const SOURCES_FILE = 'fingerprint-sources.json';

function withoutContents(source: FingerprintSource): FingerprintSource {
  return source.type === 'contents' ? { ...source, contents: '' } : source;
}

export function storedSources(platform: string, key: string, root: string = cacheRoot()): FingerprintSource[] | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(entryDir(platform, key, root), SOURCES_FILE), 'utf-8'));
    return Array.isArray(parsed) ? (parsed as FingerprintSource[]) : null;
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

function diffItemChange(item: unknown): SourceChange | null {
  const o = item as Record<string, unknown> | null | undefined;
  const [change, source] =
    o?.op === 'added'
      ? (['added', o.addedSource] as const)
      : o?.op === 'removed'
        ? (['removed', o.removedSource] as const)
        : (['changed', o?.afterSource ?? o?.beforeSource] as const);
  const name = sourceName(source);
  return name === null ? null : { name, change, reasons: sourceReasons(source) };
}

export function compareSourceLists(previous: unknown[], current: unknown[]): SourceChange[] {
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
  previousHash = null,
  current,
  differ = null,
}: {
  previous: FingerprintSource[];
  previousHash?: string | null;
  current: ProjectFingerprint;
  differ?: typeof expoFingerprint.diffFingerprints | null;
}): SourceChange[] {
  if (typeof differ === 'function') {
    try {
      const items = differ(
        { sources: previous, hash: previousHash ?? '' },
        { sources: current.sources, hash: current.hash },
      );
      if (Array.isArray(items)) {
        const changes: SourceChange[] = [];
        const seen = new Set<string>();
        for (const item of items) {
          const change = diffItemChange(item);
          if (change !== null && !seen.has(change.name)) {
            seen.add(change.name);
            changes.push(change);
          }
        }
        return changes;
      }
    } catch {}
  }
  return compareSourceLists(previous, current.sources);
}

export async function refingerprintAfterMutation({
  projectRoot,
  platform,
  previousHash,
  fingerprint = fingerprintProject,
}: {
  projectRoot: string;
  platform: string;
  previousHash: string;
  fingerprint?: typeof fingerprintProject;
}): Promise<(ProjectFingerprint & { moved: boolean }) | null> {
  let computed: ProjectFingerprint | null = null;
  try {
    computed = await fingerprint(projectRoot, { platform });
  } catch {
    return null;
  }
  if (!computed?.hash) return null;
  return { hash: computed.hash, sources: computed.sources, moved: computed.hash !== previousHash };
}

const CONFIG_INPUT_REASONS = new Set(['expoConfig', 'expoConfigPlugins', 'expoConfigExternalFile']);

function writtenByBuild(name: string, platform: string): boolean {
  return (
    name === platform ||
    name.startsWith(`${platform}/`) ||
    name.startsWith('node_modules/') ||
    name.includes('/node_modules/')
  );
}

const PREBUILD_WRITTEN_IDS = [
  ['ios', 'bundleIdentifier'],
  ['android', 'package'],
] as const;

function expoConfigContents(sources: FingerprintSource[]): Record<string, unknown> | null {
  const source = sources.find((s) => s.type === 'contents' && s.id === 'expoConfig');
  if (source?.type !== 'contents') return null;
  try {
    const parsed: unknown = JSON.parse(String(source.contents));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function onlyPrebuildIdsAdded(before: FingerprintSource[], after: FingerprintSource[]): boolean {
  const previous = expoConfigContents(before);
  const current = expoConfigContents(after);
  if (!previous || !current) return false;
  const stripped: Record<string, unknown> = { ...current };
  for (const [section, key] of PREBUILD_WRITTEN_IDS) {
    const was = previous[section] as Record<string, unknown> | undefined;
    const now = stripped[section] as Record<string, unknown> | undefined;
    if (now?.[key] === undefined || was?.[key] !== undefined) continue;
    const rest = { ...now };
    delete rest[key];
    if (was === undefined && Object.keys(rest).length === 0) delete stripped[section];
    else stripped[section] = rest;
  }
  return isDeepStrictEqual(previous, stripped);
}

export function configInputsChanged(
  before: FingerprintSource[],
  after: FingerprintSource[],
  { prebuildRan }: { prebuildRan: boolean },
): string[] {
  return compareSourceLists(before, after)
    .filter((change) => change.reasons.some((reason) => CONFIG_INPUT_REASONS.has(reason)))
    .filter((change) => !(prebuildRan && change.name === 'expoConfig' && onlyPrebuildIdsAdded(before, after)))
    .map((change) => change.name);
}

export function inputsChangedDuringBuild({
  platform,
  lookup,
  prebuildRan,
  compiled,
  current,
}: {
  platform: string;
  lookup: FingerprintSource[];
  prebuildRan: boolean;
  compiled: FingerprintSource[];
  current: FingerprintSource[];
}): string[] {
  const names = new Set(configInputsChanged(lookup, current, { prebuildRan }));
  for (const change of compareSourceLists(compiled, current)) {
    if (!writtenByBuild(change.name, platform)) names.add(change.name);
  }
  return [...names];
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
  exec = getExecutor(),
}: {
  projectRoot: string;
  exec?: { runFile: (file: string, args?: string[]) => string };
}): string[] {
  let out: string;
  try {
    out = exec.runFile('git', [
      '-C',
      projectRoot,
      'ls-files',
      '--others',
      '--exclude-standard',
      '--',
      'ios',
      'android',
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
