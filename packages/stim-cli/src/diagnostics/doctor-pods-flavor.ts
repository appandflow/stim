import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding } from './doctor.ts';

const IOS_PODS_FLAVOR = 'ios-pods-flavor';

const PREBUILT_PODS = ['React-Core-prebuilt', 'ReactNativeDependencies', 'hermes-engine'] as const;
const FLAVORS = ['Debug', 'Release'];

function lastBuildConfiguration(podsDir: string, pod: string): string | null {
  try {
    return readFileSync(join(podsDir, pod, '.last_build_configuration'), 'utf-8').trim();
  } catch {
    return null;
  }
}

/**
 * React Native's replace-rncore-version.js and replace_hermes_version.js re-extract the prebuilt frameworks
 * from Pods/*-artifacts when .last_build_configuration differs from the configuration being built, so a
 * cloned Pods tree only stays shared while the worktree builds the flavor the source checkout last built.
 */
function mismatchedPrebuiltPods(
  sourcePods: string,
  worktreePods: string,
  configuration: string,
): { pod: string; flavor: string }[] {
  if (!FLAVORS.includes(configuration)) return [];
  return PREBUILT_PODS.flatMap((pod) => {
    const flavor = lastBuildConfiguration(sourcePods, pod);
    return flavor !== null &&
      flavor !== configuration &&
      FLAVORS.includes(flavor) &&
      lastBuildConfiguration(worktreePods, pod) === flavor
      ? [{ pod, flavor }]
      : [];
  });
}

function podsFlavorAdvice(configuration: string): string {
  const command = configuration === 'Debug' ? 'stim ios' : `stim ios --configuration ${configuration}`;
  return `build the source checkout once in ${configuration} (\`${command}\` there) before warming more worktrees`;
}

function podsFlavorDetail(pods: { pod: string; flavor: string }[], configuration: string): string {
  const last = pods.map(({ pod, flavor }) => `${pod} (${flavor})`).join(', ');
  return `The source checkout's Pods were last built as ${last}, but this workspace builds ${configuration}. React Native re-extracts its prebuilt frameworks when the configuration changes, so the first build in a worktree cloned from the source writes about 1 GB of unshared disk (the Debug core alone is about 640 MB) and spends time extracting.`;
}

export function inspectPodsFlavor(sourceIosDir: string, worktreeIosDir: string, configuration: string): Finding | null {
  const pods = mismatchedPrebuiltPods(join(sourceIosDir, 'Pods'), join(worktreeIosDir, 'Pods'), configuration);
  if (!pods.length) return null;
  const advice = podsFlavorAdvice(configuration);
  return {
    code: IOS_PODS_FLAVOR,
    level: 'note',
    title: "The source checkout's React Native prebuilt frameworks are a different flavor than this workspace builds",
    detail: podsFlavorDetail(pods, configuration),
    fix: advice.charAt(0).toUpperCase() + advice.slice(1) + '.',
  };
}
