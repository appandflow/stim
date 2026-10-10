import { productFlavorRefusal, readProductFlavors } from '../../integrations/react-native-build.ts';
import { DEFAULT_DEVICE_SLOT_WAIT_MS } from '../../engine/device-capacity.ts';
import type { CacheProviderConfig } from '@stim-cli/cache';
import {
  artifactCachePolicy,
  compilerCacheFallbackMessage,
  optimizationBuildProfile,
  resolveOptimizations,
  type Optimizations,
} from '../../optimizations.ts';
import { resolveAndroidCas, resolveAndroidCompilerCache } from '../../engine/android-cas.ts';
import { parseDeviceWait } from '../../engine/device-lease-run.ts';
import { detectIsExpo } from '../../workspace/project.ts';
import {
  DEFAULT_AVD_DEVICE_PROFILE,
  listAvdDeviceProfiles,
  listInstalledSystemImages,
  ownedAvdDeviceProfile,
  ownedAvdSystemImage,
  pickDefaultSystemImage,
  profileNeedsFoldFeature,
  systemImageSupportsFold,
} from '../../devices/android.ts';
import { deviceSlotPlatforms } from '../../devices/device-slots.ts';
import { getProject } from '../../workspace/config.ts';
import { parkedMaxSetting } from '../../devices/sim-pool.ts';
import type { RemoteDeviceBackend } from '../../engine/device-remote.ts';
import type { SettingsObject } from '@stim-cli/core/state';
import {
  androidLayoutSetting,
  androidLayoutSettingError,
  resolveAndroidLayout,
  type AndroidLayout,
  androidAvdConfigSettingError,
  androidDataPartitionSizeGbSettingError,
  cacheProviderSettingError,
  remoteAndroidSetting,
  parseAndroidRemote,
  resolveCacheProviderConfig,
  SETTING_SHAPE_REMEDY,
  settingFile,
  settingOriginScope,
  settingShapeErrors,
  settingsLayers,
  unknownSettingKeys,
} from '../../workspace/settings.ts';
import { isPhysicalDeviceRequest } from '../native-runtime.ts';
import type { AndroidRuntimeKind } from './launch.ts';
import {
  deviceProfileRefusal,
  foldableImageRefusal,
  isReleaseVariant,
  remoteAvdFlagRefusal,
  resolveDeviceProfile,
  resolveSystemImage,
  resolveVariant,
  systemImageRefusal,
} from './support.ts';

interface SettingsContext {
  readonly projectPath: string;
  readonly gitCommonDir: string | null;
  readonly repoRoot: string | null;
}

export interface AndroidBuildPlanInputs {
  readonly settings: SettingsObject;
  readonly settingsContext: SettingsContext;
  readonly easProfile?: string;
  readonly variant: string | null;
  readonly buildCache: boolean;
}

export interface AndroidPlanInputs extends AndroidBuildPlanInputs {
  readonly slot: string;
  readonly systemImage: string | null;
  readonly deviceProfile?: string | null;
  readonly device: string | boolean | null;
  readonly wait: string | boolean | undefined;
  readonly waitConflict: boolean;
  readonly remote: string | null;
}

type AndroidTargetPlan =
  | {
      readonly kind: 'hosted';
      readonly machine: string;
      readonly systemImage: string | null;
      readonly deviceProfile: string | null;
    }
  | { readonly kind: 'emulator'; readonly systemImage: string | null; readonly deviceProfile: string | null }
  | {
      readonly kind: 'remote';
      readonly backend: RemoteDeviceBackend;
      readonly systemImage: string | null;
      readonly deviceProfile: string | null;
    }
  | {
      readonly kind: 'physical';
      readonly serial: string | null;
      readonly lease: { readonly waitSeconds: number; readonly noWait: boolean };
    };

