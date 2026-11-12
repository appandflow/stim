import { brokenPodLinks } from './doctor-pods-flavor.ts';
import { readFingerprint } from '../fingerprint-precompute.ts';
import { processContext } from '../cli-operation.ts';
import { diffInputs, isUncertain } from '../fingerprint/key.ts';
import { reportSignal, reportTimeRemainingMs, trackReportResource } from '../report-runtime.ts';
import { sizeScanDeferred } from '../stimd/passes/measure.ts';
import type { StimContext } from '@stim-cli/core';
import { resolveOptimizations, type Optimizations } from '../optimizations.ts';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync } from 'fs';
import { rm } from 'fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { plural, quotedPath } from '../command-output.ts';
import { getExecutor } from '../exec.ts';
import { probeSigningIdentities } from '../engine/ios-signing.ts';
import type { SigningIdentity } from '../engine/ios-profile.ts';
import { gitQuietAsync } from '../workspace/git.ts';
import {
  isJsonObject,
  readJsonObject,
  LAST_BUILD_KEYS,
  readBuildHistory,
  readStats,
  type StatsPlacement,
  type SettingsObject,
  type WorkspaceState,
} from '@stim-cli/core/state';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { tailscaleStatus } from '../tailscale-status.ts';
import { makeTemporaryDirectory } from '../temporary.ts';
import { checkStorageLayout } from './doctor-storage.ts';
import { appProjectProblem, detectIsExpo, isPackageResolvable, resolvePackageJson } from '../workspace/project.ts';
import { CHROME_INSTALL_REMEDY, findChrome } from '../web/chrome.ts';
import {
  dirtyFingerprintFiles,
  gitCommonDirAsync,
  listWorktreesAsync,
  resolveSourceCheckoutAsync,
  locallyKnownUpstreamAsync,
  repoRoot,
  repoRootAsync,
  type UpstreamState,
} from '../workspace/worktree.ts';
import { dependencyState, hasInstalledDependencies } from '../dependency-state.ts';
import { installedTreeIsStaleAsync } from '../workspace/worktree-refresh.ts';
import { workspaceDerivedData } from '../workspace/paths.ts';
import { repackServerProblem } from '../stimd/metro/server-repack.ts';
import {
  type ConcurrencyLimits,
  getConcurrencyLimits,
  getPlatformDeviceLimits,
  loadConfig,
  type PlatformDeviceLimits,
} from '../workspace/config.ts';
import { ccacheInstallCommand } from '../engine/ccache.ts';
import { ccacheEnabled } from '../integrations/react-native-build.ts';
import { podInstallCommand } from '../engine/bundler.ts';
import { countLiveOwnedDevices, countLiveOwnedDevicesAsync } from '../engine/device-capacity.ts';
import { parseSlimProfile } from '../engine/simslim.ts';
import { readHostMemoryPressureAsync, hostMemoryPressureAdvice, type HostMemoryPressure } from '../host-memory.ts';
import { listBuildSlots } from '../engine/build-slots.ts';
import { parkedMaxSetting, POOL_SETTING_REMEDY } from '../devices/sim-pool.ts';
import { COMPILATION_CACHE_MIN_XCODE } from '../engine/xcode.ts';
import { androidHome, hostSystemImageArch, listInstalledSystemImages } from '../devices/android.ts';
import {
  androidImageInstallPolicy,
  decideSystemImage,
  systemImageInstallProblem,
  type SystemImageDecision,
} from '../devices/android-image.ts';
import {
  type EasAuthResult,
  checkEasAuth as probeEasAuth,
  ownerFromConfig,
  providerFromConfig,
  resolveEasCliBin,
} from '../engine/remote-cache.ts';
import {
  DEFAULT_IOS_PROJECT_PATH,
  defaultAndroidLayout,
  resolveAndroidLayout,
  resolveIosProjectDir,
  type AndroidLayout,
  iosSimSlimProfileSetting,
  metroCommandSetting,
  projectSettingsContext,
  remoteAndroidSetting,
  remoteIosSetting,
  webSettings,
  resolveSettings,
  SETTING_SHAPE_REMEDY,
  settingShapeErrors,
  settingValueAt,
} from '../workspace/settings.ts';
import { readInstalledEasCliVersionAsync, type RemoteDeviceBackend } from '../engine/device-remote.ts';
import { easCliSupport, easCliUpgradeRemedy, MIN_EAS_CLI_SIMULATOR_VERSION } from '../engine/eas-simulator.ts';
import { MIN_EAS_CLI_BUILD_DOWNLOAD_VERSION } from '../engine/eas-build.ts';
import { readAndroidCasToolchain, resolveAndroidCompilerCache } from '../engine/android-cas.ts';
import { androidPathRoom, androidPathRoomMessage, androidPathRoomRemedy } from '../engine/android-path-limit.ts';
import { androidSdkRefusal } from '../engine/gradle.ts';
import { readCxxLauncherStates, type CxxLauncherState } from './doctor-cxx.ts';
import { checkMachineSettings, readMachineSettings, type MachineSettings } from './doctor-config.ts';
import { dependencyEditsFindings } from './doctor-dependency-edits.ts';

export { brokenPodLinks } from './doctor-pods-flavor.ts';

type AnyJson = Record<string, unknown>;

export interface Finding {
  code?: string;
  level: 'cost' | 'note';
  title: string;
  detail: string;
  fix: string | null;
}

export type DoctorPlatform = 'ios' | 'android';

function finding(level: 'cost' | 'note', title: string, detail: string, fix: string | null): Finding {
  return { level, title, detail, fix };
}

const isDeviceCacheKey = (key: unknown): boolean => typeof key === 'string' && /-device(?:-|$)/.test(key);

/** Whether this workspace has run, or is set up for, `ios --device`: a device build in its history or an iOS signing or LAN setting. */
export function deviceWorkflowPlausible(state: WorkspaceState | null, settings: SettingsObject): boolean {
  const last = state?.[LAST_BUILD_KEYS.ios];
  if (last && typeof last === 'object' && 'cacheKey' in last && isDeviceCacheKey(last.cacheKey)) return true;
  if ((readBuildHistory(state).ios ?? []).some((entry) => isDeviceCacheKey(entry.cacheKey))) return true;
  return ['ios.signingIdentity', 'ios.signingIdentitySha1', 'ios.lanHost'].some(
    (key) => settingValueAt(settings, key) !== undefined,
  );
}

export function checkDeviceSigning(identities: readonly SigningIdentity[] | null): Finding | null {
  if (identities === null) {
    return finding(
      'note',
      'Could not list code signing identities',
      '`security find-identity -v -p codesigning` failed, so doctor cannot tell whether `stim ios --device` can sign a build for a phone.',
      'Run `security find-identity -v -p codesigning` to see the error; a locked login keychain is the usual cause (`security unlock-keychain`).',
    );
  }
  if (identities.length > 0) return null;
  return finding(
    'note',
    'No code signing identity for iOS device builds',
    '`security find-identity -v -p codesigning` lists no identity on this Mac, so `stim ios --device` cannot sign a build for a phone. Simulator runs are unaffected.',
    'With the phone connected, run `stim device provision ios`: it lists the Apple Developer account changes (register the phone, create or refresh its Development profile, create an Apple Development certificate) and asks before making them; an agent runs it only with your go-ahead. Or sign in under Xcode > Settings > Accounts and build once from Xcode to the phone.',
  );
}

export function checkOffloadCandidate(
  placements: readonly StatsPlacement[],
  machines: readonly string[],
  peers: readonly unknown[],
  now: number,
): Finding | null {
  if (machines.length || !peers.some((peer) => isJsonObject(peer) && peer.OS === 'macOS' && peer.Online === true))
    return null;
  const cold = placements.filter((placement) => {
    const age = now - Date.parse(placement.at);
    return (
      placement.decision === 'here' &&
      !placement.failed &&
      (placement.buildMs ?? 0) > 0 &&
      age >= 0 &&
      age <= 7 * 24 * 60 * 60_000
    );
  });
  if (cold.length < 3) return null;
  const average = cold.reduce((total, placement) => total + placement.buildMs!, 0) / cold.length;
  if (average <= 180_000) return null;
  return {
    code: 'offload-candidate',
    ...finding(
      'note',
      'Builds could run on another machine',
      `Cold builds averaged ~${Math.round(average / 60_000)} min over ${cold.length} builds this week.`,
      'In Stim Desktop, open Settings > Connections > This machine uses > Add.',
    ),
  };
}

async function readOffloadCandidate(
  tailnetStatus: () => unknown,
  now: number,
  host: NodeJS.Platform,
): Promise<Finding | null> {
  if (host !== 'darwin') return null;
  try {
    const entries = loadConfig()?.remote?.machines;
    const machines = Array.isArray(entries)
      ? entries.filter((entry): entry is string => typeof entry === 'string')
      : [];
    const placements = readStats().record?.placements ?? [];
    if (machines.length || placements.length < 3) return null;
    const status = await tailnetStatus();
    const peers = isJsonObject(status) && isJsonObject(status.Peer) ? Object.values(status.Peer) : [];
    return checkOffloadCandidate(placements, machines, peers, now);
  } catch {
    return null;
  }
}

