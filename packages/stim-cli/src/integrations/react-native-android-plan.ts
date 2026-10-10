import chalk from 'chalk';
import { loadCacheProvider } from '@stim-cli/cache';
import { buildCacheKey, fingerprintProject } from '../cache/build-cache.ts';
import { phaseLine } from '../command-output.ts';
import {
  androidSystemImageAbi,
  hostSystemImageArch,
  listAvds,
  listInstalledSystemImages,
  ownedAvdDirectory,
  ownedAvdSystemImage,
  pickDefaultSystemImage,
} from '../devices/android.ts';
import { deviceSlotPlatforms, validateDeviceSlot } from '../devices/device-slots.ts';
import { planEasDevelopmentBuild } from '../engine/eas-build.ts';
import { planPrebuild } from '../engine/prebuild.ts';
import { checkEasAuth, loadProjectProvider, resolveRemote } from '../engine/remote-cache.ts';
import { statsProjectKey } from '../engine/stats.ts';
import { getProject } from '../workspace/config.ts';
import {
  publicUrlSetting,
  remoteEasFallbackSetting,
  type AndroidLayout,
  type ResolvedProjectSettings,
  tunnelModeSetting,
} from '../workspace/settings.ts';
import { checkEasFallback } from '../engine/eas-fallback.ts';
import { planCachedBuild, planFlagRefusal, planPayload } from '../commands/build-plan.ts';
import { planHostedDevice } from '../device-host/plan-placement.ts';
import { resolveAndroidRunPlan } from '../commands/android/plan.ts';
import {
  androidBuildOptions,
  androidGradleProject,
  NO_DEVICE,
  NO_FINGERPRINT,
  PLATFORM,
} from '../commands/android/support.ts';

import type { AndroidProject } from './android-project.ts';
import type { AndroidPlanOptions } from '../commands/android/next-build.ts';
import type { PlanRefusal, ProjectPlanResult } from './project-plan.ts';

export interface AndroidPlanDeps {
  fingerprint: typeof fingerprintProject;
  listSystemImages: typeof listInstalledSystemImages;
  avdSystemImage: typeof ownedAvdSystemImage;
  avdDirectory: typeof ownedAvdDirectory;
  listAvds: typeof listAvds;
  loadCacheProvider: typeof loadCacheProvider;
  loadProjectProvider: typeof loadProjectProvider;
  checkEasAuth: typeof checkEasAuth;
  resolveRemote: typeof resolveRemote;
  planPrebuild: typeof planPrebuild;
}

const DEFAULT_PLAN_DEPS: AndroidPlanDeps = {
  fingerprint: fingerprintProject,
  listSystemImages: listInstalledSystemImages,
  avdSystemImage: ownedAvdSystemImage,
  avdDirectory: ownedAvdDirectory,
  listAvds,
  loadCacheProvider,
  loadProjectProvider,
  checkEasAuth,
  resolveRemote,
  planPrebuild,
};

function note(line: string): void {
  console.error(line);
}

function refuse(refusal: PlanRefusal, lines: string[] = []): ProjectPlanResult {
  return { refusal, lines };
}

type EmulatorImage = { systemImage: string | null } | { refusal: { code: string; message: string; remedy: string } };

