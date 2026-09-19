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
import { productFlavorRefusal, readProductFlavors } from '../../engine/gradle.ts';
import { detectIsExpo } from '../../project.ts';
import { listInstalledSystemImages } from '../../sim/android.ts';
import { parkedMaxSetting } from '../../sim-pool.ts';
import type { RemoteDeviceBackend } from '../../engine/device-remote.ts';
import type { SettingsObject } from '../../settings-types.ts';
import {
  androidAvdConfigSettingError,
  androidDataPartitionSizeGbSettingError,
  cacheProviderSettingError,
  remoteAndroidSetting,
  remoteDeviceSettingError,
  resolveCacheProviderConfig,
  REMOTE_DEVICE_BACKENDS,
  SETTING_SHAPE_REMEDY,
  settingFile,
  settingShapeErrors,
  unknownSettingKeys,
} from '../../settings.ts';
import { isPhysicalDeviceRequest } from '../native-runtime.ts';
import { isReleaseVariant, resolveSystemImage, resolveVariant, systemImageRefusal } from './support.ts';

interface SettingsContext {
  readonly projectPath: string;
  readonly gitCommonDir: string | null;
  readonly repoRoot: string | null;
}

export interface AndroidPlanInputs {
  readonly settings: SettingsObject;
  readonly settingsContext: SettingsContext;
  readonly slot: string;
  readonly easProfile?: string;
  readonly variant: string | null;
  readonly systemImage: string | null;
  readonly device: string | boolean | null;
  readonly wait: string | boolean | undefined;
  readonly waitConflict: boolean;
  readonly remote: RemoteDeviceBackend | null;
  readonly buildCache: boolean;
}

type AndroidTargetPlan =
  | { readonly kind: 'emulator'; readonly systemImage: string | null }
  | { readonly kind: 'remote'; readonly backend: RemoteDeviceBackend; readonly systemImage: string | null }
  | {
      readonly kind: 'physical';
      readonly serial: string | null;
      readonly lease: { readonly waitSeconds: number; readonly noWait: boolean };
    };

export interface AndroidRunPlan {
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
  readonly target: AndroidTargetPlan;
  readonly isExpo: boolean;
  readonly metroWarmup: boolean;
  readonly cacheProviderConfig: CacheProviderConfig | null;
}

export type AndroidPlanResult =
  | { readonly ok: true; readonly plan: AndroidRunPlan }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly remedy: string;
      readonly lines: string[];
    };

export interface AndroidPlanDependencies {
  warn: (label: 'setting' | 'cache', message: string) => void;
  resolveCompilerCache?: typeof androidCompilerCache;
  resolveCacheProvider?: typeof resolveCacheProviderConfig;
  validateAvdConfig?: typeof androidAvdConfigSettingError;
  readFlavors?: typeof readProductFlavors;
  detectExpo?: typeof detectIsExpo;
  listSystemImages?: typeof listInstalledSystemImages;
  parkedLimit?: typeof parkedMaxSetting;
}

function fail(
  code: string,
  message: string,
  remedy: string,
  { lines = [] }: { lines?: string[] } = {},
): AndroidPlanResult {
  return { ok: false, code, message, remedy, lines };
}

