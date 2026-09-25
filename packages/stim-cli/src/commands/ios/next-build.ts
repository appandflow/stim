import chalk from 'chalk';
import { buildCacheKey } from '../../cache/build-cache.ts';
import { phaseLine } from '../../command-output.ts';
import { planEasDevelopmentBuild } from '../../engine/eas-build.ts';
import { statsProjectKey } from '../../engine/stats.ts';
import { artifactCachePolicy, optimizationBuildProfile, resolveOptimizations } from '../../optimizations.ts';
import { appProjectProblem, NO_PROJECT_REFUSAL } from '../../workspace/project.ts';
import {
  cacheProviderSettingError,
  remoteIosSetting,
  SETTING_SHAPE_REMEDY,
  settingShapeErrors,
} from '../../workspace/settings.ts';
import { planCachedBuild, planFlagRefusal, planPayload, printPlan, refusePlan } from '../build-plan.ts';
import { isPhysicalDeviceRequest } from '../native-runtime.ts';
import type { IosDeps } from './dependencies.ts';
import {
  deviceModelRefusal,
  isReleaseConfiguration,
  PLATFORM,
  resolveConfiguration,
  resolveDeviceType,
  resolveRuntime,
} from './support.ts';
import type { FailArgs, IosCommandOptions } from './types.ts';

type Refusal = { code: string; message: string; remedy: string };

function note(line: string): void {
  console.error(line);
}

function runOnlyFlag(opts: IosCommandOptions): string | null {
  if (isPhysicalDeviceRequest(opts.device)) return '--device';
  if (opts.remote) return '--remote';
  if (opts.wait !== undefined) return opts.wait === false ? '--no-wait' : '--wait';
  if (opts.simulatorApp !== undefined) return '--simulator-app';
  if (opts.metroCheck === false) return '--no-metro-check';
  return null;
}

export async function planIos(
  opts: IosCommandOptions,
  d: IosDeps,
  schemeRefusal: (root: string, scheme: string | undefined, isExpo: boolean) => FailArgs | null,
): Promise<void> {
  const json = Boolean(opts.json);
  const refuse = (refusal: Refusal, lines: string[] = []) => refusePlan(refusal, json, lines);
  const flag = runOnlyFlag(opts);
  if (flag) return refuse(planFlagRefusal(flag));
  const root = d.findProjectRoot(process.cwd());
  if (!root) return refuse(NO_PROJECT_REFUSAL);
  const projectProblem = appProjectProblem(root);
  if (projectProblem) return refuse({ code: 'STIM_NO_PROJECT', ...projectProblem });

  const settingsContext = { projectPath: root, gitCommonDir: d.gitCommonDir(root), repoRoot: d.repoRoot(root) };
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
  const modelRefusal = deviceModelRefusal({
    slot,
    deviceTypeFlag: opts.deviceType,
    runtimeFlag: opts.runtime,
    deviceType: resolveDeviceType(opts.deviceType, settings),
    runtime: resolveRuntime(opts.runtime, settings),
    physical: false,
    remoteBackend: remoteIosSetting(settings),
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
    return printPlan(
      planPayload(target, {
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

  const refusal = schemeRefusal(root, opts.scheme, isExpo);
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
  const cacheKey = buildCacheKey(PLATFORM, fingerprint.hash, {
    scheme: opts.scheme,
    ...(configuration ? { configuration } : {}),
    isSimulator: true,
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
        cachePolicy.remote && !buildProfile && !opts.scheme
          ? { runOptions: configuration ? { configuration } : null }
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
  printPlan(plan, json);
}
