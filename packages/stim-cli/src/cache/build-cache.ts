import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'fs';
import { basename, isAbsolute, join, posix, relative, resolve as resolvePath, sep } from 'path';
import { isDeepStrictEqual } from 'util';
import * as expoFingerprint from '@expo/fingerprint';
import type { Fingerprint, FingerprintSource, Options as FingerprintOptions } from '@expo/fingerprint';
import { loadConfigAsync as loadFingerprintConfig } from '@expo/fingerprint/build/Config.js';
import { normalizeOptionsAsync } from '@expo/fingerprint/build/Options.js';
import { isIgnoredPathWithMatchObjects } from '@expo/fingerprint/build/utils/Path.js';
import { buildUploadTimeoutMs, type BuildCacheCapability, type ProviderCallResult } from '@stim-cli/cache';
import { resolveArtifact, storeArtifactAsync, type StimContext } from '@stim-cli/core';
import { readdir, writeFile } from 'node:fs/promises';
import { withDrainingCancellation } from '../engine/operation-state.ts';
import { throwIfCancelled } from '../cancellation.ts';
import { childEnvironment, killOnAbort } from '../workspace/git-read.ts';
import { getExecutor } from '../exec.ts';
import { git, gitAsync, gitQuiet } from '../workspace/git.ts';
import { register } from './cache-manifest.ts';
import { computeSignedTail, writeSignedTail } from '../engine/apk-signed-tail.ts';
import { ASSET_MANIFEST_FILE, parseAssetManifest, type AssetManifest } from '../engine/asset-manifest.ts';
import { sharedBuildCache as cacheRoot } from '../workspace/paths.ts';
import { DEFAULT_IOS_PROJECT_PATH, type AndroidLayout } from '../workspace/settings.ts';

export { artifactIn, buildCacheKey } from '@stim-cli/core';
export { cacheRoot };

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
  // Appears the first time someone opens the project in Xcode; @expo/fingerprint only ignores the workspace's.
  '**/*.xcodeproj/xcuserdata/**/*',
];

/**
 * `react-native bundle` output, ignored only while an ignore pattern matches it: a committed copy can be a native
 * resource, while a Debug build loads JS from Metro and a release cache hit injects the current JS. The match skips
 * the index, so a force-added copy counts the same on a build worker, whose mirror index is empty. A build worker
 * has only the synced .gitignore files, so the client sends the paths it ignored (`ignoredFingerprintPaths`) for
 * those it ignores through .git/info/exclude or a global excludes file.
 */
const BUNDLE_OUTPUT_IGNORES: Record<string, string> = {
  'ios/main.jsbundle': 'ios/main.jsbundle',
  'ios/assets': 'ios/assets/**/*',
};

const APP_ROOT_IOS_SKIPPED = new Set(['node_modules', 'Pods', 'build', 'android', '.git', '.DS_Store', '.stim.json']);

const appRootNames = (entries: readonly string[]) =>
  entries.filter((name) => !APP_ROOT_IOS_SKIPPED.has(name) && !name.startsWith('.watchman-cookie-'));

