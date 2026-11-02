import chalk from 'chalk';
import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import type { StimContext } from '@stim-cli/core';
import { LAST_BUILD_KEYS, isJsonObject, readIdleStop, type WorkspaceState } from '@stim-cli/core/state';
import { runProcessOperation } from '../cli-operation.ts';
import { formatLongDuration, phaseLine, refuseNoProject } from '../command-output.ts';
import { deviceSlotPlatforms, parseDeviceSlotKey } from '../devices/device-slots.ts';
import { resolveOwnedAvdSerialAsync, type ResolvedAvdSerial } from '../devices/android.ts';
import { listAllIosSimsAsync, resolveOwnedIosSim, type ResolvedIosSim } from '../devices/ios.ts';
import { androidAppProcess, iosAppProcess } from '../engine/app-install.ts';
import { nativeRunCommand } from '../engine/slot-launch.ts';
import type { RecordedBuild } from '../engine/recorded-build.ts';
import { describeMetroLastStop, metroLastStop } from '../supervisor/stop-cause.ts';
import { readWorkspaceLaunches, type WorkspaceLaunchRecord } from '../supervisor/state.ts';
import { getProject, type ProjectRecord } from '../workspace/config.ts';
import { findCommandWorkspaceAsync } from '../workspace/project.ts';
import { resolveProjectSettingsAsync, SETTING_SHAPE_REMEDY, settingShapeErrors } from '../workspace/settings.ts';
import { readWorkspaceState, recordWorkspaceUseAsync } from '../workspace/workspace-state.ts';
import { repoRootAsync } from '../workspace/worktree.ts';
import { liveSupervisor, startDevServer } from './start.ts';
import { runIosOperation } from './ios.ts';
import { runAndroidOperation } from './android.ts';

type Platform = 'ios' | 'android';

export interface ReviveFailure {
  code: string;
  message: string;
  remedy: string | null;
}

export interface RevivedDevice {
  platform: Platform;
  slot: string;
  deviceId: string | null;
  deviceName: string | null;
  rebooted: boolean;
  app: { bundleId: string; relaunched: boolean; launched: boolean | 'bundling' | 'unverified' | null };
}

export interface ReviveFacts {
  revived: {
    metro: { port: number | null; stoppedAt: string | null; reason: string | null; restarted: boolean };
    devices: RevivedDevice[];
  };
}

type ReviveResult = { ok: true; facts: ReviveFacts } | { ok: false; error: ReviveFailure };

interface RunOutcome {
  ok: boolean;
  error?: { code?: string; message?: string | null; remedy?: string | null };
  deviceId?: string | null;
  deviceName?: string | null;
  launched?: boolean | 'bundling' | 'unverified';
}

interface RunRequest {
  slot: string;
  configuration: string | null;
  recordedBuild: RecordedBuild;
}

export interface ReviveDeps {
  getProject: typeof getProject;
  readState: (root: string) => WorkspaceState | null;
  readLaunches: typeof readWorkspaceLaunches;
  liveSupervisor: typeof liveSupervisor;
  resolveIos: (udid: string) => Promise<ResolvedIosSim>;
  resolveAndroid: (avdName: string) => Promise<ResolvedAvdSerial>;
  appRunning: (platform: Platform, deviceId: string, appId: string) => Promise<boolean>;
  artifactExists: (path: string) => boolean;
  startMetro: (
    root: string,
    note: (line: string) => void,
  ) => Promise<{ ok: true } | { ok: false; error: ReviveFailure }>;
  run: (platform: Platform, root: string, request: RunRequest) => Promise<RunOutcome>;
}

interface Target {
  platform: Platform;
  slot: string;
  record: WorkspaceLaunchRecord;
  deviceId: string;
  deviceName: string | null;
  booted: boolean;
  build: RecordedBuild;
  configuration: string | null;
}

function failure(code: string, message: string, remedy: string | null): { ok: false; error: ReviveFailure } {
  return { ok: false, error: { code, message, remedy } };
}

