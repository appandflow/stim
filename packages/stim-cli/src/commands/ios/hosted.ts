import { hostedIosStatus, type HostedDeviceSelectors, type HostedAppOffer } from '@stim-cli/core/state';
import type { HostedIosTarget } from '../../device-host/hosted-ios.ts';
import type { IosDeps } from './dependencies.ts';
import type { PreparedIosArtifact } from './artifact.ts';
import { reportIosResult, type ReportIosResultArgs } from './result.ts';
import type { FailArgs } from './types.ts';
import type { BuildPhase, BuildProgress } from '../../engine/build-progress.ts';
import { verifyIosMetroRun, type IosRunCompletion } from './launch.ts';
import { LAUNCH_BUNDLING, LAUNCH_FATAL } from '../../engine/launch-verify.ts';
import { launchOutcomeRecord } from '../native-runtime.ts';

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
  phase,
  enterPhase,
  enterActivity,
  selectors,
  projectBundleId,
  logWriter,
  ...report
}: Pick<
  ReportIosResultArgs,
  | 'output'
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
  phase: (name: unknown, text: string) => void;
  enterPhase: (phase: BuildPhase) => void;
  enterActivity?: BuildProgress['activity'];
  selectors: HostedDeviceSelectors;
  projectBundleId: () => string | null | Promise<string | null>;
  logWriter: () => { write: (record: Record<string, unknown>) => void };
}): Promise<IosRunCompletion | null> {
  const bundleId = artifact.bundleId ?? ((await d.readBundleId(artifact.path)) || (await projectBundleId()));
  if (!bundleId) return fail({ code: 'STIM_INSTALL_FAILED', message: 'The built app has no bundle identifier.' });
  const devClientScheme =
    appMode === 'development' && isExpo ? (d.devClientScheme(root, artifact.path) ?? undefined) : undefined;
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
      ...(appMode === 'development' && isExpo ? { devClientScheme } : {}),
      metroPort,
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
  await d.writeHostedIos(root, slot, run.placement);
  logWriter().write({
    src: 'build',
    level: 'info',
    marker: true,
    event: 'launch_attempt',
    ts: launchedAt,
    platform: 'ios',
    appId: bundleId,
    deviceId: run.placement.session,
    remote: true,
    host: target.host.machine,
    msg: `launching ${bundleId} on ${target.host.machine}`,
  });
  await d.writeWorkspaceLaunch(
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
  let launchWarning: string | undefined;
  let unattributed = false;
  if (appMode === 'development') {
    const hostedLogs = d.followHostedLaunchLogs(root, slot, 'ios', launchedAt);
    let verification;
    try {
      verification = await verifyIosMetroRun({
        root,
        slot,
        appPath: artifact.path,
        d,
        launched: {},
        configuration: report.configuration,
        phase,
        note,
        metroCheck,
        logsDir,
        launchedAt,
        metroPort,
        isExpo,
        bundleId,
        udid: run.placement.device?.udid ?? '',
        scheme: devClientScheme,
        physical: false,
        appName: null,
        lanAddress: null,
        lanOrigin: null,
        remoteDevice: true,
        metroOrigin: null,
        enterActivity,
        hostedLogs,
      });
    } finally {
      hostedLogs.stop();
    }
    if (verification.state === LAUNCH_FATAL)
      return fail({
        code: 'STIM_LAUNCH_FAILED',
        message: 'The app failed its launch readiness check.',
        remedy: `Read the launch error above or run \`stim logs --errors\`. The full timeline is in ${logsDir}.`,
        logPath: logsDir,
      });
    launched = verification.state === true ? true : verification.state === LAUNCH_BUNDLING ? 'bundling' : 'unverified';
    launchWarning = verification.warning;
    unattributed = verification.unattributed ?? false;
  }
  logWriter().write(
    launchOutcomeRecord({
      launchState: launched,
      release,
      process: appMode === 'process',
      bundleId,
      configuration: report.configuration,
      metroPort,
      unattributed,
    }),
  );
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
    launchWarning,
    providerName: cache.providerName,
    buildMachine: cache.buildMachine,
    builtOn: cache.builtOn,
    offloadedTo: cache.offloadedTo,
    offloadFallback: cache.offloadFallback,
    webPreviewUrl: null,
  });
  return { facts, uploadsAbandoned };
}