export async function mainCheckoutProjectRoot(projectRoot: string): Promise<string> {
  const currentRepoRoot = await repoRootAsync(projectRoot);
  if (!currentRepoRoot) return projectRoot;
  try {
    const source = await resolveSourceCheckoutAsync(currentRepoRoot);
    if ('refusal' in source) return projectRoot;
    const projectRel = relative(currentRepoRoot, realpathSync(projectRoot));
    if (projectRel.startsWith('..')) return projectRoot;
    return resolve(source.path, projectRel);
  } catch {
    return projectRoot;
  }
}

export function podsManifestState(podfileLock: string, podManifest: string): 'missing' | 'stale' | null {
  if (!existsSync(podManifest)) return 'missing';
  try {
    return readFileSync(podfileLock, 'utf-8') === readFileSync(podManifest, 'utf-8') ? null : 'stale';
  } catch {
    return 'stale';
  }
}

function hasIosWarmOutput(root: string, iosRoot: string): boolean {
  if (existsSync(join(iosRoot, 'build'))) return true;
  const derivedData = workspaceDerivedData(root);
  if (existsSync(join(derivedData, 'Build', 'Products'))) return true;
  try {
    return readdirSync(derivedData).some(
      (entry) => /^scheme-[a-f0-9]{64}$/.test(entry) && existsSync(join(derivedData, entry, 'Build', 'Products')),
    );
  } catch {
    return false;
  }
}

async function hasLinkedWorktree(projectRoot: string): Promise<boolean> {
  const root = await repoRootAsync(projectRoot);
  if (!root) return false;
  return (await listWorktreesAsync(root)).filter((entry) => !entry.prunable && !entry.bare).length > 1;
}

async function headBranch(root: string): Promise<string | null> {
  const ref = (await gitQuietAsync(root, ['symbolic-ref', '--quiet', 'HEAD']))?.trim();
  return ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
}

async function mainOperation(root: string): Promise<'rebase' | 'merge' | null> {
  const gitDir = (await gitQuietAsync(root, ['rev-parse', '--path-format=absolute', '--git-dir']))?.trim();
  if (!gitDir) return null;
  if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) return 'rebase';
  return existsSync(join(gitDir, 'MERGE_HEAD')) ? 'merge' : null;
}

