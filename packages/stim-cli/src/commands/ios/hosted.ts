import { hostedIosStatus, type HostedDeviceSelectors } from '@stim-cli/core/state';
import type { HostedIosTarget } from '../../device-host/hosted-ios.ts';
import type { IosDeps } from './dependencies.ts';
import type { PreparedIosArtifact } from './artifact.ts';
import { reportIosResult, type ReportIosResultArgs } from './result.ts';
import type { FailArgs } from './types.ts';
import type { IosRunCompletion } from './launch.ts';
import { launchSlotScope, siblingPlatformSlots } from '../../engine/slot-launch.ts';
import { MODE_BARE, MODE_EXPO } from '../../supervisor/state.ts';

export async function finishHostedIosRun({
  target,
  d,
  artifact,
  root,
  slot,
  release,
  isExpo,
  metroCheck,
  metroPort,
  logsDir,
  fail,
  note,
  selectors,
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
> & {
  target: HostedIosTarget;
  d: IosDeps;
  artifact: PreparedIosArtifact;
  isExpo: boolean;
  slot: string;
  fail: (failure: FailArgs) => null;
  note: (line: string) => void;
  selectors: HostedDeviceSelectors;
}): Promise<IosRunCompletion | null> {
  const bundleId = artifact.bundleId;
  if (!bundleId) return fail({ code: 'STIM_INSTALL_FAILED', message: 'The built app has no bundle identifier.' });
  const launchedAt = d.now();
  let run;
  try {
    run = await d.placeHostedIos(target, {
      root,
      slot,
      bundle: artifact.path,
      bundleId,
      selectors,
      release,
      ...(!release && isExpo ? { devClientScheme: d.devClientScheme(root, artifact.path) ?? undefined } : {}),
      reserved: (placement) => d.writeHostedIos(root, slot, placement),
      note,
    });
  } catch (error) {
    return fail({
      code: (error as Error & { code?: string }).code ?? 'STIM_HOSTING_REFUSED',
      message: (error as Error).message,
      remedy: `The placement stays recorded. Retry stim ios --remote ${target.host.machine}, or run stim stop.`,
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
      launchedAt: new Date(launchedAt).toISOString(),
    },
    slot,
  );
  let launched: true | 'unverified' | 'bundling' = run.launched;
  if (!release && metroCheck) {
    const evidence = await d.verifyLaunch({
      requireBundleResponse: true,
      platform: 'ios',
      logsDir,
      since: launchedAt,
      metroPort,
      mode: isExpo ? MODE_EXPO : MODE_BARE,
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
    root,
    slot,
    release,
    metroCheck,
    metroPort,
    logsDir,
    device: { deviceName: device.name, deviceType: device.deviceType, runtime: device.runtime },
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