export interface AndroidBuildPlan {
  readonly build: {
    readonly variant: string | null;
    readonly release: boolean;
    readonly profile: string | undefined;
    readonly cas: ReturnType<typeof resolveAndroidCas>;
    readonly cache: Readonly<ReturnType<typeof artifactCachePolicy>>;
    readonly compilerCache: Optimizations['android']['compilerCache'];
    readonly gradleBuildCache: boolean;
    readonly pch: Optimizations['android']['pch'];
    readonly targetAbiOnly: boolean;
  };
  readonly metroWarmup: boolean;
  readonly cacheProviderConfig: CacheProviderConfig | null;
}

export interface AndroidRunPlan extends AndroidBuildPlan {
  readonly target: AndroidTargetPlan;
  readonly deviceSlotWaitMs: number;
  readonly isExpo: boolean;
}

type PlanResult<Plan> =
  | { readonly ok: true; readonly plan: Plan }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly remedy: string;
      readonly lines: string[];
    };

export type AndroidPlanResult = PlanResult<AndroidRunPlan>;

export interface AndroidBuildPlanDependencies {
  runtimeKind: (build: { release: boolean }) => AndroidRuntimeKind;
  warn: (label: 'setting' | 'cache', message: string) => void;
  resolveCompilerCache?: typeof androidCompilerCache;
  resolveCacheProvider?: typeof resolveCacheProviderConfig;
  variantProblem: (variant: string | null) => ReturnType<typeof productFlavorRefusal>;
  detectExpo?: () => boolean;
}

export interface AndroidPlanDependencies extends Omit<AndroidBuildPlanDependencies, 'variantProblem'> {
  validateAvdConfig?: typeof androidAvdConfigSettingError;
  readFlavors?: typeof readProductFlavors;
  variantProblem?: AndroidBuildPlanDependencies['variantProblem'];
  listSystemImages?: typeof listInstalledSystemImages;
  listDeviceProfiles?: typeof listAvdDeviceProfiles;
  parkedLimit?: typeof parkedMaxSetting;
  supportsFold?: (pkg: string) => boolean;
  ownedAvd?: typeof slotOwnedAvd;
}

interface SlotAvd {
  avdName: string;
  systemImage: string;
  deviceProfile: string | null;
}

function slotOwnedAvd(projectPath: string, slot: string): SlotAvd | null {
  const android = deviceSlotPlatforms(getProject(projectPath), slot)?.android;
  if (!android?.owned || !android.avdName || android.setupIncomplete) return null;
  const systemImage = ownedAvdSystemImage(android.avdName);
  return systemImage
    ? { avdName: android.avdName, systemImage, deviceProfile: ownedAvdDeviceProfile(android.avdName) }
    : null;
}

function fail(
  code: string,
  message: string,
  remedy: string,
  { lines = [] }: { lines?: string[] } = {},
): Extract<AndroidPlanResult, { ok: false }> {
  return { ok: false, code, message, remedy, lines };
}

function androidLayoutError(
  settings: SettingsObject,
  root: string,
  bound: string,
  isExpo: () => boolean,
): string | null {
  const error = androidLayoutSettingError(settings, root, bound);
  if (error || !androidLayoutSetting(settings, root, bound).custom || !isExpo()) return error;
  return 'android.gradleRoot and android.module apply to bare React Native apps only: expo prebuild generates and builds android/. Remove them for this Expo app.';
}

function androidCompilerCache({
  root,
  optimizations,
  settingsContext,
  layout,
}: {
  root: string;
  optimizations: Optimizations;
  settingsContext: SettingsContext;
  layout: AndroidLayout;
}): { cas: ReturnType<typeof resolveAndroidCas>; optimizations: Optimizations; warning: string | null } {
  const { cas, optimizations: resolved } = resolveAndroidCompilerCache({
    optimizations,
    use: (manifest) => resolveAndroidCas(root, { ...process.env, STIM_ANDROID_CAS_TOOLCHAIN: manifest }, layout),
  });
  const fallback = resolved.android.compilerCacheFallback;
  if (!fallback) return { cas, optimizations: resolved, warning: null };
  const message = compilerCacheFallbackMessage({
    fallback,
    compilerCache: resolved.android.compilerCache === 'none' ? 'none' : 'ccache',
    file: settingFile(settingsContext, fallback.key),
  });
  return { cas, optimizations: resolved, warning: `Warning: ${message}` };
}

