import type { PreparedIosArtifact } from './artifact.ts';
import { launchSlotScope, nativeRunCommand, siblingPlatformSlots } from '../../engine/slot-launch.ts';
import { basename } from 'node:path';
import chalk from 'chalk';
import type { BuildPhase, BuildProgress } from '../../engine/build-progress.ts';
import {
  DEFAULT_METRO_PORT,
  IOS_DEV_MENU_OFF_DEFAULTS_PLIST,
  devClientUrl,
  iosAppProcess,
  restartedAppNote,
} from '../../engine/app-install.ts';
import {
  LAUNCH_BUNDLING,
  LAUNCH_FATAL,
  LAUNCH_UNVERIFIED,
  readCollectorRecords,
  unattributedLaunchLines,
  unverifiedLaunchLines,
  RELEASE_VERIFY_WAIT_MS,
} from '../../engine/launch-verify.ts';
import type { IosDeps } from './dependencies.ts';
import {
  formatDuration,
  appReadinessMessage,
  phaseLine,
  launchErrorReport,
  type LaunchErrorRecord,
  stepTimer,
} from '../../command-output.ts';
import { localNetworkPending, iosDeviceBounds, isWirelessIosDevice } from '../../engine/ios-device.ts';
import { launchErrorPreview } from '../../diagnostics/launch-error-preview.ts';
import { workspaceDevServerMode } from '../../supervisor/state.ts';
import type { VerifyLaunchResultLike, DeviceLike, IosBootLike, FailArgs } from './types.ts';
import { PLATFORM, deviceLabel, deviceShortName, appNameFromPath } from './support.ts';
import { type RunLease, DEBUG_VERIFY_STEP_MS, lostLine, lostRefusal } from '../../engine/device-lease-run.ts';
import type { IosFacts } from '../../engine/build-facts.ts';
import type { NdjsonWriter } from '../../ndjson.ts';
import { type ReportIosResultArgs, reportIosResult } from './result.ts';
import { workspaceLinks } from '../../devices/stim-desktop.ts';
import { launchOutcomeRecord, type MobileRuntimePreparation, type RuntimeReadiness } from '../native-runtime.ts';
import type { RuntimePlan } from '../../engine/runtime-plan.ts';
import { COLLECTOR_EXIT_WAIT_MS } from './collector.ts';
import {
  captureNativeCrashes,
  IOS_CRASH_REPORT_RETRY,
  printNativeCrashReport,
  simulatorConsolePaths,
} from '../../diagnostics/native-crash.ts';
import { errorDiagnostics } from '../../diagnostics/error-diagnostics.ts';

interface VerifyIosRunArgs {
  root: string;
  slot?: string;
  appPath: string | null;
  d: IosDeps;
  launched: ReturnType<IosDeps['launchIosApp']>;
  configuration: string | null;
  phase: (name: unknown, text: string) => void;
  note: (line: string) => void;
  metroCheck: boolean;
  logsDir: string;
  launchedAt: number;
  metroPort: number | null;
  isExpo: boolean;
  bundleId: string;
  udid: string;
  scheme?: string;
  physical: boolean;
  appName: string | null;
  lanAddress: string | null;
  lanOrigin: string | null;
  remoteDevice: boolean;
  metroOrigin: string | null;
  enterActivity?: BuildProgress['activity'];
}

interface IosRuntimeRoute {
  metroPort: number | null;
  devClientScheme?: string;
  devMenuParams: boolean;
  payloadUrl: string | null;
}

type IosRuntimeLaunchResult = ReturnType<IosDeps['launchIosApp']> | { error: FailArgs };

interface IosRuntimeLaunchContext {
  scheme?: string;
  devMenuParams: boolean;
  lanAddress: string | null;
  launch(route: IosRuntimeRoute): Promise<IosRuntimeLaunchResult>;
}

export type IosRuntimeKind = 'metro' | 'embedded-js' | 'process';

export interface IosRuntimePlan extends RuntimePlan<
  MobileRuntimePreparation,
  IosRuntimeLaunchContext,
  IosRuntimeLaunchResult,
  VerifyIosRunArgs,
  RuntimeReadiness
> {
  kind: IosRuntimeKind;
  devMenuParams(root: string, d: IosDeps): boolean;
  scheme(root: string, appPath: string | null, d: IosDeps): string | undefined;
  verificationWaitMs: number;
}

export function iosProcessRuntime(
  prepare: IosRuntimePlan['prepare'],
  kind: 'embedded-js' | 'process' = 'process',
): IosRuntimePlan {
  return {
    kind,
    prepare,
    devMenuParams: () => false,
    scheme: () => undefined,
    verificationWaitMs: RELEASE_VERIFY_WAIT_MS,
    launch: async (_prepared, { launch }) => launch({ metroPort: null, devMenuParams: false, payloadUrl: null }),
    verify: async (_prepared, context) =>
      verifyIosProcessRun({ ...context, embeddedJavaScript: kind === 'embedded-js' }),
  };
}

