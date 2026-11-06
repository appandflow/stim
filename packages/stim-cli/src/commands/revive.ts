import chalk from 'chalk';
import type { Command } from 'commander';
import type { StimContext } from '@stim-cli/core';
import { hostedNativeRecords, readIdleStop, type PlatformRecords, type WorkspaceState } from '@stim-cli/core/state';
import { runProcessOperation } from '../cli-operation.ts';
import { formatLongDuration, phaseLine, refuseNoProject } from '../command-output.ts';
import { deviceSlotPlatforms, parseDeviceSlotKey, projectDeviceSlots } from '../devices/device-slots.ts';
import { resolveOwnedAvdSerialAsync, type ResolvedAvdSerial } from '../devices/android.ts';
import { listAllIosSimsAsync, resolveOwnedIosSim, type ResolvedIosSim } from '../devices/ios.ts';
import { androidAppProcess, iosAppProcess } from '../engine/app-install.ts';
import { nativeRunCommand } from '../engine/slot-launch.ts';
import type { RecordedBuild } from '../engine/recorded-build.ts';
import { resolveBuild } from '../cache/build-cache.ts';
import { describeMetroLastStop, metroLastStop } from '../stimd/metro/stop-cause.ts';
import { launchWithoutMetro, readWorkspaceLaunches, type WorkspaceLaunchRecord } from '../stimd/metro/state.ts';
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
  expectedDevice: string;
}

export interface ReviveDeps {
  findWorkspace: (cwd: string) => Promise<string | null>;
  getProject: typeof getProject;
  readState: (root: string) => WorkspaceState | null;
  readLaunches: typeof readWorkspaceLaunches;
  liveSupervisor: typeof liveSupervisor;
  resolveIos: (udid: string) => Promise<ResolvedIosSim>;
  resolveAndroid: (avdName: string) => Promise<ResolvedAvdSerial>;
  appRunning: (platform: Platform, deviceId: string, appId: string) => Promise<boolean>;
  resolveCachedApp: (platform: Platform, cacheKey: string) => string | null;
  startMetro: (
    root: string,
    note: (line: string) => void,
  ) => Promise<{ ok: true; port: number } | { ok: false; error: ReviveFailure }>;
  run: (platform: Platform, root: string, request: RunRequest) => Promise<RunOutcome>;
}

interface Target {
  platform: Platform;
  slot: string;
  record: WorkspaceLaunchRecord;
  deviceId: string;
  deviceName: string | null;
  expectedDevice: string;
  booted: boolean;
  build: RecordedBuild;
  configuration: string | null;
}

function failure(code: string, message: string, remedy: string | null): { ok: false; error: ReviveFailure } {
  return { ok: false, error: { code, message, remedy } };
}

function launchDeviceNames(record: WorkspaceLaunchRecord): string[] {
  return [record.deviceId, ...(record.avdName ? [record.avdName] : [])];
}

interface RecordedLaunch {
  platform: Platform;
  slot: string;
  record: WorkspaceLaunchRecord;
}

function ownedDeviceName(platforms: PlatformRecords | undefined, platform: Platform): string | undefined {
  if (platform === 'ios') return platforms?.ios?.owned ? platforms.ios.deviceUdid : undefined;
  return platforms?.android?.owned ? platforms.android.avdName : undefined;
}

function unrecordedOwnedDevice(
  project: ProjectRecord,
  requestedDevice: string,
): { ok: false; error: ReviveFailure } | null {
  for (const { slot, platforms } of projectDeviceSlots(project)) {
    for (const platform of ['ios', 'android'] as const) {
      if (ownedDeviceName(platforms, platform) !== requestedDevice) continue;
      return failure(
        'STIM_NO_RECORDED_BUILD',
        `${platform === 'ios' ? 'Simulator' : 'Emulator'} ${requestedDevice} belongs to this workspace, but no launch is recorded on it.`,
        `Run \`${nativeRunCommand(platform, slot)}\` to boot it, install the app and launch it.`,
      );
    }
  }
  return null;
}