function lastSuccessfulRun(
  state: WorkspaceState | null,
  platform: Platform,
  appId: string,
): { build: RecordedBuild; configuration: string | null } | null {
  const record = state?.[LAST_BUILD_KEYS[platform]];
  if (!isJsonObject(record) || record.status !== 'ok' || record.bundleId !== appId) return null;
  if (typeof record.appPath !== 'string') return null;
  const { fingerprint, cacheKey, cacheHit } = record;
  const hit: 'local' | 'remote' | null = cacheHit === 'local' || cacheHit === 'remote' ? cacheHit : null;
  const cache =
    typeof fingerprint === 'string' && typeof cacheKey === 'string' && hit ? { fingerprint, key: cacheKey, hit } : null;
  return {
    build: { appPath: record.appPath, bundleId: appId, builtAt: '', ...(cache ? { cache } : {}) },
    configuration: typeof record.configuration === 'string' ? record.configuration : null,
  };
}

async function inspectTarget(
  project: ProjectRecord,
  state: WorkspaceState | null,
  platform: Platform,
  slot: string,
  record: WorkspaceLaunchRecord,
  d: ReviveDeps,
): Promise<Target | { ok: false; error: ReviveFailure }> {
  const run = nativeRunCommand(platform, slot);
  const slotDevices = deviceSlotPlatforms(project, slot);
  const lost = (why: string) =>
    failure(
      'STIM_DEVICE_LOST',
      `${why}, so revive cannot bring back the ${platform === 'ios' ? 'simulator' : 'emulator'} the app last ran on.`,
      `Run \`${run}\`; it boots or creates this workspace's owned device and launches the app.`,
    );
  let deviceId: string;
  let deviceName: string | null;
  let booted: boolean;
  if (platform === 'ios') {
    const owned = slotDevices?.ios;
    if (!owned?.owned || owned.deviceUdid !== record.deviceId) {
      return lost(`Simulator ${record.deviceId} is no longer this workspace's owned simulator`);
    }
    const resolved = await d.resolveIos(record.deviceId);
    if (!resolved.sim) return lost(`Simulator ${record.deviceId} no longer exists as a Stim-owned simulator`);
    deviceId = resolved.sim.udid;
    deviceName = resolved.sim.name;
    booted = resolved.sim.state === 'Booted';
  } else {
    const owned = slotDevices?.android;
    if (!owned?.owned || !owned.avdName) return lost('This workspace no longer records an owned emulator for the slot');
    const resolved = await d.resolveAndroid(owned.avdName);
    if (resolved.missing || resolved.notOwned) {
      return lost(`Emulator ${owned.avdName} no longer exists as a Stim-owned emulator`);
    }
    deviceId = resolved.serial ?? owned.avdName;
    deviceName = owned.avdName;
    booted = Boolean(resolved.serial);
  }
  const last = lastSuccessfulRun(state, platform, record.appId);
  if (!last) {
    return failure(
      'STIM_NO_RECORDED_BUILD',
      `No successful ${platform} run of ${record.appId} is recorded for this workspace, so there is no app to relaunch.`,
      `Run \`${run}\` to build or restore it from the cache and launch it.`,
    );
  }
  if (!d.artifactExists(last.build.appPath)) {
    return failure(
      'STIM_NO_RECORDED_BUILD',
      `The app the last ${platform} run installed, ${last.build.appPath}, no longer exists.`,
      `Run \`${run}\` to build or restore it from the cache and launch it.`,
    );
  }
  return { platform, slot, record, deviceId, deviceName, booted, ...last };
}

