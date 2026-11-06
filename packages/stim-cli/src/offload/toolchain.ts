import { basename, posix } from 'node:path';
import {
  androidToolchain,
  buildsOnlyOnWorker,
  cocoapodsInstall,
  installedJdkMajors,
  iosToolchainForRuby,
  iphoneRuntimes,
  localJdk,
  quiet,
  sdkReport,
  xcodeSelectionReport,
  type AndroidRequirements,
  type AndroidToolchain,
  type BuildTarget,
  type WorkerToolchain,
  type XcodeApp,
} from '../engine/toolchain.ts';

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
  if (!local.jdk) {
    // React Native's Gradle builds need JDK 17; the worker builds on its own default JDK.
    if (!worker.jdk) out.push({ code: 'jdk', reason: 'no JDK there', ...jdkInstall('17', worker.os) });
  } else if (worker.jdk !== local.jdk && !worker.jdks?.includes(local.jdk)) {
    out.push({
      code: 'jdk',
      reason: `JDK ${worker.jdk ?? 'none'} there, ${local.jdk} here`,
      ...(worker.jdks ? jdkInstall(local.jdk, worker.os) : {}),
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

export function cocoapodsDifference(
  target: Extract<BuildTarget, { platform: 'ios' }>,
  worker: WorkerToolchain,
): OffloadProblem | null {
  if (target.native || target.cocoapodsPinned) return null;
  if (worker.os !== undefined && worker.os !== 'darwin') return null;
  const here = target.local.cocoapods;
  if (!worker.cocoapods) {
    return {
      code: 'cocoapods',
      reason: buildsOnlyOnWorker(target.local) ? 'no CocoaPods there' : versionMismatch('CocoaPods', null, here),
      ...cocoapodsInstall(here),
    };
  }
  return here && worker.cocoapods !== here
    ? { code: 'cocoapods', reason: versionMismatch('CocoaPods', worker.cocoapods, here) }
    : null;
}

/**
 * What a build on the worker does beyond the match: the SDK packages it lacks and Gradle downloads on the first build,
 * because its SDK licenses are accepted and the project allows the download, and the JDK it builds on for a client with
 * none. None of them stops the build. For iOS, the CocoaPods difference a named machine is sent the build despite.
 */
export function toolchainNotes(target: BuildTarget, worker: WorkerToolchain): OffloadProblem[] {
  if (target.platform === 'ios') {
    const pods = cocoapodsDifference(target, worker);
    return pods ? [{ ...pods, reason: `${pods.reason}; its pod install runs anyway and a failure is reported` }] : [];
  }
  if (target.platform !== 'android') return [];
  // A client with no JDK sends no JDK major, so the worker's own JDK is the build's JDK.
  const jdk: OffloadProblem[] =
    !target.local.jdk && worker.jdk
      ? [{ code: 'jdk', reason: `this machine has no JDK, so the build runs on JDK ${worker.jdk} there` }]
      : [];
  if (!worker.androidSdk || !gradleDownloads(target.requires, worker)) return jdk;
  const sdkManager = sdkManagerPath(worker);
  return [
    ...jdk,
    ...sdkGaps(target.requires, worker.androidSdk).map((gap) => ({
      code: gap.code,
      reason: `${gap.label} is not installed there; Gradle downloads it on the first build${gap.size ? ` (${gap.size})` : ''}`,
      commands: [`${sdkManager} "${gap.id}"`],
      lead: 'install the package now so the first build does not download it',
    })),
  ];
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

const developerDirOf = (app: XcodeApp) => posix.join(app.path, 'Contents', 'Developer');

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
  if (!local.stimBuild || worker.compat === undefined || worker.compat !== local.compat) {
    out.push({
      code: 'stim-build',
      reason:
        worker.compat === undefined
          ? 'The worker reports no build compatibility version; update the worker: stim service update --release <version>; update an old client: npm i -g stim@latest; Stim Desktop 0.2.5 or older: Stim > Check for Updates'
          : `Stim build ${worker.stimBuild ?? 'unknown'} there, ${local.stimBuild ?? 'unknown'} here`,
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
  if (worker.arch !== local.arch && !(target.platform === 'ios' && target.runsOnWorker))
    out.push({ code: 'arch', reason: `CPU ${worker.arch} there, ${local.arch} here` });
  if (target.platform === 'macos') {
    const macos = target.local;
    const xcode = !macos.xcode || worker.xcode !== macos.xcode ? xcodeProblem(macos, worker) : null;
    if (xcode) out.push(xcode);
    if ((!macos.macosSdk || worker.macosSdk !== macos.macosSdk) && !(xcode && diagnosesXcode(macos, worker)))
      out.push({ code: 'macos-sdk', reason: versionMismatch('macOS SDK', worker.macosSdk, macos.macosSdk) });
    return out;
  }
  const ios = target.local;
  const onWorker = buildsOnlyOnWorker(ios);
  const xcode = onWorker
    ? worker.xcode
      ? null
      : xcodeProblem(ios, worker, true)
    : !ios.xcode || worker.xcode !== ios.xcode
      ? xcodeProblem(ios, worker)
      : null;
  if (xcode) out.push(xcode);
  const selection = xcode !== null && (onWorker ? worker.developerDir !== undefined : diagnosesXcode(ios, worker));
  const sdkDiffers = onWorker ? !worker.simulatorSdk : !ios.simulatorSdk || worker.simulatorSdk !== ios.simulatorSdk;
  if (sdkDiffers && !selection) {
    out.push({
      code: 'simulator-sdk',
      reason: onWorker
        ? 'no simulator SDK there'
        : versionMismatch('simulator SDK', worker.simulatorSdk, ios.simulatorSdk),
    });
  }
  if (!target.native && target.cocoapodsPinned && !worker.bundler) {
    out.push({ code: 'bundler', reason: "no Bundler there to run the CocoaPods this project's Gemfile.lock pins" });
  }
  if (target.runtime && !worker.runtimes.includes(target.runtime)) {
    out.push(runtimeProblem(target.runtime, worker, selection || Boolean(xcode?.commands)));
  }
  return out;
}