export function iosMetroRuntime(prepare: IosRuntimePlan['prepare']): IosRuntimePlan {
  return {
    kind: 'metro',
    prepare,
    devMenuParams: (root, d) => d.devClientTakesDevMenuParams(root),
    scheme: (root, appPath, d) => d.devClientScheme(root, appPath),
    verificationWaitMs: DEBUG_VERIFY_STEP_MS,
    launch: async ({ metroPort }, { launch, scheme, devMenuParams, lanAddress }) =>
      launch({
        metroPort,
        devClientScheme: scheme,
        devMenuParams,
        payloadUrl: scheme && metroPort !== null && lanAddress ? devClientUrl(scheme, metroPort, lanAddress) : null,
      }),
    verify: async ({ metroPort }, context) => verifyIosMetroRun({ ...context, metroPort }),
  };
}

function missingCrashReportHint({
  physical,
  remote,
  crashed,
}: {
  physical: boolean;
  remote: boolean;
  crashed: boolean;
}): string {
  return crashed && !physical && !remote
    ? `No attributable native crash report captured yet. ${IOS_CRASH_REPORT_RETRY}`
    : 'No attributable native crash report captured. Read `stim logs --source device` for available output.';
}

async function verifyIosProcessRun({
  root,
  slot,
  appPath,
  d,
  launched,
  configuration,
  phase,
  note,
  logsDir,
  launchedAt,
  bundleId,
  udid,
  physical,
  appName,
  remoteDevice,
  embeddedJavaScript,
}: VerifyIosRunArgs & { embeddedJavaScript: boolean }): Promise<RuntimeReadiness> {
  const readNativeCrashes = () =>
    remoteDevice
      ? []
      : captureNativeCrashes(
          { root, slot, platform: 'ios', deviceId: udid, appId: bundleId, since: launchedAt, appPath, physical },
          logsDir,
        );
  const processCheck = physical
    ? await d.verifyIosDeviceReleaseLaunch({ udid, appName: appName ?? bundleId })
    : await d.verifyReleaseLaunch({ pid: launched?.pid ?? null });
  const crashes = readNativeCrashes();
  if (processCheck?.verified && !crashes.length) {
    phase(
      'verify',
      `process alive ${formatDuration(processCheck.waitedMs ?? 0)} after launch (${configuration}: no bundle fetch to observe)`,
    );
    return { state: true };
  }
  for (const line of launchErrorPreview(crashes, root)) note(chalk.red(phaseLine('launch', line)));
  if (!crashes.length)
    note(
      phaseLine(
        'logs',
        missingCrashReportHint({
          physical,
          remote: Boolean(remoteDevice),
          crashed: processCheck?.reason === 'exited',
        }),
      ),
    );
  phase(
    'verify',
    chalk.yellow(
      crashes.length
        ? 'FATAL: the app reported a native crash'
        : processCheck?.reason === 'exited'
          ? `FATAL: the app process exited within ${formatDuration(processCheck.waitedMs ?? 0)} of launch`
          : physical
            ? `UNVERIFIED: devicectl could not read ${udid}'s process list`
            : 'UNVERIFIED: simctl launch reported no process id to check',
    ),
  );
  note(
    chalk.yellow(
      phaseLine(
        '',
        `${embeddedJavaScript ? 'Release' : 'Process'} readiness was not established. Run \`stim logs --errors\` for captured crash reports, or \`stim logs --source device\` for the full device output.`,
      ),
    ),
  );
  return { state: crashes.length || processCheck?.reason === 'exited' ? LAUNCH_FATAL : LAUNCH_UNVERIFIED };
}