/** Resumes what an idle stop paused: the dev server, each recorded owned device, and the app last launched on it. */
export async function runRevive({
  root,
  note,
  deps,
}: {
  root: string;
  note: (line: string) => void;
  deps: ReviveDeps;
}): Promise<ReviveResult> {
  const d = deps;
  const project = d.getProject(root);
  if (!project) {
    return failure('STIM_NO_PROJECT', `No Stim environment is registered for ${root}.`, 'Run `stim start` first.');
  }
  const state = d.readState(root);
  const port = typeof project.metroPort === 'number' ? project.metroPort : null;
  const live = port === null ? null : d.liveSupervisor({ state, project, port });
  const idle = readIdleStop(state);
  if (!live && !idle) {
    const stop = metroLastStop(state, null);
    return failure(
      'STIM_NO_METRO',
      stop
        ? `This workspace's Metro was not stopped for being idle (${describeMetroLastStop(stop)}), so there is nothing to resume.`
        : "This workspace's Metro was never started, so there is nothing to resume.",
      'Run `stim start`, then `stim ios` or `stim android`.',
    );
  }

  const targets: Target[] = [];
  for (const [key, record] of Object.entries(d.readLaunches(root))) {
    const parsed = parseDeviceSlotKey(key);
    // A Release or native-process app does not load JS from Metro, and reinstalling its cached artifact could
    // replace the JS a release run injected; `stim ios|android` relaunches it.
    if (!parsed || record.release || record.runtime === 'process') continue;
    const target = await inspectTarget(project, state, parsed.platform, parsed.slot, record, d);
    if ('ok' in target) return target;
    targets.push(target);
  }

  let restarted = false;
  if (!live) {
    const started = await d.startMetro(root, note);
    if (!started.ok) return started;
    restarted = true;
  }

  const devices: RevivedDevice[] = [];
  for (const target of targets) {
    if (!restarted && target.booted && (await d.appRunning(target.platform, target.deviceId, target.record.appId))) {
      devices.push({
        platform: target.platform,
        slot: target.slot,
        deviceId: target.deviceId,
        deviceName: target.deviceName,
        rebooted: false,
        app: { bundleId: target.record.appId, relaunched: false, launched: null },
      });
      continue;
    }
    const outcome = await d.run(target.platform, root, {
      slot: target.slot,
      configuration: target.configuration,
      recordedBuild: target.build,
    });
    if (!outcome.ok) {
      return failure(
        outcome.error?.code ?? 'STIM_RUN_FAILED',
        outcome.error?.message ?? `The ${target.platform} relaunch failed.`,
        outcome.error?.remedy ?? null,
      );
    }
    devices.push({
      platform: target.platform,
      slot: target.slot,
      deviceId: outcome.deviceId ?? target.deviceId,
      deviceName: outcome.deviceName ?? target.deviceName,
      rebooted: !target.booted,
      app: { bundleId: target.record.appId, relaunched: true, launched: outcome.launched ?? null },
    });
  }
  return {
    ok: true,
    facts: {
      revived: {
        metro: { port, stoppedAt: live ? null : (idle?.at ?? null), reason: live ? null : 'idle', restarted },
        devices,
      },
    },
  };
}

export function reviveLines(facts: ReviveFacts, now: number): string[] {
  const { metro, devices } = facts.revived;
  const lines: string[] = [];
  if (metro.restarted) {
    const ago = metro.stoppedAt ? ` ${formatLongDuration(now - Date.parse(metro.stoppedAt))} ago` : '';
    lines.push(`Metro stopped idle${ago}, restarted on port ${metro.port}.`);
  } else {
    lines.push(`Metro is running on port ${metro.port}.`);
  }
  for (const device of devices) {
    const kind = device.platform === 'ios' ? 'Simulator' : 'Emulator';
    const name = `${kind} ${device.deviceName ?? device.deviceId}`;
    if (device.rebooted) lines.push(`${name} rebooted.`);
    if (device.app.relaunched) {
      lines.push(`${device.app.bundleId} relaunched from cold on ${name}; in-app state is gone.`);
    } else {
      lines.push(`${device.app.bundleId} is running on ${name}; left as is.`);
    }
  }
  if (!metro.restarted && devices.every((device) => !device.app.relaunched)) {
    lines.push('Nothing to revive.');
  }
  return lines;
}

function writeNote(line: string): void {
  console.error(line);
}