function gitIgnoredNames(projectRoot: string, names: readonly string[], noIndex = false): Set<string> {
  if (names.length === 0) return new Set();
  const out = gitQuiet(projectRoot, ['check-ignore', ...(noIndex ? ['--no-index'] : []), '--', ...names]);
  return new Set(
    String(out ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

/**
 * Sources and ignores that make an `ios.projectPath` outside `ios/` count the way
 * @expo/fingerprint's bare sourcer counts `ios/`. A project directory that is the
 * app itself cannot be told apart from the app's JavaScript, so every top-level
 * entry git tracks, except dependencies and build output, is hashed: a JS change
 * misses the cache instead of risking a stale native build.
 */
export function iosProjectFingerprintOptions(
  projectRoot: string,
  iosProjectPath: string,
  {
    list = (dir: string) => readdirSync(dir),
    isDirectory = (path: string) => statSync(path).isDirectory(),
    ignored = gitIgnoredNames,
  }: {
    list?: (dir: string) => string[];
    isDirectory?: (path: string) => boolean;
    ignored?: (projectRoot: string, names: readonly string[]) => Set<string>;
  } = {},
): Pick<FingerprintOptions, 'extraSources' | 'ignorePaths'> {
  if (iosProjectPath === DEFAULT_IOS_PROJECT_PATH) return {};
  const appRoot = iosProjectPath === '.';
  const prefix = appRoot ? '' : `${iosProjectPath}/`;
  const reasons = ['ios.projectPath'];
  let extraSources: NonNullable<FingerprintOptions['extraSources']> = [
    { type: 'dir', filePath: iosProjectPath, reasons },
  ];
  if (appRoot) {
    const names = appRootNames(list(projectRoot));
    const skip = ignored(projectRoot, names);
    extraSources = names
      .filter((name) => !skip.has(name))
      .toSorted((a, b) => a.localeCompare(b))
      .map((filePath) => ({
        type: isDirectory(join(projectRoot, filePath)) ? 'dir' : 'file',
        filePath,
        reasons,
      }));
  }
  return {
    extraSources,
    ignorePaths: [
      `${prefix}Pods/**/*`,
      `${prefix}build/**/*`,
      `${prefix}.xcode.env.local`,
      `${prefix}**/project.xcworkspace`,
      `${prefix}*.xcworkspace/xcuserdata/**/*`,
    ],
  };
}

const ANDROID_ROOT_SOURCES = [
  'settings.gradle',
  'settings.gradle.kts',
  'build.gradle',
  'build.gradle.kts',
  'gradle.properties',
  'gradle',
];

export function androidProjectFingerprintOptions(
  projectRoot: string,
  layout: Pick<AndroidLayout, 'gradleRoot' | 'gradleRootRelative' | 'module' | 'moduleDir' | 'custom'>,
  exists: (path: string) => boolean = existsSync,
): Pick<FingerprintOptions, 'extraSources' | 'ignorePaths'> {
  if (!layout.custom) return {};
  const reasons = ['android.gradleRoot'];
  const extraSources: NonNullable<FingerprintOptions['extraSources']> = ANDROID_ROOT_SOURCES.filter((name) =>
    exists(join(layout.gradleRoot, name)),
  ).map((name) => ({
    type: name === 'gradle' ? 'dir' : 'file',
    filePath: posix.join(layout.gradleRootRelative, name),
    reasons,
  }));
  let appRoot = projectRoot;
  try {
    appRoot = realpathSync(projectRoot);
  } catch {}
  const fromApp = relative(appRoot, layout.moduleDir).split(sep).join('/');
  if (fromApp === 'android' || fromApp.startsWith('android/')) {
    return fromApp === 'android/app'
      ? { extraSources }
      : { extraSources, ignorePaths: ['build', '.cxx', '.gradle'].map((dir) => `${fromApp}/${dir}/**/*`) };
  }
  const moduleRel = posix.join(layout.gradleRootRelative, ...layout.module.split(':').filter(Boolean));
  extraSources.push({ type: 'dir', filePath: moduleRel, reasons: ['android.module'] });
  return {
    extraSources,
    ignorePaths: ['build', '.cxx', '.gradle'].map((dir) => `${moduleRel}/${dir}/**/*`),
  };
}

const LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lock', 'bun.lockb'];

/**
 * The patches of a monorepo's install root, which @expo/fingerprint does not see: its patch sourcer reads only the
 * app's own `patches/`, and its default preset hashes an installed package by name and version, so a patch applied
 * from the workspace root would leave the key unchanged.
 */
function workspacePatchSources(projectRoot: string): NonNullable<FingerprintOptions['extraSources']> {
  let dir = resolvePath(projectRoot);
  for (;;) {
    if (LOCKFILES.some((name) => existsSync(join(dir, name)))) break;
    const parent = resolvePath(dir, '..');
    if (parent === dir || existsSync(join(dir, '.git'))) return [];
    dir = parent;
  }
  const sources: NonNullable<FingerprintOptions['extraSources']> = ['patches', '.yarn/patches']
    .filter((name) => (name === 'patches' ? dir !== resolvePath(projectRoot) : true) && existsSync(join(dir, name)))
    .map((name) => ({
      type: 'dir' as const,
      filePath: relative(projectRoot, join(dir, name)).split(sep).join('/'),
      reasons: ['workspacePatches'],
    }));
  const patched = pnpmPatchedDependencies(join(dir, 'pnpm-lock.yaml'));
  if (patched)
    sources.push({ type: 'contents', id: 'pnpmPatchedDependencies', contents: patched, reasons: ['workspacePatches'] });
  return sources;
}

/** The lockfile's `patchedDependencies` block, which pnpm rewrites with each patch's hash wherever the patch lives. */
function pnpmPatchedDependencies(lockfile: string): string | null {
  let text: string;
  try {
    text = readFileSync(lockfile, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf('patchedDependencies:');
  if (start === -1) return null;
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line && !/^\s/.test(line)) break;
    if (line.trim()) block.push(line.trim());
  }
  return block.length ? block.join('\n') : null;
}

export interface FingerprintTarget {
  platform?: string;
  iosProjectPath?: string;
  androidLayout?: AndroidLayout | null;
  ignoredPaths?: readonly string[];
  trackedPaths?: readonly string[];
}

/**
 * The bundle output and, with `ios.projectPath` '.', the top-level entries that git ignores here for an iOS
 * fingerprint, as the paths a build worker needs to ignore the same ones: it has no .git/info/exclude or global
 * excludes file.
 */
export function ignoredFingerprintPaths(
  projectRoot: string,
  { platform, iosProjectPath = DEFAULT_IOS_PROJECT_PATH }: FingerprintTarget,
): string[] {
  if (platform !== 'ios') return [];
  const appRoot = iosProjectPath === '.' ? gitIgnoredNames(projectRoot, appRootNames(readdirSync(projectRoot))) : [];
  return [...gitIgnoredNames(projectRoot, Object.keys(BUNDLE_OUTPUT_IGNORES), true), ...appRoot].toSorted();
}

/**
 * With `ios.projectPath` '.', the top-level entries that git tracks here although an ignore pattern matches them, as
 * the names a build worker must count: its mirror index is empty, so its own `check-ignore` skips them.
 */
export function trackedFingerprintPaths(
  projectRoot: string,
  { platform, iosProjectPath = DEFAULT_IOS_PROJECT_PATH }: FingerprintTarget,
): string[] {
  if (platform !== 'ios' || iosProjectPath !== '.') return [];
  const names = appRootNames(readdirSync(projectRoot));
  const ignored = gitIgnoredNames(projectRoot, names);
  const matched = gitIgnoredNames(projectRoot, names, true);
  return names.filter((name) => matched.has(name) && !ignored.has(name)).toSorted();
}

export async function fingerprintOptions(
  projectRoot: string,
  {
    platform,
    iosProjectPath = DEFAULT_IOS_PROJECT_PATH,
    androidLayout = null,
    ignoredPaths = [],
    trackedPaths = [],
  }: FingerprintTarget,
): Promise<FingerprintOptions> {
  const ignoredHere = (names: readonly string[], noIndex = false) =>
    new Set([...gitIgnoredNames(projectRoot, names, noIndex), ...ignoredPaths.filter((path) => names.includes(path))]);
  const ignoredAtAppRoot = (names: readonly string[]) =>
    new Set([...ignoredHere(names)].filter((name) => !trackedPaths.includes(name)));
  const platforms =
    platform && FINGERPRINT_PLATFORMS.has(platform)
      ? { platforms: [platform] as FingerprintOptions['platforms'] }
      : undefined;
  const ios: Pick<FingerprintOptions, 'extraSources' | 'ignorePaths'> =
    platform === 'ios'
      ? iosProjectFingerprintOptions(projectRoot, iosProjectPath, { ignored: (_, names) => ignoredAtAppRoot(names) })
      : androidLayout?.custom
        ? androidProjectFingerprintOptions(projectRoot, androidLayout)
        : {};
  const patches = workspacePatchSources(projectRoot);
  if (ios.extraSources || patches.length) {
    // An explicit extraSources replaces fingerprint.config.js's list in @expo/fingerprint, so keep the project's own.
    const config = await loadFingerprintConfig(projectRoot, true);
    ios.extraSources = [...(config?.extraSources ?? []), ...(ios.extraSources ?? []), ...patches];
  }
  const bundleOutput =
    platform === 'android'
      ? []
      : [...ignoredHere(Object.keys(BUNDLE_OUTPUT_IGNORES), true)].map((path) => BUNDLE_OUTPUT_IGNORES[path]!);
  // With DEBUG set, @expo/fingerprint profiles sourcers on stdout unless silent.
  return {
    ...platforms,
    ...(ios.extraSources ? { extraSources: ios.extraSources } : {}),
    ignorePaths: [...DEFAULT_FINGERPRINT_IGNORES, ...bundleOutput, ...(ios.ignorePaths ?? [])],
    silent: true,
  };
}

export async function fingerprintProject(
  projectRoot: string,
  {
    createFingerprint = expoFingerprint.createFingerprintAsync,
    debug = false,
    ...target
  }: FingerprintTarget & {
    createFingerprint?: typeof expoFingerprint.createFingerprintAsync;
    debug?: boolean;
  } = {},
): Promise<ProjectFingerprint | null> {
  const options = await fingerprintOptions(projectRoot, target);
  const result = await createFingerprint(projectRoot, debug ? { ...options, debug } : options);
  const hash = result?.hash ?? null;
  if (!hash) return null;
  const sources = Array.isArray(result?.sources) ? (result.sources as FingerprintSource[]) : [];
  return { hash, sources };
}

/** The env files @expo/env loads for the config: @expo/fingerprint 0.21 evaluates it in development mode. */
export function expoEnvFiles(env: NodeJS.ProcessEnv = {}): string[] {
  if (/^(1|true)$/i.test(env.EXPO_NO_DOTENV ?? '')) return [];
  return ['.env.development.local', '.env.local', '.env.development', '.env'];
}

const inNodeModules = (path: string) => path.split('/').includes('node_modules');

/**
 * Absolute paths of the files git ignores that a fingerprint with `sources` hashed or the Expo config loader read:
 * the inputs a checkout of the tracked and untracked files lacks. Files under node_modules are left out, because a
 * dependency install recreates them.
 */
export async function gitignoredFingerprintInputs(
  projectRoot: string,
  sources: readonly FingerprintSource[],
  target: FingerprintTarget,
  { env, signal }: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<string[]> {
  const found = new Set<string>();
  if (sources.some((source) => source.type === 'contents' && source.id === 'expoConfig'))
    for (const name of expoEnvFiles(env))
      if (lstatSync(join(projectRoot, name), { throwIfNoEntry: false })?.isFile()) found.add(name);
  const top = realpathSync(await gitAsync(projectRoot, ['rev-parse', '--show-toplevel'], { signal }));
  const base = realpathSync(projectRoot);
  const pathspecs = sources.flatMap((source) => {
    if (source.type === 'contents' || inNodeModules(source.filePath)) return [];
    const inRepo = relative(top, resolvePath(base, source.filePath));
    return isAbsolute(inRepo) || inRepo === '..' || inRepo.startsWith(`..${sep}`)
      ? []
      : [posix.normalize(source.filePath)];
  });
  if (pathspecs.length) {
    const { ignorePathMatchObjects, ignoreDirMatchObjects } = await normalizeOptionsAsync(
      projectRoot,
      await fingerprintOptions(projectRoot, target),
    );
    const addFile = (path: string) => {
      if (!isIgnoredPathWithMatchObjects(path, ignorePathMatchObjects)) found.add(path);
    };
    const walk = async (dir: string): Promise<void> => {
      if (isIgnoredPathWithMatchObjects(dir, ignoreDirMatchObjects)) return;
      for (const entry of await readdir(join(projectRoot, dir), { withFileTypes: true })) {
        signal?.throwIfAborted();
        const path = posix.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') await walk(path);
        } else if (entry.isFile()) addFile(path);
      }
    };
    const inSource = (path: string) =>
      pathspecs.some((spec) => spec === '.' || path === spec || path.startsWith(`${spec}/`));
    const listed = await gitAsync(
      projectRoot,
      [
        '--literal-pathspecs',
        'ls-files',
        '-z',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--directory',
        '--',
        ...pathspecs,
      ],
      { untrimmed: true, timeoutMs: 120_000, signal },
    );
    for (const listedPath of listed.split('\0')) {
      if (!listedPath || inNodeModules(listedPath)) continue;
      const directory = listedPath.endsWith('/');
      const path = directory ? listedPath.slice(0, -1) : listedPath;
      if (inSource(path)) {
        if (directory) await walk(path);
        else addFile(path);
        continue;
      }
      // `git ls-files --directory` reports a wholly ignored directory as one entry, even when a source is only part of it.
      for (const spec of pathspecs.filter((each) => each.startsWith(`${path}/`))) {
        const stat = lstatSync(join(projectRoot, spec), { throwIfNoEntry: false });
        if (stat?.isDirectory()) await walk(spec);
        else if (stat?.isFile()) addFile(spec);
      }
    }
  }
  return [...found].toSorted().map((path) => join(projectRoot, path));
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
        sources?: FingerprintSource[] | null;
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
  sources?: FingerprintSource[] | null;
  assetManifest?: AssetManifest | null;
  readAppId?: AppIdReader;
  resolve?: typeof resolveBuild;
  store?: BuildStore;
}

export function filesystemBuildCapability({
  root,
  context,
  sources,
  assetManifest,
  readAppId,
  resolve = resolveBuild,
  store = storeBuild,
}: FilesystemBuildCapabilityOptions = {}): BuildCacheCapability {
  const stored = {
    ...(context === undefined ? {} : { context }),
    ...(root === undefined ? {} : { root }),
    ...(sources === undefined ? {} : { sources }),
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
const APP_ID_FILE = 'app-id.json';

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
  return mergeMovedPackages(changes);
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
        const seen = new Set<string>();
        return mergeMovedPackages(
          items.map(diffItemChange).filter((change): change is SourceChange => change !== null),
        ).filter((change) => !seen.has(change.name) && Boolean(seen.add(change.name)));
      }
    } catch {}
  }
  return compareSourceLists(previous, current.sources);
}

export async function refingerprintAfterMutation({
  projectRoot,
  platform,
  previousHash,
  iosProjectPath,
  androidLayout,
  ignoredPaths,
  trackedPaths,
  fingerprint = fingerprintProject,
}: {
  projectRoot: string;
  platform: string;
  previousHash: string;
  iosProjectPath?: string;
  androidLayout?: AndroidLayout;
  ignoredPaths?: readonly string[];
  trackedPaths?: readonly string[];
  fingerprint?: typeof fingerprintProject;
}): Promise<(ProjectFingerprint & { moved: boolean }) | null> {
  let computed: ProjectFingerprint | null = null;
  try {
    computed = await fingerprint(projectRoot, {
      platform,
      ...(iosProjectPath ? { iosProjectPath } : {}),
      ...(androidLayout ? { androidLayout } : {}),
      ...(ignoredPaths ? { ignoredPaths } : {}),
      ...(trackedPaths ? { trackedPaths } : {}),
    });
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

export function expoConfigContents(sources: readonly FingerprintSource[]): Record<string, unknown> | null {
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
