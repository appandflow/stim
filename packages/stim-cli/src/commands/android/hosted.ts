import chalk from 'chalk';
import { settleFingerprintCheck } from '../../cache/fingerprint-memo.ts';
import { hostedAndroidStatus, type HostedDeviceSelectors, type HostedAppOffer } from '@stim-cli/core/state';
import { placeHostedAndroid, type HostedAndroidTarget } from '../../device-host/hosted-android.ts';
import { writeHostedAndroidAsync } from '../../device-host/ios-state.ts';
import type { writeWorkspaceLaunchAsync } from '../../supervisor/state.ts';
import { LAUNCH_BUNDLING, LAUNCH_FATAL, type verifyLaunch } from '../../engine/launch-verify.ts';
import type { followHostedLaunchLogs } from '../../device-host/hosted-logs-sync.ts';
import { verifyAndroidMetroRun } from './launch.ts';
import { launchOutcomeRecord } from '../native-runtime.ts';
import type { PreparedAndroidArtifact } from './artifact.ts';
import { persistLastBuild, reportAndroidResult, finishAndroidUpload, type ReportAndroidResultArgs } from './result.ts';
import { androidDevClientScheme } from './support.ts';
import type { RunAndroidResult, FailExtra } from './types.ts';
import type { BuildPhase, BuildProgress } from '../../engine/build-progress.ts';