function unrevivableLaunch(
  project: ProjectRecord,
  launches: RecordedLaunch[],
  requestedDevice: string,
): { ok: false; error: ReviveFailure } | null {
  const own = launches.find(
    ({ platform, slot, record }) =>
      ownedDeviceName(deviceSlotPlatforms(project, slot), platform) === requestedDevice ||
      (launchWithoutMetro(record) !== null && launchDeviceNames(record).includes(requestedDevice)),
  );
  if (!own) return unrecordedOwnedDevice(project, requestedDevice);
  const why = launchWithoutMetro(own.record) ?? 'its record does not name this device';
  return failure(
    'STIM_NO_RECORDED_BUILD',
    `${own.platform === 'ios' ? 'Simulator' : 'Emulator'} ${requestedDevice} belongs to this workspace, but revive does not relaunch the last launch on it (${why}).`,
    `Run \`${nativeRunCommand(own.platform, own.slot)}\` to boot it, install the app and launch it.`,
  );
}

function launchedCacheEntry(record: WorkspaceLaunchRecord) {
  const artifact = record.artifact;
  if (!artifact || typeof artifact.fingerprint !== 'string' || typeof artifact.cacheKey !== 'string') return null;
  return {
    fingerprint: artifact.fingerprint,
    key: artifact.cacheKey,
    hit: artifact.cacheHit === 'remote' ? ('remote' as const) : ('local' as const),
    configuration: typeof artifact.configuration === 'string' ? artifact.configuration : null,
  };
}

async function inspectTarget(
  project: ProjectRecord,
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
  const entry = launchedCacheEntry(record);
  if (!entry) {
    return failure(
      'STIM_NO_RECORDED_BUILD',
      `The ${platform} launch of ${record.appId} names no build cache entry, so revive cannot restore the exact app it installed.`,
      `Run \`${run}\` to build or restore it from the cache and launch it.`,
    );
  }
  let expectedDevice: string;
  let deviceId: string;
  let deviceName: string;
  let booted: boolean;
  if (platform === 'ios') {
    const owned = slotDevices?.ios;
    if (!owned?.owned || owned.deviceUdid !== record.deviceId) {
      return lost(`Simulator ${record.deviceId} is no longer this workspace's owned simulator`);
    }
    const resolved = await d.resolveIos(record.deviceId);
    if (!resolved.sim) return lost(`Simulator ${record.deviceId} no longer exists as a Stim-owned simulator`);
    expectedDevice = resolved.sim.udid;
    deviceId = resolved.sim.udid;
    deviceName = resolved.sim.name;
    booted = resolved.sim.state === 'Booted';
  } else {
    const owned = slotDevices?.android;
    if (!record.avdName || !owned?.owned || owned.avdName !== record.avdName) {
      return lost(`Emulator ${record.avdName ?? record.deviceId} is no longer this workspace's owned emulator`);
    }
    const resolved = await d.resolveAndroid(record.avdName);
    if (resolved.missing || resolved.notOwned) {
      return lost(`Emulator ${record.avdName} no longer exists as a Stim-owned emulator`);
    }
    expectedDevice = record.avdName;
    deviceId = resolved.serial ?? record.avdName;
    deviceName = record.avdName;
    booted = Boolean(resolved.serial);
  }
  const appPath = d.resolveCachedApp(platform, entry.key);
  if (!appPath) {
    return failure(
      'STIM_NO_RECORDED_BUILD',
      `The build cache entry ${entry.key} that held the app the last ${platform} launch installed is gone.`,
      `Run \`${run}\` to build or restore it from the cache and launch it.`,
    );
  }
  return {
    platform,
    slot,
    record,
    deviceId,
    deviceName,
    expectedDevice,
    booted,
    configuration: entry.configuration,
    build: {
      appPath,
      bundleId: record.appId,
      builtAt: '',
      cache: { fingerprint: entry.fingerprint, key: entry.key, hit: entry.hit },
    },
  };
}