export function resolveAndroidBuildPlan(
  {
    settings,
    settingsContext,
    easProfile,
    variant: variantFlag,
    buildCache: requestedBuildCache,
  }: AndroidBuildPlanInputs,
  {
    warn,
    runtimeKind,
    resolveCompilerCache = androidCompilerCache,
    resolveCacheProvider = resolveCacheProviderConfig,
    variantProblem,
    detectExpo = () => detectIsExpo(settingsContext.projectPath),
  }: AndroidBuildPlanDependencies,
): PlanResult<AndroidBuildPlan> {
  const root = settingsContext.projectPath;
  const [shapeError, ...moreShapeErrors] = settingShapeErrors(settings);
  if (shapeError) return fail('STIM_BAD_ARG', shapeError, SETTING_SHAPE_REMEDY, { lines: moreShapeErrors });
  const bound = settingsContext.repoRoot ?? root;
  const layoutError = androidLayoutError(settings, root, bound, detectExpo);
  if (layoutError) return fail('STIM_BAD_ARG', layoutError, SETTING_SHAPE_REMEDY);
  const layout = resolveAndroidLayout(settings, root, bound);
  for (const key of unknownSettingKeys(settings)) {
    warn('setting', `Warning: setting "${key}" is not read by Stim and will be ignored.`);
  }
  let optimizations: Optimizations;
  try {
    optimizations = resolveOptimizations(settings);
  } catch (error) {
    return fail('STIM_BAD_ARG', `Could not configure Android build: ${(error as Error).message}`, SETTING_SHAPE_REMEDY);
  }
  const compilerCache = resolveCompilerCache({ root, optimizations, settingsContext, layout });
  const cas = compilerCache.cas;
  optimizations = compilerCache.optimizations;
  if (compilerCache.warning) warn('cache', compilerCache.warning);
  const buildProfile = optimizationBuildProfile('android', optimizations);
  const cacheProviderConfig = resolveCacheProvider(settingsContext);
  const cacheProviderError = cacheProviderSettingError(settings);
  if (cacheProviderError) warn('cache', `${cacheProviderError} Using the local cache.`);
  const variant = easProfile !== undefined ? 'debug' : resolveVariant(variantFlag, settings);
  const flavorRefusal = variantProblem(variant);
  if (flavorRefusal) return fail(flavorRefusal.code, flavorRefusal.reason, flavorRefusal.remedy);
  const release = isReleaseVariant(variant);
  const cachePolicy = artifactCachePolicy(
    optimizations,
    requestedBuildCache,
    runtimeKind({ release }) === 'embedded-js',
  );
  return {
    ok: true,
    plan: {
      build: {
        variant,
        release,
        profile: buildProfile,
        cas,
        cache: cachePolicy,
        compilerCache: optimizations.android.compilerCache,
        gradleBuildCache: optimizations.android.gradleBuildCache,
        pch: optimizations.android.pch,
        targetAbiOnly: optimizations.android.targetAbiOnly,
      },
      metroWarmup: optimizations.metroWarmup,
      cacheProviderConfig,
    },
  };
}

