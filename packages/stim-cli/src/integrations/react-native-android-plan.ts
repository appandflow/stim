import type { StimContext } from '@stim-cli/core';
import { processContext } from '../cli-operation.ts';
import { readDoctorFingerprint } from '../doctor-fingerprint.ts';
import { memoizedFingerprint } from '../cache/fingerprint-memo.ts';
import { reportSignal } from '../report-runtime.ts';
import chalk from 'chalk';
import { loadCacheProvider } from '@stim-cli/cache';
import { buildCacheKey, fingerprintProject } from '../cache/build-cache.ts';
import { phaseLine } from '../command-output.ts';
import {
  androidSystemImageAbi,
  hostSystemImageArch,
  listAvdsAsync,
  listInstalledSystemImages,
  ownedAvdDirectory,
  ownedAvdSystemImage,
  pickDefaultSystemImage,
} from '../devices/android.ts';
import { deviceSlotPlatforms, validateDeviceSlot } from '../devices/device-slots.ts';
import { planEasDevelopmentBuild } from '../engine/eas-build.ts';
import { planPrebuildAsync, type PrebuildAction } from '../engine/prebuild.ts';
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
  listAvds: (options: { timeoutMs: number; signal?: AbortSignal }) => string[] | Promise<string[]>;
  loadCacheProvider: typeof loadCacheProvider;
  loadProjectProvider: typeof loadProjectProvider;
  checkEasAuth: typeof checkEasAuth;
  resolveRemote: typeof resolveRemote;
  planPrebuild: (...args: Parameters<typeof planPrebuildAsync>) => PrebuildAction | Promise<PrebuildAction>;
}

const DEFAULT_PLAN_DEPS: AndroidPlanDeps = {
  fingerprint: fingerprintProject,
  listSystemImages: listInstalledSystemImages,
  avdSystemImage: ownedAvdSystemImage,
  avdDirectory: ownedAvdDirectory,
  listAvds: listAvdsAsync,
  loadCacheProvider,
  loadProjectProvider,
  checkEasAuth,
  resolveRemote,
  planPrebuild: planPrebuildAsync,
};

function refuse(refusal: PlanRefusal, lines: string[] = []): ProjectPlanResult {
  return { refusal, lines };
}

type EmulatorImage = { systemImage: string | null } | { refusal: PlanRefusal };

function imageReplacement(
  root: string,
  slot: string,
  flagImage: string | undefined,
  deps: Pick<AndroidPlanDeps, 'avdSystemImage' | 'avdDirectory'>,
): { replaces: boolean; refusal: PlanRefusal | null } {
  const record = deviceSlotPlatforms(getProject(root), slot)?.android;
  if (!flagImage || !record?.owned || !record.avdName || record.setupIncomplete || !deps.avdDirectory(record.avdName))
    return { replaces: false, refusal: null };
  const current = deps.avdSystemImage(record.avdName);
  if (!current || current === flagImage) return { replaces: false, refusal: null };
  if (record.bootPending) return { replaces: true, refusal: null };
  return {
    replaces: false,
    refusal: {
      code: 'STIM_BAD_ARG',
      message: `This project's emulator ${record.avdName} uses system image ${current}, but ${flagImage} was requested. --system-image replaces only an emulator that never finished a boot, and this one has.`,
      remedy:
        'Run `stim worktree remove` (or `stim gc --delete`) to reap the current emulator, then `stim android` again to create the requested one, or pass `--slot <name>` to create it beside the current one.',
    },
  };
}