export async function runRevive({
  root,
  note,
  requestedDevice = null,
  deps,
}: {
  root: string;
  note: (line: string) => void;
  requestedDevice?: string | null;
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
  if (!live && (!idle || port === null)) {
    const stop = metroLastStop(state, null);
    return failure(
      'STIM_NO_METRO',
      idle
        ? "This workspace was stopped after Metro's idle stop and its Metro port was released, so there is nothing to resume."
        : stop
          ? `This workspace's Metro was not stopped for being idle (${describeMetroLastStop(stop)}), so there is nothing to resume.`
          : "This workspace's Metro was never started, so there is nothing to resume.",
      'Run `stim start`, then `stim ios` or `stim android`.',
    );
  }

  const recorded = Object.entries(d.readLaunches(root)).flatMap(([key, record]): RecordedLaunch[] => {
    const parsed = parseDeviceSlotKey(key);
    if (!parsed || hostedNativeRecords(state, parsed.platform)[parsed.slot]) return [];
    return [{ ...parsed, record }];
  });
  const launches = recorded.filter(({ record }) => launchWithoutMetro(record) === null);
  const selected = requestedDevice
    ? launches.filter((launch) => launchDeviceNames(launch.record).includes(requestedDevice))
    : launches;
  if (requestedDevice && selected.length === 0) {
    const unrevivable = unrevivableLaunch(project, recorded, requestedDevice);
    if (unrevivable) return unrevivable;
    return failure(
      'STIM_DEVICE_LOST',
      `Device ${requestedDevice} is not a simulator or emulator this workspace last launched its app on, so revive started nothing for it.`,
      "Stim boots only this workspace's owned devices. Run `stim status` to see them, and drive one of those.",
    );
  }
  const targets: Target[] = [];
  for (const { platform, slot, record } of selected) {
    const target = await inspectTarget(project, platform, slot, record, d);
    if ('ok' in target) return target;
    targets.push(target);
  }

  let metroPort = port;
  let restarted = false;
  if (!live) {
    const started = await d.startMetro(root, note);
    if (!started.ok) return started;
    metroPort = started.port;
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
      expectedDevice: target.expectedDevice,
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
        metro: {
          port: metroPort,
          stoppedAt: live ? null : (idle?.at ?? null),
          reason: live ? null : 'idle',
          restarted,
        },
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

function findWorkspace(cwd: string): Promise<string | null> {
  return findCommandWorkspaceAsync(cwd, repoRootAsync, writeNote);
}

export function reviveDeps(context: StimContext): ReviveDeps {
  return {
    findWorkspace,
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
    resolveCachedApp: (platform, cacheKey) => resolveBuild(platform, cacheKey),
    startMetro: async (root, note) => {
      const { context: settingsContext, settings } = await resolveProjectSettingsAsync(root);
      const [shapeError] = settingShapeErrors(settings);
      if (shapeError) return failure('STIM_BAD_ARG', shapeError, SETTING_SHAPE_REMEDY);
      const started = await startDevServer({ root, settings, settingsContext, out: note, note });
      return started.ok ? { ok: true, port: started.facts.port } : { ok: false, error: started.error };
    },
    run: async (platform, root, { slot, configuration, recordedBuild, expectedDevice }) => {
      const nested = nestedContext(context);
      if (platform === 'ios') {
        let error: RunOutcome['error'];
        const result = await runIosOperation(
          nested,
          root,
          { slot, recordedBuild, expectedDevice, remote: 'local', ...(configuration ? { configuration } : {}) },
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
        expectedDevice,
        remote: 'local',
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
      const root = await (overrides.findWorkspace ?? findWorkspace)(process.cwd());
      if (!root) {
        refuseNoProject({ json });
        return;
      }
      await recordWorkspaceUseAsync(root);
      const { value: result, interrupted } = await runProcessOperation(root, (context) =>
        runRevive({
          root,
          note: writeNote,
          requestedDevice: context.env.AGENT_DEVICE_BOOT_HOOK_DEVICE_ID || null,
          deps: { ...reviveDeps(context), ...overrides },
        }),
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
