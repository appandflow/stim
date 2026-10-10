import {
  androidSystemImageAbi,
  listInstalledSystemImages,
  ownedAvdDirectory,
  ownedAvdSystemImage,
  pickDefaultSystemImage,
} from '../devices/android.ts';
import { deviceSlotPlatforms, validateDeviceSlot } from '../devices/device-slots.ts';
import { resolveAndroidRunPlan } from '../commands/android/plan.ts';
import { planFlagRefusal, planPayload } from '../commands/build-plan.ts';
import { statsProjectKey } from '../engine/stats.ts';
import { getProject } from '../workspace/config.ts';
import { gitCommonDir, repoRoot } from '../workspace/worktree.ts';
import { resolveSettings, settingValueAt } from '../workspace/settings.ts';
import { gradleArtifactInputs, nativeGradleArtifactSnapshot } from './native-gradle-artifact-inputs.ts';
import { plannedNativeApk } from './native-android-cache.ts';
import type { AndroidPlanOptions } from '../commands/android/next-build.ts';
import type { ProjectPlanResult } from './project-plan.ts';

export async function planNativeAndroid(root: string, options: AndroidPlanOptions): Promise<ProjectPlanResult> {
  if (options.easProfile !== undefined) return { refusal: planFlagRefusal('--eas-profile') };
  try {
    const slot = validateDeviceSlot(options.slot);
    const context = { projectPath: root, gitCommonDir: gitCommonDir(root), repoRoot: repoRoot(root) };
    const settings = resolveSettings(context);
    const declared = settingValueAt(settings, 'android.artifactInputs');
    gradleArtifactInputs(declared);
    const planned = resolveAndroidRunPlan(
      {
        settings,
        settingsContext: context,
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
        warn: (label, message) => console.error(`${label}: ${message}`),
      },
    );
    if (!planned.ok) return { refusal: planned };
    const { build, target } = planned.plan;
    if (target.kind !== 'emulator') throw new Error('Native Android planning requires a local emulator target.');
    let abi: string | null = null;
    if (build.targetAbiOnly && !build.release) {
      const owned = deviceSlotPlatforms(getProject(root), slot)?.android;
      const image =
        owned?.owned && owned.avdName && !owned.setupIncomplete && ownedAvdDirectory(owned.avdName)
          ? ownedAvdSystemImage(owned.avdName)
          : pickDefaultSystemImage(
              listInstalledSystemImages(),
              target.systemImage ? { systemImage: target.systemImage } : {},
            )?.pkg;
      abi = androidSystemImageAbi(image);
      if (!abi) throw new Error('No installed emulator image identifies the native Android build ABI.');
    }
    const snapshot = nativeGradleArtifactSnapshot(root, declared, build, abi);
    const hit = build.cache.read && (await plannedNativeApk(snapshot.key, snapshot.sdkDirectory, abi));
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