async function dirtyTrackedPaths(root: string): Promise<string[]> {
  const out = await gitQuietAsync(root, ['diff', '--name-only', 'HEAD']);
  return (out ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function resolveDefaultBranch(root: string): Promise<string | null> {
  const settings = resolveSettings({
    gitCommonDir: await gitCommonDirAsync(root),
    repoRoot: (await repoRootAsync(root)) ?? root,
  });
  const worktree = settings.worktree;
  const configured =
    worktree && typeof worktree === 'object' && !Array.isArray(worktree)
      ? (worktree as { defaultBranch?: unknown }).defaultBranch
      : undefined;
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  const head = (await gitQuietAsync(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))?.trim();
  if (!head) return null;
  const cut = head.indexOf('/');
  return cut > 0 ? head.slice(cut + 1) : head;
}

async function seedFindings(mainRoot: string, upstream: UpstreamState | null): Promise<Finding[]> {
  const findings: Finding[] = [];
  const root = await repoRootAsync(mainRoot);
  const quotedRoot = quotedPath(root ?? mainRoot);

  if (upstream && upstream.behind > 0 && upstream.ahead === 0) {
    findings.push(
      finding(
        'note',
        `The source checkout is ${plural(upstream.behind, 'commit')} behind ${upstream.name}`,
        'The count uses the locally known upstream ref. A fetch can reveal additional commits. A later rebase or merge can change native inputs and invalidate work done from the older base.',
        `Run \`stim worktree warm --refresh\` from a linked worktree to fetch and fast-forward the source checkout, or \`git -C ${quotedRoot} fetch --prune\` and inspect the branch yourself.`,
      ),
    );
  }
  if (root === null) return findings;

  const operation = await mainOperation(root);
  if (operation) {
    findings.push(
      finding(
        'note',
        `The source checkout has a ${operation} in progress`,
        '`stim worktree warm --refresh` refuses a source checkout it cannot move, and the branch stays where the interrupted operation left it.',
        `Finish it, or run \`git -C ${quotedRoot} ${operation} --abort\`.`,
      ),
    );
    return findings;
  }

  const dirty = await dirtyTrackedPaths(root);
  if (dirty.length) {
    findings.push(
      finding(
        'note',
        `The source checkout has ${plural(dirty.length, 'uncommitted tracked change')}`,
        `\`stim worktree warm --refresh\` refuses a source checkout it cannot move, so the seed stays where it is until this is cleared. First: ${dirty[0]}.`,
        `Commit them, or run \`git -C ${quotedRoot} stash push -u -m warm-refresh\`.`,
      ),
    );
  }

  const branch = await headBranch(root);
  if (branch === null) {
    findings.push(
      finding(
        'note',
        'The source checkout has a detached HEAD',
        '`stim worktree warm --refresh` refuses: there is no branch to fast-forward.',
        `Run \`git -C ${quotedRoot} checkout <branch>\`.`,
      ),
    );
    return findings;
  }

  if (upstream && upstream.ahead > 0 && upstream.behind > 0) {
    findings.push(
      finding(
        'note',
        `The source checkout has diverged from ${upstream.name}`,
        `${branch} is ${upstream.ahead} ahead of and ${upstream.behind} behind ${upstream.name}, so it cannot fast-forward. \`stim worktree warm --refresh\` refuses rather than merging or resetting.`,
        `Rebase or merge ${branch} onto ${upstream.name} yourself.`,
      ),
    );
  }

  const defaultBranch = await resolveDefaultBranch(root);
  if (defaultBranch !== null && defaultBranch !== branch) {
    findings.push(
      finding(
        'note',
        `The source checkout is on ${branch}, not the default branch ${defaultBranch}`,
        `Every worktree warmed from here carries ${branch}'s dependencies. \`stim worktree warm --refresh\` warns and continues; it never switches a branch under another checkout.`,
        `Run \`git -C ${quotedRoot} checkout ${defaultBranch}\`.`,
      ),
    );
  }

  return findings;
}

export async function checkMainCheckout(
  projectRoot: string,
  {
    npmTreeValid,
    brokenPods = undefined,
    upstream = undefined,
    linkedWorktrees = undefined,
    platform,
    localIos = platform !== 'android',
    iosProjectPath = DEFAULT_IOS_PROJECT_PATH,
    androidLayout = defaultAndroidLayout(projectRoot),
  }: {
    npmTreeValid?: boolean | null;
    brokenPods?: string[];
    upstream?: UpstreamState | null;
    linkedWorktrees?: boolean;
    platform?: DoctorPlatform;
    localIos?: boolean;
    iosProjectPath?: string;
    androidLayout?: AndroidLayout;
  } = {},
): Promise<Finding[]> {
  const mainRoot = await mainCheckoutProjectRoot(projectRoot);
  const mainAndroid = {
    ...androidLayout,
    gradleRoot: join(mainRoot, relative(projectRoot, androidLayout.gradleRoot)),
    moduleDir: join(mainRoot, relative(projectRoot, androidLayout.moduleDir)),
  };
  const findings: Finding[] = [];
  const dependencies = dependencyState(mainRoot, (await repoRootAsync(mainRoot)) ?? mainRoot);

  if (dependencies) {
    const installed = hasInstalledDependencies(dependencies.root, dependencies.installed);
    const installCommand = `cd ${quotedPath(dependencies.root)} && ${dependencies.command}`;
    if (!installed) {
      findings.push(
        finding(
          'cost',
          'The source checkout has no installed dependencies',
          `A worktree cannot carry dependencies from ${dependencies.root}, so its first build must install them from scratch.`,
          `Run \`${installCommand}\` before creating native worktrees, let \`stim worktree warm --refresh\` run it from a linked worktree, or run stim doctor --fix in a terminal.`,
        ),
      );
    } else if (dependencies.lock === 'package-lock.json') {
      const stale = npmTreeValid === undefined ? await installedTreeIsStaleAsync(dependencies) : npmTreeValid === false;
      if (stale) {
        findings.push(
          finding(
            'cost',
            'The source checkout dependency tree is stale',
            `npm reports that ${dependencies.root}/node_modules does not match the project dependency graph. Copying it makes each worktree start from the same invalid state.`,
            `Run \`${installCommand}\` before creating native worktrees, let \`stim worktree warm --refresh\` run it from a linked worktree, or run stim doctor --fix in a terminal.`,
          ),
        );
      }
    }
  }

  const iosRoot = join(mainRoot, iosProjectPath);
  const podfileLock = join(iosRoot, 'Podfile.lock');
  const podManifest = join(iosRoot, 'Pods', 'Manifest.lock');
  const podsRoot = join(iosRoot, 'Pods');
  if (localIos && existsSync(podfileLock)) {
    const podsState = podsManifestState(podfileLock, podManifest);
    if (podsState) {
      const podCommand = `cd ${quotedPath(iosRoot)} && ${podInstallCommand(mainRoot, iosRoot)}`;
      findings.push(
        finding(
          'cost',
          `The source checkout CocoaPods state is ${podsState}`,
          `ios/Pods cannot be reused safely because its Manifest.lock ${podsState === 'missing' ? 'is absent' : 'does not match ios/Podfile.lock'}.`,
          `Run \`${podCommand}\` before creating native worktrees, let \`stim worktree warm --refresh\` run it from a linked worktree, or run stim doctor --fix in a terminal.`,
        ),
      );
    }

    const broken = brokenPods === undefined && existsSync(podsRoot) ? await brokenPodLinks(podsRoot) : brokenPods || [];
    if (broken.length) {
      const podCommand = `cd ${quotedPath(iosRoot)} && ${podInstallCommand(mainRoot, iosRoot, '--clean-install')}`;
      findings.push(
        finding(
          'cost',
          'The source checkout CocoaPods state has broken links',
          `${broken.length} symlink${broken.length === 1 ? '' : 's'} under ios/Pods point to missing files. Worktrees copy these broken links and can fail during compilation. First: ${broken[0]}.`,
          `Run \`${podCommand}\` before creating native worktrees, or run stim doctor --fix in a terminal.`,
        ),
      );
    }
  }

  const coldPlatforms = [
    localIos && existsSync(iosRoot) && !hasIosWarmOutput(mainRoot, iosRoot) ? 'iOS' : null,
    platform !== 'ios' &&
    hasAndroidProject(mainAndroid) &&
    !existsSync(join(mainAndroid.gradleRoot, 'build')) &&
    !existsSync(join(mainAndroid.moduleDir, 'build'))
      ? 'Android'
      : null,
  ].filter((coldPlatform): coldPlatform is string => coldPlatform !== null);
  if (coldPlatforms.length) {
    findings.push(
      finding(
        'note',
        `The source checkout has no ${coldPlatforms.join(' or ')} warm build output`,
        'The shared Stim artifact or compilation cache can still be warm. Building the source checkout once gives later native worktrees the strongest warm starting point.',
        `When more native worktrees are expected, run \`stim start\`, \`stim ${coldPlatforms[0] === 'iOS' ? 'ios' : 'android'}\`, and \`stim stop\` from ${mainRoot}.`,
      ),
    );
  }

  const linked = linkedWorktrees === undefined ? await hasLinkedWorktree(projectRoot) : linkedWorktrees;
  if (linked) {
    findings.push(
      ...(await seedFindings(mainRoot, upstream === undefined ? await locallyKnownUpstreamAsync(mainRoot) : upstream)),
    );
  }

  return findings;
}

function checkRepackServer(projectRoot: string, command: readonly string[] | null): Finding | null {
  const problem = repackServerProblem(projectRoot, command);
  return problem
    ? finding('cost', 'stim start cannot run the Re.Pack dev server', problem.message, problem.remedy)
    : null;
}

export function checkMetroCache(metroConfigSource: string | null): Finding | null {
  if (metroConfigSource == null) return null;
  const lines = String(metroConfigSource).split('\n');
  const mentions = lines.filter((line) => /cacheStores/.test(line));
  if (!mentions.length) return null;
  if (!lines.every((line, i) => !/cacheStores/.test(line) || isConditional(lines, i))) return null;
  return finding(
    'note',
    'metro.config.js mentions cacheStores, but not unconditionally',
    `Every line naming it is inside a conditional, and doctor reads this file rather than executing it, so it cannot tell whether the store is installed. Under \`stim start\` this costs nothing -- Stim appends its own store whether the project's is on or off -- but outside Stim a cacheStores that is off by default costs exactly what having none costs: ${mentions.map((l) => l.trim()).join(' / ')}`,
    'Only for Metro runs Stim does not host: confirm it applies without env vars -- a store behind an opt-in flag is not shared until every workspace sets the flag.',
  );
}

function isConditional(lines: string[], index: number): boolean {
  const line = lines[index];
  if (line === undefined) return false;
  if (isConditionalLine(line)) return true;
  if (!/^\s+\S/.test(line)) return false;
  for (let i = index - 1; i >= 0; i--) {
    const prev = lines[i];
    if (prev === undefined) continue;
    if (prev.trim() === '') continue;
    return isConditionalLine(prev);
  }
  return false;
}

function isConditionalLine(line: string): boolean {
  return /process\.env/.test(line) || line.includes('?') || /(^|[^\w])if([^\w]|$)/.test(line);
}

export function checkCompilationCache(podfileSource: string | null, xcodeMajor: number | null): Finding | null {
  if (podfileSource == null) return null;
  if (xcodeMajor != null && xcodeMajor < COMPILATION_CACHE_MIN_XCODE) return null;
  if (!/COMPILATION_CACHE_ENABLE_CACHING/.test(podfileSource)) return null;
  if (/COMPILATION_CACHE_CAS_PATH/.test(podfileSource)) return null;
  return finding(
    'note',
    'The Podfile enables compilation caching but leaves the CAS at its default path',
    'The default CAS lives at the DerivedData root, and DerivedData is per-workspace -- so nothing is actually shared between worktrees, which is the only reason to turn it on. Builds Stim drives are unaffected: they override COMPILATION_CACHE_CAS_PATH to a shared path on the xcodebuild command line, which wins over the project setting. This costs only the builds you run outside Stim.',
    'Nothing to do for Stim. For builds outside it: set COMPILATION_CACHE_CAS_PATH to a fixed path outside DerivedData -- ~/.stim/compilation-cache is where Stim puts its own, so the two share entries instead of filling two caches.',
  );
}

export function checkCcacheConflict(podfileSource: string | null, podfileProperties: AnyJson | null): Finding | null {
  if (podfileSource == null) return null;
  if (!ccacheEnabled(podfileProperties)) return null;
  return finding(
    'cost',
    'ccache is enabled, so Stim leaves Xcode compilation caching off',
    "The ccache launcher script is what disables explicitly built modules, which compilation caching requires -- so enabling both tends to mean neither works. Stim will not add its compilation-cache settings to a build whose project has apple.ccacheEnabled=true, and in its default configuration ccache hashes the working directory and every absolute include path, so it misses across worktrees. (Stim relocates ccache itself on Android, where it drives the compile and can set CCACHE_BASEDIR and CCACHE_NOHASHDIR; the Podfile launcher script here is the project's, not Stim's.)",
    'Pick one, and on Xcode 26 the compilation cache is the one that survives a different workspace path -- Stim supplies it on its own builds as soon as ccache is off. Turn it off where the value comes FROM: on Expo that is the expo-build-properties plugin in the app config (ios.ccacheEnabled), because prebuild rewrites ios/Podfile.properties.json from it; on a bare project edit ios/Podfile.properties.json directly. Then re-run pod install (or let `stim ios` do it).',
  );
}

function checkChrome({
  usesWeb,
  chrome = findChrome,
}: {
  usesWeb: () => boolean;
  chrome?: () => string | null;
}): Finding | null {
  if (!usesWeb() || chrome()) return null;
  return finding(
    'cost',
    'No Chrome is installed, so `stim web` cannot open this app',
    '`stim web` drives the installed Google Chrome or Chromium with a Stim-owned profile, and found neither in /Applications, ~/Applications, Program Files or on PATH. This project renders on the web (web.url is set, app.json lists the web platform, or react-native-web is installed).',
    CHROME_INSTALL_REMEDY,
  );
}

export function checkCcacheInstalled(onPath: boolean, platform: NodeJS.Platform = process.platform): Finding | null {
  if (onPath) return null;
  return finding(
    'cost',
    'ccache is not on PATH, so Android C++ recompiles in every worktree',
    'Stim resolves the launcher with a PATH lookup for `ccache` -- the same lookup the build itself uses -- and found nothing, so it passes no CMAKE_C_COMPILER_LAUNCHER / CMAKE_CXX_COMPILER_LAUNCHER to Gradle and every AGP CMake task compiles without one. Those tasks are uncacheable by Gradle, so not one C++ object crosses a worktree. Measured on trailhead (arm64, fresh worktree): 49.6s without the launcher against 34.2s with it.',
    `${ccacheInstallCommand(platform)}, then delete android/app/.cxx and node_modules/**/android/.cxx once so CMake reconfigures with the launcher. The shell that runs Stim must have the install location on PATH${platform === 'darwin' ? ' -- agent shells often lack /opt/homebrew/bin' : ''}.`,
  );
}

// CMake docs, CMAKE_<LANG>_COMPILER_LAUNCHER: the value is a ;-separated
// command line whose first word is resolved through PATH unless it is
// absolute, so only an absolute one is a path this machine must hold.
function launcherPath(launcher: string | null): string | null {
  const command = launcher?.split(';')[0]?.trim();
  return command && isAbsolute(command) ? command : null;
}

export function checkCxxCompilerLauncher({
  states,
  ccacheOnPath,
  launcherExists = existsSync,
}: {
  states: CxxLauncherState[];
  ccacheOnPath: boolean;
  launcherExists?: (path: string) => boolean;
}): Finding | null {
  const missing = states
    .map((state) => ({ path: state.path, command: launcherPath(state.launcher) }))
    .filter(
      (state): state is { path: string; command: string } => state.command !== null && !launcherExists(state.command),
    );
  if (missing.length > 0) {
    const named = [...new Set(missing.map((state) => state.command))].join(', ');
    return finding(
      'cost',
      'A configured CMake cache names a compiler launcher that is not on this machine',
      `${plural(missing.length, 'CMakeCache.txt file')} under this project name ${named}, and CMake runs that path for every C++ compile. Until the cache is reconfigured the build fails there rather than falling back: ${missing[0]?.path}.`,
      'With ccache installed, run `stim doctor --fix --platform android` in this checkout to clear affected generated .cxx configurations. Custom launchers require project-specific repair. Stop native builds before repairing.',
    );
  }
  if (!ccacheOnPath) return null;
  const stale = states.filter((state) => state.launcher === null);
  if (stale.length === 0) return null;
  return finding(
    'cost',
    'The configured CMake cache predates the ccache launcher, so C++ compiles still bypass it',
    `CMake seeds CMAKE_CXX_COMPILER_LAUNCHER from the environment on a fresh configure only. ${plural(stale.length, 'CMakeCache.txt file')} here names no launcher: ${stale[0]?.path}. These configurations can bypass ccache; cache misses reported by ccache itself still represent compilations that used the launcher.`,
    'Stop native builds, then run `stim doctor --fix --platform android` in this checkout. It clears affected ignored, untracked .cxx configurations; the next `stim android` configures them with ccache. Existing custom launcher settings require project-specific repair.',
  );
}

function ccacheIsOnPath(): boolean {
  try {
    return Boolean(getExecutor().findExecutable('ccache'));
  } catch {
    return false;
  }
}

export function checkBuildCacheProvider(
  appConfig: AnyJson | null,
  sdkMajor: number | null,
  isExpo: boolean = true,
  dynamicConfig: string | null = null,
): Finding | null {
  if (!isExpo) return null;
  if (!appConfig && dynamicConfig) {
    return finding(
      'note',
      `Cannot check the build cache provider in ${dynamicConfig}`,
      'This config is code, so it is not readable without executing it. A provider is optional -- stim ios/android have their own cache -- but if this project DOES set one, confirm by hand that it is on the key this SDK reads.',
      `${
        sdkMajor && sdkMajor <= 53
          ? `SDK ${sdkMajor} reads expo.experiments.buildCacheProvider and ignores the top-level key in silence.`
          : 'Use the top-level expo.buildCacheProvider; the experiments key still works as a fallback.'
      } Run \`npx expo config --json\` and look for buildCacheProvider. If one is already set -- including "eas" -- that satisfies this; Stim never replaces it.`,
    );
  }
  if (!appConfig) return null;
  const expo = (appConfig.expo ?? appConfig) as AnyJson;
  const topLevel = expo.buildCacheProvider;
  const experimental = (expo.experiments as AnyJson | null | undefined)?.buildCacheProvider;

  if (!topLevel && !experimental) return null;

  if (sdkMajor && sdkMajor <= 53 && topLevel && !experimental) {
    return finding(
      'cost',
      'buildCacheProvider is at the top level, but this SDK only reads it from experiments',
      `SDK ${sdkMajor}'s CLI resolves exp.experiments.buildCacheProvider and nothing else. The top-level key is ignored in silence, so the provider is never called and every build is a full build.`,
      'Move it to expo.experiments.buildCacheProvider.',
    );
  }

  if (sdkMajor && sdkMajor >= 54 && experimental && !topLevel) {
    return finding(
      'note',
      'buildCacheProvider is still under experiments',
      `It works -- SDK ${sdkMajor} falls back to the experiments key -- but the setting was promoted out of experiments, and the top-level key is the one that will keep working.`,
      'Move it to expo.buildCacheProvider.',
    );
  }

  return null;
}

export function checkEasAuth({
  provider,
  owner = null,
  auth = null,
}: {
  provider?: string | null;
  owner?: string | null;
  auth?: EasAuthResult | ((opts: { owner: string | null }) => EasAuthResult) | null;
} = {}): Finding | null {
  if (provider !== 'eas') return null;
  const status = typeof auth === 'function' ? auth({ owner }) : auth;
  if (!status || status.ok) return null;

  // Offline, timed out, or an output shape this eas-cli does not produce.
  // Never an accusation: whoami reaches the network whenever a session exists,
  // so "could not check" is a fact about the check, not about the user.
  if (status.unknown) {
    return finding(
      'note',
      'Could not check the EAS session',
      `\`eas whoami\` did not give a definite answer (${status.unknown}), so whether this project's EAS build cache can be reached is unknown. Offline is the ordinary reason, and it is not a problem: the cache simply does not answer until the machine is back on the network.`,
      null,
    );
  }

  if (status.code === 'no-cli') {
    return finding(
      'cost',
      'The build cache provider is "eas", but no eas-cli is installed',
      'The provider shells out to `npx eas-cli` on every lookup and every upload. With no eas-cli resolvable, npx downloads one on the fly (slow, and a version nobody chose) or the call fails -- and the provider swallows that failure and returns null, so every build looks like a cache miss and nothing says why.',
      status.remedy ?? null,
    );
  }

  if (status.code === 'project-cli') {
    return finding(
      'note',
      'Did not check the EAS session: doctor runs only an eas-cli it can place outside the repository',
      `Doctor does not run code from the project tree, and \`eas whoami\` would run ${status.reason}, which is in the repository, in a node_modules/.bin above it, or in a checkout whose repository root git did not report. Builds run that eas-cli, so whether this project's EAS build cache can be reached is unchecked.`,
      status.remedy ?? null,
    );
  }

  if (status.code === 'logged-out') {
    return finding(
      'cost',
      'Not logged in to EAS, so the shared build cache never answers',
      'eas-build-cache-provider catches its own errors and returns null, so an unauthenticated lookup reads as a plain cache miss: every build compiles, nothing is uploaded for anybody else, and no line in any log mentions authentication.',
      status.remedy ?? null,
    );
  }

  if (status.code === 'wrong-account') {
    return finding(
      'note',
      `EAS is authenticated as ${status.account}, but this project's owner is ${status.owner}`,
      `A session on an account that does not cover ${status.owner} cannot read or write that account's builds, so the shared cache silently does nothing here. This is a NOTE and not a hard failure on purpose: \`eas whoami\` only enumerates accounts for some actors (a robot prints a display name that is not an account name at all), the list may be incomplete, and access is the server's decision rather than this list's. Confirm before acting on it.`,
      status.remedy ?? null,
    );
  }

  return null;
}

export function checkConcurrency({
  maxBuilds = 0,
  maxDevices = 0,
  platformMax = { ios: 0, android: 0, macos: 0 },
  liveDevices = 0,
  activeBuilds = 0,
}: {
  maxBuilds?: number;
  maxDevices?: number;
  platformMax?: PlatformDeviceLimits;
  liveDevices?: number | { unknown: string };
  activeBuilds?: number;
} = {}): Finding | null {
  const platformCaps = (
    [
      ['ios', 'maxIosDevices'],
      ['android', 'maxAndroidDevices'],
      ['macos', 'maxMacosApps'],
    ] as const
  ).filter(([platform]) => platformMax[platform] > 0);
  if (!maxBuilds && !maxDevices && !platformCaps.length) return null;
  const caps = [
    `maxBuilds ${maxBuilds || 'unlimited'}, maxDevices ${maxDevices || 'unlimited'}`,
    ...platformCaps.map(([platform, setting]) => `${setting} ${platformMax[platform]}`),
  ].join(', ');
  const devices =
    typeof liveDevices === 'number'
      ? `${liveDevices} Stim device(s) are booted`
      : `the number of booted Stim devices is unknown (${liveDevices.unknown})`;
  return finding(
    'note',
    'Concurrency limits are set',
    `${caps}. Right now ${devices} and ${activeBuilds} build slot(s) are in use on this machine. ` +
      'At the device cap a new `stim ios`/`android` waits in FIFO order for 600s (--wait changes it; --no-wait refuses with STIM_AT_CAPACITY); ' +
      'at the build cap a compile waits for a free slot.' +
      (platformCaps.length
        ? ' A per-platform cap bounds its platform alone, and a boot must also fit maxDevices; maxMacosApps bounds hosted macOS apps only.'
        : ''),
    null,
  );
}

async function easCliOutsideRepository(projectRoot: string, operation?: StimContext): Promise<string | null> {
  const found = (String(getExecutor().findExecutable('eas') ?? '').split('\n')[0] ?? '').trim();
  const root = found
    ? operation
      ? await repoRootAsync(projectRoot, { env: operation.env, signal: operation.signal })
      : repoRoot(projectRoot)
    : null;
  if (!found || !root) return null;
  try {
    const repository = realpathSync(root);
    const directory = realpathSync(dirname(resolve(found)));
    const within = (path: string) => {
      const rel = relative(repository, path);
      return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
    };
    if (within(join(directory, basename(found))) || within(realpathSync(found))) return null;
    for (let dir = realpathSync(projectRoot); ; dir = dirname(dir)) {
      if (directory === join(dir, 'node_modules', '.bin')) return null;
      if (dirname(dir) === dir) return found;
    }
  } catch {
    return null;
  }
}

async function readProjectEasCliVersion(projectRoot: string, operation?: StimContext): Promise<string | null> {
  const packageJson = resolvePackageJson(projectRoot, 'eas-cli');
  if (packageJson) {
    const version = readJsonObject(packageJson)?.version;
    return typeof version === 'string' ? `eas-cli/${version}` : null;
  }
  const onPath = await easCliOutsideRepository(projectRoot, operation);
  return onPath ? readInstalledEasCliVersionAsync(onPath, projectRoot) : null;
}

async function doctorEasAuth({
  projectRoot,
  owner,
  operation,
}: {
  projectRoot: string;
  owner?: string | null;
  operation?: StimContext;
}): Promise<EasAuthResult> {
  const file = await easCliOutsideRepository(projectRoot, operation);
  if (file)
    return probeEasAuth({
      context: operation,
      projectRoot,
      owner,
      resolveBin: () => ({ file, source: 'path' }),
    });
  const unchecked = resolveEasCliBin(projectRoot);
  if (!unchecked) return probeEasAuth({ context: operation, projectRoot, owner, resolveBin: () => null });
  return {
    failed: true,
    code: 'project-cli',
    reason: unchecked.file,
    remedy:
      'Once you trust this checkout, run `npx eas whoami` in it. Or install eas-cli globally (`npm i -g eas-cli`) so doctor can check the session.',
  };
}

export function checkRemoteDevice({
  configured = null,
  daemonInEnv = false,
  agentDeviceOnPath = false,
  easCliResolvable = false,
  readEasCliVersion = () => null,
}: {
  configured?: RemoteDeviceBackend | null;
  daemonInEnv?: boolean;
  agentDeviceOnPath?: boolean;
  easCliResolvable?: boolean;
  readEasCliVersion?: () => string | null;
} = {}): Finding | null {
  if (!configured) return null;

  if (!agentDeviceOnPath) {
    return finding(
      'cost',
      'A remote device is configured, but agent-device is missing',
      `agent-device drives the selected remote backend. Without it, \`stim ios --remote ${configured}\` and \`stim android --remote ${configured}\` refuse before device work.`,
      'npm i -g agent-device',
    );
  }

  if (configured === 'proxy') {
    if (daemonInEnv) {
      return finding(
        'note',
        'This project uses a remote proxy',
        'The proxy backend connects through AGENT_DEVICE_DAEMON_BASE_URL and AGENT_DEVICE_DAEMON_AUTH_TOKEN. Stim does not create or stop the remote device.',
        null,
      );
    }
    return finding(
      'cost',
      'The remote proxy credentials are missing',
      'The proxy backend requires AGENT_DEVICE_DAEMON_BASE_URL and AGENT_DEVICE_DAEMON_AUTH_TOKEN.',
      'Export AGENT_DEVICE_DAEMON_BASE_URL and AGENT_DEVICE_DAEMON_AUTH_TOKEN.',
    );
  }

  if (!easCliResolvable) {
    return finding(
      'cost',
      'A remote device is configured, but there is no eas-cli to create a session with',
      'The eas backend creates an EAS Simulator session. It needs eas-cli and an account with EAS Simulator access. Neither a project copy nor one on PATH was found.',
      'Install eas-cli.',
    );
  }

  const easCli = easCliSupport(readEasCliVersion(), MIN_EAS_CLI_SIMULATOR_VERSION);
  if (!easCli.supported) {
    return finding(
      'cost',
      easCli.version
        ? `A remote device is configured, but eas-cli ${easCli.version} has no EAS Simulator commands`
        : 'A remote device is configured, but the eas-cli version could not be read',
      `The eas backend runs \`eas simulator:*\` commands, which need eas-cli ${MIN_EAS_CLI_SIMULATOR_VERSION} or later. \`stim ios --remote eas\` and \`stim android --remote eas\` refuse with STIM_REMOTE_EAS_UNAVAILABLE before device work.`,
      `${easCliUpgradeRemedy(MIN_EAS_CLI_SIMULATOR_VERSION)}.`,
    );
  }

  return finding(
    'note',
    'This project uses a remote device',
    '`ios --remote eas` / `android --remote eas` create an EAS Simulator session named stim-<label> and end it on `stop` and `worktree remove`. The build still runs on this machine; only the device is elsewhere. Native device logs are not captured on a remote device -- the Metro half of the timeline is unaffected.',
    null,
  );
}

function checkEasBuildDownload({
  easJson = false,
  remoteEas = false,
  easCliResolvable = false,
  readEasCliVersion = () => null,
}: {
  easJson?: boolean;
  remoteEas?: boolean;
  easCliResolvable?: boolean;
  readEasCliVersion?: () => string | null;
} = {}): Finding | null {
  if (!easJson || remoteEas || !easCliResolvable) return null;
  const easCli = easCliSupport(readEasCliVersion(), MIN_EAS_CLI_BUILD_DOWNLOAD_VERSION);
  if (easCli.supported) return null;
  return finding(
    'cost',
    easCli.version
      ? `eas-cli ${easCli.version} cannot download EAS builds for --eas-profile`
      : 'The eas-cli version could not be read for --eas-profile',
    `\`stim ios --eas-profile\` and \`stim android --eas-profile\` download a finished EAS development build with \`eas build:download --build-id\`, which needs eas-cli ${MIN_EAS_CLI_BUILD_DOWNLOAD_VERSION} or later. Older versions refuse with STIM_EAS_UNAVAILABLE before any download.`,
    `${easCliUpgradeRemedy(MIN_EAS_CLI_BUILD_DOWNLOAD_VERSION)}.`,
  );
}

async function projectEasBuildDownloadFinding(
  projectRoot: string,
  remoteBackends: readonly RemoteDeviceBackend[],
  lookupEasCli: (() => boolean) | null,
  operation?: StimContext,
): Promise<Finding | null> {
  const easJson = existsSync(join(projectRoot, 'eas.json'));
  const remoteEas = remoteBackends.includes('eas');
  const easCliResolvable = easJson && (lookupEasCli ? lookupEasCli() : Boolean(resolveEasCliBin(projectRoot)));
  const version =
    easJson && !remoteEas && easCliResolvable ? await readProjectEasCliVersion(projectRoot, operation) : null;
  return checkEasBuildDownload({
    easJson,
    remoteEas,
    easCliResolvable,
    readEasCliVersion: () => version,
  });
}

export function checkSimSlim({ profileError = null }: { profileError?: string | null } = {}): Finding | null {
  if (!profileError) return null;
  return finding(
    'cost',
    'The SimSlim profile is invalid',
    profileError,
    'Set ios.simslimProfile to a readable JSON profile inside the repository.',
  );
}

function checkIosHost(platform: DoctorPlatform | undefined, host: NodeJS.Platform): Finding | null {
  if (platform !== 'ios' || host === 'darwin') return null;
  return finding(
    'note',
    `iOS runs on a remote Mac or through EAS on this ${host} host`,
    'Xcode, CocoaPods and simctl exist only on macOS, so `stim ios` cannot build or boot a simulator here. ' +
      '`stim ios --remote <mac> --remote-build <mac>` builds the app on a Mac approved for builds and hosted simulators, ' +
      "with that Mac's Xcode and CocoaPods, and runs it on a simulator there; Metro stays on this machine. " +
      '`stim ios --remote eas --eas-profile <simulator profile>` downloads a finished EAS development build and runs it ' +
      'on an EAS Simulator session driven through agent-device.',
    'Add a Mac with `stim doctor --fix` and run `stim ios --remote <mac> --remote-build <mac>`, or install eas-cli and ' +
      'agent-device and run `stim start --remote` and `stim ios --remote eas --eas-profile <profile>`. ' +
      'Read `stim guide settings` for remote machines and `stim guide metro` for the remote device backends.',
  );
}

function checkXcodeEnvLineEndings(
  projectRoot: string,
  platform: DoctorPlatform | undefined,
  host: NodeJS.Platform,
): Finding | null {
  if (platform === 'android' || host !== 'win32') return null;
  const xcodeEnv = join(projectRoot, 'ios', '.xcode.env');
  if (!existsSync(xcodeEnv)) return null;
  let content: string;
  try {
    content = readFileSync(xcodeEnv, 'utf-8');
  } catch {
    return null;
  }
  if (!content.includes('\r')) return null;
  return finding(
    'cost',
    'ios/.xcode.env has CRLF line endings',
    'An EAS build uploads the working-tree bytes of ios/.xcode.env, and Xcode sources that file with sh on the ' +
      'build worker, where each carriage return becomes part of the line and the build fails with ' +
      '`: command not found`. On Windows the usual cause is core.autocrlf=true rewriting the file at checkout.',
    'Run `git config core.autocrlf input` then `git checkout -- ios/.xcode.env`, or add ' +
      '`ios/.xcode.env text eol=lf` to .gitattributes and check the file out again.',
  );
}

function configuredRemoteBackends(
  projectSettings: Parameters<typeof remoteIosSetting>[0],
  platform: string | undefined,
): RemoteDeviceBackend[] {
  const iosTarget = remoteIosSetting(projectSettings);
  const androidTarget = remoteAndroidSetting(projectSettings);
  return [
    ...new Set([
      ...(platform !== 'android' ? [iosTarget?.kind === 'backend' ? iosTarget.backend : null] : []),
      ...(platform !== 'ios' ? [androidTarget?.kind === 'backend' ? androidTarget.backend : null] : []),
    ]),
  ].filter((backend): backend is RemoteDeviceBackend => backend !== null);
}

export interface DoctorInspectionOptions {
  readFile?: typeof readFileSync;
  xcodeMajor?: number | null;
  easAuth?: (opts: {
    projectRoot: string;
    owner?: string | null;
    operation?: StimContext;
  }) => EasAuthResult | Promise<EasAuthResult>;
  concurrency?: (() => ConcurrencyLimits) | ConcurrencyLimits;
  liveDevices?: (() => number) | null;
  activeBuilds?: (() => number) | null;
  remoteEnv?: NodeJS.ProcessEnv;
  operation?: StimContext;
  lookupAgentDevice?: (() => boolean) | null;
  lookupEasCli?: (() => boolean) | null;
  lookupSigningIdentities?: () => Promise<readonly SigningIdentity[] | null>;
  memoryPressure?: () => HostMemoryPressure | null | Promise<HostMemoryPressure | null>;
  lookupCcache?: (() => boolean) | null;
  lookupChrome?: () => string | null;
  tailnetStatus?: () => unknown;
  now?: () => number;
  platform?: DoctorPlatform;
  host?: NodeJS.Platform;
  platforms?: readonly DoctorPlatform[];
  machineSettings?: MachineSettings;
  repoRoot?: string | null;
}

export interface DoctorContext {
  root: string;
  options: DoctorInspectionOptions;
  settings: SettingsObject;
  optimizations: Optimizations | null;
  platforms: readonly DoctorPlatform[];
  repoRoot: string | null;
}

export async function runDoctor(
  projectRoot: string,
  options: DoctorInspectionOptions = {},
  inspectors: readonly ((context: DoctorContext) => Finding[] | Promise<Finding[]>)[] = [],
): Promise<{ findings: Finding[]; context: DoctorContext }> {
  const {
    concurrency = getConcurrencyLimits,
    liveDevices = null,
    activeBuilds = null,
    lookupSigningIdentities = () => probeSigningIdentities({ env: options.operation?.env ?? process.env }),
    memoryPressure = readHostMemoryPressureAsync,
    lookupChrome,
    platform,
    host = process.platform,
    platforms = ['ios', 'android'],
    machineSettings = readMachineSettings(projectSettingsContext(projectRoot)),
  } = options;
  const localIos = platforms.includes('ios') && platform !== 'android' && host === 'darwin';

  const projectSettings = machineSettings.settings;
  const context: DoctorContext = {
    root: projectRoot,
    options,
    settings: projectSettings,
    optimizations: null,
    platforms,
    repoRoot: options.repoRoot ?? null,
  };
  if (machineSettings.corrupt) return { findings: [machineSettings.corrupt], context };

  let concurrencyFinding: Finding | null = null;
  try {
    const limits = typeof concurrency === 'function' ? concurrency() : concurrency;
    const platformMax = getPlatformDeviceLimits();
    if (
      (limits && (limits.maxBuilds || limits.maxDevices)) ||
      platformMax.ios ||
      platformMax.android ||
      platformMax.macos
    ) {
      concurrencyFinding = checkConcurrency({
        maxBuilds: limits?.maxBuilds,
        maxDevices: limits?.maxDevices,
        platformMax,
        liveDevices: liveDevices
          ? liveDevices()
          : options.operation
            ? await countLiveOwnedDevicesAsync(options.operation)
            : countLiveOwnedDevices(),
        activeBuilds: activeBuilds ? activeBuilds() : countActiveBuilds(),
      });
    }
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'STIM_BAD_ARG') throw error;
    concurrencyFinding = finding(
      'cost',
      'A concurrency limit is invalid',
      error.message,
      'Fix the value with `stim settings set <key> <value>`, or unset the environment variable.',
    );
  }

  const settingShapeFindings = settingShapeErrors(projectSettings).map((error) =>
    finding('cost', 'A setting has the wrong type', error, SETTING_SHAPE_REMEDY),
  );
  let optimizations: Optimizations | null = null;
  try {
    optimizations = resolveAndroidCompilerCache({
      optimizations: resolveOptimizations(projectSettings, options.operation?.env ?? options.remoteEnv ?? process.env),
      env: options.operation?.env ?? options.remoteEnv ?? process.env,
      use: readAndroidCasToolchain,
    }).optimizations;
  } catch {}
  context.optimizations = optimizations;
  for (const poolPlatform of ['ios', 'android'] as const) {
    if (!platforms.includes(poolPlatform) || (platform && platform !== poolPlatform)) continue;
    const poolSettingError = parkedMaxSetting(poolPlatform).error;
    if (poolSettingError) {
      settingShapeFindings.push(
        finding(
          'cost',
          `The ${poolPlatform === 'ios' ? 'simulator' : 'emulator'} pool bound is not a number`,
          poolSettingError,
          POOL_SETTING_REMEDY,
        ),
      );
    }
  }
  let simslimProfileError: string | null = null;
  let simslimProfileSet = false;
  if (localIos) {
    try {
      const path = iosSimSlimProfileSetting(projectSettings, projectRoot);
      simslimProfileSet = path !== null;
      if (path) parseSlimProfile(readFileSync(path, 'utf8'), path);
    } catch (error) {
      simslimProfileError = String((error as Error)?.message || error);
    }
  }
  const simslimFinding =
    !localIos || (!simslimProfileSet && !simslimProfileError && remoteIosSetting(projectSettings))
      ? null
      : checkSimSlim({ profileError: simslimProfileError });
  const memoryAdvice =
    localIos && !remoteIosSetting(projectSettings) ? hostMemoryPressureAdvice(await memoryPressure()) : null;

  const shared = [
    ...checkStorageLayout(projectRoot, { platform, host, scope: 'shared' }),
    checkChrome({
      usesWeb: () => !platform && webSettings(projectSettings).url !== null,
      chrome: lookupChrome,
    }),
    concurrencyFinding,
    memoryAdvice
      ? finding(
          'cost',
          'Host memory pressure can stall the iOS simulator',
          memoryAdvice,
          'Free host memory, then retry. Owned iOS simulators already run slim; `stim guide lifecycle simslim` lists what it turns off.',
        )
      : null,
    simslimFinding,
    localIos && deviceWorkflowPlausible(readWorkspaceState(projectRoot), projectSettings)
      ? checkDeviceSigning(await lookupSigningIdentities())
      : null,
    ...settingShapeFindings,
    ...checkMachineSettings({
      settings: projectSettings,
      layers: machineSettings.layers,
      repositoryLayer: machineSettings.repositoryLayer,
      projectRoot,
      optimizations,
      env: options.operation?.env ?? options.remoteEnv ?? process.env,
      remoteBuild: loadConfig()?.remote?.build,
      machineConfig: loadConfig(),
      reportedElsewhere: simslimProfileError ? ['ios.simslimProfile'] : [],
    }),
  ].filter((f): f is Finding => Boolean(f));
  const inspected = await Promise.all(inspectors.map((inspect) => inspect(context)));
  return { findings: [...shared, ...inspected.flat()], context };
}

export async function reactNativeDoctorFindings({
  root: projectRoot,
  settings: projectSettings,
  optimizations,
  options,
  repoRoot: repositoryRoot,
}: DoctorContext): Promise<Finding[]> {
  const androidLayout = resolveAndroidLayout(projectSettings, projectRoot, repositoryRoot ?? projectRoot);
  const {
    readFile = readFileSync,
    xcodeMajor = null,
    easAuth = doctorEasAuth,
    remoteEnv = options.operation?.env ?? process.env,
    lookupAgentDevice = null,
    lookupEasCli = null,
    lookupCcache = null,
    tailnetStatus = tailscaleStatus,
    now = Date.now,
    platform,
    host = process.platform,
  } = options;
  const localIos = platform !== 'android' && host === 'darwin';
  const read = (rel: string): string | null => {
    const p = join(projectRoot, rel);
    if (!existsSync(p)) return null;
    try {
      return readFile(p, 'utf-8') as string;
    } catch {
      return null;
    }
  };

  const pkg = readJsonObject(join(projectRoot, 'package.json'));
  const appConfig = readJsonObject(join(projectRoot, 'app.json'));
  const dynamicConfig = appConfig
    ? null
    : ['app.config.ts', 'app.config.js', 'app.config.mjs'].find((f) => existsSync(join(projectRoot, f))) || null;
  const iosProject = resolveIosProjectDir(projectSettings, projectRoot);
  const podfileProperties = readJsonObject(join(iosProject.dir, 'Podfile.properties.json'));
  const podfile = read(relative(projectRoot, join(iosProject.dir, 'Podfile')));
  const metroConfig = read('metro.config.js') ?? read('metro.config.cjs');

  const isExpo = detectIsExpo(projectRoot);
  const expoRange = (pkg?.dependencies as AnyJson | undefined)?.expo || '';
  const sdkMajor =
    parseInt(
      String(expoRange)
        .replace(/[^\d.]/g, '')
        .split('.')[0] ?? '',
      10,
    ) || null;

  const provider = appConfig ? providerFromConfig(appConfig) : null;
  const owner = appConfig ? ownerFromConfig(appConfig) : null;

  const remoteBuildCache = optimizations?.buildCache && optimizations.remoteBuildCache;
  const easFinding =
    remoteBuildCache && provider === 'eas'
      ? checkEasAuth({ provider, owner, auth: await easAuth({ projectRoot, owner, operation: options.operation }) })
      : null;
  const remoteBackends = configuredRemoteBackends(projectSettings, platform);
  const daemonInEnv = Boolean(
    remoteEnv.AGENT_DEVICE_DAEMON_BASE_URL?.trim() && remoteEnv.AGENT_DEVICE_DAEMON_AUTH_TOKEN?.trim(),
  );
  const agentDeviceOnPath = remoteBackends.length
    ? lookupAgentDevice
      ? lookupAgentDevice()
      : agentDeviceIsOnPath()
    : false;
  const easCliResolvable = remoteBackends.includes('eas')
    ? lookupEasCli
      ? lookupEasCli()
      : Boolean(resolveEasCliBin(projectRoot))
    : false;
  const remoteVersion =
    agentDeviceOnPath && easCliResolvable && remoteBackends.includes('eas')
      ? await readProjectEasCliVersion(projectRoot, options.operation)
      : null;
  const remoteFindings = remoteBackends
    .map((backend) =>
      checkRemoteDevice({
        configured: backend,
        daemonInEnv,
        agentDeviceOnPath,
        easCliResolvable,
        readEasCliVersion: () => remoteVersion,
      }),
    )
    .filter((remoteFinding): remoteFinding is Finding => remoteFinding !== null);
  const easBuildDownloadFinding = await projectEasBuildDownloadFinding(
    projectRoot,
    remoteBackends,
    lookupEasCli,
    options.operation,
  );

  const appProjectFinding = checkAppProject(projectRoot);
  return [
    appProjectFinding,
    checkIosHost(platform, host),
    checkXcodeEnvLineEndings(projectRoot, platform, host),
    ...checkStorageLayout(projectRoot, {
      platform,
      host,
      scope: 'native',
      iosProjectPath: iosProject.relative,
      androidLayout,
    }),
    optimizations?.metroSharedCache ? checkMetroCache(metroConfig) : null,
    checkRepackServer(projectRoot, metroCommandSetting(projectSettings)),
    localIos && optimizations?.ios.compilationCache ? checkCompilationCache(podfile, xcodeMajor) : null,
    localIos && optimizations?.ios.compilationCache ? checkCcacheConflict(podfile, podfileProperties) : null,
    ...(platform === 'ios' || optimizations?.android.compilerCache !== 'ccache'
      ? []
      : await androidCcacheFindings(projectRoot, platform, lookupCcache, androidLayout)),
    checkAndroidPathRoom(projectRoot, platform, host),
    checkAndroidSdk(projectRoot, platform, androidLayout),
    checkAndroidSystemImage(androidImageDecision(platform, androidLayout, projectSettings, remoteEnv), remoteEnv),
    checkChrome({
      usesWeb: () =>
        !platform &&
        webSettings(projectSettings).url === null &&
        ((Array.isArray(((appConfig?.expo ?? appConfig) as AnyJson | null)?.platforms) &&
          (((appConfig?.expo ?? appConfig) as AnyJson).platforms as unknown[]).includes('web')) ||
          isPackageResolvable(projectRoot, 'react-native-web')),
      chrome: options.lookupChrome,
    }),
    remoteBuildCache ? checkBuildCacheProvider(appConfig, sdkMajor, isExpo, dynamicConfig) : null,
    easFinding,
    easBuildDownloadFinding,
    await readOffloadCandidate(tailnetStatus, now(), host),
    ...remoteFindings,
    appProjectFinding ? null : checkReadinessMarkers(projectRoot),
    ...dependencyEditsFindings([...new Set([projectRoot, repositoryRoot ?? projectRoot])]),
  ].filter((value): value is Finding => Boolean(value));
}

function checkAndroidPathRoom(
  projectRoot: string,
  platform: DoctorPlatform | undefined,
  host: NodeJS.Platform,
  hostArch: string = process.arch,
): Finding | null {
  // Android Emulator system images can target an ABI other than the host default; doctor checks the default.
  const room =
    platform === 'ios' ? null : androidPathRoom(projectRoot, { abi: hostSystemImageArch(hostArch), platform: host });
  if (!room) return null;
  return {
    code: 'android-path-room',
    ...finding(
      'cost',
      'The project path leaves no room for Android native object paths',
      `${androidPathRoomMessage(room)} \`stim android\` refuses to run an emulator here with STIM_PATH_TOO_LONG, before it prepares the device, because Gradle would fail deep inside ninja instead.`,
      androidPathRoomRemedy(room),
    ),
  };
}

function hasAndroidProject(layout: AndroidLayout): boolean {
  return existsSync(layout.custom ? layout.moduleDir : layout.gradleRoot);
}

function checkAndroidSdk(
  projectRoot: string,
  platform: DoctorPlatform | undefined,
  layout: AndroidLayout = defaultAndroidLayout(projectRoot),
): Finding | null {
  const androidDir = layout.gradleRoot;
  if (platform === 'ios' || (platform !== 'android' && !existsSync(androidDir))) return null;
  const sdkPath = androidHome();
  const refusal = androidSdkRefusal({
    sdkPath,
    sdkExists: existsSync(sdkPath),
    hasLocalProperties: existsSync(join(androidDir, 'local.properties')),
    localPropertiesPath: `${relative(projectRoot, androidDir) || '.'}/local.properties`,
  });
  if (!refusal) return null;
  return {
    code: 'android-sdk-missing',
    ...finding(
      'cost',
      'No Android SDK was found',
      `${refusal.reason} \`stim android\` refuses with ${refusal.code} before Gradle runs.`,
      refusal.remedy,
    ),
  };
}

/** The system image decision for this project's owned emulator, or null when doctor does not check Android here. */
export function androidImageDecision(
  platform: DoctorPlatform | undefined,
  layout: AndroidLayout,
  settings: SettingsObject | null,
  env: NodeJS.ProcessEnv,
): SystemImageDecision | null {
  if (platform === 'ios' || (platform !== 'android' && !hasAndroidProject(layout))) return null;
  if (!existsSync(androidHome(env))) return null;
  const remote = settings ? remoteAndroidSetting(settings) : null;
  if (remote && (remote.kind === 'backend' || remote.machine !== 'auto')) return null;
  const requested = settingValueAt(settings, 'android.systemImage');
  return decideSystemImage({
    requested: typeof requested === 'string' && requested.trim() ? requested.trim() : null,
    installed: listInstalledSystemImages(undefined, env),
    policy: androidImageInstallPolicy(settings),
    env,
  });
}

function checkAndroidSystemImage(decision: SystemImageDecision | null, env: NodeJS.ProcessEnv): Finding | null {
  if (!decision || decision.kind === 'installed') return null;
  const title = 'No Android system image for an owned emulator is installed';
  if (decision.kind === 'refuse')
    return { code: 'android-system-image', ...finding('note', title, decision.message, decision.remedy) };
  const problem = systemImageInstallProblem(decision.pkg, env);
  return {
    code: 'android-system-image',
    ...finding(
      'note',
      title,
      `\`stim android\` installs ${decision.pkg} with sdkmanager on its first emulator run (about 2 GB).${problem ? ` It cannot now: ${problem.message}` : ''}`,
      problem ? problem.remedy : 'Run `stim doctor --fix --platform android` to install it now.',
    ),
  };
}

async function androidCcacheFindings(
  projectRoot: string,
  platform: DoctorPlatform | undefined,
  lookupCcache: (() => boolean) | null,
  layout: AndroidLayout,
): Promise<(Finding | null)[]> {
  if (platform !== 'android' && !hasAndroidProject(layout)) return [];
  const onPath = lookupCcache ? lookupCcache() : ccacheIsOnPath();
  let cxx: Finding | null;
  try {
    cxx = checkCxxCompilerLauncher({ states: await readCxxLauncherStates(projectRoot, layout), ccacheOnPath: onPath });
  } catch (error) {
    getExecutor().reportSignal?.()?.throwIfAborted();
    cxx = finding(
      'cost',
      'CMake launcher state could not be inspected',
      String(error),
      'Restore read access and rerun doctor.',
    );
  }
  if (cxx) cxx.code = 'android-cmake-launcher';
  return [checkCcacheInstalled(onPath), cxx];
}

function checkAppProject(projectRoot: string): Finding | null {
  const problem = appProjectProblem(projectRoot);
  if (!problem) return null;
  const result = finding(
    'cost',
    problem.kind === 'unreadable'
      ? 'This package.json does not parse'
      : 'This directory is not a React Native or Expo app',
    `${problem.message} \`stim start\`, \`stim ios\` and \`stim android\` refuse here with STIM_NO_PROJECT, so nothing below was measured against an app.`,
    problem.remedy,
  );
  if (problem.kind === 'not-an-app') result.code = 'not-an-app';
  return result;
}

const READINESS_MARKER = '[stim:readiness]';
const READINESS_SCAN_LIMIT = 5000;
const READINESS_SKIPPED_DIRS = new Set([
  'node_modules',
  'ios',
  'android',
  'macos',
  'windows',
  'Pods',
  'build',
  'dist',
  'web-build',
  'coverage',
]);
const JS_SOURCE = /\.[cm]?[jt]sx?$/;

function hasReadinessMarker(projectRoot: string): boolean | null {
  const dirs = [projectRoot];
  let scanned = 0;
  for (let dir = dirs.pop(); dir !== undefined; dir = dirs.pop()) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!READINESS_SKIPPED_DIRS.has(entry.name)) dirs.push(path);
        continue;
      }
      if (!entry.isFile() || !JS_SOURCE.test(entry.name)) continue;
      if (++scanned > READINESS_SCAN_LIMIT) return null;
      try {
        if (readFileSync(path, 'utf-8').includes(READINESS_MARKER)) return true;
      } catch {}
    }
  }
  return false;
}

