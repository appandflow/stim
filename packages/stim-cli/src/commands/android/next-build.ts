import chalk from 'chalk';
import { loadCacheProvider } from '@stim-cli/cache';
import { buildCacheKey, fingerprintProject } from '../../cache/build-cache.ts';
import { phaseLine } from '../../command-output.ts';
import {
  hostSystemImageArch,
  listAvds,
  listInstalledSystemImages,
  ownedAvdDirectory,
  ownedAvdSystemImage,
  pickDefaultSystemImage,
} from '../../devices/android.ts';
import { deviceSlotPlatforms, validateDeviceSlot } from '../../devices/device-slots.ts';
import type { RemoteDeviceBackend } from '../../engine/device-remote.ts';
import { planEasDevelopmentBuild } from '../../engine/eas-build.ts';
import { planPrebuild } from '../../engine/prebuild.ts';
import { checkEasAuth, loadProjectProvider, resolveRemote } from '../../engine/remote-cache.ts';
import { statsProjectKey } from '../../engine/stats.ts';
import { getProject } from '../../workspace/config.ts';
import { appProjectProblem, findProjectRoot, NO_PROJECT_REFUSAL } from '../../workspace/project.ts';
import { resolveSettings } from '../../workspace/settings.ts';
import { gitCommonDir, repoRoot } from '../../workspace/worktree.ts';
import { planCachedBuild, planFlagRefusal, planPayload, printPlan, refusePlan } from '../build-plan.ts';
import { isPhysicalDeviceRequest } from '../native-runtime.ts';
import { resolveAndroidRunPlan } from './plan.ts';
import { androidBuildOptions, NO_DEVICE, NO_FINGERPRINT, PLATFORM } from './support.ts';

export interface AndroidPlanOptions {
  slot?: string;
  json?: boolean;
  easProfile?: string;
  buildCache?: boolean;
  variant?: string;
  systemImage?: string;
  device?: string | boolean;
  remote?: RemoteDeviceBackend;
  wait?: string | boolean;
  metroCheck?: boolean;
}

export interface AndroidPlanDeps {
  findRoot: typeof findProjectRoot;
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
  findRoot: findProjectRoot,
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

function runOnlyFlag(opts: AndroidPlanOptions): string | null {
  if (isPhysicalDeviceRequest(opts.device)) return '--device';
  if (opts.remote) return '--remote';
  if (opts.wait !== undefined) return opts.wait === false ? '--no-wait' : '--wait';
  if (opts.metroCheck === false) return '--no-metro-check';
  return null;
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

export async function planAndroid(opts: AndroidPlanOptions, overrides: Partial<AndroidPlanDeps> = {}): Promise<void> {
  const deps = { ...DEFAULT_PLAN_DEPS, ...overrides };
  const json = Boolean(opts.json);
  const refuse = (refusal: { code: string; message: string; remedy: string }, lines: string[] = []) =>
    refusePlan(refusal, json, lines);
  const flag = runOnlyFlag(opts);
  if (flag) return refuse(planFlagRefusal(flag));
  const root = deps.findRoot(process.cwd());
  if (!root) return refuse(NO_PROJECT_REFUSAL);
  const projectProblem = appProjectProblem(root);
  if (projectProblem) return refuse({ code: 'STIM_NO_PROJECT', ...projectProblem });

  const slot = validateDeviceSlot(opts.slot);
  const settingsContext = { projectPath: root, gitCommonDir: gitCommonDir(root), repoRoot: repoRoot(root) };
  const planned = resolveAndroidRunPlan(
    {
      settings: resolveSettings(settingsContext),
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
    return printPlan(
      planPayload(planTarget, {
        fingerprint: eas.fingerprint,
        cacheKey: eas.cacheKey,
        cacheHit: eas.buildId ? 'remote' : false,
        provider: 'eas',
        cacheSkipped: false,
        prebuild: null,
        refusal: eas.missing,
      }),
      json,
    );
  }

  if (target.kind !== 'emulator') {
    if (target.kind === 'physical') return refuse(planFlagRefusal('--device'));
    return refuse({
      code: 'STIM_BAD_ARG',
      message: `android.remote routes this workspace's runs to a ${target.backend} device, whose ABI --plan cannot read without a session.`,
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
  const image =
    build.targetAbiOnly && !build.release ? emulatorImage(root, slot, target.systemImage, deps) : { systemImage: null };
  if ('refusal' in image) return refuse(image.refusal);
  const { abi, runOptions, remoteRunOptions } = androidBuildOptions({
    release: build.release,
    physical: false,
    device: { systemImage: image.systemImage },
    variant: build.variant,
    deviceAbi: () => null,
    buildProfile: build.profile,
    targetAbiOnly: build.targetAbiOnly,
  });

  let fingerprint;
  try {
    fingerprint = await deps.fingerprint(root, { platform: PLATFORM });
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
  printPlan(plan, json);
}
