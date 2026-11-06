import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { phaseLine } from '../command-output.ts';
import {
  checkMainCheckout,
  detectFingerprintParity,
  detectLinkedLibraryGitMetadata,
  mainCheckoutProjectRoot,
  reactNativeDoctorFindings,
  type DoctorPlatform,
} from '../diagnostics/doctor.ts';
import { inspectIosDebugArchitectures } from '../diagnostics/doctor-ios-architectures.ts';
import { inspectPodsFlavor } from '../diagnostics/doctor-pods-flavor.ts';
import { inspectPrebuildRecords, inspectSourceFacts, prebuildRecordFinding } from '../diagnostics/doctor-source.ts';
import { repairSourceCheckout } from '../diagnostics/doctor-source-repair.ts';
import { repoRootAsync } from '../workspace/worktree.ts';
import { iosConfigurationSetting } from '../commands/ios/support.ts';
import { repairCxxLauncherState } from '../diagnostics/doctor-cxx.ts';
import { bundlerPin } from '../engine/bundler.ts';
import type { BuildTarget } from '../engine/toolchain.ts';
import {
  androidRequirements,
  androidToolchain,
  androidToolchainAsync,
  buildsOnlyOnWorker,
  iosToolchainAsync,
} from '../engine/toolchain.ts';
import { detectIsExpo } from '../workspace/project-files.ts';
import { resolveAndroidLayout, resolveIosProjectDir } from '../workspace/settings.ts';
import type { ProjectDoctor } from './project-doctor.ts';
import type { SettingsObject } from '../workspace/settings.ts';