function checkReadinessMarkers(projectRoot: string): Finding | null {
  if (hasReadinessMarker(projectRoot) !== false) return null;
  return {
    code: 'readiness-markers-missing',
    ...finding(
      'note',
      'The app does not report readiness to Stim',
      `No \`${READINESS_MARKER}\` marker appears in this app's JavaScript or TypeScript sources outside node_modules. A debug \`stim ios\` or \`stim android\` launch then ends shortly after the app's JavaScript starts running, before the app is usable, and a later startup error shows only in \`stim logs --errors\`.`,
      "In debug builds, log `[stim:readiness] pending` from the first module the app's entry loads, before the root component, and `[stim:readiness] ready` once the app is usable. `stim guide lifecycle readiness` has the code.",
    ),
  };
}

function agentDeviceIsOnPath(): boolean {
  try {
    return Boolean(getExecutor().findExecutable('agent-device'));
  } catch {
    return true;
  }
}

function countActiveBuilds(): number {
  try {
    return listBuildSlots().filter((s) => s.alive).length;
  } catch {
    return 0;
  }
}

export function checkFingerprintParity({
  projectHash,
  worktreeHash,
  changed = [],
  dirtyFiles = [],
}: {
  projectHash?: string | null;
  worktreeHash?: string | null;
  changed?: string[];
  dirtyFiles?: string[];
} = {}): Finding | null {
  if (!projectHash || !worktreeHash || projectHash === worktreeHash) return null;
  const names = changed.slice(0, 3).join(', ');
  const differing = changed.length
    ? ` The differing source${changed.length === 1 ? '' : 's'}: ${names}${changed.length > 3 ? ` (and ${changed.length - 3} more)` : ''}.`
    : '';
  const cause = dirtyFiles.length
    ? `The likely cause is uncommitted changes to tracked fingerprint inputs -- git reports ${dirtyFiles.slice(0, 3).join(', ')}${dirtyFiles.length > 3 ? ` (and ${dirtyFiles.length - 3} more)` : ''} dirty in this checkout.`
    : 'The likely cause is uncommitted changes to tracked fingerprint inputs (this check compared against a clean worktree of HEAD).';
  return finding(
    'note',
    'This checkout does not fingerprint like a fresh worktree of HEAD',
    `A clean detached worktree of HEAD computes a different Stim fingerprint hash than this checkout, so worktrees will MISS the cache entries this checkout fills (and vice versa) until the two agree.${differing} ${cause} (To measure this, doctor ran a real fingerprint twice and briefly created a temporary git worktree -- .git/worktrees metadata was touched and cleaned up.)`,
    'Commit the dirty fingerprint inputs, or list the build-irrelevant ones in .fingerprintignore (same syntax as .gitignore, at the project root). Stim already ignores android/local.properties, android/.idea, *.xcodeproj/xcuserdata, .git and its contents, and .expo. It also ignores ios/main.jsbundle and ios/assets while a .gitignore pattern matches them. Only the ones that genuinely cannot change the native build belong there -- generated reports, local env files, a lockfile that embeds absolute machine paths (the fingerprint already counts the ios/Podfile.lock checksum of a podspec that names the checkout path without that path). Never ignore a real native input (a Podfile, a gradle file, the app config) to force a hit: that trades a slow build for a wrong one.',
  );
}

