import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AndroidLayout } from '../workspace/settings.ts';
import chalk from 'chalk';
import { register } from '../cache/cache-manifest.ts';
import { phaseLine } from '../command-output.ts';
import type { Executor } from '../exec.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { resolveOptimizations, type Optimizations } from '../optimizations.ts';
import { resolvePackageJson } from '../workspace/project.ts';
import { sharedCompilationCache } from '../workspace/paths.ts';
import { androidPathRoom, androidPathRoomMessage, androidPathRoomRemedy } from '../engine/android-path-limit.ts';
import {
  ASSEMBLE_TASK,
  BUILD_ERROR,
  assembleTaskFor,
  buildGradle,
  parseProductFlavors,
  variantNameOf,
  type BuildAndroidResult,
  type ProductFlavors,
} from '../engine/gradle.ts';
import {
  buildXcode,
  compilationCacheSettings,
  COMPILATION_CACHE_MIN_XCODE,
  detectSwiftVersion,
  detectXcodeMajor,
  pickXcodeProject,
  swiftPrefixMappingSupported,
  SWIFT_PREFIX_MAPPING_MIN_SWIFT,
  type BuildIosResult,
  type XcodeProject,
} from '../engine/xcode.ts';

type AndroidProjectResult =
  | { failed?: never; androidDir: string; gradlew: string }
  | { failed: true; code: string; reason: string; remedy: string };

