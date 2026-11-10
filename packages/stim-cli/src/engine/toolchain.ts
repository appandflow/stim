import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stimBuildDigest } from '@stim-cli/core/state';
import { androidHome } from '../devices/android.ts';
import { getExecutor } from '../exec.ts';
import { bundlerPin } from '../engine/bundler.ts';
import { podEnvForRuby, podEnvForRubyAsync, readRubyVersion } from '../engine/deps.ts';
import type { ExactPins } from '../integrations/exact-offload.ts';
import type { OffloadProblem } from '../offload/toolchain.ts';

/** What must be identical on this Mac and a remote Mac for an iOS simulator build to come out the same. */
export interface IosToolchain {
  stimBuild: string | null;
  /** The Stim build compatibility version both sides must share. */
  compat: number;
  arch: string;
  xcode: string | null;
  simulatorSdk: string | null;
  cocoapods: string | null;
}

/** What must be identical on this machine and a remote machine for an Android debug build; Gradle and AGP come from the synced project. */
export interface AndroidToolchain {
  stimBuild: string | null;
  compat: number;
  arch: string;
  /** The major version of the JDK Gradle runs on. */
  jdk: string | null;
}

/** The Android SDK packages the project's React Native version builds with, from its version catalog. */
export interface AndroidRequirements {
  ndk: string | null;
  buildTools: string | null;
  compileSdk: string | null;
  /** `false` when the project sets `android.builder.sdkDownload=false`, so Gradle never fetches a missing package. */
  sdkDownload?: boolean;
}

/** An Xcode app in `/Applications`, with the license and first-launch checks of its developer directory when they ran. */
export interface XcodeApp {
  path: string;
  version: string | null;
  build: string | null;
  license?: boolean;
  firstLaunch?: boolean;
}

/** A remote machine's toolchain, the simulator runtimes it can build for, and its JDK and Android SDK packages. */
export interface WorkerToolchain extends Omit<IosToolchain, 'compat'> {
  /** Absent from a stim-server older than build compatibility versions. */
  compat?: number;
  /** The OS stim-server runs on, as Node names it; absent from a stim-server older than this field. */
  os?: string;
  macosSdk: string | null;
  bundler: string | null;
  runtimes: string[];
  /** The developer directory `xcode-select -p` prints, null when it prints none; absent from a stim-server older than this field. */
  developerDir?: string | null;
  /** The Xcode apps in `/Applications`; their license and first-launch checks run only while `xcode` is null. */
  xcodeApps?: XcodeApp[];
  jdk: string | null;
  /** The majors of every JDK found on the machine, `jdk` included; absent from a stim-server older than this field. */
  jdks?: string[];
  androidSdk: { ndk: string[]; buildTools: string[]; platforms: string[] } | null;
  /** Whether that SDK has its licenses accepted, so Gradle can download a missing package; absent from a stim-server older than this field. */
  androidLicenses?: boolean;
  /** The SDK directory `androidSdk` was read from, for the commands that install into it; absent from a stim-server older than this field. */
  androidHome?: string;
}

/** The build a machine is asked to take, with this machine's side of the toolchain comparison. */
export type BuildTarget =
  | {
      platform: 'ios';
      native?: 'xcode';
      local: IosToolchain;
      runtime: string | null;
      cocoapodsPinned: boolean;
      /** No CPU comparison: doctor's target for a client without Xcode, whose app runs on a simulator of the Mac that builds it. */
      runsOnWorker?: true;
      /** An Exact app's pins, which the machine's own Bun, Rust and exact2 must provide. */
      exact?: ExactPins;
    }
  | { platform: 'android'; native?: 'gradle'; local: AndroidToolchain; requires: AndroidRequirements }
  | { platform: 'macos'; local: MacosToolchain; runsOnWorker?: true };

const distDir = dirname(fileURLToPath(import.meta.url));

/**
 * What a client and a remote machine must agree on to build for each other: what a worker builds and how, the
 * artifacts it returns and the build and artifact messages. It lives in the `stim` package, whose own code does the
 * build, because `@stim-cli/core` is a ranged dependency that can resolve newer than the installed `stim`.
 * `scripts/build-compat.json` records the files a change to which needs a bump or a recorded no-bump.
 */
const STIM_BUILD_COMPAT = 5;

export function quiet(file: string, args: string[]): string | null {
  return getExecutor().runFileQuiet(file, args, { timeoutMs: 20_000 });
}

async function quietAsync(file: string, args: string[]): Promise<string | null> {
  try {
    return await getExecutor().runFileAsync(file, args, { timeoutMs: 20_000 });
  } catch {
    return null;
  }
}