function podsFlavorFinding(root: string, sourceRoot: string, iosProjectPath: string, settings: SettingsObject | null) {
  return realpathOrSelf(sourceRoot) !== realpathOrSelf(root)
    ? inspectPodsFlavor(
        join(sourceRoot, iosProjectPath),
        join(root, iosProjectPath),
        iosConfigurationSetting(settings) ?? 'Debug',
      )
    : null;
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function reactNativeProjectDoctor(root: string): ProjectDoctor {
  return {
    inspect: reactNativeDoctorFindings,
    async inspectAsync({
      options: { platform, host = process.platform, machineSettings, operation },
      settings,
      repoRoot,
    }) {
      const iosProjectPath = resolveIosProjectDir(settings, root).relative;
      const source = machineSettings?.corrupt
        ? []
        : await checkMainCheckout(root, {
            platform,
            localIos: platform !== 'android' && host === 'darwin',
            iosProjectPath,
            androidLayout: resolveAndroidLayout(settings, root, repoRoot ?? root),
          });
      const checksIos = !machineSettings?.corrupt && platform !== 'android' && host === 'darwin';
      const mainRoot = await mainCheckoutProjectRoot(root);
      const sourceRoot = checksIos ? mainRoot : root;
      const architectures = checksIos ? await inspectIosDebugArchitectures(sourceRoot, iosProjectPath) : [];
      const podsFlavor = checksIos ? podsFlavorFinding(root, sourceRoot, iosProjectPath, settings) : null;
      const prebuildRecords = machineSettings?.corrupt
        ? []
        : (await inspectPrebuildRecords({ root: mainRoot, platform, host })).map(prebuildRecordFinding);
      const parity = await detectFingerprintParity(root, {
        platform,
        iosProjectPath,
        operation,
      });
      const linkedGit = await detectLinkedLibraryGitMetadata(root, { platform, operation });
      return [
        ...source,
        ...prebuildRecords,
        ...architectures,
        podsFlavor,
        parity,
        linkedGit?.code === parity?.code ? null : linkedGit,
      ].filter((finding) => finding !== null);
    },
    offloadTargets({ options: { platform, host = process.platform, operation }, settings, repoRoot }, iosRuntime) {
      const iosDir = resolveIosProjectDir(settings, root).dir;
      const checksIos = platform !== 'android' && (host === 'darwin' || existsSync(iosDir) || detectIsExpo(root));
      const androidDir = resolveAndroidLayout(settings, root, repoRoot ?? root).gradleRoot;
      const checksAndroid =
        platform === 'android' || (platform === undefined && (existsSync(androidDir) || detectIsExpo(root)));
      if (!checksIos && !checksAndroid) return null;
      return async () => {
        const targets: BuildTarget[] = [];
        if (checksIos) {
          const [local, runtime] = await Promise.all([iosToolchainAsync(root, iosDir), iosRuntime()]);
          targets.push({
            platform: 'ios',
            local,
            runtime,
            cocoapodsPinned: bundlerPin(root, iosDir) !== null,
            ...(buildsOnlyOnWorker(local) ? { runsOnWorker: true as const } : {}),
          });
        }
        if (checksAndroid) {
          targets.push({
            platform: 'android',
            local: operation ? await androidToolchainAsync(operation.env) : androidToolchain(),
            requires: androidRequirements(root, androidDir),
          });
        }
        return targets;
      };
    },
    async repairSource({ platform, settings, host, operation, confirm, note }) {
      if (!settings) return 0;
      const sourceRoot = await mainCheckoutProjectRoot(root);
      const iosProjectPath = resolveIosProjectDir(settings, root).relative;
      const repoRoot = realpathOrSelf((await repoRootAsync(sourceRoot)) ?? sourceRoot);
      const facts = await inspectSourceFacts({ root: sourceRoot, repoRoot, platform, host, iosProjectPath });
      const exitCode = await repairSourceCheckout({ facts, repoRoot, settings, operation, confirm, note });
      const flavor =
        platform !== 'android' && host === 'darwin'
          ? podsFlavorFinding(root, sourceRoot, iosProjectPath, settings)
          : null;
      if (flavor)
        note(
          phaseLine(
            'flavor',
            `not repaired: ${flavor.fix} Only a build of the source checkout changes its prebuilt frameworks, and a build needs a simulator, a build slot and several minutes, so doctor leaves it to you.`,
          ),
        );
      return exitCode;
    },
    repair: (platform, settings, repoRoot, operation) =>
      platform === 'ios'
        ? { removed: [], refused: [] }
        : repairCxxLauncherState(root, settings, resolveAndroidLayout(settings, root, repoRoot ?? root), operation),
    successLines: reactNativeDoctorSuccessLines,
  };
}

export function reactNativeDoctorSuccessLines(platform: DoctorPlatform | undefined): string[] {
  const lines = [
    '',
    'Project',
    phaseLine(
      'project',
      'source checkout, dependencies, local upstream, nested worktrees Watchman would crawl, prebuilt React Native frameworks the source checkout built in another configuration',
    ),
  ];

  if (platform !== 'android') {
    lines.push('', 'iOS');
    lines.push(phaseLine('setup', 'CocoaPods, warm state, effective Debug simulator architectures'));
    lines.push(phaseLine('caches', 'Metro, Xcode compilation, ccache, build provider'));
    lines.push(phaseLine('devices', 'remote device, SimSlim profile'));
  }
  if (platform !== 'ios') {
    lines.push('', 'Android');
    lines.push(phaseLine('setup', 'Android SDK, warm state'));
    lines.push(phaseLine('caches', 'Metro, Gradle, ccache, build provider'));
    lines.push(phaseLine('devices', 'remote device'));
  }

  lines.push('', 'Expo and React Native');
  lines.push(phaseLine('services', 'EAS session'));
  lines.push(phaseLine('fingerprint', 'parity when dependencies are absent'));
  lines.push('', 'Handled automatically');
  const suppliedCaches =
    platform === 'ios'
      ? 'Metro transform store, Xcode compilation cache'
      : platform === 'android'
        ? 'Metro transform store, Gradle build cache, ccache'
        : 'Metro transform store, Xcode compilation cache, Gradle build cache, ccache';
  lines.push(phaseLine('caches', suppliedCaches));
  lines.push(phaseLine('meaning', 'missing project cache settings are healthy'));
  return lines;
}