function androidCompilerCache({
  root,
  optimizations,
  settingsContext,
}: {
  root: string;
  optimizations: Optimizations;
  settingsContext: SettingsContext;
}): { cas: ReturnType<typeof resolveAndroidCas>; optimizations: Optimizations; warning: string | null } {
  const { cas, optimizations: resolved } = resolveAndroidCompilerCache({
    optimizations,
    use: (manifest) => resolveAndroidCas(root, { ...process.env, STIM_ANDROID_CAS_TOOLCHAIN: manifest }),
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

export function resolveAndroidRunPlan(
  {
    settings,
    settingsContext,
    slot,
    easProfile,
    variant: variantFlag,
    systemImage: systemImageFlag,
    device: deviceFlag,
    wait: waitFlag,
    waitConflict,
    remote: commandRemoteBackend,
    buildCache: requestedBuildCache,
  }: AndroidPlanInputs,
  {
    warn,
    resolveCompilerCache = androidCompilerCache,
    resolveCacheProvider = resolveCacheProviderConfig,
    validateAvdConfig = androidAvdConfigSettingError,
    readFlavors = readProductFlavors,
    detectExpo = detectIsExpo,
    listSystemImages = listInstalledSystemImages,
    parkedLimit = parkedMaxSetting,
  }: AndroidPlanDependencies,
): AndroidPlanResult {
  const root = settingsContext.projectPath;
  const [shapeError, ...moreShapeErrors] = [parkedLimit('android').error, ...settingShapeErrors(settings)].filter(
    (error): error is string => Boolean(error),
  );
  if (shapeError) {
    return fail('STIM_BAD_ARG', shapeError, SETTING_SHAPE_REMEDY, { lines: moreShapeErrors });
  }
  for (const key of unknownSettingKeys(settings)) {
    warn('setting', `Warning: setting "${key}" is not read by Stim and will be ignored.`);
  }
  let optimizations: Optimizations;
  try {
    optimizations = resolveOptimizations(settings);
  } catch (error) {
    return fail('STIM_BAD_ARG', `Could not configure Android build: ${(error as Error).message}`, SETTING_SHAPE_REMEDY);
  }
  const compilerCache = resolveCompilerCache({ root, optimizations, settingsContext });
  const cas = compilerCache.cas;
  optimizations = compilerCache.optimizations;
  if (compilerCache.warning) warn('cache', compilerCache.warning);
  const buildProfile = optimizationBuildProfile('android', optimizations);
  const cacheProviderConfig = resolveCacheProvider(settingsContext);
  const cacheProviderError = cacheProviderSettingError(settings);
  if (cacheProviderError) warn('cache', `${cacheProviderError} Using the local cache.`);
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
  const remoteSettingError = remoteDeviceSettingError(settings);
  if (remoteSettingError) {
    return fail(
      'STIM_BAD_ARG',
      remoteSettingError,
      `Set ios.remote and android.remote to one of: ${REMOTE_DEVICE_BACKENDS.join(', ')}.`,
    );
  }
  const systemImage = resolveSystemImage(systemImageFlag, settings);
  const variant = easProfile !== undefined ? 'debug' : resolveVariant(variantFlag, settings);
  const flavorRefusal = productFlavorRefusal({ flavors: readFlavors(root), variant });
  if (flavorRefusal) return fail(flavorRefusal.code, flavorRefusal.reason, flavorRefusal.remedy);
  const release = isReleaseVariant(variant);
  const cachePolicy = artifactCachePolicy(optimizations, requestedBuildCache, release);
  const isExpo = detectExpo(root);
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
  const waitFlagged = waitFlag !== undefined;
  if (waitConflict) {
    return fail(
      'STIM_BAD_ARG',
      '--wait and --no-wait ask for opposite things.',
      'Pass `--wait <seconds>` to wait for the lease, or `--no-wait` to install without one.',
    );
  }
  if (waitFlagged && !physical) {
    return fail(
      'STIM_BAD_ARG',
      '--wait and --no-wait only apply to a `--device` run.',
      'This workspace owns its emulator, so nothing contends for it. Drop the flag, or pass `--device`.',
    );
  }
  const waitParsed = parseDeviceWait(noWait ? undefined : waitFlag);
  if ('error' in waitParsed) {
    return fail(
      'STIM_BAD_ARG',
      waitParsed.error,
      'Pass a whole number of seconds, e.g. --wait 90. `--wait 0` refuses a leased device at once.',
    );
  }
  const waitSeconds = waitParsed.seconds;

  const remoteBackend = physical ? null : (commandRemoteBackend ?? remoteAndroidSetting(settings));
  const imageRefusal = systemImageRefusal({
    slot,
    flag: systemImageFlag,
    resolved: systemImage,
    physical,
    remoteBackend,
    listImages: listSystemImages,
  });
  if (imageRefusal) return fail(imageRefusal.code, imageRefusal.message, imageRefusal.remedy);
  const target: AndroidTargetPlan = physical
    ? { kind: 'physical', serial: typeof deviceFlag === 'string' ? deviceFlag : null, lease: { waitSeconds, noWait } }
    : remoteBackend
      ? { kind: 'remote', backend: remoteBackend, systemImage }
      : { kind: 'emulator', systemImage };
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
      target,
      isExpo,
      metroWarmup: optimizations.metroWarmup,
      cacheProviderConfig,
    },
  };
}
