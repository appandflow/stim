import { existsSync } from 'node:fs';
import { phaseLine } from '../command-output.ts';
import {
  detectFingerprintParity,
  detectLinkedLibraryGitMetadata,
  reactNativeDoctorFindings,
  type DoctorPlatform,
} from '../diagnostics/doctor.ts';
import { repairCxxLauncherState } from '../diagnostics/doctor-cxx.ts';
import { bundlerPin } from '../engine/bundler.ts';
import type { BuildTarget } from '../offload/toolchain.ts';
import { androidRequirements, androidToolchain, iosToolchainAsync } from '../offload/toolchain.ts';
import { detectIsExpo } from '../workspace/project-files.ts';
import { resolveAndroidLayout, resolveIosProjectDir } from '../workspace/settings.ts';
import type { ProjectDoctor } from './project-doctor.ts';

export function reactNativeProjectDoctor(root: string): ProjectDoctor {
  return {
    inspect: reactNativeDoctorFindings,
    async inspectAsync({ options: { platform }, settings }) {
      const parity = await detectFingerprintParity(root, {
        platform,
        iosProjectPath: resolveIosProjectDir(settings, root).relative,
      });
      const linkedGit = await detectLinkedLibraryGitMetadata(root, { platform });
      return [parity, linkedGit?.code === parity?.code ? null : linkedGit].filter((finding) => finding !== null);
    },
    offloadTargets({ options: { platform, host = process.platform }, settings, repoRoot }, iosRuntime) {
      const checksIos = platform !== 'android' && host === 'darwin';
      const androidDir = resolveAndroidLayout(settings, root, repoRoot ?? root).gradleRoot;
      const checksAndroid =
        platform === 'android' || (platform === undefined && (existsSync(androidDir) || detectIsExpo(root)));
      if (!checksIos && !checksAndroid) return null;
      return async () => {
        const targets: BuildTarget[] = [];
        if (checksIos) {
          const [local, runtime] = await Promise.all([iosToolchainAsync(root), iosRuntime()]);
          targets.push({ platform: 'ios', local, runtime, cocoapodsPinned: bundlerPin(root) !== null });
        }
        if (checksAndroid) {
          targets.push({ platform: 'android', local: androidToolchain(), requires: androidRequirements(root) });
        }
        return targets;
      };
    },
    repair: (platform, settings, repoRoot) =>
      platform === 'ios'
        ? { removed: [], refused: [] }
        : repairCxxLauncherState(root, settings, resolveAndroidLayout(settings, root, repoRoot ?? root)),
    successLines: reactNativeDoctorSuccessLines,
  };
}

export function reactNativeDoctorSuccessLines(platform: DoctorPlatform | undefined): string[] {
  const lines = [
    '',
    'Project',
    phaseLine('project', 'source checkout, dependencies, local upstream, nested worktrees Watchman would crawl'),
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