export async function finishHostedAndroidRun({
  target,
  artifact,
  root,
  slot = 'default',
  release,
  appMode = release ? 'release' : 'development',
  isExpo,
  metroPort,
  logsDir,
  selectors,
  place,
  writePlacement,
  verifyLaunch: verify,
  followLogs,
  writeLaunch,
  readApkPackage,
  resolveDevClientScheme,
  now,
  started,
  startedAt,
  fail,
  phase,
  enterPhase,
  enterActivity,
  out,
  recordBuild,
  ...report
}: Omit<
  ReportAndroidResultArgs,
  | 'serial'
  | 'apkPath'
  | 'androidPackage'
  | 'installSkipped'
  | 'waitedForBuild'
  | 'remote'
  | 'providerName'
  | 'launchState'
  | 'launched'
  | 'ccache'
  | 'durationMs'
> & {
  target: HostedAndroidTarget;
  artifact: PreparedAndroidArtifact;
  isExpo: boolean;
  appMode?: HostedAppOffer['mode'];
  selectors: HostedDeviceSelectors;
  place: typeof placeHostedAndroid;
  writePlacement: typeof writeHostedAndroidAsync;
  verifyLaunch: typeof verifyLaunch;
  followLogs: typeof followHostedLaunchLogs;
  writeLaunch: typeof writeWorkspaceLaunchAsync;
  readApkPackage: (path: string | null) => string | null | Promise<string | null>;
  resolveDevClientScheme: typeof androidDevClientScheme;
  now: () => number;
  started: number;
  startedAt: string;
  fail: (
    code: string | undefined,
    message?: string | null,
    remedy?: string | null,
    extra?: FailExtra,
  ) => RunAndroidResult;
  phase: (label: unknown, text: string) => void;
  enterPhase: (phase: BuildPhase) => void;
  enterActivity?: BuildProgress['activity'];
  out: (line: string) => void;
  recordBuild?: Parameters<typeof persistLastBuild>[0]['recordBuild'];
}): Promise<RunAndroidResult> {
  const packageName = artifact.androidPackage ?? (await readApkPackage(artifact.apkPath));
  if (!artifact.apkPath || !packageName) return fail('STIM_INSTALL_FAILED', 'The built APK has no package identity.');
  const devClientScheme =
    appMode === 'development' && isExpo
      ? ((await resolveDevClientScheme(root, artifact.apkPath)) ?? undefined)
      : undefined;
  const launchedAt = now();
  let marked = false;
  try {
    const run = await place(target, {
      root,
      slot,
      bundle: artifact.apkPath,
      handoff: artifact.handoff,
      bundleId: packageName,
      release,
      ...(appMode === 'process' ? { mode: appMode } : {}),
      metroPort,
      selectors,
      ...(appMode === 'development' && isExpo ? { devClientScheme } : {}),
      reserved: (placement) => {
        if (placement.device && !marked) {
          marked = true;
          report.writer.write({
            src: 'build',
            level: 'info',
            marker: true,
            event: 'launch_attempt',
            ts: now(),
            platform: 'android',
            appId: packageName,
            deviceId: placement.session,
            remote: true,
            host: target.host.machine,
            msg: `launching ${packageName} on ${target.host.machine}`,
          });
        }
        return writePlacement(root, slot, placement);
      },
      note: out,
      enterPhase,
    });
    await writePlacement(root, slot, run.placement);
    await writeLaunch(
      root,
      'android',
      {
        appId: packageName,
        deviceId: run.placement.session,
        metroPort,
        release,
        ...(appMode === 'process' ? { runtime: 'process' as const } : {}),
        launchedAt: new Date(launchedAt).toISOString(),
      },
      slot,
    );
    let launched: true | 'bundling' | 'unverified' = run.launched;
    let launchWarning: string | undefined;
    let unattributed = false;
    if (appMode === 'development') {
      const hostedLogs = followLogs(root, slot, 'android', launchedAt);
      let verification;
      try {
        verification = await verifyAndroidMetroRun({
          root,
          slot,
          remoteDevice: false,
          verifyLaunched: verify,
          serial: run.placement.device?.serial ?? '',
          androidPackage: packageName,
          metroCheck: report.metroCheck,
          logsDir: logsDir ?? '',
          launchedAt,
          metroPort,
          isExpo,
          physical: false,
          device: {},
          scheme: devClientScheme,
          phase,
          enterActivity,
          hostedLogs,
          hostedRunCommand: `stim android --remote ${run.placement.selected}${slot === 'default' ? '' : ` --slot ${slot}`}`,
        });
      } finally {
        hostedLogs.stop();
      }
      if (verification.state === LAUNCH_FATAL)
        return fail(
          'STIM_LAUNCH_FAILED',
          'The app failed its launch readiness check.',
          `Read the launch error above or run \`stim logs --errors\`. The full timeline is in ${logsDir}.`,
          { lastBuildStatus: true },
        );
      launched =
        verification.state === true ? true : verification.state === LAUNCH_BUNDLING ? 'bundling' : 'unverified';
      launchWarning = verification.warning;
      unattributed = verification.unattributed ?? false;
    }
    report.writer.write(
      launchOutcomeRecord({
        launchState: launched,
        release,
        process: appMode === 'process',
        bundleId: packageName,
        configuration: report.variant,
        metroPort,
        unattributed,
      }),
    );
    if (launched === 'unverified')
      out(
        `Launch on ${target.host.machine} is unverified; check the hosted app, then retry stim android --remote ${target.host.machine}.`,
      );
    const host = hostedAndroidStatus(run.placement);
    report.record.deviceName = host.device?.name ?? null;
    report.record.bundleId = packageName;
    persistLastBuild({
      recordBuild,
      root,
      record: report.record,
      startedAt,
      durationMs: now() - started,
      status: 'ok',
      out,
    });
    await finishAndroidUpload(artifact.uploadPending, artifact.remote, phase);
    await artifact.providerUpload;
    await settleFingerprintCheck(
      artifact.fingerprintCheck,
      'android',
      (line) => phase('fingerprint', chalk.yellow(line)),
      (entry) => report.writer.write(entry),
    );
    const facts = reportAndroidResult({
      ...report,
      out,
      ...(appMode === 'process' ? { runtimeKind: 'process' as const } : {}),
      root,
      slot,
      release,
      metroPort,
      logsDir,
      host,
      serial: null,
      apkPath: artifact.apkPath,
      androidPackage: packageName,
      installSkipped: false,
      waitedForBuild: artifact.waitedForBuild,
      remote: artifact.remote,
      providerName: artifact.providerName,
      launchState: launched,
      launchWarning,
      launched: {},
      ccache: artifact.ccache,
      durationMs: now() - started,
    });
    return { ok: true, facts };
  } catch (error) {
    return fail(
      (error as Error & { code?: string }).code ?? 'STIM_HOSTING_REFUSED',
      (error as Error).message,
      `Retry stim android --remote ${target.host.machine}, or run stim stop to reconcile the recorded placement.`,
      { lastBuildStatus: true },
    );
  }
}
