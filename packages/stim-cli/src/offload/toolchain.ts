import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { androidHome } from '../devices/android.ts';
import { getExecutor } from '../exec.ts';

/** What must be identical on this Mac and a build machine for an iOS simulator build to come out the same. */
export interface IosToolchain {
  /** A digest of Stim's built code, so both sides prove they run the same Stim. */
  stimBuild: string | null;
  arch: string;
  xcode: string | null;
  simulatorSdk: string | null;
  cocoapods: string | null;
}

/** What must be identical on this Mac and a build machine for an Android debug build; Gradle and AGP come from the synced project. */
export interface AndroidToolchain {
  stimBuild: string | null;
  arch: string;
  /** The major version of the JDK Gradle runs on. */
  jdk: string | null;
}

/** The Android SDK packages the project's React Native version builds with, from its version catalog. */
export interface AndroidRequirements {
  ndk: string | null;
  buildTools: string | null;
  compileSdk: string | null;
}

/** A build machine's toolchain, the simulator runtimes it can build for, and its JDK and Android SDK packages. */
export interface WorkerToolchain extends IosToolchain {
  runtimes: string[];
  jdk: string | null;
  androidSdk: { ndk: string[]; buildTools: string[]; platforms: string[] } | null;
}

/** The build a machine is asked to take, with this Mac's side of the toolchain comparison. */
export type BuildTarget =
  | { platform: 'ios'; local: IosToolchain; runtime: string }
  | { platform: 'android'; local: AndroidToolchain; requires: AndroidRequirements };

const distDir = dirname(fileURLToPath(import.meta.url));

function quiet(file: string, args: string[]): string | null {
  return getExecutor().runFileQuiet(file, args, { timeoutMs: 20_000 });
}