async function verifyIosMetroRun({
  root,
  slot,
  appPath,
  d,
  launched,
  phase,
  note,
  metroCheck,
  logsDir,
  launchedAt,
  metroPort,
  isExpo,
  bundleId,
  udid,
  scheme,
  physical,
  appName,
  lanAddress,
  lanOrigin,
  remoteDevice,
  metroOrigin,
  enterActivity,
}: VerifyIosRunArgs): Promise<{ state: boolean | string; warning?: string; unattributed?: boolean }> {
  const runCommand = nativeRunCommand('ios', slot, { physical, deviceId: udid });
  const readNativeCrashes = () =>
    remoteDevice
      ? []
      : captureNativeCrashes(
          { root, slot, platform: 'ios', deviceId: udid, appId: bundleId, since: launchedAt, appPath, physical },
          logsDir,
        );
  const deviceProcess = (): boolean | null => {
    const pid = d.iosDeviceProcess({ udid, appName: appName ?? bundleId });
    return pid === undefined ? null : pid !== null;
  };

  const siblings = metroCheck ? siblingPlatformSlots(root, 'ios', slot) : [];
  const verification: VerifyLaunchResultLike = metroCheck
    ? await d.verifyLaunch({
        requireBundleResponse: true,
        slot: launchSlotScope(root, slot),
        appPid: physical || remoteDevice ? null : launched?.pid,
        platformShared: siblings.length > 0,
        onReadinessPending: () => phase('readiness', 'waiting for app readiness (up to 30s after bundle load)'),
        onActivity: enterActivity,
        logsDir,
        since: launchedAt,
        metroPort,
        platform: 'ios',
        mode: workspaceDevServerMode(root, isExpo),
        readNativeCrashes,
        processAlive: remoteDevice
          ? null
          : physical
            ? deviceProcess
            : () => {
                if (launched?.pid) return d.pidExists(launched.pid);
                const pid = iosAppProcess(udid, bundleId);
                return pid === undefined ? null : pid !== null;
              },
      })
    : { verified: false, skipped: true };
  const nativeCrashes = verification.errors?.some((record) => record.event === 'native_crash')
    ? []
    : readNativeCrashes();
  if (nativeCrashes.length) {
    verification.fatal = true;
  }
  verification.errors = await errorDiagnostics([...(verification.errors ?? []), ...nativeCrashes], {
    root,
    logsDir,
    port: metroPort,
    allowRequest: true,
  });
  if (verification.readiness)
    phase('readiness', appReadinessMessage(verification.readiness, verification.waitedMs ?? 0));
  if (verification?.fatal) {
    const nativeFatal = verification.errors?.some((record) => record.event === 'native_crash');
    const deliveryFailed = verification.record?.event === 'bundle_response_failed';
    const reason = nativeFatal
      ? 'the app reported a native crash'
      : verification.processAlive === false
        ? 'the app process exited'
        : deliveryFailed
          ? 'Metro bundle delivery failed'
          : 'Metro could not build the bundle';
    phase('verify', chalk.red(`FATAL after ${formatDuration(verification.waitedMs ?? 0)}: ${reason}`));
    for (const line of launchErrorPreview(verification.errors ?? [], root)) note(chalk.red(phaseLine('', line)));
    if (verification.processAlive === false && !verification.errors?.some((record) => record.event === 'native_crash'))
      note(phaseLine('logs', missingCrashReportHint({ physical, remote: Boolean(remoteDevice), crashed: true })));
    if (nativeFatal || verification.processAlive === false) {
      note(
        chalk.yellow(
          phaseLine(
            'remedy',
            `Fix the crash, then run \`${runCommand}\` again. A Metro reload cannot restart an exited app.`,
          ),
        ),
      );
    } else if (verification.processAlive === true && metroPort !== null) {
      // Bridgeless RCTInstance resolves DevSettings only in _loadJSBundle's
      // success callback, and RCTDevSettings.initialize is what opens the
      // /message socket, so an iOS app whose first bundle failed is not a Metro
      // peer and no websocket reload can reach it. Fixed by
      // react/react-native#58352, which has landed but is not in a release yet.
      const reloadRemedy = `press Reload on the app's own error screen -- run \`agent-device snapshot -i --platform ios --udid ${udid}\` in your existing automation session to reach it. Neither \`stim reload ios\` nor \`agent-device metro reload\` can: this app never connected to Metro.`;
      note(
        chalk.yellow(
          phaseLine(
            'remedy',
            `The native app is still running. ${deliveryFailed ? 'Check the Metro logs and device connection, then' : 'Fix the JavaScript or TypeScript error, then'} ${reloadRemedy} Do not run \`${runCommand}\` unless native inputs changed or the app process exits.`,
          ),
        ),
      );
    }
    return { state: LAUNCH_FATAL };
  }
  if (verification?.verified) {
    phase(
      'verify',
      `bundle loaded` +
        (verification.processAlive === true ? ', process alive' : '') +
        (verification.readiness ? '' : ', stable for 3s -- the first screen may still be rendering') +
        ` (${formatDuration(verification.waitedMs ?? 0)} total)`,
    );
    const hasAppErrors = reportLaunchErrors(verification.errors ?? [], note, root);
    if (hasAppErrors && verification.processAlive === true && metroPort !== null) {
      const reloadRemedy =
        physical || remoteDevice
          ? `run \`agent-device metro reload --metro-port ${metroPort}\`.`
          : 'run `stim reload ios`.';
      note(
        chalk.yellow(
          phaseLine(
            'remedy',
            `The native app is still running. Fix the JavaScript or TypeScript error; Fast Refresh should apply the edit. If the error screen remains, ${reloadRemedy} Do not run \`${runCommand}\` unless native inputs changed or the app process exits.`,
          ),
        ),
      );
    }
    return {
      state: true,
      warning: hasAppErrors
        ? 'app errors detected; inspect the error above'
        : verification.readiness === 'timed-out' || verification.readiness === 'error'
          ? 'app readiness not confirmed; inspect the UI and logs'
          : undefined,
    };
  }
  if (verification?.skipped) {
    phase('verify', 'skipped (--no-metro-check): the launch is reported as unverified');
    return { state: LAUNCH_UNVERIFIED };
  }
  if (verification?.requested) {
    phase(
      'verify',
      `BUNDLING: the app asked port ${metroPort} for its bundle; build or delivery was still pending ` +
        `after ${formatDuration(verification.waitedMs ?? 0)} (a cold bundle on a large graph outlasts this window)`,
    );
    note(
      chalk.dim(
        phaseLine('', 'Nothing to do: `stim logs --source metro` shows the build finishing, usually within a minute.'),
      ),
    );
    return { state: LAUNCH_BUNDLING };
  }

  return reportUnverified({
    root,
    verification,
    siblings,
    slot,
    phase,
    note,
    metroPort,
    bundleId,
    udid,
    scheme,
    lanAddress,
    isExpo,
    remoteDevice,
    physical,
    lanOrigin,
    metroOrigin,
    logsDir,
    launchedAt,
    launched,
  });
}