export function resolveAndroidRunPlan(
  {
    settings,
    settingsContext,
    slot,
    easProfile,
    variant: variantFlag,
    systemImage: systemImageFlag,
    deviceProfile: deviceProfileFlag,
    device: deviceFlag,
    wait: waitFlag,
    waitConflict,
    remote: commandRemoteBackend,
    buildCache: requestedBuildCache,
  }: AndroidPlanInputs,
  {
    warn,
    runtimeKind,
    resolveCompilerCache = androidCompilerCache,
    resolveCacheProvider = resolveCacheProviderConfig,
    validateAvdConfig = androidAvdConfigSettingError,
    readFlavors = readProductFlavors,
    variantProblem = (variant) =>
      productFlavorRefusal({
        flavors: readFlavors(
          resolveAndroidLayout(
            settings,
            settingsContext.projectPath,
            settingsContext.repoRoot ?? settingsContext.projectPath,
          ),
        ),
        variant,
      }),
    detectExpo = () => detectIsExpo(settingsContext.projectPath),
    listSystemImages = listInstalledSystemImages,
    listDeviceProfiles = listAvdDeviceProfiles,
    parkedLimit = parkedMaxSetting,
    supportsFold = systemImageSupportsFold,
    ownedAvd = slotOwnedAvd,
  }: AndroidPlanDependencies,
): AndroidPlanResult {
  const root = settingsContext.projectPath;
  const [shapeError, ...moreShapeErrors] = [parkedLimit('android').error, ...settingShapeErrors(settings)].filter(
    (error): error is string => Boolean(error),
  );
  if (shapeError) {
    return fail('STIM_BAD_ARG', shapeError, SETTING_SHAPE_REMEDY, { lines: moreShapeErrors });
  }
  const plannedBuild = resolveAndroidBuildPlan(
    { settings, settingsContext, easProfile, variant: variantFlag, buildCache: requestedBuildCache },
    { warn, runtimeKind, resolveCompilerCache, resolveCacheProvider, variantProblem, detectExpo },
  );
  if (!plannedBuild.ok) return plannedBuild;
  const dataPartitionSizeError = androidDataPartitionSizeGbSettingError(settings);
  if (dataPartitionSizeError) {
    return fail(
      'STIM_BAD_ARG',
      dataPartitionSizeError,
      'Set android.dataPartitionSizeGb to a whole number of GiB from 6 through 16384.',
    );
  }
  const avdConfigError = validateAvdConfig(settings, root);
  if (avdConfigError) {
    return fail(
      'STIM_BAD_ARG',
      avdConfigError,
      'Use only documented android.avdConfig keys, or an android.avdConfigFile fragment contained by the app directory.',
    );
  }
  const systemImage = resolveSystemImage(systemImageFlag, settings);
  const deviceProfile = resolveDeviceProfile(deviceProfileFlag, settings);
  const isExpo = detectExpo();
  const physical = isPhysicalDeviceRequest(deviceFlag);
  if (physical && deviceFlag === '') {
    return fail(
      'STIM_BAD_ARG',
      '--device was given an empty serial.',
      'Pass `--device` on its own to take the first connected device this workspace can lease, or ' +
        '`--device <serial>` to name one.',
    );
  }
  if (physical && commandRemoteBackend) {
    return fail(
      'STIM_BAD_ARG',
      '--device installs on a device connected to this machine, and --remote installs on a remote one.',
      'Pass only one of --device and --remote.',
    );
  }
  const noWait = waitFlag === false;
  if (waitConflict) {
    return fail(
      'STIM_BAD_ARG',
      '--wait and --no-wait ask for opposite things.',
      'Pass only one of `--wait <seconds>` and `--no-wait`.',
    );
  }
  const waitParsed = parseDeviceWait(noWait ? undefined : waitFlag);
  if ('error' in waitParsed) {
    return fail(
      'STIM_BAD_ARG',
      waitParsed.error,
      'Pass a whole number of seconds, e.g. --wait 90. `--wait 0` refuses a busy lease or device slot at once.',
    );
  }
  const waitSeconds = waitParsed.seconds;

  const remoteTarget =
    commandRemoteBackend !== null ? parseAndroidRemote(commandRemoteBackend) : remoteAndroidSetting(settings);
  if (physical && remoteTarget?.kind === 'machine')
    return fail(
      'STIM_BAD_ARG',
      '--device installs on a phone connected to this machine, and --remote installs on a remote one.',
      'Pass only one of --device and --remote; unset android.remote for a local phone.',
    );
  const machine = remoteTarget?.kind === 'machine' ? remoteTarget.machine : null;
  const remoteBackend = !physical && remoteTarget?.kind === 'backend' ? remoteTarget.backend : null;
  if (!machine) {
    const refusal = androidDeviceSelectorRefusal(
      {
        settingsContext,
        slot,
        systemImageFlag,
        deviceProfileFlag,
        systemImage,
        deviceProfile,
        physical,
        remoteBackend,
      },
      { listSystemImages, listDeviceProfiles, supportsFold, ownedAvd },
    );
    if (refusal) return refusal;
  }
  const target: AndroidTargetPlan = physical
    ? { kind: 'physical', serial: typeof deviceFlag === 'string' ? deviceFlag : null, lease: { waitSeconds, noWait } }
    : machine
      ? { kind: 'hosted', machine, systemImage, deviceProfile }
      : remoteBackend
        ? { kind: 'remote', backend: remoteBackend, systemImage, deviceProfile }
        : { kind: 'emulator', systemImage, deviceProfile };
  return {
    ok: true,
    plan: {
      ...plannedBuild.plan,
      target,
      deviceSlotWaitMs: noWait
        ? 0
        : waitFlag === undefined && !physical
          ? DEFAULT_DEVICE_SLOT_WAIT_MS
          : waitSeconds * 1000,
      isExpo,
    },
  };
}