export function gradlewPath(layout: AndroidLayout): string {
  return join(layout.gradleRoot, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
}

export function apkOutputsDir(layout: AndroidLayout): string {
  return join(layout.moduleDir, 'build', 'outputs', 'apk');
}

export function debugApkDir(layout: AndroidLayout): string {
  return join(apkOutputsDir(layout), 'debug');
}

export function discoverAndroidProject(root: string, layout: AndroidLayout): AndroidProjectResult {
  const dir = layout.gradleRoot;
  if (!existsSync(dir)) {
    return {
      failed: true,
      code: BUILD_ERROR,
      reason: `No ${relative(root, dir) || '.'}/ directory in ${root}.`,
      remedy:
        'Generate it (`npx expo prebuild -p android`, which `stim android` runs itself on an Expo project) or check out the native sources.',
    };
  }
  const gradlew = gradlewPath(layout);
  if (!existsSync(gradlew)) {
    return {
      failed: true,
      code: BUILD_ERROR,
      reason: `${gradlew} does not exist, so there is no gradle wrapper to build with.`,
      remedy: `Restore the wrapper (\`gradle wrapper\` in ${relative(root, dir) || '.'}/, or regenerate the project with \`npx expo prebuild -p android --clean\`).`,
    };
  }
  return { androidDir: dir, gradlew };
}

export function readProductFlavors(layout: AndroidLayout): ProductFlavors {
  return parseProductFlavors(readOrNull(join(layout.moduleDir, 'build.gradle')));
}

export function productFlavorRefusal({
  flavors,
  variant,
}: {
  flavors: ProductFlavors;
  variant?: string | null;
}): { code: string; reason: string; remedy: string } | null {
  if (variant) return null;
  if (!flavors.known || flavors.dimensions.length === 0) return null;
  let combinations: string[][] = [[]];
  for (const group of flavors.dimensions) {
    combinations = combinations.flatMap((combination) => group.map((flavor) => combination.concat(flavor)));
  }
  if (combinations.length < 2) return null;
  const count = flavors.dimensions.reduce((total, group) => total + group.length, 0);
  const variants = combinations.map((combination) => variantNameOf(combination.concat('debug')));
  return {
    code: 'STIM_BAD_ARG',
    reason: `android/app/build.gradle declares ${count} product flavors, so \`./gradlew ${ASSEMBLE_TASK}\` builds an APK for each of them and nothing says which flavor to install.`,
    remedy: `Pass \`--variant ${variants[0]}\` or set the android.variant setting -- e.g. {"android": {"variant": "${variants[0]}"}} in .stim.json. The debug variants are: ${variants.join(', ')}.`,
  };
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

export async function buildAndroid(
  {
    root,
    layout,
    logWriter,
    variant = null,
    abi = null,
  }: {
    root: string;
    layout: AndroidLayout;
    logWriter?: NdjsonWriter | null;
    variant?: string | null;
    abi?: string | null;
  },
  options: NonNullable<Parameters<typeof buildGradle>[1]> & { platform?: NodeJS.Platform } = {},
): Promise<BuildAndroidResult> {
  const project = discoverAndroidProject(root, layout);
  if (project.failed)
    return {
      ok: false,
      code: project.code,
      reason: project.reason,
      remedy: project.remedy,
      diagnostics: [],
      truncated: 0,
      lastLines: [],
      durationMs: 0,
    };
  // https://github.com/appandflow/stim/issues/893: Gradle has not configured a custom
  // buildStagingDirectory yet, so this default-layout check may refuse a shorter custom path.
  const room = androidPathRoom(root, { abi, variant, platform: options.platform ?? process.platform });
  return buildGradle(
    {
      root,
      logWriter,
      variant,
      project: {
        directory: project.androidDir,
        gradlew: project.gradlew,
        module: layout.module,
        outputsDir: apkOutputsDir(layout),
      },
      task: layout.custom ? `${layout.module}:${assembleTaskFor(variant)}` : assembleTaskFor(variant),
      projectArgs: abi ? [`-PreactNativeArchitectures=${abi}`] : [],
      preflightFailure: room
        ? { code: 'STIM_PATH_TOO_LONG', reason: androidPathRoomMessage(room), remedy: androidPathRoomRemedy(room) }
        : null,
    },
    options,
  );
}

const PREBUILD_REMEDY =
  'Generate it with `npx expo prebuild -p ios` (stim ios does this automatically for an Expo project with no ios/ directory), or commit the native project.';

function buildFailure(message: string, remedy: string | null): XcodeProject {
  return { error: { code: 'STIM_BUILD_FAILED', message, remedy } };
}

export function discoverXcodeProject(root: string, dir: string): XcodeProject {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return buildFailure(`No ${relative(root, dir) || '.'}/ directory in ${root}.`, PREBUILD_REMEDY);
  }
  const picked = pickXcodeProject(entries);
  if (!picked) {
    return buildFailure(`${dir} contains no .xcworkspace and no .xcodeproj.`, PREBUILD_REMEDY);
  }
  return { ...picked, dir, appRoot: root, path: join(dir, picked.file) };
}

export function ccacheEnabled(podfileProperties: unknown): boolean {
  if (!podfileProperties || typeof podfileProperties !== 'object') return false;
  return (podfileProperties as Record<string, unknown>)['apple.ccacheEnabled'] === 'true';
}

export function readPodfileProperties(iosDir: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(iosDir, 'Podfile.properties.json'), 'utf-8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface ReactNativeVersion {
  major: number;
  minor: number;
}

// React Native 0.87 dropped the SWIFT_ENABLE_EXPLICIT_MODULES=NO override its
// prebuilt core needed on Xcode 26 (react/react-native#53457); Xcode refuses
// Swift caching for targets built without explicit modules.
const SWIFT_CACHE_MIN_REACT_NATIVE: ReactNativeVersion = { major: 0, minor: 87 };

function reactNativeSupportsSwiftCache(version: ReactNativeVersion | null): boolean {
  if (!version) return false;
  const min = SWIFT_CACHE_MIN_REACT_NATIVE;
  return version.major > min.major || (version.major === min.major && version.minor >= min.minor);
}

export function parseReactNativeVersion(packageJson: unknown): ReactNativeVersion | null {
  if (!packageJson || typeof packageJson !== 'object') return null;
  const raw = (packageJson as { version?: unknown }).version;
  const m = typeof raw === 'string' ? /^(\d+)\.(\d+)\./.exec(raw) : null;
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10) };
}

export function detectReactNativeVersion(root: string): ReactNativeVersion | null {
  const file = resolvePackageJson(root, 'react-native');
  if (!file) return null;
  try {
    return parseReactNativeVersion(JSON.parse(readFileSync(file, 'utf-8')));
  } catch {
    return null;
  }
}

