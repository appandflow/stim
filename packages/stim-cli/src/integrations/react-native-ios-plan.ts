import chalk from 'chalk';
import { buildCacheKey } from '../cache/build-cache.ts';
import { phaseLine } from '../command-output.ts';
import { planEasDevelopmentBuild } from '../engine/eas-build.ts';
import { statsProjectKey } from '../engine/stats.ts';
import { artifactCachePolicy, optimizationBuildProfile, resolveOptimizations } from '../optimizations.ts';
import {
  cacheProviderSettingError,
  projectSettingsContext,
  publicUrlSetting,
  remoteEasFallbackSetting,
  remoteIosSetting,
  SETTING_SHAPE_REMEDY,
  settingShapeErrors,
  tunnelModeSetting,
} from '../workspace/settings.ts';
import { planCachedBuild, planPayload } from '../commands/build-plan.ts';
import { planHostedDevice } from '../device-host/plan-placement.ts';
import type { SimulatorArch } from '../engine/agent-device.ts';
import type { IosDeps } from '../commands/ios/dependencies.ts';
import {
  resolveSchemeSelection,
  deviceModelRefusal,
  isReleaseConfiguration,
  PLATFORM,
  resolveConfiguration,
  resolveDeviceType,
  resolveRuntime,
  simulatorBuildArch,
  iosProviderRunOptions,
} from '../commands/ios/support.ts';
import { hostedIosSelectors } from '../commands/ios/remote.ts';
import type { FailArgs, IosCommandOptions } from '../commands/ios/types.ts';

import type { PlanRefusal, ProjectPlanResult } from './project-plan.ts';

function note(line: string): void {
  console.error(line);
}

function refuse(refusal: PlanRefusal, lines: string[] = []): ProjectPlanResult {
  return { refusal, lines };
}