async function appPathInRepository(projectRoot: string): Promise<string> {
  const top = await repoRootAsync(projectRoot);
  if (!top) return '';
  const path = relative(realpathSync.native(top), realpathSync.native(projectRoot));
  return path.startsWith('..') ? '' : path;
}

const FINGERPRINT_MIN_REPORT_MS = 30_000;

export function fingerprintReportGate(operation: StimContext | undefined): string | null {
  const remaining = reportTimeRemainingMs(operation);
  if (remaining === undefined) return null;
  if (remaining < FINGERPRINT_MIN_REPORT_MS) return 'The report had too little time left to start a fingerprint child.';
  if (sizeScanDeferred()) return 'The host load is too high to start a fingerprint child inside a report.';
  return null;
}

export async function detectFingerprintParity(
  projectRoot: string,
  {
    dirtyFiles = dirtyFingerprintFiles,
    platform: selectedPlatform,
    iosProjectPath = DEFAULT_IOS_PROJECT_PATH,
    androidLayout,
    fingerprintInputs,
    operation,
  }: {
    dirtyFiles?: (root: string) => string[] | Promise<string[]>;
    platform?: DoctorPlatform;
    iosProjectPath?: string;
    androidLayout?: AndroidLayout;
    fingerprintInputs?: string[];
    operation?: StimContext;
  } = {},
): Promise<Finding | null> {
  if ((await gitQuietAsync(projectRoot, ['rev-parse', '--git-dir'])) == null) return null;
  const skipped = fingerprintReportGate(operation);
  if (skipped)
    return finding(
      'note',
      'Fingerprint parity was not checked',
      skipped,
      'Run stim doctor in a terminal to get the check.',
    );
  const platform = selectedPlatform ?? (existsSync(join(projectRoot, iosProjectPath)) ? 'ios' : 'android');
  const context = operation ?? processContext(projectRoot);
  let base: string;
  try {
    base = makeTemporaryDirectory(projectRoot, 'stim-parity-');
  } catch {
    return null;
  }
  const worktree = join(base, 'head');
  let released: () => void;
  let rejected!: (error: unknown) => void;
  const cleanup = new Promise<void>((done, reject) => {
    released = done;
    rejected = reject;
  });
  const release = () => released();
  let added = false;
  let retain = false;
  trackReportResource(operation, cleanup, () => cleanup);

  try {
    added =
      (await gitQuietAsync(
        projectRoot,
        ['-c', `core.hooksPath=${join(base, 'hooks')}`, 'worktree', 'add', '--detach', worktree, 'HEAD'],
        { write: true, timeoutMs: 60000 },
      )) !== null;
    if (!added) return null;
    const headApp = join(worktree, await appPathInRepository(projectRoot));
    const sourceTop = await repoRootAsync(projectRoot);
    if (sourceTop) {
      const top = realpathSync.native(sourceTop);
      for (let dir = realpathSync.native(projectRoot); ; dir = dirname(dir)) {
        const modules = join(dir, 'node_modules');
        const destination = join(worktree, relative(top, modules));
        if (existsSync(modules) && !lstatSync(destination, { throwIfNoEntry: false })) {
          mkdirSync(dirname(destination), { recursive: true });
          symlinkSync(modules, destination, 'junction');
        }
        if (dir === top || dirname(dir) === dir) break;
      }
    }
    const inspect = (root: string) =>
      readFingerprint(context, {
        root,
        platform,
        iosProjectPath,
        fingerprintInputs,
        embedMode: 'development',
        ...(androidLayout
          ? {
              androidLayout: {
                ...androidLayout,
                gradleRoot: resolve(root, relative(projectRoot, androidLayout.gradleRoot)),
                moduleDir: resolve(root, relative(projectRoot, androidLayout.moduleDir)),
              },
            }
          : {}),
      });
    const project = await inspect(projectRoot);
    const clean = await inspect(headApp);
    if (!project || isUncertain(project) || !clean || isUncertain(clean))
      return finding(
        'note',
        'Fingerprint parity could not be checked',
        'The checkout or clean worktree could not produce a fingerprint, so their cache keys were not compared.',
        'Check the fingerprint diagnostic and installed project dependencies, then retry.',
      );
    if (!project.portable || !clean.portable)
      return finding(
        'note',
        'Fingerprint parity could not be checked',
        'An input cannot be mapped safely between the checkout and clean worktree.',
        'Check linked packages and inputs outside the project before relying on cache sharing.',
      );
    if (project.hash === clean.hash) return null;
    const changed = diffInputs(clean.inputs, project.inputs).map((change) => change.name);
    return checkFingerprintParity({
      projectHash: project.hash,
      worktreeHash: clean.hash,
      changed,
      dirtyFiles: await dirtyFiles(projectRoot),
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'reportCleanup' in error) {
      retain = true;
      const previous = 'remedy' in error && typeof error.remedy === 'string' ? error.remedy : '';
      Object.assign(error, {
        remedy:
          `${previous} After verifying evaluator cleanup, remove the temporary worktree ${worktree} with git worktree remove --force, then remove ${base}.`.trim(),
      });
      if (reportSignal(operation)) rejected(error);
      throw error;
    }
    context.signal.throwIfAborted();
    return finding(
      'note',
      'Fingerprint parity could not be checked',
      'The fingerprint comparison failed.',
      'Check the project dependencies and retry.',
    );
  } finally {
    if (!retain) await finishCleanup();
  }

  async function finishCleanup() {
    try {
      const options = {
        timeoutMs: 30000,
        ...(operation ? { signal: AbortSignal.timeout(30000) } : {}),
      };
      const target = join(realpathSync.native(base), 'head');
      if (added || operation)
        await gitQuietAsync(projectRoot, ['worktree', 'remove', '--force', '--force', worktree], {
          write: true,
          ...options,
        });
      if (operation) {
        const registered = await gitQuietAsync(projectRoot, ['worktree', 'list', '--porcelain', '-z'], options);
        if (
          registered === null ||
          registered
            .split('\0')
            .some((line) => line.startsWith('worktree ') && relative(target, line.slice('worktree '.length)) === '')
        )
          throw new Error('The temporary worktree is still registered or its registration cannot be read.');
      }
      await rm(base, { recursive: true, force: true });
      if (added && !operation) await gitQuietAsync(projectRoot, ['worktree', 'prune'], { write: true });
    } catch (error) {
      if (!operation) throw error;
      const refusal = Object.assign(
        new Error(`Cannot finish cleanup for temporary worktree ${worktree}.`, { cause: error }),
        { code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true },
      );
      if (reportSignal(operation)) rejected(refusal);
      throw refusal;
    } finally {
      release();
    }
  }
}