function reportUnverified({
  root,
  verification,
  siblings,
  slot,
  phase,
  note,
  metroPort,
  bundleId,
  udid,
  scheme,
  lanAddress,
  isExpo,
  remoteDevice,
  physical,
  lanOrigin,
  metroOrigin,
  logsDir,
  launchedAt,
  launched,
}: Pick<
  VerifyIosRunArgs,
  | 'root'
  | 'slot'
  | 'phase'
  | 'note'
  | 'metroPort'
  | 'bundleId'
  | 'udid'
  | 'scheme'
  | 'lanAddress'
  | 'isExpo'
  | 'remoteDevice'
  | 'physical'
  | 'lanOrigin'
  | 'metroOrigin'
  | 'logsDir'
  | 'launchedAt'
  | 'launched'
> & { verification: VerifyLaunchResultLike; siblings: string[] }): { state: string; unattributed?: boolean } {
  if (verification.unattributed) {
    const [headline, ...lines] = unattributedLaunchLines({ platform: 'ios', metroPort, slot, siblings });
    phase('verify', chalk.yellow(headline));
    for (const line of lines) note(chalk.yellow(phaseLine('', line)));
    return { state: LAUNCH_UNVERIFIED, unattributed: true };
  }

  phase('verify', chalk.yellow("UNVERIFIED: no bundle request reached this workspace's Metro"));
  for (const line of unverifiedLaunchLines({
    platform: PLATFORM,
    metroPort: metroPort ?? DEFAULT_METRO_PORT,
    waitedMs: verification.waitedMs,
    bundleId,
    udid,
    devClientUrl: scheme
      ? (launched?.url ?? devClientUrl(scheme, metroPort ?? DEFAULT_METRO_PORT, lanAddress ?? undefined))
      : null,
    mode: workspaceDevServerMode(root, isExpo),
    remote: remoteDevice,
    physical,
    devClient: Boolean(scheme),
    lanOrigin,
    metroOrigin,
    localNetworkPending:
      physical &&
      localNetworkPending(readCollectorRecords(logsDir), {
        since: launchedAt,
        pid: launched?.pid ?? null,
        lanOrigin,
      }),
  }))
    note(chalk.yellow(phaseLine('', line)));
  return { state: LAUNCH_UNVERIFIED };
}

function reportLaunchErrors(errors: LaunchErrorRecord[], note: (line: string) => void, root: string): boolean {
  const report = launchErrorReport(errors, root);
  if (report.summary) note(chalk.dim(phaseLine('launch', report.summary)));
  for (const line of report.lines) note(chalk.yellow(phaseLine('launch', line)));
  return report.lines.length > 0;
}

export interface IosRunCompletion {
  facts: IosFacts;
  uploadsAbandoned: boolean;
}

function installsOverWifi(d: IosDeps, udid: string, selectedWireless: boolean, note: (line: string) => void): boolean {
  const current = d.listIosDevices().find((entry) => entry.udid === udid);
  const wireless = current ? isWirelessIosDevice(current) : selectedWireless;
  if (wireless) {
    note(
      phaseLine(
        'device',
        `${current?.name ?? udid} is paired over Wi-Fi, so the install and launch go over the network and take longer than over a cable`,
      ),
    );
  }
  return wireless;
}

interface FinishIosRunArgs {
  projectBundleId(): string | null;
  runtime: IosRuntimePlan;
  runtimePreparation: MobileRuntimePreparation;
  devicePlacement?: ReportIosResultArgs['devicePlacement'];
  artifact: PreparedIosArtifact;
  d: IosDeps;
  root: string;
  slot?: string;
  json: boolean;
  release: boolean;
  configuration: string | null;
  buildScheme?: string;
  isExpo: boolean;
  metroCheck: boolean;
  metroPort: number | null;
  logsDir: string;
  logFile: string;
  device: DeviceLike;
  udid: string;
  physical: boolean;
  wireless: boolean;
  lanAddress: string | null;
  lanOriginUrl: string | null;
  remoteDevice: ReturnType<IosDeps['remoteIosDeps']> | null;
  bootPromise: Promise<IosBootLike | null | undefined>;
  bootDuration: () => string;
  /** Whether the run's own simulator or emulator boot is still running. */
  bootPending: () => boolean;
  fail: (args: FailArgs) => null;
  phase: (name: unknown, text: string) => void;
  note: (line: string) => void;
  logWriter: () => NdjsonWriter;
  elapsed: () => number;
  startedAt: string;
  closeWriter: () => void;
  lease: RunLease | null;
  releaseLease: () => void;
  recordRun: ReportIosResultArgs['recordRun'];
  reclaimed: ReportIosResultArgs['reclaimed'];
  devServer: ReportIosResultArgs['devServer'];
  enterPhase: (phase: BuildPhase) => void;
  enterActivity: BuildProgress['activity'];
}

