import { hostedIosStatus, type HostedDeviceSelectors, type HostedAppOffer } from '@stim-cli/core/state';
import type { HostedIosTarget } from '../../device-host/hosted-ios.ts';
import type { IosDeps } from './dependencies.ts';
import type { PreparedIosArtifact } from './artifact.ts';
import { reportIosResult, type ReportIosResultArgs } from './result.ts';
import type { FailArgs } from './types.ts';
import type { BuildPhase } from '../../engine/build-progress.ts';
import type { IosRunCompletion } from './launch.ts';
import { launchSlotScope, siblingPlatformSlots } from '../../engine/slot-launch.ts';
import { workspaceDevServerMode } from '../../supervisor/state.ts';

export async function finishHostedIosRun({
  target,
  d,
  artifact,
  root,
  slot,
  release,
  appMode,
  isExpo,
  metroCheck,
  metroPort,
  logsDir,
  fail,
  note,
  enterPhase,
  selectors,
  projectBundleId,
  ...report
}: Pick<
  ReportIosResultArgs,
  | 'root'
  | 'slot'
  | 'release'
  | 'metroCheck'
  | 'metroPort'
  | 'logsDir'
  | 'json'
  | 'configuration'
  | 'buildScheme'
  | 'elapsed'
  | 'startedAt'
  | 'closeWriter'
  | 'recordRun'
  | 'reclaimed'
  | 'devServer'
  | 'devicePlacement'
> & {
  target: HostedIosTarget;
  d: IosDeps;
  artifact: PreparedIosArtifact;
  isExpo: boolean;
  appMode: HostedAppOffer['mode'];
  slot: string;
  fail: (failure: FailArgs) => null;
  note: (line: string) => void;
  enterPhase: (phase: BuildPhase) => void;
  selectors: HostedDeviceSelectors;
  projectBundleId: () => string | null;
}): Promise<IosRunCompletion | null> {
  const bundleId = artifact.bundleId ?? (d.readBundleId(artifact.path) || projectBundleId());
  if (!bundleId) return fail({ code: 'STIM_INSTALL_FAILED', message: 'The built app has no bundle identifier.' });
  const launchedAt = d.now();
  let run;
  try {
    run = await d.placeHostedIos(target, {
      root,
      slot,
      bundle: artifact.path,
      handoff: artifact.handoff,
      bundleId,
      selectors,
      release,
      mode: appMode,
      ...(appMode === 'development' && isExpo
        ? { devClientScheme: d.devClientScheme(root, artifact.path) ?? undefined }
        : {}),
      reserved: (placement) => d.writeHostedIos(root, slot, placement),
      note,
      enterPhase,
    });
  } catch (error) {
    return fail({
      code: (error as Error & { code?: string }).code ?? 'STIM_HOSTING_REFUSED',
      message: (error as Error).message,
      remedy:
        error instanceof Error && 'remedy' in error && typeof error.remedy === 'string'
          ? error.remedy
          : `Retry stim ios --remote ${target.host.machine}, or run stim stop to reconcile any recorded placement.`,
    });
  }
  d.writeHostedIos(root, slot, run.placement);
  d.writeWorkspaceLaunch(
    root,
    'ios',
    {
      appId: bundleId,
      deviceId: run.placement.session,
      metroPort,
      release,
      ...(appMode === 'process' ? { runtime: 'process' as const } : {}),
      launchedAt: new Date(launchedAt).toISOString(),
    },
    slot,
  );
  let launched: true | 'unverified' | 'bundling' = run.launched;
  if (appMode === 'development' && metroCheck) {
    const evidence = await d.verifyLaunch({
      requireBundleResponse: true,
      platform: 'ios',
      logsDir,
      since: launchedAt,
      metroPort,
      mode: workspaceDevServerMode(root, isExpo),
      slot: launchSlotScope(root, slot),
      platformShared: siblingPlatformSlots(root, 'ios', slot).length > 0,
    });
    if (evidence.fatal)
      return fail({
        code: 'STIM_LAUNCH_FAILED',
        message: 'Metro could not deliver the hosted app bundle.',
        remedy: 'Run stim logs --errors and fix the bundle error.',
      });
    launched = evidence.verified ? true : evidence.requested ? 'bundling' : 'unverified';
  }
  if (launched === 'unverified')
    note(
      `Launch on ${target.host.machine} is unverified; check the hosted app, then retry stim ios --remote ${target.host.machine}.`,
    );
  const cache = artifact.cache;
  const device = run.placement.device!;
  const uploadsAbandoned = await artifact.completeUploads();
  const facts = reportIosResult({
    ...report,
    ...(appMode === 'process' ? { runtimeKind: 'process' as const } : {}),
    root,
    slot,
    release,
    metroCheck,
    metroPort,
    logsDir,
    device: { deviceName: device.deviceType, deviceType: device.deviceType, runtime: device.runtime },
    udid: '',
    host: hostedIosStatus(run.placement),
    appPath: artifact.path,
    bundleId,
    installSkipped: false,
    storeHash: cache.identity?.fingerprint ?? null,
    storeKey: cache.identity?.key ?? null,
    cacheHit: cache.hit,
    missReason: cache.missReason,
    compilationCache: cache.compilation,
    useBuildCache: cache.readEnabled,
    waitedForBuild: cache.waitedForBuild,
    launchState: launched,
    providerName: cache.providerName,
    buildMachine: cache.buildMachine,
    builtOn: cache.builtOn,
    offloadedTo: cache.offloadedTo,
    offloadFallback: cache.offloadFallback,
    webPreviewUrl: null,
  });
  return { facts, uploadsAbandoned };
}