export function reactNativeCompilationCacheSettings({
  reactNativeVersion = null,
  ...options
}: Omit<Parameters<typeof compilationCacheSettings>[0], 'swiftCacheCompatible'> & {
  reactNativeVersion?: ReactNativeVersion | null;
}): string[] {
  return compilationCacheSettings({
    ...options,
    swiftCacheCompatible: reactNativeSupportsSwiftCache(reactNativeVersion),
  });
}

function resolveCompilationCacheSettings({
  root,
  iosDir,
  derivedDataPath,
  exec = null,
  casPath = sharedCompilationCache(),
  optimizations = resolveOptimizations({}, {}).ios,
  onNote = (line: string) => console.error(line),
}: {
  root: string;
  iosDir: string;
  derivedDataPath: string;
  exec?: Executor | null;
  casPath?: string;
  optimizations?: Optimizations['ios'];
  onNote?: (line: string) => void;
}): string[] {
  const xcodeMajor = detectXcodeMajor(exec);
  const ccache = ccacheEnabled(readPodfileProperties(iosDir));
  const probe =
    xcodeMajor !== null &&
    xcodeMajor >= COMPILATION_CACHE_MIN_XCODE &&
    !ccache &&
    optimizations.compilationCache &&
    optimizations.swiftCompilationCache !== false;
  const swiftVersion = probe ? detectSwiftVersion(exec) : null;
  const reactNativeVersion = probe ? detectReactNativeVersion(root) : null;
  const settings = reactNativeCompilationCacheSettings({
    workspaceRoot: root,
    derivedDataPath,
    casPath,
    xcodeMajor,
    swiftVersion,
    reactNativeVersion,
    ccache,
    optimizations,
  });
  if (settings.length > 0 && optimizations.compilationCache) {
    register({
      dir: casPath,
      name: 'Xcode compilation cache',
      prune: 'atomic',
      note: 'shared Xcode compilation cache',
    });
    const swift = settings.includes('SWIFT_ENABLE_COMPILE_CACHE=YES')
      ? settings.includes('SWIFT_ENABLE_PREFIX_MAPPING=YES')
        ? 'Swift on'
        : 'Swift on, unmapped'
      : swiftVersion && !swiftPrefixMappingSupported(swiftVersion)
        ? `Swift off, ${swiftVersion.major}.${swiftVersion.minor} < ${SWIFT_PREFIX_MAPPING_MIN_SWIFT.major}.${SWIFT_PREFIX_MAPPING_MIN_SWIFT.minor}`
        : swiftVersion && reactNativeVersion && !reactNativeSupportsSwiftCache(reactNativeVersion)
          ? `Swift off, react-native ${reactNativeVersion.major}.${reactNativeVersion.minor} < ${SWIFT_CACHE_MIN_REACT_NATIVE.major}.${SWIFT_CACHE_MIN_REACT_NATIVE.minor}`
          : 'Swift off';
    onNote(chalk.dim(phaseLine('cache', `compilation cache on (CAS at ${casPath}, ${swift})`)));
  }
  return settings;
}

type IosBuildInputs = Omit<Parameters<typeof buildXcode>[0], 'project' | 'compilationCache' | 'startedAt'> & {
  iosDir: string;
  project?: XcodeProject | null;
  compilationCache?: string[] | null;
  optimizations?: Optimizations['ios'];
  onNote?: (line: string) => void;
};

export async function buildIos(inputs: IosBuildInputs): Promise<BuildIosResult> {
  const { root, iosDir, logWriter, udid, destination, now = () => Date.now() } = inputs;
  if (!root || typeof root !== 'string') throw new TypeError('buildIos requires {root}');
  if (!logWriter || typeof logWriter.write !== 'function')
    throw new TypeError('buildIos requires {logWriter} with a write() method');
  if (!udid && !destination) throw new TypeError('buildIos requires {udid} (or an explicit {destination})');
  const startedAt = now();
  return buildXcode({
    ...inputs,
    startedAt,
    project: inputs.project ?? discoverXcodeProject(root, iosDir),
    compilationCache:
      inputs.compilationCache === undefined
        ? ({ derivedDataPath, exec }) =>
            resolveCompilationCacheSettings({
              root,
              iosDir,
              derivedDataPath,
              exec,
              optimizations: inputs.optimizations,
              onNote: inputs.onNote,
            })
        : inputs.compilationCache,
  });
}
