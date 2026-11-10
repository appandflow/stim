// Legacy oracle from https://github.com/appandflow/stim/commit/6c5ef3bfcde179bcfe1f9d9186c399d3e313d44f.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, posix, relative, resolve as resolvePath, sep } from 'node:path';
import * as expoFingerprint from '@expo/fingerprint';
import type { Fingerprint, Options as FingerprintOptions } from '@expo/fingerprint';
import { loadConfigAsync as loadFingerprintConfig } from '@expo/fingerprint/build/Config.js';
import { trace } from '@stim-cli/core/state';
import { gitQuiet } from '../workspace/git.ts';
import { DEFAULT_IOS_PROJECT_PATH, type AndroidLayout } from '../workspace/settings.ts';
import { podfileLockHook } from './fingerprint-parity-podfile.ts';

type ProjectFingerprint = Fingerprint;

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
  // A linked worktree's .git file holds that worktree's absolute git directory.
  '**/.git',
  // A main checkout's git directory changes with every commit, ref update and worktree add.
  '**/.git/**',
  // Metro and the Expo CLI write logs and caches here; reached through a `..` dir source it is not ignored by default.
  '**/.expo/**',
];

/** What an Android offload may not send, so both machines leave it out of the fingerprint. An APK's own assets stay in. */
const ANDROID_SIGNING_FINGERPRINT_IGNORES: string[] = [
  '**/*.keystore',
  '**/*.jks',
  '**/*.p12',
  '**/*.pfx',
  '**/keystore.properties',
  '!**/debug.keystore',
  '!**/src/*/assets/**',
  '!**/src/*/res/**',
];

/** What an iOS offload may not send: App Store Connect API keys, certificates and provisioning profiles. */
const IOS_SIGNING_FINGERPRINT_IGNORES: string[] = [
  '**/*.p8',
  '**/*.p12',
  '**/*.mobileprovision',
  '**/*.provisionprofile',
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
  /** Lists Android and iOS signing files as inputs, for the sync's own decision about them; they still hash to nothing. */
  keepSigningFiles?: boolean;
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
    keepSigningFiles = false,
  }: FingerprintTarget,
): Promise<FingerprintOptions> {
  const ignoredHere = (names: readonly string[], noIndex = false) =>
    new Set([...gitIgnoredNames(projectRoot, names, noIndex), ...ignoredPaths.filter((path) => names.includes(path))]);
  const ignoredAtAppRoot = (names: readonly string[]) =>
    new Set([...ignoredHere(names)].filter((name) => !trackedPaths.includes(name)));
  const platforms: Pick<FingerprintOptions, 'platforms'> | undefined =
    platform === 'ios' || platform === 'android' ? { platforms: [platform] } : undefined;
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
  const fileHookTransform =
    platform === 'ios'
      ? podfileLockHook(
          projectRoot,
          iosProjectPath,
          (await loadFingerprintConfig(projectRoot, true))?.fileHookTransform,
        )
      : undefined;
  // With DEBUG set, @expo/fingerprint profiles sourcers on stdout unless silent.
  return {
    ...platforms,
    ...(fileHookTransform ? { fileHookTransform } : {}),
    ...(ios.extraSources ? { extraSources: ios.extraSources } : {}),
    ignorePaths: [
      ...DEFAULT_FINGERPRINT_IGNORES,
      ...bundleOutput,
      ...(ios.ignorePaths ?? []),
      ...(platform === 'android' && !keepSigningFiles ? ANDROID_SIGNING_FINGERPRINT_IGNORES : []),
      ...(platform === 'ios' && !keepSigningFiles ? IOS_SIGNING_FINGERPRINT_IGNORES : []),
    ],
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
  return trace.spanAsync(
    'fingerprint',
    async () => {
      const options = await fingerprintOptions(projectRoot, target);
      const result = await createFingerprint(projectRoot, debug ? { ...options, debug } : options);
      const hash = result?.hash ?? null;
      if (!hash) return null;
      const sources = Array.isArray(result?.sources) ? result.sources : [];
      return { hash, sources };
    },
    { platform: target.platform },
  );
}