/** This Mac's iOS toolchain, with the CocoaPods that `pod install` in `podDirectory` runs; null skips CocoaPods. */
export async function iosToolchainAsync(root: string, podDirectory: string | null): Promise<IosToolchain> {
  const [xcode, simulatorSdk, cocoapods] = await Promise.all([
    quietAsync('xcodebuild', ['-version']),
    quietAsync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version']),
    podDirectory === null ? null : projectCocoapodsVersion(root, podDirectory),
  ]);
  return assembleIosToolchain(xcode, simulatorSdk, cocoapods);
}

const iosToolchainMemo = new Map<string, Promise<IosToolchain>>();

export function memoizedIosToolchainAsync(root: string, podDirectory: string | null): Promise<IosToolchain> {
  if (podDirectory !== null) return iosToolchainAsync(root, podDirectory);
  let pending = iosToolchainMemo.get(root);
  if (!pending) {
    pending = iosToolchainAsync(root, null);
    iosToolchainMemo.set(root, pending);
  }
  return pending;
}

export function iosToolchainForRuby(rubyVersion: string | null, native?: 'xcode'): IosToolchain {
  return assembleIosToolchain(
    quiet('xcodebuild', ['-version']),
    quiet('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version']),
    native ? null : cocoapodsVersion(rubyVersion),
  );
}

function assembleIosToolchain(
  xcode: string | null,
  simulatorSdk: string | null,
  cocoapods: string | null,
): IosToolchain {
  return {
    stimBuild: stimBuildDigest(distDir),
    compat: STIM_BUILD_COMPAT,
    arch: process.arch,
    xcode: xcode ? xcode.trim().replace(/\n/g, ' / ') : null,
    simulatorSdk: simulatorSdk?.trim() ?? null,
    cocoapods,
  };
}

function podProbeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function podVersionLine(output: string | null | undefined): string | null {
  return output?.trim().split('\n').pop()?.trim() ?? null;
}

function cocoapodsVersion(rubyVersion: string | null): string | null {
  return podVersionLine(
    getExecutor().runFileQuiet('pod', ['--version'], {
      timeoutMs: 20_000,
      env: podProbeEnv(podEnvForRuby(rubyVersion)),
    }),
  );
}

async function projectCocoapodsVersion(root: string, podDirectory: string): Promise<string | null> {
  const pin = bundlerPin(root, podDirectory);
  if (pin) return pin.cocoapods;
  try {
    return podVersionLine(
      await getExecutor().runFileAsync('pod', ['--version'], {
        timeoutMs: 20_000,
        cwd: podDirectory,
        env: podProbeEnv(await podEnvForRubyAsync(readRubyVersion(root))),
      }),
    );
  } catch {
    return null;
  }
}

export interface MacosToolchain {
  stimBuild: string | null;
  compat: number;
  arch: string;
  xcode: string | null;
  macosSdk: string | null;
}

export function macosToolchain(): MacosToolchain {
  return assembleMacosToolchain(
    quiet('xcodebuild', ['-version']),
    quiet('xcrun', ['--sdk', 'macosx', '--show-sdk-version']),
  );
}

export async function macosToolchainAsync(): Promise<MacosToolchain> {
  const [xcode, macosSdk] = await Promise.all([
    quietAsync('xcodebuild', ['-version']),
    quietAsync('xcrun', ['--sdk', 'macosx', '--show-sdk-version']),
  ]);
  return assembleMacosToolchain(xcode, macosSdk);
}

function assembleMacosToolchain(xcode: string | null, macosSdk: string | null): MacosToolchain {
  return {
    stimBuild: stimBuildDigest(distDir),
    compat: STIM_BUILD_COMPAT,
    arch: process.arch,
    xcode: xcode ? xcode.trim().replace(/\n/g, ' / ') : null,
    macosSdk: macosSdk?.trim() ?? null,
  };
}