export function androidDeviceSelectorRefusal(
  {
    settingsContext,
    slot,
    systemImageFlag,
    deviceProfileFlag,
    systemImage,
    deviceProfile,
    physical,
    remoteBackend,
  }: {
    settingsContext: SettingsContext;
    slot: string;
    systemImageFlag: string | null;
    deviceProfileFlag?: string | null;
    systemImage: string | null;
    deviceProfile: string | null;
    physical: boolean;
    remoteBackend: RemoteDeviceBackend | null;
  },
  {
    listSystemImages = listInstalledSystemImages,
    listDeviceProfiles = listAvdDeviceProfiles,
    supportsFold = systemImageSupportsFold,
    ownedAvd = slotOwnedAvd,
  }: Pick<AndroidPlanDependencies, 'listSystemImages' | 'listDeviceProfiles' | 'supportsFold' | 'ownedAvd'> = {},
): Extract<AndroidPlanResult, { ok: false }> | null {
  const root = settingsContext.projectPath;
  const settingsLayersForOrigin = settingsLayers(settingsContext);
  const imageRefusal = systemImageRefusal({
    slot,
    flag: systemImageFlag,
    resolved: systemImage,
    origin: settingOriginScope(settingsLayersForOrigin, 'android.systemImage'),
    physical,
    remoteBackend,
    listImages: listSystemImages,
  });
  if (imageRefusal) return fail(imageRefusal.code, imageRefusal.message, imageRefusal.remedy);
  const profileRefusal = deviceProfileRefusal({
    flag: deviceProfileFlag,
    resolved: deviceProfile,
    origin: settingOriginScope(settingsLayersForOrigin, 'android.deviceProfile'),
    physical,
    remoteBackend,
    listProfiles: listDeviceProfiles,
  });
  if (profileRefusal) return fail(profileRefusal.code, profileRefusal.message, profileRefusal.remedy);
  const avdFlagRefusal = remoteAvdFlagRefusal({
    systemImageFlag,
    deviceProfileFlag,
    remoteBackend,
  });
  if (avdFlagRefusal) return fail(avdFlagRefusal.code, avdFlagRefusal.message, avdFlagRefusal.remedy);
  if (!physical && !remoteBackend) {
    const flagImage = typeof systemImageFlag === 'string' && systemImageFlag.trim() ? systemImageFlag.trim() : null;
    const existing = ownedAvd(root, slot);
    const profile = deviceProfile ?? existing?.deviceProfile ?? DEFAULT_AVD_DEVICE_PROFILE;
    const image = () =>
      flagImage ?? existing?.systemImage ?? systemImage ?? pickDefaultSystemImage(listSystemImages())?.pkg ?? null;
    const checked = profileNeedsFoldFeature(profile) ? image() : null;
    const foldRefusal =
      checked !== null &&
      foldableImageRefusal({
        profile,
        image: checked,
        avdName:
          existing && existing.systemImage === checked && existing.deviceProfile === profile ? existing.avdName : null,
        images: listSystemImages,
        supportsFold,
      });
    if (foldRefusal) return fail(foldRefusal.code, foldRefusal.message, foldRefusal.remedy);
  }
  return null;
}