async function emulatorImage(
  root: string,
  slot: string,
  requested: string | null,
  replaces: boolean,
  deps: Pick<AndroidPlanDeps, 'listSystemImages' | 'avdSystemImage' | 'avdDirectory' | 'listAvds'>,
  signal?: AbortSignal,
): Promise<EmulatorImage> {
  const record = deviceSlotPlatforms(getProject(root), slot)?.android;
  if (record?.avdName && !record.setupIncomplete && !replaces) {
    if (record.owned && deps.avdDirectory(record.avdName)) return { systemImage: deps.avdSystemImage(record.avdName) };
    if (!record.owned && (await avdListed(record.avdName, deps.listAvds, signal))) return { systemImage: null };
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

async function avdListed(avdName: string, list: AndroidPlanDeps['listAvds'], signal?: AbortSignal): Promise<boolean> {
  try {
    return (await list({ timeoutMs: 10_000, signal })).includes(avdName);
  } catch {
    signal?.throwIfAborted();
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
  operation: StimContext = processContext(root),
): Promise<ProjectPlanResult> {
  const note = (line: string) => operation.output('stderr', `${line}\n`);
  const deps = { ...DEFAULT_PLAN_DEPS, ...overrides };
  const slot = validateDeviceSlot(opts.slot);
  const planned = await resolveAndroidRunPlan(
    {
      settings,
      settingsContext,
      env: operation?.env,
      signal: operation?.signal,
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
      context: operation,
      env: operation?.env,
      signal: operation?.signal,
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
  const replacement =
    target.kind === 'emulator' || target.kind === 'hosted'
      ? imageReplacement(root, slot, opts.systemImage?.trim() || undefined, deps)
      : { replaces: false, refusal: null };
  if (target.kind === 'emulator' && replacement.refusal) return refuse(replacement.refusal);
  const abiKeyed = build.targetAbiOnly && !build.release;
  let localImageRead: Promise<EmulatorImage> | undefined;
  const localImage = () =>
    (localImageRead ??= abiKeyed
      ? emulatorImage(root, slot, target.systemImage, replacement.replaces, deps, operation.signal)
      : Promise.resolve({ systemImage: null }));
  let image: EmulatorImage;
  let hostedAbi: string | null = null;
  let placement: string | undefined;
  if (target.kind === 'hosted') {
    const hostedPlan = await planHostedDevice({
      operation,
      root,
      slot,
      platform: 'android',
      machine: target.machine,
      ...(target.placement ? { placement: target.placement } : {}),
      selectors: {
        ...(target.systemImage ? { systemImage: target.systemImage } : {}),
        ...(target.deviceProfile ? { deviceProfile: target.deviceProfile } : {}),
      },
      sameKey: async (choice) => {
        if (build.targetAbiOnly && build.release) return !('architecture' in choice && choice.architecture);
        if (!abiKeyed) return true;
        const local = await localImage();
        if ('refusal' in local || !('systemImage' in choice)) return null;
        return androidSystemImageAbi(local.systemImage) === androidSystemImageAbi(choice.systemImage);
      },
      ...(remoteEasFallbackSetting(settings)
        ? {
            eas: () =>
              checkEasFallback({
                operation,
                env: operation?.env,
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
        message: `android.remote is ${target.placement ?? target.machine}, and its emulator ABI is unknown here: ${hostedPlan.reason}.`,
        remedy:
          'Run `stim android` to build for the remote device, or unset android.remote to plan the owned emulator.',
      });
    }
    if (hostedPlan.kind === 'local' && replacement.refusal) return refuse(replacement.refusal);
    placement = hostedPlan.placement;
    if (hostedPlan.kind === 'hosted' && 'architecture' in hostedPlan.choice)
      hostedAbi = hostedPlan.choice.architecture ?? null;
    image =
      hostedPlan.kind === 'hosted'
        ? { systemImage: abiKeyed && 'systemImage' in hostedPlan.choice ? hostedPlan.choice.systemImage : null }
        : await localImage();
  } else image = await localImage();
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
    fingerprint = (
      await memoizedFingerprint(
        root,
        { platform: PLATFORM, androidLayout: layout },
        {
          consult: build.cache.read,
          operation: operation && reportSignal(operation) ? undefined : operation,
          record: false,
          fingerprint: (projectRoot, fingerprintTarget) =>
            operation && reportSignal(operation)
              ? readDoctorFingerprint(operation, { root: projectRoot, platform: PLATFORM, androidLayout: layout })
              : deps.fingerprint(projectRoot, fingerprintTarget),
        },
      )
    ).fingerprint;
  } catch (error) {
    operation?.signal.throwIfAborted();
    return refuse({
      code: NO_FINGERPRINT,
      message: `@expo/fingerprint could not fingerprint ${root}: ${(error as Error)?.message || error}`,
      remedy: 'Fix the @expo/fingerprint error above, then retry.',
    });
  }
  if (!fingerprint?.hash) {
    operation?.signal.throwIfAborted();
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
    { ...deps, operation, note },
  );
  return placement ? { ...plan, placement } : plan;
}
