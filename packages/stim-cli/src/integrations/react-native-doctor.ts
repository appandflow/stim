import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { phaseLine } from '../command-output.ts';
import {
  detectFingerprintParity,
  detectLinkedLibraryGitMetadata,
  reactNativeDoctorFindings,
  type DoctorPlatform,
} from '../diagnostics/doctor.ts';
import { repairCxxLauncherState } from '../diagnostics/doctor-cxx.ts';
import { bundlerPin } from '../engine/bundler.ts';
import { androidRequirements, androidToolchain, iosToolchain } from '../offload/toolchain.ts';
import { detectIsExpo } from '../workspace/project-files.ts';
import type { ProjectDoctor } from './project-doctor.ts';

export function reactNativeProjectDoctor(root: string): ProjectDoctor {
  return {
    inspect: reactNativeDoctorFindings,
    async inspectAsync({ options: { platform } }) {
      const parity = await detectFingerprintParity(root, { platform });
      const linkedGit = await detectLinkedLibraryGitMetadata(root, { platform });
      return [parity, linkedGit].filter((finding) => finding !== null);
    },
    offloadTargets({ options: { platform, host = process.platform } }, iosRuntime) {
      const checksIos = platform !== 'android' && host === 'darwin';
      const checksAndroid =
        platform === 'android' || (platform === undefined && (existsSync(join(root, 'android')) || detectIsExpo(root)));
      if (!checksIos && !checksAndroid) return null;
      return () => [
        ...(checksIos
          ? [
              {
                platform: 'ios' as const,
                local: iosToolchain(root),
                runtime: iosRuntime(),
                cocoapodsPinned: bundlerPin(root) !== null,
              },
            ]
          : []),
        ...(checksAndroid
          ? [
              {
                platform: 'android' as const,
                local: androidToolchain(),
                requires: androidRequirements(root),
              },
            ]
          : []),
      ];
    },
    repair: (platform) => (platform === 'ios' ? { removed: [], refused: [] } : repairCxxLauncherState(root)),
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
