import { rmSync } from 'node:fs';
import { hostedAndroidStatus, type HostedDeviceSelectors } from '@stim-cli/core/state';
import { placeHostedAndroid, type HostedAndroidTarget } from '../../device-host/hosted-android.ts';
import { writeHostedAndroid } from '../../device-host/ios-state.ts';
import { writeWorkspaceLaunch, MODE_BARE, MODE_EXPO } from '../../supervisor/state.ts';
import { verifyLaunch } from '../../engine/launch-verify.ts';
import { launchSlotScope, siblingPlatformSlots } from '../../engine/slot-launch.ts';
import type { PreparedAndroidArtifact } from './artifact.ts';
import { persistLastBuild, reportAndroidResult, finishAndroidUpload, type ReportAndroidResultArgs } from './result.ts';
import { androidDevClientScheme } from './support.ts';
import type { RunAndroidResult, FailExtra } from './types.ts';

export async function finishHostedAndroidRun({
  target,
  artifact,
  root,
  slot = 'default',
  release,
  isExpo,
  metroPort,
  logsDir,
  selectors,
  place,
  writePlacement,
  verifyLaunch: verify,
  writeLaunch,
  readApkPackage,
  resolveDevClientScheme,
  now,
  started,
  startedAt,
  fail,
  phase,
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
  selectors: HostedDeviceSelectors;
  place: typeof placeHostedAndroid;
  writePlacement: typeof writeHostedAndroid;
  verifyLaunch: typeof verifyLaunch;
  writeLaunch: typeof writeWorkspaceLaunch;
  readApkPackage: (path: string | null) => string | null;
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
  out: (line: string) => void;
  recordBuild?: Parameters<typeof persistLastBuild>[0]['recordBuild'];
}): Promise<RunAndroidResult> {
  const packageName = artifact.androidPackage ?? readApkPackage(artifact.apkPath);
  if (!artifact.apkPath || !packageName) return fail('STIM_INSTALL_FAILED', 'The built APK has no package identity.');
  const launchedAt = now();
  try {
    const run = await place(target, {
      root,
      slot,
      bundle: artifact.apkPath,
      handoff: artifact.handoff,
      bundleId: packageName,
      release,
      metroPort,
      selectors,
      ...(!release && isExpo ? { devClientScheme: resolveDevClientScheme(root, artifact.apkPath) ?? undefined } : {}),
      reserved: (placement) => writePlacement(root, slot, placement),
      note: out,
    });
    writePlacement(root, slot, run.placement);
    writeLaunch(root, 'android', {
      appId: packageName,
      deviceId: run.placement.session,
      metroPort,
      release,
      launchedAt: new Date(launchedAt).toISOString(),
    });
    let launched: true | 'bundling' | 'unverified' = run.launched;
    if (!release) {
      const evidence = await verify({
        requireBundleResponse: true,
        platform: 'android',
        logsDir: logsDir ?? undefined,
        since: launchedAt,
        metroPort,
        mode: isExpo ? MODE_EXPO : MODE_BARE,
        slot: launchSlotScope(root, slot),
        platformShared: siblingPlatformSlots(root, 'android', slot).length > 0,
      });
      if (evidence.fatal)
        return fail(
          'STIM_LAUNCH_FAILED',
          'Metro could not deliver the hosted app bundle.',
          'Run stim logs --errors and fix the bundle error.',
        );
      launched = evidence.verified ? true : evidence.requested ? 'bundling' : 'unverified';
    }
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
      status: 'success',
      out,
    });
    await finishAndroidUpload(artifact.uploadPending, artifact.remote, phase);
    await artifact.providerUpload;
    const facts = reportAndroidResult({
      ...report,
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
    );
  } finally {
    if (artifact.swapDir) rmSync(artifact.swapDir, { recursive: true, force: true });
  }
}
