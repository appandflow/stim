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

/** What must be identical on this Mac and a remote Mac for an iOS simulator build to come out the same. */
export interface IosToolchain {
  /** A digest of Stim's built code, compared only with a remote machine that reports no `compat`. */
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
const STIM_BUILD_COMPAT = 2;

function quiet(file: string, args: string[]): string | null {
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

function iosToolchainForRuby(rubyVersion: string | null, native?: 'xcode'): IosToolchain {
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
export function jdkMajor(release: string): string | null {
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

function installedJdkMajors(): string[] {
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
export function parseAndroidRequirements(catalog: string): AndroidRequirements {
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

function xcodeSelectionReport(xcode: string | null): Pick<WorkerToolchain, 'developerDir' | 'xcodeApps'> {
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

function sdkReport(): Pick<WorkerToolchain, 'androidSdk' | 'androidLicenses' | 'androidHome'> {
  const androidSdk = sdkPackages();
  if (!androidSdk) return { androidSdk };
  const home = androidHome();
  return { androidSdk, androidLicenses: sdkLicensesAccepted(home), androidHome: home };
}

export function workerToolchain(rubyVersion: string | null = null, native?: 'xcode' | 'gradle'): WorkerToolchain {
  if (native === 'gradle')
    return {
      ...androidToolchain(),
      os: process.platform,
      xcode: null,
      simulatorSdk: null,
      cocoapods: null,
      macosSdk: null,
      bundler: null,
      runtimes: [],
      jdks: installedJdkMajors(),
      ...sdkReport(),
    };
  let listed: unknown = null;
  try {
    listed = JSON.parse(quiet('xcrun', ['simctl', 'list', 'devices', 'available', '-j']) ?? 'null');
  } catch {}
  const ios = iosToolchainForRuby(rubyVersion, native);
  return {
    ...ios,
    ...(process.platform === 'darwin' ? xcodeSelectionReport(ios.xcode) : {}),
    os: process.platform,
    macosSdk: native ? null : (quiet('xcrun', ['--sdk', 'macosx', '--show-sdk-version'])?.trim() ?? null),
    bundler: native ? null : quiet('bundle', ['--version'])?.trim() || null,
    runtimes: iphoneRuntimes(listed),
    jdk: native ? null : localJdk(),
    ...(native ? {} : { jdks: installedJdkMajors() }),
    ...(native ? { androidSdk: null } : sdkReport()),
  };
}

/** The API level of an SDK `platforms/` directory: `android-37.0` and `android-37` are both 37. */
const platformLevel = (dir: string): string | undefined => dir.replace(/^android-/, '').split('.')[0];

/** One reason a remote machine cannot take this build now, with a stable `code` for doctor's JSON. */
export interface OffloadProblem {
  code:
    | 'unreachable'
    | 'checkout'
    | 'stim-build'
    | 'arch'
    | 'xcode'
    | 'macos-sdk'
    | 'simulator-sdk'
    | 'cocoapods'
    | 'bundler'
    | 'runtime'
    | 'jdk'
    | 'android-sdk'
    | 'ndk'
    | 'build-tools'
    | 'compile-sdk'
    | 'disk'
    | 'busy'
    | 'platform';
  reason: string;
  /** Shell commands that clear it, to run on the remote machine, and what they do, as the end of "On <machine>, ...". */
  commands?: string[];
  lead?: string;
  /** The problem whose fix also clears this one, so it carries no fix of its own. */
  followsFrom?: OffloadProblem['code'];
}

interface SdkGap {
  code: 'ndk' | 'build-tools' | 'compile-sdk';
  label: string;
  /** The `sdkmanager` package id. */
  id: string;
  /** What Gradle's download costs on the first build, for the packages worth a warning. */
  size?: string;
}

function sdkGaps(requires: AndroidRequirements, sdk: NonNullable<WorkerToolchain['androidSdk']>): SdkGap[] {
  const gaps: SdkGap[] = [];
  if (requires.ndk && !sdk.ndk.includes(requires.ndk)) {
    gaps.push({ code: 'ndk', label: `NDK ${requires.ndk}`, id: `ndk;${requires.ndk}`, size: 'about 1-2 GB' });
  }
  if (requires.buildTools && !sdk.buildTools.includes(requires.buildTools)) {
    gaps.push({
      code: 'build-tools',
      label: `build-tools ${requires.buildTools}`,
      id: `build-tools;${requires.buildTools}`,
    });
  }
  if (requires.compileSdk && !sdk.platforms.some((dir) => platformLevel(dir) === requires.compileSdk)) {
    gaps.push({
      code: 'compile-sdk',
      label: `platform android-${requires.compileSdk}`,
      id: `platforms;android-${requires.compileSdk}`,
    });
  }
  return gaps;
}

/** Whether Gradle downloads a package the worker's SDK lacks: its licenses are accepted and the project allows it. */
function gradleDownloads(requires: AndroidRequirements, worker: WorkerToolchain): boolean {
  return worker.androidLicenses === true && requires.sdkDownload !== false;
}

function shellQuote(path: string, os: string | undefined): string {
  if (/^[\w@%+=:,./\\~-]+$/.test(path)) return path;
  return os === 'win32' ? `"${path}"` : `'${path.replaceAll("'", "'\\''")}'`;
}

function sdkManagerPath(worker: WorkerToolchain): string {
  if (!worker.androidHome) return 'sdkmanager';
  return shellQuote(
    worker.os === 'win32'
      ? `${worker.androidHome}\\cmdline-tools\\latest\\bin\\sdkmanager.bat`
      : `${worker.androidHome}/cmdline-tools/latest/bin/sdkmanager`,
    worker.os,
  );
}

function jdkInstall(major: string, os: string | undefined): Pick<OffloadProblem, 'commands' | 'lead'> {
  const command =
    os === 'linux'
      ? `sudo apt install openjdk-${major}-jdk-headless`
      : os === 'win32'
        ? `winget install EclipseAdoptium.Temurin.${major}.JDK`
        : `brew install --cask zulu@${major}`;
  return { commands: [command], lead: `install JDK ${major}; Stim uses it automatically, no restart needed` };
}

function androidMismatches(
  local: AndroidToolchain,
  requires: AndroidRequirements,
  worker: WorkerToolchain,
): OffloadProblem[] {
  const out: OffloadProblem[] = [];
  if ((!local.jdk || worker.jdk !== local.jdk) && !(local.jdk && worker.jdks?.includes(local.jdk))) {
    out.push({
      code: 'jdk',
      reason: `JDK ${worker.jdk ?? 'none'} there, ${local.jdk ?? 'none'} here`,
      ...(local.jdk && worker.jdks ? jdkInstall(local.jdk, worker.os) : {}),
    });
  }
  const sdk = worker.androidSdk;
  if (!sdk) return [...out, { code: 'android-sdk', reason: 'no Android SDK there' }];
  if (gradleDownloads(requires, worker)) return out;
  const sdkManager = sdkManagerPath(worker);
  const why =
    requires.sdkDownload === false
      ? ', and the project sets android.builder.sdkDownload=false'
      : worker.androidLicenses === false
        ? ', and its SDK licenses are not accepted'
        : '';
  for (const gap of sdkGaps(requires, sdk)) {
    const install = `${sdkManager} "${gap.id}"`;
    const licenses = worker.androidLicenses === false && requires.sdkDownload !== false;
    out.push({
      code: gap.code,
      reason: `no ${gap.label} there${why}`,
      commands: licenses ? [`${sdkManager} --licenses`, install] : [install],
      lead: licenses
        ? 'accept the SDK licenses so Gradle downloads the package, or install it'
        : worker.androidHome
          ? 'install the package into its Android SDK'
          : 'install the package into the Android SDK stim-server uses (its ANDROID_HOME, else the default SDK location)',
    });
  }
  return out;
}

/**
 * What a build on the worker does beyond the match: the SDK packages it lacks and Gradle downloads on the first build,
 * because its SDK licenses are accepted and the project allows the download. None of them stops the build.
 */
export function toolchainNotes(target: BuildTarget, worker: WorkerToolchain): OffloadProblem[] {
  if (target.platform !== 'android' || !worker.androidSdk || !gradleDownloads(target.requires, worker)) return [];
  return sdkGaps(target.requires, worker.androidSdk).map((gap) => ({
    code: gap.code,
    reason: `${gap.label} is not installed there; Gradle downloads it on the first build${gap.size ? ` (${gap.size})` : ''}`,
  }));
}

function versionMismatch(tool: string, there: string | null, here: string | null): string {
  const side = (version: string | null) =>
    version ? (version.startsWith(tool) ? version : `${tool} ${version}`) : `no ${tool}`;
  return `${side(there)} there, ${side(here)} here`;
}

const COMMAND_LINE_TOOLS = '/Library/Developer/CommandLineTools';

function xcodeIdentity(xcode: string | null): { version: string | null; build: string | null } {
  return {
    version: xcode ? (/Xcode (\S+)/.exec(xcode)?.[1] ?? null) : null,
    build: xcode ? (/Build version (\S+)/.exec(xcode)?.[1] ?? null) : null,
  };
}

const versionParts = (version: string | null) =>
  (version ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0);

function compareVersions(a: string | null, b: string | null): number {
  const [left, right] = [versionParts(a), versionParts(b)];
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function pickXcodeApp(
  apps: XcodeApp[],
  wanted: { version: string | null; build: string | null },
): XcodeApp | undefined {
  return (
    (wanted.build ? apps.find((app) => app.build === wanted.build) : undefined) ??
    (wanted.version ? apps.find((app) => app.version === wanted.version) : undefined) ??
    apps.toSorted((a, b) => compareVersions(b.version, a.version))[0]
  );
}

const developerDirOf = (app: XcodeApp) => join(app.path, 'Contents', 'Developer');

function selectXcode(
  app: XcodeApp,
  selected: boolean,
  worker: WorkerToolchain,
): Pick<OffloadProblem, 'commands' | 'lead'> {
  const commands = selected ? [] : [`sudo xcode-select -s ${shellQuote(developerDirOf(app), worker.os)}`];
  if (app.license === false && app.firstLaunch === false) {
    commands.push('sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch');
  } else if (app.license === false) commands.push('sudo xcodebuild -license accept');
  else if (app.firstLaunch === false) commands.push('sudo xcodebuild -runFirstLaunch');
  const name = basename(app.path, '.app');
  return {
    commands,
    lead: selected
      ? `finish setting up ${name}`
      : `select ${name}${commands.length > 1 ? ' and finish setting it up' : ''}`,
  };
}

function diagnosesXcode(local: { xcode: string | null }, worker: WorkerToolchain): boolean {
  return worker.xcode === null && worker.developerDir !== undefined && local.xcode !== null;
}

function xcodeProblem(local: { xcode: string | null }, worker: WorkerToolchain, onWorker = false): OffloadProblem {
  const legacy = {
    code: 'xcode' as const,
    reason: onWorker ? 'no Xcode there' : versionMismatch('Xcode', worker.xcode, local.xcode),
  };
  if (worker.developerDir === undefined || (!onWorker && !local.xcode)) return legacy;
  const wanted = onWorker ? { version: null, build: null } : xcodeIdentity(local.xcode);
  const apps = worker.xcodeApps ?? [];
  if (worker.xcode) {
    const match = wanted.build ? apps.find((app) => app.build === wanted.build) : undefined;
    return match ? { ...legacy, ...selectXcode(match, false, worker) } : legacy;
  }
  const app = pickXcodeApp(apps, wanted);
  if (!app) {
    return {
      code: 'xcode',
      reason: 'no Xcode there',
      ...(wanted.version
        ? {
            commands: [`xcodes install ${wanted.version}`],
            lead: `install Xcode ${wanted.version} (from the App Store, or with xcodes), then run stim doctor again`,
          }
        : {}),
    };
  }
  const selected = worker.developerDir === developerDirOf(app);
  const where = worker.developerDir
    ? worker.developerDir.startsWith(COMMAND_LINE_TOOLS)
      ? 'Command Line Tools'
      : worker.developerDir
    : 'nothing';
  const fix = selectXcode(app, selected, worker);
  const matches = app.build === wanted.build || app.version === wanted.version;
  return {
    code: 'xcode',
    reason: selected
      ? `no Xcode there: ${basename(app.path)} is selected${fix.commands?.length ? ' but not set up' : ' but xcodebuild fails'}`
      : `no Xcode there: xcode-select points at ${where}`,
    ...fix,
    ...(wanted.version && !matches
      ? { lead: `${fix.lead} (this Mac has Xcode ${wanted.version}; xcodes install ${wanted.version} matches it)` }
      : {}),
  };
}

function runtimeProblem(runtime: string, worker: WorkerToolchain, followsXcode: boolean): OffloadProblem {
  const reason = `no iPhone simulator on ${runtime} there`;
  if (followsXcode) {
    return { code: 'runtime', reason: `${reason}; this follows from the Xcode problem`, followsFrom: 'xcode' };
  }
  const version = /iOS-(\d+)-(\d+)$/.exec(runtime);
  return worker.developerDir !== undefined && version
    ? {
        code: 'runtime',
        reason,
        commands: [`xcodebuild -downloadPlatform iOS -buildVersion ${version[1]}.${version[2]}`],
        lead: `download the iOS ${version[1]}.${version[2]} simulator runtime if it is not installed (an installed runtime also needs an iPhone simulator)`,
      }
    : { code: 'runtime', reason };
}

/** Why a remote machine cannot build like this machine; empty when it can. */
export function toolchainMismatches(target: BuildTarget, worker: WorkerToolchain): OffloadProblem[] {
  const { local } = target;
  const out: OffloadProblem[] = [];
  if (
    !local.stimBuild ||
    (worker.compat !== undefined ? worker.compat !== local.compat : worker.stimBuild !== local.stimBuild)
  ) {
    out.push({
      code: 'stim-build',
      reason: `Stim build ${worker.stimBuild ?? 'unknown'} there, ${local.stimBuild ?? 'unknown'} here`,
    });
  }
  if (target.platform === 'android') return [...out, ...androidMismatches(target.local, target.requires, worker)];
  if (worker.os !== undefined && worker.os !== 'darwin') {
    const name = target.platform === 'ios' ? 'iOS' : 'macOS';
    return [...out, { code: 'platform', reason: `${worker.os} there, and ${name} builds need a Mac` }];
  }
  if (target.platform === 'macos' && target.runsOnWorker) {
    if (!worker.xcode) {
      out.push(xcodeProblem(target.local, worker, true));
    }
    if (!worker.macosSdk) out.push({ code: 'macos-sdk', reason: 'no macOS SDK there' });
    return out;
  }
  if (worker.arch !== local.arch) out.push({ code: 'arch', reason: `CPU ${worker.arch} there, ${local.arch} here` });
  if (target.platform === 'macos') {
    const macos = target.local;
    const xcode = !macos.xcode || worker.xcode !== macos.xcode ? xcodeProblem(macos, worker) : null;
    if (xcode) out.push(xcode);
    if ((!macos.macosSdk || worker.macosSdk !== macos.macosSdk) && !(xcode && diagnosesXcode(macos, worker)))
      out.push({ code: 'macos-sdk', reason: versionMismatch('macOS SDK', worker.macosSdk, macos.macosSdk) });
    return out;
  }
  const ios = target.local;
  const xcode = !ios.xcode || worker.xcode !== ios.xcode ? xcodeProblem(ios, worker) : null;
  if (xcode) out.push(xcode);
  const selection = xcode !== null && diagnosesXcode(ios, worker);
  if ((!ios.simulatorSdk || worker.simulatorSdk !== ios.simulatorSdk) && !selection) {
    out.push({
      code: 'simulator-sdk',
      reason: versionMismatch('simulator SDK', worker.simulatorSdk, ios.simulatorSdk),
    });
  }
  if (!target.native && target.cocoapodsPinned) {
    if (!worker.bundler) {
      out.push({ code: 'bundler', reason: "no Bundler there to run the CocoaPods this project's Gemfile.lock pins" });
    }
  } else if (!target.native && worker.cocoapods !== ios.cocoapods) {
    out.push({ code: 'cocoapods', reason: versionMismatch('CocoaPods', worker.cocoapods, ios.cocoapods) });
  }
  if (target.runtime && !worker.runtimes.includes(target.runtime)) {
    out.push(runtimeProblem(target.runtime, worker, selection || Boolean(xcode?.commands)));
  }
  return out;
}