function cleanAdoptedIosApps({
  d,
  udid,
  bundleId,
  devClient,
  phase,
  note,
}: {
  d: IosDeps;
  udid: string;
  bundleId: string | null;
  devClient: boolean;
  phase: (name: unknown, text: string) => void;
  note: (line: string) => void;
}): string | null {
  const swept = d.clearOtherUserApps({ udid, keep: bundleId });
  if (swept.removed.length) {
    phase('install', `removed ${swept.removed.join(', ')}, left by the previous workspace`);
  }
  if (swept.listed && swept.failed.length === 0) {
    if (swept.kept && bundleId) {
      try {
        d.clearIosAppData(udid, bundleId, {
          defaultsPlist: devClient ? IOS_DEV_MENU_OFF_DEFAULTS_PLIST : null,
        });
      } catch (error) {
        return `Could not clear the data ${bundleId} kept from the previous workspace: ${String((error as Error)?.message || error)}`;
      }
      phase('install', `cleared ${bundleId} data left by the previous workspace`);
    }
    return null;
  }
  if (!swept.listed) return 'Could not list apps left by the previous workspace.';
  for (const failure of swept.failed) {
    note(chalk.yellow(phaseLine('install', `could not remove ${failure}, left by the previous workspace`)));
  }
  return `Could not remove ${swept.failed.join(', ')}, left by the previous workspace.`;
}

function installMayBeProven(adopting: boolean, parkedCacheKey: string | undefined, storeKey: string | null): boolean {
  return !adopting || !parkedCacheKey || parkedCacheKey === storeKey;
}

function resolveRunBundleId(
  d: IosDeps,
  projectBundleId: () => string | null,
  appPath: string | null,
  bundleId: string | null,
): string | null {
  if (!appPath || bundleId) return bundleId;
  return d.readBundleId(appPath) || projectBundleId();
}

function readRunExecutable(d: IosDeps, appPath: string | null, note: (line: string) => void): string | null {
  const executable = appPath ? d.readBundleExecutable(appPath) : null;
  if (appPath && !executable) {
    note(
      chalk.dim(
        `Could not read CFBundleExecutable from ${appPath}; the device log predicate falls back to the .app basename.`,
      ),
    );
  }
  return executable;
}

function recordIosReloadTarget({
  d,
  root,
  physical,
  remoteDevice,
  bundleId,
  udid,
  metroPort,
  release,
  runtimeKind,
  launchedAt,
  note,
}: {
  d: IosDeps;
  root: string;
  slot?: string;
  physical: boolean;
  remoteDevice: boolean;
  bundleId: string;
  udid: string;
  metroPort: number | null;
  release: boolean;
  runtimeKind: IosRuntimeKind;
  launchedAt: number;
  note: (line: string) => void;
}): void {
  if (physical || remoteDevice) return;
  try {
    d.writeWorkspaceLaunch(root, 'ios', {
      appId: bundleId,
      deviceId: udid,
      metroPort,
      release,
      ...(runtimeKind === 'process' ? { runtime: 'process' as const } : {}),
      launchedAt: new Date(launchedAt).toISOString(),
    });
  } catch (error) {
    note(chalk.yellow(phaseLine('state', `could not record iOS launch: ${(error as Error)?.message || error}`)));
  }
}

function installFailureRemedy(remoteDevice: { failureRemedy: () => string } | null): string {
  return (
    remoteDevice?.failureRemedy() ??
    'Check that the simulator is booted and that the app was built for the simulator SDK.'
  );
}

function launchFailureRemedy(
  remoteDevice: { failureRemedy: () => string } | null,
  udid: string,
  bundleId: string,
  logFile: string,
): string {
  if (remoteDevice) return remoteDevice.failureRemedy();
  return `If the simulator timed out, run \`stim doctor --platform ios\` and resolve any reported host memory pressure before retrying. Otherwise run \`xcrun simctl launch --terminate-running-process --console ${udid} ${bundleId}\` to see what the app reports, and check ${logFile}.`;
}

