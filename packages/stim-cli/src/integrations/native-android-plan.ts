import type { StimContext } from '@stim-cli/core';
import {
  androidSystemImageAbi,
  listInstalledSystemImages,
  ownedAvdDirectory,
  ownedAvdDeviceProfile,
  ownedAvdSystemImage,
} from '../devices/android.ts';
import { androidImageInstallPolicy, decideSystemImage } from '../devices/android-image.ts';
import { deviceSlotPlatforms, validateDeviceSlot } from '../devices/device-slots.ts';
import { resolveAndroidRunPlan } from '../commands/android/plan.ts';
import { planFlagRefusal, planPayload } from '../commands/build-plan.ts';
import { statsProjectKey } from '../engine/stats.ts';
import { getProject } from '../workspace/config.ts';
import { settingValueAt, type ResolvedProjectSettings } from '../workspace/settings.ts';
import { gradleArtifactInputs, nativeGradleArtifactSnapshot } from './native-gradle-artifact-inputs.ts';
import { plannedNativeApk } from './native-android-cache.ts';
import type { AndroidPlanOptions } from '../commands/android/next-build.ts';
import type { ProjectPlanResult } from './project-plan.ts';

export async function planNativeAndroid(
  root: string,
  options: AndroidPlanOptions,
  resolved: ResolvedProjectSettings,
  operation: StimContext,
): Promise<ProjectPlanResult> {
  if (options.easProfile !== undefined) return { refusal: planFlagRefusal('--eas-profile') };
  try {
    const slot = validateDeviceSlot(options.slot);
    const { context, settings } = resolved;
    const { env, signal } = operation;
    const declared = settingValueAt(settings, 'android.artifactInputs');
    gradleArtifactInputs(declared);
    const planned = await resolveAndroidRunPlan(
      {
        settings,
        settingsContext: context,
        env,
        signal,
        slot,
        variant: options.variant ?? null,
        systemImage: options.systemImage ?? null,
        deviceProfile: options.deviceProfile ?? null,
        device: null,
        wait: undefined,
        waitConflict: false,
        remote: null,
        buildCache: options.buildCache !== false,
      },
      {
        runtimeKind: () => 'process',
        variantProblem: () => null,
        resolveCompilerCache: ({ optimizations }) => {
          if (optimizations.android.compilerCache === 'cas')
            throw new Error('Native Android planning does not initialize the experimental CAS toolchain.');
          return { cas: null, optimizations, warning: null };
        },
        warn: (label, message) => operation.output('stderr', `${label}: ${message}\n`),
      },
    );
    if (!planned.ok) return { refusal: planned };
    const { build, target } = planned.plan;
    if (target.kind !== 'emulator') throw new Error('Native Android planning requires a local emulator target.');
    const recorded = deviceSlotPlatforms(getProject(root), slot)?.android;
    let reuseRecorded = Boolean(
      recorded?.owned && recorded.avdName && !recorded.setupIncomplete && ownedAvdDirectory(recorded.avdName),
    );
    const recordedImage = reuseRecorded && recorded?.avdName ? ownedAvdSystemImage(recorded.avdName) : null;
    const requestedImage = options.systemImage?.trim();
    if (recordedImage && requestedImage && recordedImage !== requestedImage) {
      if (!recorded?.bootPending)
        return {
          refusal: {
            code: 'STIM_BAD_ARG',
            message: `The recorded emulator uses ${recordedImage}; --system-image ${requestedImage} only replaces an emulator that never finished booting.`,
            remedy: 'Use the existing image or pass --slot <name> to create the requested emulator beside it.',
          },
        };
      reuseRecorded = false;
    }
    if (reuseRecorded && recorded?.avdName && target.deviceProfile) {
      const recordedProfile = ownedAvdDeviceProfile(recorded.avdName);
      if (recordedProfile && recordedProfile !== target.deviceProfile)
        return {
          refusal: {
            code: 'STIM_BAD_ARG',
            message: `The recorded emulator uses device profile ${recordedProfile}, but ${target.deviceProfile} was requested.`,
            remedy: 'Use the existing profile or pass --slot <name> to create the requested emulator beside it.',
          },
        };
    }
    let abi: string | null = null;
    if (build.targetAbiOnly && !build.release) {
      if (recorded?.avdName && !recorded.owned)
        return {
          refusal: {
            code: 'STIM_BAD_ARG',
            message: 'The legacy emulator assignment does not establish a build ABI for native planning.',
            remedy:
              'Run stim android without --plan to reconcile the assignment, or use --slot <name> for an owned emulator.',
          },
        };
      const decided = reuseRecorded
        ? null
        : decideSystemImage({
            requested: target.systemImage,
            installed: listInstalledSystemImages(),
            policy: androidImageInstallPolicy(settings),
          });
      if (decided?.kind === 'refuse')
        return { refusal: { code: decided.code, message: decided.message, remedy: decided.remedy } };
      abi = androidSystemImageAbi(decided ? decided.pkg : recordedImage);
      if (!abi) throw new Error('No installed emulator image identifies the native Android build ABI.');
    }
    const snapshot = await nativeGradleArtifactSnapshot(root, declared, build, abi, env, signal);
    const hit = build.cache.read && (await plannedNativeApk(snapshot.key, snapshot.sdkDirectory, abi, operation));
    return planPayload(
      {
        root,
        platform: 'android',
        slot,
        projectKey: statsProjectKey({ root, commonDir: context.gitCommonDir, repoRoot: context.repoRoot }),
      },
      {
        fingerprint: snapshot.hash,
        cacheKey: snapshot.key,
        cacheHit: hit ? 'local' : false,
        cacheSkipped: !build.cache.read,
        provider: null,
        prebuild: null,
        refusal: null,
      },
    );
  } catch (error) {
    operation.signal.throwIfAborted();
    return {
      refusal: {
        code: 'STIM_BAD_ARG',
        message: (error as Error).message,
        remedy:
          'Check android.artifactInputs and the local Android toolchain, or run stim android without --plan for an uncached build.',
      },
    };
  }
}