function stimBuildId(dir: string = distDir): string | null {
  try {
    const hash = createHash('sha256');
    const names = readdirSync(dir)
      .filter((entry) => entry.endsWith('.mjs'))
      .toSorted();
    if (names.length === 0) return null;
    for (const name of names) {
      hash.update(name);
      hash.update(readFileSync(join(dir, name)));
    }
    return hash.digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

export function iosToolchain(): IosToolchain {
  const xcode = quiet('xcodebuild', ['-version']);
  return {
    stimBuild: stimBuildId(),
    arch: process.arch,
    xcode: xcode ? xcode.trim().replace(/\n/g, ' / ') : null,
    simulatorSdk: quiet('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version'])?.trim() ?? null,
    cocoapods: quiet('pod', ['--version'])?.trim().split('\n').pop()?.trim() ?? null,
  };
}

/** The major version in a JDK's `release` file, as `JAVA_VERSION="17.0.19"` gives it. */
export function jdkMajor(release: string): string | null {
  return /^JAVA_VERSION="(\d+)/m.exec(release)?.[1] ?? null;
}

function releaseMajor(home: string): string | null {
  try {
    return jdkMajor(readFileSync(join(home, 'release'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The JDK Gradle's wrapper picks: `JAVA_HOME`, else the `java` on PATH, which is the macOS `/usr/bin/java`
 * stub (resolved through `java_home`) unless a real JDK comes first.
 */
function localJdk(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.JAVA_HOME) return releaseMajor(env.JAVA_HOME);
  const java = getExecutor().findExecutable('java');
  if (java) {
    try {
      const fromPath = releaseMajor(dirname(dirname(realpathSync(java))));
      if (fromPath) return fromPath;
    } catch {}
  }
  const home = quiet('/usr/libexec/java_home', [])?.trim();
  return home ? releaseMajor(home) : null;
}

export function androidToolchain(): AndroidToolchain {
  return { stimBuild: stimBuildId(), arch: process.arch, jdk: localJdk() };
}

/** `ndkVersion`, `buildTools` and `compileSdk` from React Native's `gradle/libs.versions.toml`. */
export function parseAndroidRequirements(catalog: string): AndroidRequirements {
  const value = (key: string) => new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm').exec(catalog)?.[1] ?? null;
  return { ndk: value('ndkVersion'), buildTools: value('buildTools'), compileSdk: value('compileSdk') };
}

export function androidRequirements(projectRoot: string): AndroidRequirements {
  try {
    const pkg = createRequire(join(projectRoot, 'package.json')).resolve('react-native/package.json');
    return parseAndroidRequirements(readFileSync(join(dirname(pkg), 'gradle', 'libs.versions.toml'), 'utf8'));
  } catch {
    return { ndk: null, buildTools: null, compileSdk: null };
  }
}

/** Runtime identifiers that have at least one available iPhone simulator, from `simctl list devices -j`. */
export function iphoneRuntimes(listed: unknown): string[] {
  const devices = (listed as { devices?: Record<string, Array<{ name?: unknown; isAvailable?: unknown }>> })?.devices;
  if (!devices || typeof devices !== 'object') return [];
  return Object.entries(devices)
    .filter(([, list]) =>
      (Array.isArray(list) ? list : []).some(
        (device) => device.isAvailable !== false && typeof device.name === 'string' && device.name.startsWith('iPhone'),
      ),
    )
    .map(([runtime]) => runtime)
    .toSorted();
}

function listDir(path: string): string[] | null {
  try {
    return readdirSync(path)
      .filter((entry) => !entry.startsWith('.'))
      .toSorted();
  } catch {
    return null;
  }
}

function sdkPackages(): WorkerToolchain['androidSdk'] {
  const sdk = androidHome();
  const platforms = listDir(join(sdk, 'platforms'));
  if (!platforms) return null;
  return { ndk: listDir(join(sdk, 'ndk')) ?? [], buildTools: listDir(join(sdk, 'build-tools')) ?? [], platforms };
}

export function workerToolchain(): WorkerToolchain {
  let listed: unknown = null;
  try {
    listed = JSON.parse(quiet('xcrun', ['simctl', 'list', 'devices', 'available', '-j']) ?? 'null');
  } catch {}
  return { ...iosToolchain(), runtimes: iphoneRuntimes(listed), jdk: localJdk(), androidSdk: sdkPackages() };
}

/** The API level of an SDK `platforms/` directory: `android-37.0` and `android-37` are both 37. */
const platformLevel = (dir: string): string | undefined => dir.replace(/^android-/, '').split('.')[0];

function androidMismatches(local: AndroidToolchain, requires: AndroidRequirements, worker: WorkerToolchain): string[] {
  const out: string[] = [];
  if (!local.jdk || worker.jdk !== local.jdk)
    out.push(`JDK ${worker.jdk ?? 'none'} there, ${local.jdk ?? 'none'} here`);
  const sdk = worker.androidSdk;
  if (!sdk) return [...out, 'no Android SDK there'];
  if (requires.ndk && !sdk.ndk.includes(requires.ndk)) out.push(`no NDK ${requires.ndk} there`);
  if (requires.buildTools && !sdk.buildTools.includes(requires.buildTools)) {
    out.push(`no build-tools ${requires.buildTools} there`);
  }
  if (requires.compileSdk && !sdk.platforms.some((dir) => platformLevel(dir) === requires.compileSdk)) {
    out.push(`no platform android-${requires.compileSdk} there`);
  }
  return out;
}

/** Why a build machine cannot build like this Mac; empty when it can. */
export function toolchainMismatches(target: BuildTarget, worker: WorkerToolchain): string[] {
  const { local } = target;
  const out: string[] = [];
  if (!local.stimBuild || worker.stimBuild !== local.stimBuild) {
    out.push(`Stim build ${worker.stimBuild ?? 'unknown'} there, ${local.stimBuild ?? 'unknown'} here`);
  }
  if (worker.arch !== local.arch) out.push(`CPU ${worker.arch} there, ${local.arch} here`);
  if (target.platform === 'android') return [...out, ...androidMismatches(target.local, target.requires, worker)];
  const ios = target.local;
  if (!ios.xcode || worker.xcode !== ios.xcode) out.push(`Xcode ${worker.xcode} there, ${ios.xcode} here`);
  if (!ios.simulatorSdk || worker.simulatorSdk !== ios.simulatorSdk) {
    out.push(`simulator SDK ${worker.simulatorSdk} there, ${ios.simulatorSdk} here`);
  }
  if (worker.cocoapods !== ios.cocoapods) out.push(`CocoaPods ${worker.cocoapods} there, ${ios.cocoapods} here`);
  if (!worker.runtimes.includes(target.runtime)) out.push(`no iPhone simulator on ${target.runtime} there`);
  return out;
}