function emulatorImage(
  root: string,
  slot: string,
  requested: string | null,
  deps: Pick<AndroidPlanDeps, 'listSystemImages' | 'avdSystemImage' | 'avdDirectory' | 'listAvds'>,
): EmulatorImage {
  const record = deviceSlotPlatforms(getProject(root), slot)?.android;
  if (record?.avdName && !record.setupIncomplete) {
    if (record.owned && deps.avdDirectory(record.avdName)) return { systemImage: deps.avdSystemImage(record.avdName) };
    if (!record.owned && avdListed(record.avdName, deps.listAvds)) return { systemImage: null };
  }
  let images;
  try {
    images = deps.listSystemImages();
  } catch (error) {
    return {
      refusal: {
        code: NO_DEVICE,
        message: `Could not read the installed Android system images: ${(error as Error)?.message || error}`,
        remedy: 'Check that ANDROID_HOME points at a readable SDK, then try again.',
      },
    };
  }
  const picked = pickDefaultSystemImage(images, requested ? { systemImage: requested } : {});
  if (picked) return { systemImage: picked.pkg };
  const arch = hostSystemImageArch();
  return {
    refusal: {
      code: NO_DEVICE,
      message: `No ${arch} Android system image is installed, so the emulator build's ABI and cache key are unknown.`,
      remedy: `Install one, e.g.: sdkmanager "system-images;android-36;google_apis;${arch}", then try again.`,
    },
  };
}

function avdListed(avdName: string, list: AndroidPlanDeps['listAvds']): boolean {
  try {
    return list({ timeoutMs: 10_000 }).includes(avdName);
  } catch {
    return false;
  }
}