function nestedContext(context: StimContext): StimContext {
  return {
    ...context,
    output: (stream, text) => {
      if (stream === 'stderr') context.output('stderr', text);
    },
  };
}

function defaultDeps(context: StimContext): ReviveDeps {
  return {
    getProject,
    readState: readWorkspaceState,
    readLaunches: readWorkspaceLaunches,
    liveSupervisor,
    resolveIos: async (udid) =>
      resolveOwnedIosSim(udid, await listAllIosSimsAsync({ operation: context, signal: context.signal })),
    resolveAndroid: (avdName) => resolveOwnedAvdSerialAsync(avdName, { operation: context, signal: context.signal }),
    appRunning: async (platform, deviceId, appId) =>
      (platform === 'ios' ? await iosAppProcess(deviceId, appId) : await androidAppProcess(deviceId, appId)).state ===
      'running',
    artifactExists: existsSync,
    startMetro: async (root, note) => {
      const { context: settingsContext, settings } = await resolveProjectSettingsAsync(root);
      const [shapeError] = settingShapeErrors(settings);
      if (shapeError) return failure('STIM_BAD_ARG', shapeError, SETTING_SHAPE_REMEDY);
      // `stim start` records no flags, so an explicit `--remote` is not restored; settings that select a
      // remote device still are, because startDevServer derives them from settings.
      const started = await startDevServer({ root, settings, settingsContext, out: note, note });
      return started.ok ? { ok: true } : { ok: false, error: started.error };
    },
    run: async (platform, root, { slot, configuration, recordedBuild }) => {
      const nested = nestedContext(context);
      if (platform === 'ios') {
        let error: RunOutcome['error'];
        const result = await runIosOperation(
          nested,
          root,
          { slot, recordedBuild, ...(configuration ? { configuration } : {}) },
          {},
          (failed) => {
            error = failed;
          },
        );
        return result
          ? {
              ok: true,
              deviceId: result.facts.udid,
              deviceName: result.facts.deviceName,
              launched: result.facts.launched,
            }
          : { ok: false, error };
      }
      const result = await runAndroidOperation(nested, root, {
        slot,
        recordedBuild,
        ...(configuration ? { variant: configuration } : {}),
      });
      return result.ok && result.facts
        ? {
            ok: true,
            deviceId: result.facts.serial,
            deviceName: result.facts.deviceName,
            launched: result.facts.launched,
          }
        : { ok: false, error: result.error };
    },
  };
}

export function registerRevive(program: Command, overrides: Partial<ReviveDeps> = {}): void {
  program
    .command('revive')
    .description(
      'Resume this workspace after an idle stop: restart its Metro, boot the owned simulator or emulator the app last ran on, and relaunch that app from cold. Never builds, and never starts or boots what the workspace did not have.',
    )
    .option('--json', 'Emit the revived facts as one JSON line; every other line goes to stderr')
    .action(async (opts: { json?: boolean }) => {
      const json = Boolean(opts.json);
      const root = await findCommandWorkspaceAsync(process.cwd(), repoRootAsync, writeNote);
      if (!root) {
        refuseNoProject({ json });
        return;
      }
      await recordWorkspaceUseAsync(root);
      const { value: result, interrupted } = await runProcessOperation(root, (context) =>
        runRevive({ root, note: writeNote, deps: { ...defaultDeps(context), ...overrides } }),
      );
      if (!result.ok) {
        if (json) console.log(JSON.stringify(result.error));
        console.error(chalk.red(phaseLine('error', `${result.error.code}: ${result.error.message}`)));
        if (result.error.remedy) console.error(phaseLine('remedy', result.error.remedy));
        process.exitCode = interrupted ?? 1;
        return;
      }
      for (const line of reviveLines(result.facts, Date.now())) console.error(line);
      if (json) console.log(JSON.stringify(result.facts));
      if (interrupted !== null) process.exitCode = interrupted;
    });
}

export default function reviveCommand(program: Command): void {
  registerRevive(program);
}