/** The major version in a JDK's `release` file, as `JAVA_VERSION="17.0.19"` (or `"1.8.0_402"` for Java 8) gives it. */
function jdkMajor(release: string): string | null {
  return /^JAVA_VERSION="(?:1\.)?(\d+)/m.exec(release)?.[1] ?? null;
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
export function localJdk(env: NodeJS.ProcessEnv = process.env): string | null {
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

/** Where JDKs install, as `JAVA_HOME` values: the one in `env` first, then the usual locations of `platform`. */
export function jdkCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string[] {
  const out: string[] = env.JAVA_HOME ? [env.JAVA_HOME] : [];
  const children = (dir: string) => (listDir(dir) ?? []).map((entry) => join(dir, entry));
  out.push(...children(join(home, '.sdkman', 'candidates', 'java')));
  if (platform === 'darwin') {
    for (const dir of ['/Library/Java/JavaVirtualMachines', join(home, 'Library', 'Java', 'JavaVirtualMachines')]) {
      out.push(...children(dir).map((jvm) => join(jvm, 'Contents', 'Home')));
    }
    for (const prefix of ['/opt/homebrew', '/usr/local']) {
      for (const formula of children(join(prefix, 'opt')).filter((dir) => /^openjdk(@\d+)?$/.test(basename(dir)))) {
        out.push(join(formula, 'libexec', 'openjdk.jdk', 'Contents', 'Home'));
      }
    }
    for (const app of children('/Applications').filter((dir) => basename(dir).startsWith('Android Studio'))) {
      out.push(join(app, 'Contents', 'jbr', 'Contents', 'Home'));
    }
  } else if (platform === 'win32') {
    const programs = env.ProgramFiles ?? 'C:\\Program Files';
    for (const vendor of ['Eclipse Adoptium', 'Java', 'Microsoft', 'Zulu', 'Android']) {
      out.push(...children(join(programs, vendor)));
    }
    out.push(join(programs, 'Android', 'Android Studio', 'jbr'));
  } else {
    out.push(...children('/usr/lib/jvm'), ...children('/opt').map((dir) => join(dir, 'jbr')));
  }
  return out;
}

/** The first home of each JDK major among `candidates`, read from each `release` file; a home without `javac` is a JRE. */
export function jdkHomes(candidates: string[]): Map<string, string> {
  const homes = new Map<string, string>();
  for (const candidate of candidates) {
    const major = releaseMajor(candidate);
    const javac = join(candidate, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
    if (major && !homes.has(major) && existsSync(javac)) homes.set(major, candidate);
  }
  return homes;
}

export function installedJdkMajors(): string[] {
  const majors = new Set(jdkHomes(jdkCandidates()).keys());
  const current = localJdk();
  if (current) majors.add(current);
  return [...majors].toSorted((a, b) => Number(a) - Number(b));
}

/**
 * Points this process, and the Gradle it starts, at an installed JDK of `major` when its default JDK is another one.
 * Returns why it cannot, or null.
 */
export function useJdkMajor(
  major: string,
  env: NodeJS.ProcessEnv = process.env,
  candidates: string[] = jdkCandidates(env),
): string | null {
  if (localJdk(env) === major) return null;
  const home = jdkHomes(candidates).get(major);
  if (!home) return `This machine has no JDK ${major} to build on.`;
  env.JAVA_HOME = home;
  return null;
}

export function androidToolchain(): AndroidToolchain {
  return { stimBuild: stimBuildDigest(distDir), compat: STIM_BUILD_COMPAT, arch: process.arch, jdk: localJdk() };
}

export async function androidToolchainAsync(env: NodeJS.ProcessEnv = process.env): Promise<AndroidToolchain> {
  let jdk: string | null = null;
  if (env.JAVA_HOME) jdk = releaseMajor(env.JAVA_HOME);
  else {
    const java = getExecutor().findExecutable('java');
    if (java) {
      try {
        jdk = releaseMajor(dirname(dirname(realpathSync(java))));
      } catch {}
    }
    if (!jdk) {
      const home = (await quietAsync('/usr/libexec/java_home', []))?.trim();
      if (home) jdk = releaseMajor(home);
    }
  }
  return { stimBuild: stimBuildDigest(distDir), compat: STIM_BUILD_COMPAT, arch: process.arch, jdk };
}

/** `ndkVersion`, `buildTools` and `compileSdk` from React Native's `gradle/libs.versions.toml`. */
function parseAndroidRequirements(catalog: string): AndroidRequirements {
  const value = (key: string) => new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm').exec(catalog)?.[1] ?? null;
  return { ndk: value('ndkVersion'), buildTools: value('buildTools'), compileSdk: value('compileSdk') };
}

export function sdkDownloadDisabled(properties: string): boolean {
  return /^\s*android\.builder\.sdkDownload\s*[=:]\s*false\s*$/im.test(properties);
}

function projectSdkDownload(gradleRoot: string): boolean {
  try {
    return !sdkDownloadDisabled(readFileSync(join(gradleRoot, 'gradle.properties'), 'utf8'));
  } catch {
    return true;
  }
}

export function androidRequirements(
  projectRoot: string,
  gradleRoot: string = join(projectRoot, 'android'),
): AndroidRequirements {
  const sdkDownload = projectSdkDownload(gradleRoot) ? {} : { sdkDownload: false };
  try {
    const pkg = createRequire(join(projectRoot, 'package.json')).resolve('react-native/package.json');
    return {
      ...parseAndroidRequirements(readFileSync(join(dirname(pkg), 'gradle', 'libs.versions.toml'), 'utf8')),
      ...sdkDownload,
    };
  } catch {
    return { ndk: null, buildTools: null, compileSdk: null, ...sdkDownload };
  }
}

/** Runtime identifiers that have at least one available iPhone simulator, from `simctl list devices -j`. */
export function iphoneRuntimes(listed: unknown): string[] {
  const devices = (
    listed as { devices?: Record<string, Array<{ deviceTypeIdentifier?: unknown; isAvailable?: unknown }>> }
  )?.devices;
  if (!devices || typeof devices !== 'object') return [];
  return Object.entries(devices)
    .filter(([, list]) => (Array.isArray(list) ? list : []).some(availableIphone))
    .map(([runtime]) => runtime)
    .toSorted();
}

export function availableIphone(device: { deviceTypeIdentifier?: unknown; isAvailable?: unknown }): boolean {
  return (
    device.isAvailable === true &&
    typeof device.deviceTypeIdentifier === 'string' &&
    device.deviceTypeIdentifier.startsWith('com.apple.CoreSimulator.SimDeviceType.iPhone-')
  );
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

/** `CFBundleShortVersionString` and `ProductBuildVersion` of an Xcode app's `Contents/version.plist`. */
export function parseXcodeVersionPlist(plist: string): { version: string | null; build: string | null } {
  const value = (key: string) => new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`).exec(plist)?.[1] ?? null;
  return { version: value('CFBundleShortVersionString'), build: value('ProductBuildVersion') };
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const realPathOrNull = (path: string | null) => (path ? realPath(path) : null);

export function listXcodeApps(checks: boolean, root = '/Applications'): XcodeApp[] {
  const apps: XcodeApp[] = [];
  for (const entry of listDir(root) ?? []) {
    if (!entry.endsWith('.app') || !existsSync(join(root, entry, 'Contents', 'Developer'))) continue;
    const path = realPath(join(root, entry));
    if (apps.some((each) => each.path === path)) continue;
    let plist = '';
    try {
      plist = readFileSync(join(path, 'Contents', 'version.plist'), 'utf8');
    } catch {}
    const app: XcodeApp = { path, ...parseXcodeVersionPlist(plist) };
    if (checks) {
      const env = { ...process.env, DEVELOPER_DIR: join(path, 'Contents', 'Developer') };
      const passes = (args: string[]) =>
        getExecutor().runFileQuiet('xcodebuild', args, { timeoutMs: 20_000, env }) !== null;
      app.license = passes(['-license', 'check']);
      app.firstLaunch = passes(['-checkFirstLaunchStatus']);
    }
    apps.push(app);
  }
  return apps;
}

export function xcodeSelectionReport(xcode: string | null): Pick<WorkerToolchain, 'developerDir' | 'xcodeApps'> {
  if (process.env.DEVELOPER_DIR) return {};
  return {
    developerDir: realPathOrNull(quiet('xcode-select', ['-p'])?.trim() || null),
    xcodeApps: listXcodeApps(xcode === null),
  };
}

/** Whether the SDK's licenses are accepted: Gradle's SDK download reads `licenses/android-sdk-license`. */
function sdkLicensesAccepted(sdk: string): boolean {
  try {
    return readFileSync(join(sdk, 'licenses', 'android-sdk-license'), 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

export function sdkReport(): Pick<WorkerToolchain, 'androidSdk' | 'androidLicenses' | 'androidHome'> {
  const androidSdk = sdkPackages();
  if (!androidSdk) return { androidSdk };
  const home = androidHome();
  return { androidSdk, androidLicenses: sdkLicensesAccepted(home), androidHome: home };
}

export function cocoapodsInstall(here: string | null): Required<Pick<OffloadProblem, 'commands' | 'lead'>> {
  return {
    commands: ['brew install cocoapods'],
    lead: here
      ? `install CocoaPods (this Mac has ${here}; \`gem install cocoapods -v ${here}\` instead of Homebrew installs that version)`
      : 'install CocoaPods',
  };
}

/**
 * Whether this machine has no Xcode and no simulator SDK, so an iOS app it asks for can only be built, and only run,
 * on a remote Mac: that Mac's own Xcode, simulator SDK and CocoaPods are the build's toolchain.
 */
export function buildsOnlyOnWorker(local: Pick<IosToolchain, 'xcode' | 'simulatorSdk'>): boolean {
  return !local.xcode && !local.simulatorSdk;
}