export async function planReactNativeAndroid(
  root: string,
  opts: AndroidPlanOptions,
  runtimeKind: AndroidProject['runtimeKind'],
  { context: settingsContext, settings }: ResolvedProjectSettings,
  layout: AndroidLayout,
  variantProblem: AndroidProject['variantProblem'],
  overrides: Partial<AndroidPlanDeps> = {},
): Promise<ProjectPlanResult> {
  const deps = { ...DEFAULT_PLAN_DEPS, ...overrides };
  const slot = validateDeviceSlot(opts.slot);
  const planned = resolveAndroidRunPlan(
    {
      settings,
      settingsContext,
      slot,
      easProfile: opts.easProfile,
      variant: opts.variant ?? null,
      systemImage: opts.systemImage ?? null,
      device: null,
      wait: undefined,
      waitConflict: false,
      remote: null,
      buildCache: opts.buildCache !== false,
    },
    {
      runtimeKind,
      variantProblem,
      warn: (label, message) => note(phaseLine(label, chalk.yellow(message))),
      resolveCompilerCache: ({ optimizations }) => ({ cas: null, optimizations, warning: null }),
      listSystemImages: deps.listSystemImages,
    },
  );
  if (!planned.ok) return refuse(planned, planned.lines);
  const { build, target, isExpo, cacheProviderConfig } = planned.plan;
  const planTarget = {
    platform: PLATFORM,
    slot,
    root,
    projectKey: statsProjectKey({ root, commonDir: settingsContext.gitCommonDir, repoRoot: settingsContext.repoRoot }),
  } as const;

  if (opts.easProfile !== undefined) {
    const eas = await planEasDevelopmentBuild({
      root,
      platform: PLATFORM,
      profile: opts.easProfile,
      note,
      isExpo,
      selectors: [opts.variant],
      buildCache: opts.buildCache,
    });
    if (!eas.ok) return refuse(eas);
    return planPayload(planTarget, {
      fingerprint: eas.fingerprint,
      cacheKey: eas.cacheKey,
      cacheHit: eas.buildId ? 'remote' : false,
      provider: 'eas',
      cacheSkipped: false,
      prebuild: null,
      refusal: eas.missing,
    });
  }

  if (target.kind === 'physical') return refuse(planFlagRefusal('--device'));
  if (target.kind === 'remote') {
    return refuse({
      code: 'STIM_BAD_ARG',
      message: `android.remote is ${target.backend}, whose ABI --plan cannot read without a session.`,
      remedy: 'Run `stim android` to build for the remote device, or unset android.remote to plan the owned emulator.',
    });
  }
  if (build.compilerCache === 'cas') {
    return refuse({
      code: 'STIM_BAD_ARG',
      message: 'The experimental Android compiler CAS keys builds by a toolchain Stim sets up, which --plan does not.',
      remedy: 'Run `stim android` to build with the CAS, or set optimizations.android.compilerCache to ccache.',
    });
  }
  const abiKeyed = build.targetAbiOnly && !build.release;
  const localImage = () => (abiKeyed ? emulatorImage(root, slot, target.systemImage, deps) : { systemImage: null });
  let image: EmulatorImage;
  let hostedAbi: string | null = null;
  let placement: string | undefined;
  if (target.kind === 'hosted') {
    const hostedPlan = await planHostedDevice({
      root,
      slot,
      platform: 'android',
      machine: target.machine,
      selectors: {
        ...(target.systemImage ? { systemImage: target.systemImage } : {}),
        ...(target.deviceProfile ? { deviceProfile: target.deviceProfile } : {}),
      },
      sameKey: (choice) => {
        if (build.targetAbiOnly && build.release) return !('architecture' in choice && choice.architecture);
        if (!abiKeyed) return true;
        const local = localImage();
        if ('refusal' in local || !('systemImage' in choice)) return null;
        return androidSystemImageAbi(local.systemImage) === androidSystemImageAbi(choice.systemImage);
      },
      ...(remoteEasFallbackSetting(settings)
        ? {
            eas: () =>
              checkEasFallback({
                root,
                platform: 'android',
                slot,
                release: build.release,
                isExpo,
                tunnelMode: tunnelModeSetting(settings),
                publicUrl: publicUrlSetting(settings),
                localOnlyFlags: typeof opts.systemImage === 'string' ? ['--system-image'] : [],
              }),
          }
        : {}),
    });
    if (hostedPlan.kind === 'unknown') {
      return refuse({
        code: 'STIM_BAD_ARG',
        message: `android.remote is ${target.machine}, and its emulator ABI is unknown here: ${hostedPlan.reason}.`,
        remedy:
          'Run `stim android` to build for the remote device, or unset android.remote to plan the owned emulator.',
      });
    }
    placement = hostedPlan.placement;
    if (hostedPlan.kind === 'hosted' && 'architecture' in hostedPlan.choice)
      hostedAbi = hostedPlan.choice.architecture ?? null;
    image =
      hostedPlan.kind === 'hosted'
        ? { systemImage: abiKeyed && 'systemImage' in hostedPlan.choice ? hostedPlan.choice.systemImage : null }
        : localImage();
  } else image = localImage();
  if ('refusal' in image) return refuse(image.refusal);
  const { abi, runOptions, remoteRunOptions } = androidBuildOptions({
    release: build.release,
    physical: false,
    device: { systemImage: image.systemImage },
    variant: build.variant,
    deviceAbi: () => null,
    gradleProject: androidGradleProject(layout),
    buildProfile: build.profile,
    targetAbiOnly: build.targetAbiOnly,
    hostedAbi,
  });

  let fingerprint;
  try {
    fingerprint = await deps.fingerprint(root, { platform: PLATFORM, androidLayout: layout });
  } catch (error) {
    return refuse({
      code: NO_FINGERPRINT,
      message: `@expo/fingerprint could not fingerprint ${root}: ${(error as Error)?.message || error}`,
      remedy: 'Fix the @expo/fingerprint error above, then retry.',
    });
  }
  if (!fingerprint?.hash) {
    return refuse({
      code: NO_FINGERPRINT,
      message: `@expo/fingerprint returned no hash for ${root}, so the build cache cannot be addressed.`,
      remedy: 'Check the project native inputs and the @expo/fingerprint error above, then retry.',
    });
  }
  const plan = await planCachedBuild(
    {
      ...planTarget,
      isExpo,
      fingerprint: fingerprint.hash,
      sources: fingerprint.sources ?? [],
      cacheKey: buildCacheKey(PLATFORM, fingerprint.hash, runOptions),
      cachePolicy: build.cache,
      providerConfig: cacheProviderConfig,
      expoRemote: abi || build.profile || !build.cache.remote ? null : { runOptions: remoteRunOptions },
    },
    { ...deps, note },
  );
  return placement ? { ...plan, placement } : plan;
}