export async function planReactNativeIos(
  root: string,
  opts: IosCommandOptions,
  d: IosDeps,
  schemeProblem: (scheme: string | undefined) => FailArgs | null,
): Promise<ProjectPlanResult> {
  const settingsContext = projectSettingsContext(root, d);
  const settings = d.resolveSettings(settingsContext);
  const [shapeError, ...moreShapeErrors] = settingShapeErrors(settings);
  if (shapeError)
    return refuse({ code: 'STIM_BAD_ARG', message: shapeError, remedy: SETTING_SHAPE_REMEDY }, moreShapeErrors);
  let optimizations;
  try {
    optimizations = resolveOptimizations(settings);
  } catch (error) {
    return refuse({ code: 'STIM_BAD_ARG', message: (error as Error).message, remedy: SETTING_SHAPE_REMEDY });
  }
  const cacheProviderError = cacheProviderSettingError(settings);
  if (cacheProviderError) note(chalk.yellow(phaseLine('cache', `${cacheProviderError} Using the local cache.`)));

  const slot = opts.slot ?? 'default';
  const target = {
    platform: PLATFORM,
    slot,
    root,
    projectKey: statsProjectKey({ root, commonDir: settingsContext.gitCommonDir, repoRoot: settingsContext.repoRoot }),
  } as const;
  const isExpo = d.detectIsExpo(root);
  const settingsLayersForOrigin = d.settingsLayers(settingsContext);
  const iosRemote = remoteIosSetting(settings);
  const modelRefusal = deviceModelRefusal({
    slot,
    deviceTypeFlag: opts.deviceType,
    runtimeFlag: opts.runtime,
    deviceType: resolveDeviceType(opts.deviceType, settings),
    runtime: resolveRuntime(opts.runtime, settings),
    deviceTypeOrigin: d.settingOriginScope(settingsLayersForOrigin, 'ios.deviceType'),
    runtimeOrigin: d.settingOriginScope(settingsLayersForOrigin, 'ios.runtime'),
    physical: false,
    remoteBackend: iosRemote?.kind === 'backend' ? iosRemote.backend : null,
    hosted: iosRemote?.kind === 'machine',
    listRuntimes: d.listIosRuntimes,
  });
  if (modelRefusal) return refuse(modelRefusal);

  if (opts.easProfile !== undefined) {
    const eas = await planEasDevelopmentBuild({
      root,
      platform: PLATFORM,
      profile: opts.easProfile,
      note,
      isExpo,
      selectors: [opts.scheme, opts.configuration],
      buildCache: opts.buildCache,
    });
    if (!eas.ok) return refuse(eas);
    return planPayload(target, {
      fingerprint: eas.fingerprint,
      cacheKey: eas.cacheKey,
      cacheHit: eas.buildId ? 'remote' : false,
      provider: 'eas',
      cacheSkipped: false,
      prebuild: null,
      refusal: eas.missing,
    });
  }

  if (iosRemote?.kind === 'backend') {
    return refuse({
      code: 'STIM_BAD_ARG',
      message: `ios.remote is ${iosRemote.backend}, whose simulator architecture --plan cannot read without a session.`,
      remedy: 'Run `stim ios` to build for the remote device, or unset ios.remote to plan the owned simulator.',
    });
  }
  const scheme = resolveSchemeSelection(opts, settings);
  const refusal = schemeProblem(scheme);
  if (refusal) return refuse({ code: refusal.code, message: refusal.message ?? '', remedy: refusal.remedy ?? '' });
  const configuration = resolveConfiguration(opts.configuration, settings);
  const buildProfile = optimizationBuildProfile('ios', optimizations);
  const cachePolicy = artifactCachePolicy(
    optimizations,
    opts.buildCache !== false,
    isReleaseConfiguration(configuration),
  );

  let fingerprint;
  try {
    fingerprint = await d.fingerprintProject(root, { platform: PLATFORM });
  } catch (error) {
    note(chalk.dim(`Fingerprinting failed: ${(error as Error)?.message || error}`));
  }
  if (!fingerprint?.hash) {
    return refuse({
      code: 'STIM_NO_FINGERPRINT',
      message: `Could not fingerprint ${root}: @expo/fingerprint produced no hash for it.`,
      remedy: 'Check the project native inputs and the @expo/fingerprint error above, then retry.',
    });
  }
  const keyArch = (remoteArch: SimulatorArch | null) =>
    simulatorBuildArch({ physical: false, remoteArch, hostArch: d.hostSimulatorArch(), configuration });
  let arch = keyArch(null);
  let placement: string | undefined;
  if (iosRemote?.kind === 'machine') {
    const planned = await planHostedDevice({
      root,
      slot,
      platform: 'ios',
      machine: iosRemote.machine,
      selectors: hostedIosSelectors(
        resolveDeviceType(opts.deviceType, settings),
        resolveRuntime(opts.runtime, settings),
      ),
      sameKey: (choice) => keyArch('runtime' in choice ? choice.architecture : null) === arch,
      ...(remoteEasFallbackSetting(settings)
        ? {
            eas: () =>
              d.checkEasFallback({
                root,
                platform: 'ios',
                slot,
                release: isReleaseConfiguration(configuration),
                isExpo,
                tunnelMode: tunnelModeSetting(settings),
                publicUrl: publicUrlSetting(settings),
                deviceTypeFlag: opts.deviceType,
                localOnlyFlags: typeof opts.runtime === 'string' ? ['--runtime'] : [],
              }),
          }
        : {}),
    });
    if (planned.kind === 'unknown') {
      return refuse({
        code: 'STIM_BAD_ARG',
        message: `ios.remote is ${iosRemote.machine}, and its simulator architecture is unknown here: ${planned.reason}.`,
        remedy: 'Run `stim ios` to build for the remote device, or unset ios.remote to plan the owned simulator.',
      });
    }
    placement = planned.placement;
    if (planned.kind === 'hosted' && 'runtime' in planned.choice) arch = keyArch(planned.choice.architecture);
  }
  const cacheKey = buildCacheKey(PLATFORM, fingerprint.hash, {
    scheme,
    ...(configuration ? { configuration } : {}),
    isSimulator: true,
    ...(arch ? { arch } : {}),
    ...(buildProfile ? { buildProfile } : {}),
  });
  const plan = await planCachedBuild(
    {
      ...target,
      isExpo,
      fingerprint: fingerprint.hash,
      sources: fingerprint.sources ?? [],
      cacheKey,
      cachePolicy,
      providerConfig: d.resolveCacheProviderConfig(settingsContext),
      expoRemote:
        cachePolicy.remote && !buildProfile && !scheme
          ? { runOptions: iosProviderRunOptions(configuration, arch) }
          : null,
    },
    {
      loadCacheProvider: d.loadCacheProvider,
      loadProjectProvider: d.loadProjectProvider,
      checkEasAuth: d.checkEasAuth,
      resolveRemote: d.resolveRemote,
      planPrebuild: d.planPrebuild,
      note,
    },
  );
  return placement ? { ...plan, placement } : plan;
}