export async function finishIosRun({
  projectBundleId,
  runtime,
  runtimePreparation,
  devicePlacement,
  artifact,
  d,
  root,
  slot,
  json,
  release,
  configuration,
  buildScheme,
  isExpo,
  metroCheck,
  metroPort,
  logsDir,
  logFile,
  device,
  udid,
  physical,
  wireless,
  lanAddress,
  lanOriginUrl,
  remoteDevice,
  bootPromise,
  bootDuration,
  bootPending,
  fail,
  phase,
  note,
  logWriter,
  elapsed,
  startedAt,
  closeWriter,
  lease,
  releaseLease,
  recordRun,
  reclaimed,
  devServer,
  enterPhase,
  enterActivity,
}: FinishIosRunArgs): Promise<IosRunCompletion | null> {
  const { path: appPath, bundleId: initialBundleId, failureFields: buildFailure, cache } = artifact;
  const {
    hit: cacheHit,
    providerName,
    buildMachine,
    builtOn,
    offloadedTo,
    offloadFallback,
    readEnabled: useBuildCache,
    missReason,
    waitedForBuild,
    compilation: compilationCache,
  } = cache;
  const storeHash = cache.identity?.fingerprint ?? null;
  const storeKey = cache.identity?.key ?? null;
  const runCommand = nativeRunCommand('ios', slot, { physical, deviceId: udid });
  let bundleId = initialBundleId;
  let leaseWarned = false;
  const raiseLeaseFor = (boundMs: number, beforeInstall: boolean): FailArgs | null => {
    const step = lease?.raise(boundMs);
    if (!step || step.ok) return null;
    if (beforeInstall) {
      const refusal = lostRefusal(step.holder, step.expiresAt, d.now());
      return { code: refusal.code, message: refusal.message, remedy: refusal.remedy, lease: refusal.lease };
    }
    if (!leaseWarned) {
      leaseWarned = true;
      note(chalk.yellow(phaseLine('lease', lostLine(step.holder, step.expiresAt, d.now()))));
    }
    return null;
  };

  bundleId = resolveRunBundleId(d, projectBundleId, appPath, bundleId);
  if (appPath && !bundleId) {
    return fail({
      code: 'STIM_INSTALL_FAILED',
      message: `Could not read a bundle identifier from the cached app at ${appPath}.`,
      remedy: 'Remove the cache entry (`stim gc`) and run again to rebuild it.',
      build: { ...buildFailure, appPath },
    });
  }

  if (bundleId) d.upsertProject(root, { bundleId });

  enterPhase('device');
  if (bootPending()) enterActivity('booting');
  const booted = await bootPromise;
  enterActivity(null);
  if (!booted?.ok) {
    return fail({
      code: booted?.code || 'STIM_NO_DEVICE',
      message: booted?.reason || 'The owned simulator could not be booted.',
      remedy: booted?.remedy || `Run \`${runCommand}\` again to re-establish an owned simulator for this workspace.`,
    });
  }
  const deviceOutcome = physical ? 'connected' : `${device?.adopted ? 'adopted' : 'booted'} ${bootDuration()}`;
  phase('device', `${deviceLabel(device, udid)} ${deviceOutcome}`);

  const scheme = runtime.scheme(root, appPath, d);
  const devMenuParams = runtime.devMenuParams(root, d);
  const appName = appNameFromPath(appPath);
  const appExecutable = readRunExecutable(d, appPath, note);
  const dropSwapDir = artifact.release;
  let installSkipped = false;
  let launched: IosRuntimeLaunchResult;
  let launchedAt = d.now();

  if (physical) {
    const overWifi = installsOverWifi(d, udid, wireless, note);
    const bounds = iosDeviceBounds(overWifi);
    const lostBeforeInstall = raiseLeaseFor(bounds.installMs, true);
    if (lostBeforeInstall) return fail(lostBeforeInstall);
    await d.stopPreviousCollector({ root, note });
    enterPhase('install');
    const installTimer = stepTimer(d.now);
    const installed = d.installIosDeviceApp(
      { udid, appPath: appPath!, bundleId, wireless: overWifi },
      { beforeStep: () => raiseLeaseFor(bounds.installMs, false) },
    );
    if (installed?.failed) {
      dropSwapDir();
      return fail({
        code: installed.code || 'STIM_INSTALL_FAILED',
        message: installed.reason ?? `devicectl could not install ${appPath} on ${udid}.`,
        remedy: installed.remedy ?? null,
        build: { ...buildFailure, appPath, bundleId },
      });
    }
    phase('install', `${basename(appPath!)} -> ${deviceLabel(device, udid)} ${installTimer()}`);
    if (installed?.note) {
      note(chalk.yellow(phaseLine('install', installed.note)));
      logWriter().write({ src: 'build', level: 'warn', event: 'install_uninstalled_first', msg: installed.note });
    }
    dropSwapDir();

    raiseLeaseFor(COLLECTOR_EXIT_WAIT_MS + bounds.launchMs, false);
    enterPhase('launch');
    const launchTimer = stepTimer(d.now);
    launchedAt = d.now();
    logWriter().write({
      src: 'build',
      level: 'info',
      marker: true,
      event: 'launch_attempt',
      ts: launchedAt,
      platform: 'ios',
      appId: bundleId,
      deviceId: udid,
      appPath,
      physical: true,
      msg: `launching ${bundleId} on ${udid}`,
    });
    launched = await runtime.launch(runtimePreparation, {
      scheme,
      devMenuParams,
      lanAddress,
      launch: async ({ payloadUrl }) => {
        const collector = await d.replaceCollector({
          root,
          slot,
          udid,
          bundleId: bundleId!,
          appName,
          physical: true,
          payloadUrl,
          note,
        });
        if (!collector?.pid) {
          return {
            error: {
              code: 'STIM_LAUNCH_FAILED',
              message: `The device log collector, which is what launches ${bundleId} on a phone, could not be started.`,
              remedy: `Check ${logFile} and the workspace collector log, then run the command again.`,
              build: { ...buildFailure, appPath, bundleId },
            },
          };
        }
        const started = await d.awaitIosDeviceLaunch({
          udid,
          bundleId: bundleId!,
          appName: appName ?? bundleId!,
          collectorPid: collector.pid,
          wireless: overWifi,
          readRecords: () =>
            readCollectorRecords(logsDir).filter(
              (entry) => Number(entry.ts) >= launchedAt && (entry.slot ?? 'default') === (slot ?? 'default'),
            ),
        });
        if (started.failed || !started.pid) {
          return {
            error: {
              code: started.code ?? 'STIM_LAUNCH_FAILED',
              message: started.reason ?? `${bundleId} did not start on ${udid}.`,
              remedy: started.remedy ?? null,
              lines: started.lines ?? [],
              logPath: logsDir,
              build: { ...buildFailure, appPath, bundleId },
            },
          };
        }
        return {
          ok: true,
          mode: payloadUrl ? 'payload-url' : 'launch',
          pid: started.pid,
          ...(payloadUrl ? { url: payloadUrl } : {}),
          ...(lanOriginUrl ? { jsLocation: lanOriginUrl } : {}),
        };
      },
    });
    if ('error' in launched) return fail(launched.error);
    if (launched.failed) {
      return fail({
        code: launched.code ?? 'STIM_LAUNCH_FAILED',
        message: launched.reason ?? `${bundleId} did not start on ${udid}.`,
        remedy: `Check ${logFile} and the workspace collector log, then run the command again.`,
        logPath: logsDir,
        build: { ...buildFailure, appPath, bundleId },
      });
    }
    phase('launch', `${bundleId!} pid ${launched.pid} ${launchTimer()}`);
  } else {
    const adopting = Boolean(device?.adoptionPending);
    if (adopting) {
      const cleanupFailure = cleanAdoptedIosApps({ d, udid, bundleId, devClient: Boolean(scheme), phase, note });
      if (cleanupFailure) {
        return fail({
          code: 'STIM_INSTALL_FAILED',
          message: `${cleanupFailure} Stim kept the adoption cleanup pending and did not install or launch the app.`,
          remedy: `Run \`${runCommand}\` again after simulator tooling is responsive.`,
          build: { ...buildFailure, appPath, bundleId },
        });
      }
    }
    enterPhase('install');
    const installTimer = stepTimer(d.now);
    const installed = d.installIosApp(
      {
        udid,
        appPath: appPath!,
        bundleId,
        devClientScheme: scheme,
        schemeApprovals: device.schemeApprovals,
        proveInstalled: installMayBeProven(adopting, device?.parkedCacheKey, storeKey),
      },
      { now: d.now },
    );
    if (installed?.failed) {
      return fail({
        code: installed.code || 'STIM_INSTALL_FAILED',
        message: installed.reason,
        remedy: installFailureRemedy(remoteDevice),
        build: { ...buildFailure, appPath, bundleId },
      });
    }
    if (adopting) d.clearIosAdoptionPending(root, slot);
    installSkipped = Boolean(installed?.skipped);
    const artifactDuration =
      installed?.artifactDurationMs === undefined
        ? installTimer()
        : `(${formatDuration(installed.artifactDurationMs)})`;
    phase(
      'install',
      installSkipped
        ? `unchanged (${deviceShortName(device, udid)} already has this build) ${artifactDuration}`
        : `${basename(appPath!)} -> ${deviceLabel(device, udid)} ${artifactDuration}`,
    );
    if (!remoteDevice && installed?.devClientPreparationDurationMs !== undefined) {
      phase('install', `dev client prepared (${formatDuration(installed.devClientPreparationDurationMs)})`);
    }
    if (installed.schemeApprovals) d.recordIosSchemeApprovals(root, udid, installed.schemeApprovals, slot);

    dropSwapDir();

    if (!remoteDevice)
      await d.replaceCollector({ root, slot, udid, bundleId: bundleId!, appName, appExecutable, note });
    enterPhase('launch');
    const launchTimer = stepTimer(d.now);
    launchedAt = d.now();
    logWriter().write({
      src: 'build',
      level: 'info',
      marker: true,
      event: 'launch_attempt',
      ts: launchedAt,
      platform: 'ios',
      appId: bundleId,
      deviceId: udid,
      appPath,
      remote: Boolean(remoteDevice),
      msg: `launching ${bundleId} on ${udid}`,
    });
    launched = await runtime.launch(runtimePreparation, {
      scheme,
      devMenuParams,
      lanAddress,
      launch: async ({ metroPort: port, devClientScheme, devMenuParams: menuParams }) =>
        d.launchIosApp({
          udid,
          bundleId: bundleId!,
          metroPort: port,
          devClientScheme,
          devMenuParams: menuParams,
          consolePaths: simulatorConsolePaths(
            { deviceId: udid, appId: bundleId!, since: launchedAt },
            true,
            Boolean(remoteDevice),
          ),
        }),
    });
    if ('error' in launched) return fail(launched.error);
    if (launched.failed) {
      printNativeCrashReport(
        { root, slot, platform: 'ios', deviceId: udid, appId: bundleId!, since: launchedAt, appPath },
        logsDir,
        (line) => note(chalk.red(phaseLine('launch', line))),
        Boolean(remoteDevice),
      );
      return fail({
        code: launched.code || 'STIM_LAUNCH_FAILED',
        message: launched.reason,
        remedy: launchFailureRemedy(remoteDevice, udid, bundleId!, logFile),
        build: { ...buildFailure, appPath, bundleId },
      });
    }
    phase('launch', `${bundleId!}${restartedAppNote(launched.restartedPid)} ${launchTimer()}`);
  }

  recordIosReloadTarget({
    d,
    root,
    slot,
    physical,
    remoteDevice: Boolean(remoteDevice),
    bundleId: bundleId!,
    udid,
    metroPort,
    release,
    runtimeKind: runtime.kind,
    launchedAt,
    note,
  });

  logWriter().write({
    src: 'build',
    level: 'info',
    event: 'launch',
    msg:
      runtime.kind === 'process'
        ? `launched ${bundleId} on ${udid} (${configuration ?? 'Debug'}, native process, no Metro)`
        : runtime.kind === 'embedded-js'
          ? `launched ${bundleId} on ${udid} (${configuration}, embedded JS bundle, no Metro)`
          : `launched ${bundleId} on ${udid} against Metro ${lanOriginUrl ?? `port ${metroPort}`}` +
            (launched?.mode === 'openurl' || launched?.mode === 'payload-url' ? ' (expo-dev-client)' : '') +
            restartedAppNote(launched.restartedPid, '; '),
  });

  if (remoteDevice) {
    logWriter().write({
      src: 'build',
      level: 'info',
      event: 'collector_skipped',
      msg: `remote session ${udid}: device logs come from agent-device/EAS, so no simctl log stream is attached`,
    });
  }

  if (physical) raiseLeaseFor(runtime.verificationWaitMs, false);
  const {
    state: launchState,
    warning: launchWarning,
    unattributed,
  } = await runtime.verify(runtimePreparation, {
    root,
    slot,
    appPath,
    d,
    launched,
    configuration,
    phase,
    note,
    metroCheck,
    logsDir,
    launchedAt,
    metroPort,
    isExpo,
    bundleId: bundleId!,
    udid,
    scheme,
    physical,
    appName,
    lanAddress,
    lanOrigin: lanOriginUrl,
    remoteDevice: Boolean(remoteDevice),
    metroOrigin: typeof launched?.jsLocation === 'string' ? launched.jsLocation : null,
    enterActivity,
  });
  if (launchState === LAUNCH_FATAL) {
    return fail({
      code: 'STIM_LAUNCH_FAILED',
      message: 'The app failed its launch readiness check.',
      remedy: `Read the launch error above or run \`stim logs --errors\`. The full timeline is in ${logsDir}.`,
      logPath: logsDir,
      build: { ...buildFailure, appPath, bundleId },
    });
  }
  logWriter().write(
    runtime.kind === 'process'
      ? {
          src: 'build',
          level: launchState === LAUNCH_UNVERIFIED ? 'warn' : 'info',
          event: launchState === LAUNCH_UNVERIFIED ? 'launch_unverified' : 'launch_verified',
          msg:
            launchState === LAUNCH_UNVERIFIED
              ? `${bundleId} could not be verified as running`
              : `${bundleId} is running its native process`,
        }
      : launchOutcomeRecord({
          launchState,
          release: runtime.kind === 'embedded-js',
          bundleId,
          configuration,
          metroPort,
          unattributed,
        }),
  );

  const leaseFacts = lease?.facts() ?? null;
  releaseLease();

  const uploadsAbandoned = await artifact.completeUploads();
  const facts = reportIosResult({
    devicePlacement,
    root,
    slot,
    json,
    release,
    runtimeKind: runtime.kind,
    configuration,
    buildScheme,
    metroCheck,
    metroPort,
    logsDir,
    device,
    udid,
    appPath,
    bundleId: bundleId!,
    installSkipped,
    elapsed,
    startedAt,
    storeHash,
    storeKey,
    cacheHit,
    missReason,
    compilationCache,
    useBuildCache,
    waitedForBuild,
    launchState,
    launchWarning,
    providerName,
    buildMachine,
    builtOn,
    offloadedTo,
    offloadFallback,
    closeWriter,
    webPreviewUrl: remoteDevice?.webPreviewUrl() ?? null,
    lease: physical ? leaseFacts : undefined,
    recordRun,
    reclaimed,
    devServer,
    links: workspaceLinks(root, { platform: 'ios', slot }),
  });
  return { facts, uploadsAbandoned };
}
