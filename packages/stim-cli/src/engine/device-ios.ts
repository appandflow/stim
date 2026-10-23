import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ambientContext } from '@stim-cli/core';
import { deviceSlotPlatforms, projectDeviceSlots } from '../devices/device-slots.ts';
import chalk from 'chalk';
import { phaseLine } from '../command-output.ts';
import { workspaceId, workspaceLogsDir } from '../workspace/paths.ts';
import {
  clearDevice,
  getConfigDir,
  loadConfig,
  saveConfig,
  setDevice,
  withConfigLockAsync,
} from '../workspace/config.ts';
import { configuredIosSimulatorViewer, type IosSimulatorApp } from '../devices/ios-simulator-viewer.ts';
import { getExecutor } from '../exec.ts';
import { hostMemoryPressureAdvice, readHostMemoryPressure, reportMemoryCulprits } from '../host-memory.ts';
import {
  bootIosSim,
  type IosBootEvent,
  createOwnedIosSim,
  iosSimulatorFailureAdvice,
  readSpringBoardPid,
  springBoardRunning,
  waitForSpringBoard,
  listAllIosSims,
  listAllIosSimsAsync,
  type IosSimSnapshot,
  listIosDeviceTypesAsync,
  listIosRuntimesAsync,
  ownedSimName,
  parseRuntimeVersion,
  renameIosSim,
  resetIosKeychain,
  resetIosPrivacy,
  resolveIosCreation,
  resolveOwnedIosSim,
  type IosCreationChoice,
  type SimModel,
} from '../devices/ios.ts';
import { adoptParked, dropParked, parkedMaxSetting, readParked, selectParked } from '../devices/sim-pool.ts';
import { iosSimSlimDefaultSetting, iosSimSlimProfileSetting } from '../workspace/settings.ts';
import { teardownOwnedIosSim, teardownParkedIosSim } from '../devices/teardown.ts';
import { reconcileSimSlim } from './simslim.ts';
import { withWorkspaceProcessLock } from './workspace-process-lock.ts';
import { claimFailure } from '../ownership-claim.ts';
import {
  DeviceAdmissionRefusal,
  deviceTypeMismatch,
  runtimeMismatch,
  withDeviceBootAdmission,
  type DeviceSlotWaitPolicy,
} from './device-capacity.ts';
import type { BootResult, DeviceFlags, DeviceSettings, Notify, OwnedDeviceRecord } from './device.ts';
import { cancellableSleep } from '../cancellation.ts';
import { copySpringBoardCrashReports } from '../devices/springboard-crash-reports.ts';
import { iosBootRecorder, type IosBootRecorder } from './ios-boot-log.ts';
import { isJsonObject } from '@stim-cli/core/state';

type SimRecord = ReturnType<typeof listAllIosSims>[number];

export interface IosBoot {
  udid: string;
  done: Promise<void>;
}

type IosBootOrigin = 'adopted' | 'created' | 'existing' | 'restart';

function recordBootPhase(record: IosBootRecorder, udid: string, origin?: IosBootOrigin) {
  return (event: IosBootEvent) => {
    const pid = 'pid' in event ? event.pid : undefined;
    const boot = event.phase === 'boot_requested' ? origin : undefined;
    record('ios_boot', {
      phase: event.phase,
      ...(pid === undefined ? {} : { pid }),
      ...(boot === undefined ? {} : { boot }),
      msg: `ios boot ${udid}: ${event.phase}${pid === undefined ? '' : ` pid ${pid}`}${boot === undefined ? '' : ` (${boot})`}`,
    });
  };
}

function startIosBoot(
  udid: string,
  configure: () => Promise<unknown>,
  label: string,
  out: Notify,
  simulatorApp: IosSimulatorApp | undefined,
  root: string,
  slot: string | undefined,
  origin: IosBootOrigin,
  deviceSlotWait?: DeviceSlotWaitPolicy,
): IosBoot {
  const done = withDeviceBootAdmission(
    { platform: 'ios', key: udid },
    async () => {
      out(chalk.dim(phaseLine('device', `booting ${label} (${udid})`)));
      await bootIosSim(udid, {
        label,
        out,
        simulatorApp,
        env: ambientContext()?.env,
        onPhase: recordBootPhase(iosBootRecorder(root, slot, udid), udid, origin),
      });
      await configure();
      await muteBootedSimulator(udid, out);
    },
    { ...deviceSlotWait, root, out },
  );
  done.catch(() => {});
  return { udid, done };
}

const SPRINGBOARD_MUTE_WAIT_MS = 60000;

// SpringBoard publishes the default volume, 60, every time it starts, and SimSlim
// reboots the simulator when it applies or removes a profile (#4229). Mute last,
// once SpringBoard is running again.
async function muteBootedSimulator(udid: string, out: Notify): Promise<void> {
  try {
    const springBoard = await waitForSpringBoard(udid, Date.now() + SPRINGBOARD_MUTE_WAIT_MS);
    if (springBoard.state === 'unreadable') throw new Error(springBoard.reason);
    if (springBoard.state === 'timed-out') {
      throw new Error(`SpringBoard did not finish starting within ${SPRINGBOARD_MUTE_WAIT_MS / 1000}s.`);
    }
    const response: unknown = JSON.parse(
      await getExecutor().runFileAsync(
        'xcrun',
        ['devicectl', 'device', 'settings', 'audio', '--device', udid, '--volume', '0', '--json-output', '-'],
        { timeoutMs: 30000 },
      ),
    );
    if (
      !isJsonObject(response) ||
      !isJsonObject(response.info) ||
      response.info.outcome !== 'success' ||
      !isJsonObject(response.result) ||
      typeof response.result.deviceIdentifier !== 'string' ||
      response.result.deviceIdentifier.toUpperCase() !== udid.toUpperCase() ||
      response.result.volume !== 0
    ) {
      throw new Error('Xcode did not confirm volume zero for this simulator.');
    }
    out(chalk.dim(phaseLine('device', 'simulator muted; turn on Sound in its Stim Desktop options')));
  } catch (error) {
    out(
      chalk.yellow(
        phaseLine('device', `Could not mute this simulator: ${error instanceof Error ? error.message : String(error)}`),
      ),
    );
  }
}

export class IosDeviceMismatchError extends Error {
  readonly remedy =
    'Run `stim worktree remove` (or `stim gc --delete`) to reap the current sim, then `stim ios` again to create the requested one, or pass `--slot <name>` to create it beside the current one.';
}

export async function ensureOwnedIosDevice({
  record,
  projectPath,
  slot,
  settingsRoot,
  label,
  settings,
  flags,
  note,
  out,
  reconcileIosSimulator,
  simSnapshot,
}: {
  record: OwnedDeviceRecord | null;
  projectPath: string;
  slot?: string;
  settingsRoot: string;
  label: string;
  settings: DeviceSettings;
  flags: DeviceFlags;
  note: Notify;
  out: Notify;
  reconcileIosSimulator: typeof reconcileSimSlim;
  simSnapshot?: IosSimSnapshot;
}): Promise<OwnedDeviceRecord> {
  const pressure = readHostMemoryPressure();
  const memoryAdvice = hostMemoryPressureAdvice(pressure);
  if (memoryAdvice) out(chalk.yellow(phaseLine('memory', memoryAdvice)));
  reportMemoryCulprits(pressure, (named) => out(chalk.yellow(phaseLine('memory', named))));
  const simslimProfile = iosSimSlimProfileSetting(settings, settingsRoot);
  const simslimDefault = iosSimSlimDefaultSetting(settings);
  if (record?.deviceUdid) {
    if (record.owned) {
      const listed = simSnapshot ? simSnapshot.read() : listAllIosSims({ includeUnavailable: true });
      const resolved = resolveOwnedIosSim(record.deviceUdid, listed);
      if (resolved.notOwned) {
        note(
          chalk.yellow(
            `Note: recorded sim is now named "${resolved.notOwned}", not Stim-owned -- creating a fresh owned sim instead of booting it.`,
          ),
        );
      } else if (resolved.missing) {
      } else {
        const sim = resolved.sim as SimRecord;
        const wantedType = flags.deviceType || settings?.ios?.deviceType;
        const deviceTypes = await listIosDeviceTypesAsync({ snapshot: simSnapshot });
        const mismatch = deviceTypeMismatch(sim.deviceTypeIdentifier, wantedType, deviceTypes);
        if (mismatch) {
          throw new IosDeviceMismatchError(`${mismatch}. Stim will not silently boot a different model.`);
        }
        const versionMismatch = flags.runtimeFlag
          ? runtimeMismatch(sim.runtime, flags.runtimeFlag, await listIosRuntimesAsync({ snapshot: simSnapshot }))
          : null;
        if (versionMismatch) {
          throw new IosDeviceMismatchError(`${versionMismatch}. Stim will not silently boot a different iOS version.`);
        }
        const model: SimModel = {
          model: deviceTypes.find((d) => d.identifier === sim.deviceTypeIdentifier)?.name ?? null,
          runtime: parseRuntimeVersion(sim.runtime),
        };
        const name =
          ownedIosName(sim, label, model, projectPath, listed) === sim.name
            ? sim.name
            : await withIosDeviceNameLock(() => renameToOwnedName(sim, label, model, projectPath));
        const updated = {
          deviceUdid: sim.udid,
          owned: true,
          deviceName: name,
          ...(record.simslimManaged ? { simslimManaged: true } : {}),
          ...(record.simslimApplied ? { simslimApplied: record.simslimApplied } : {}),
          ...(record.adopted ? { adopted: true } : {}),
          ...(record.adoptionPending ? { adoptionPending: true } : {}),
          ...(record.parkedCacheKey ? { parkedCacheKey: record.parkedCacheKey } : {}),
          ...(record.schemeApprovals ? { schemeApprovals: record.schemeApprovals } : {}),
        };
        const configure = async (freshBoot: boolean) => {
          if (record.adoptionPending) await resetAdoptedSim(sim.udid, out);
          return configureOwnedIosSim({
            record: updated,
            projectPath,
            slot,
            profile: simslimProfile,
            slimByDefault: simslimDefault,
            freshBoot,
            out,
            reconcileIosSimulator,
          });
        };
        const facts = {
          deviceType: model.model,
          runtime: model.runtime,
        };
        if (sim.state !== 'Booted') {
          return {
            ...updated,
            booting: startIosBoot(
              sim.udid,
              () => configure(true),
              name,
              out,
              flags.simulatorApp,
              projectPath,
              slot,
              record.adoptionPending ? 'adopted' : 'existing',
              flags.deviceSlotWait,
            ),
            ...facts,
          };
        }
        const { record: configured, rebooted } = await configure(false);
        if (rebooted) await muteBootedSimulator(sim.udid, out);
        return { ...configured, ...facts, booted: sim.udid };
      }
    } else {
      const sim = (await listAllIosSimsAsync()).find((s) => s.udid === record.deviceUdid);
      if (sim) {
        if (sim.state !== 'Booted') {
          note(
            chalk.yellow(
              `Note: assigned sim ${sim.name} (${sim.udid}) is shut down and is not owned by Stim, so it will not be booted automatically.`,
            ),
          );
          note(
            chalk.dim(
              'Boot it yourself, or run `stim gc --delete` to clear the assignment so Stim can create an owned sim.',
            ),
          );
        }
        return record;
      }
    }
    await withConfigLockAsync(() => {
      const current = deviceSlotPlatforms(loadConfig()?.projects?.[projectPath], slot)?.ios;
      if (!current) return;
      if (current.deviceUdid !== record.deviceUdid || current.owned !== record.owned) {
        throw new Error('The simulator assignment changed during recovery. Run `stim ios` again.');
      }
      clearDevice(projectPath, 'ios', slot);
    });
  }

  const choice = await resolveIosCreation({
    deviceType: flags.deviceType || settings.ios?.deviceType,
    runtime: flags.runtime || settings.ios?.runtime,
  });

  const adopted =
    parkedMaxSetting('ios').max > 0
      ? await withIosDeviceNameLock(() => takeParkedIosSim({ projectPath, slot, label, choice, out }))
      : null;
  if (adopted) {
    const booting = startIosBoot(
      adopted.deviceUdid,
      async () => {
        await resetAdoptedSim(adopted.deviceUdid, out);
        await configureOwnedIosSim({
          record: adopted,
          projectPath,
          slot,
          profile: simslimProfile,
          slimByDefault: simslimDefault,
          freshBoot: true,
          out,
          reconcileIosSimulator,
        });
      },
      adopted.deviceName,
      out,
      flags.simulatorApp,
      projectPath,
      slot,
      'adopted',
      flags.deviceSlotWait,
    );
    return { ...adopted, booting, deviceType: choice.deviceType, runtime: choice.runtime };
  }

  const created = await withIosDeviceNameLock(async () => {
    const suffix = ownedIosNameSuffix(
      label,
      { model: choice.deviceType, runtime: choice.runtime },
      projectPath,
      undefined,
      await listAllIosSimsAsync({ includeUnavailable: true }),
    );
    const result = await createOwnedIosSim(label, { suffix }, choice);
    await withConfigLockAsync(() =>
      setDevice(projectPath, 'ios', { deviceUdid: result.udid, owned: true, deviceName: result.name }, slot),
    );
    return result;
  });
  const newRecord = { deviceUdid: created.udid, owned: true, deviceName: created.name };
  const booting = startIosBoot(
    created.udid,
    () =>
      configureOwnedIosSim({
        record: newRecord,
        projectPath,
        slot,
        profile: simslimProfile,
        slimByDefault: simslimDefault,
        freshBoot: true,
        out,
        reconcileIosSimulator,
      }),
    created.name,
    out,
    flags.simulatorApp,
    projectPath,
    slot,
    'created',
    flags.deviceSlotWait,
  );
  return {
    ...newRecord,
    created: true,
    booting,
    deviceType: created.deviceType,
    runtime: created.runtime,
  };
}

function withIosDeviceNameLock<T>(fn: () => T): Promise<T> {
  return withWorkspaceProcessLock(getConfigDir(), 'ios-device-names', async () => fn(), { external: true });
}

function ownedIosNameSuffix(
  label: string,
  model: SimModel,
  projectPath: string,
  udid: string | undefined,
  listed: SimRecord[],
): string {
  const names = new Set(listed.filter((sim) => sim.udid !== udid).map((sim) => sim.name));
  for (const project of Object.values(loadConfig()?.projects ?? {})) {
    for (const { platforms } of projectDeviceSlots(project)) {
      const record = platforms.ios;
      if (record?.deviceUdid !== udid && record?.deviceName) names.add(record.deviceName);
    }
  }
  for (const parked of readParked('ios')) {
    if (parked.udid !== udid) names.add(parked.name);
  }
  let suffix = '';
  for (let attempt = 0; names.has(ownedSimName(label, model, suffix)); attempt++) {
    suffix = ` ${workspaceId(projectPath)}${attempt ? `-${attempt}` : ''}`;
  }
  return suffix;
}

function ownedIosName(sim: SimRecord, label: string, model: SimModel, projectPath: string, listed: SimRecord[]) {
  return ownedSimName(label, model, ownedIosNameSuffix(label, model, projectPath, sim.udid, listed));
}

async function renameToOwnedName(sim: SimRecord, label: string, model: SimModel, projectPath: string): Promise<string> {
  const wanted = ownedIosName(sim, label, model, projectPath, await listAllIosSimsAsync({ includeUnavailable: true }));
  if (sim.name === wanted) return wanted;
  try {
    await renameIosSim(sim.udid, wanted);
    return wanted;
  } catch {
    return sim.name;
  }
}

async function resetAdoptedSim(udid: string, out: Notify): Promise<void> {
  out(chalk.dim(phaseLine('device', `resetting privacy grants and the keychain on ${udid}`)));
  await resetIosPrivacy(udid);
  await resetIosKeychain(udid);
}

type AdoptedRecord = OwnedDeviceRecord & { deviceUdid: string; deviceName: string };

async function takeParkedIosSim({
  projectPath,
  slot,
  label,
  choice,
  out,
}: {
  projectPath: string;
  slot?: string;
  label: string;
  choice: IosCreationChoice;
  out: Notify;
}): Promise<AdoptedRecord | null> {
  const candidates = selectParked(readParked('ios'), {
    deviceTypeIdentifier: choice.deviceTypeId,
    runtimeIdentifier: choice.runtimeId,
  });
  if (candidates.length === 0) return null;
  const listed = new Map((await listAllIosSimsAsync({ includeUnavailable: true })).map((sim) => [sim.udid, sim]));
  for (const parked of candidates) {
    const sim = listed.get(parked.udid);
    if (!sim || !sim.available) {
      const result = sim ? await teardownParkedIosSim(parked.udid, { label: parked.name }) : null;
      const removed = sim ? result?.status === 'torn-down' : await dropParked('ios', parked.udid);
      if (removed) {
        out(
          chalk.dim(
            phaseLine('device', `deleted parked ${parked.name} (${parked.udid}): ${sim ? 'unavailable' : 'gone'}`),
          ),
        );
      } else if (result?.status === 'failed') {
        out(
          chalk.yellow(
            phaseLine(
              'device',
              `could not delete unavailable parked ${parked.name} (${parked.udid}): ${result.reason}`,
            ),
          ),
        );
      }
      continue;
    }
    if (!sim.name.startsWith('stim-')) {
      out(
        chalk.yellow(
          phaseLine(
            'device',
            `kept parked record for ${parked.udid}: simulator is now named ${JSON.stringify(sim.name)} and is not Stim-owned`,
          ),
        ),
      );
      continue;
    }
    const model = { model: choice.deviceType, runtime: choice.runtime };
    const name = ownedSimName(
      label,
      model,
      ownedIosNameSuffix(label, model, projectPath, parked.udid, [...listed.values()]),
    );
    const device = {
      deviceUdid: parked.udid,
      owned: true,
      deviceName: name,
      adopted: true,
      adoptionPending: true,
      ...(parked.simslimManaged ? { simslimManaged: true } : {}),
      ...(parked.cacheKey ? { parkedCacheKey: parked.cacheKey } : {}),
    };
    const adopted = await adoptParked({ platform: 'ios', projectPath, slot, udid: parked.udid, device });
    if (!adopted) continue;
    try {
      await renameIosSim(parked.udid, name);
    } catch {}
    return adopted.schemeApprovals && adopted.schemeApprovals.length > 0
      ? { ...device, schemeApprovals: adopted.schemeApprovals }
      : device;
  }
  return null;
}

export function clearIosAdoptionPending(projectPath: string, slot = 'default'): Promise<void> {
  return withConfigLockAsync(() => {
    const cfg = loadConfig();
    const ios = deviceSlotPlatforms(cfg?.projects?.[projectPath], slot)?.ios;
    if (!cfg || !ios?.adoptionPending) return;
    delete ios.adopted;
    delete ios.adoptionPending;
    delete ios.parkedCacheKey;
    saveConfig(cfg);
  });
}

function simslimProfileIdentity(profile: string | null, slimByDefault: boolean): string | null {
  if (profile) return `profile:${createHash('sha256').update(readFileSync(profile)).digest('hex')}`;
  return slimByDefault ? 'default' : null;
}

async function configureOwnedIosSim({
  record,
  projectPath,
  slot,
  profile,
  slimByDefault,
  freshBoot,
  out,
  reconcileIosSimulator,
}: {
  record: OwnedDeviceRecord & { deviceUdid: string };
  projectPath: string;
  slot?: string;
  profile: string | null;
  slimByDefault: boolean;
  freshBoot: boolean;
  out: Notify;
  reconcileIosSimulator: typeof reconcileSimSlim;
}): Promise<{ record: OwnedDeviceRecord; rebooted: boolean }> {
  const identity = simslimProfileIdentity(profile, slimByDefault);
  const slimConfigured = identity !== null || Boolean(record.simslimManaged);
  const applied = record.simslimApplied;
  const springBoardBefore = slimConfigured ? await readSpringBoardPid(record.deviceUdid) : null;
  if (
    identity !== null &&
    record.simslimManaged &&
    !freshBoot &&
    applied?.profile === identity &&
    springBoardBefore !== null &&
    springBoardBefore === applied.springBoardPid
  ) {
    await withConfigLockAsync(() => setDevice(projectPath, 'ios', { ...record }, slot));
    return { record, rebooted: false };
  }

  if (profile) out(chalk.dim(phaseLine('device', `applying the SimSlim profile to ${record.deviceUdid}`)));
  else if (slimByDefault)
    out(chalk.dim(phaseLine('device', `applying SimSlim's default services to ${record.deviceUdid}`)));
  else if (record.simslimManaged)
    out(chalk.dim(phaseLine('device', `restoring stock simulator services on ${record.deviceUdid}`)));

  const previouslyManaged = Boolean(record.simslimManaged);
  if ((identity !== null && !record.simslimManaged) || applied) {
    const { simslimApplied: _applied, ...rest } = record;
    const pending = identity !== null ? { ...rest, simslimManaged: true } : rest;
    await withConfigLockAsync(() => setDevice(projectPath, 'ios', pending, slot));
    record = pending;
  }
  const result = await reconcileIosSimulator({
    context: ambientContext(),
    udid: record.deviceUdid,
    profile,
    slimByDefault,
    previouslyManaged,
    out,
  });
  const updated = { ...record };
  if (result.managed) updated.simslimManaged = true;
  else delete updated.simslimManaged;
  const springBoardAfter = slimConfigured ? await readSpringBoardPid(record.deviceUdid) : null;
  if (result.managed && !result.notInstalled && identity !== null && springBoardAfter !== null) {
    updated.simslimApplied = { profile: identity, springBoardPid: springBoardAfter };
  }
  await withConfigLockAsync(() => setDevice(projectPath, 'ios', updated, slot));
  const rebooted = slimConfigured && springBoardAfter !== springBoardBefore;
  if (rebooted && !result.notInstalled) {
    iosBootRecorder(
      projectPath,
      slot,
      record.deviceUdid,
    )('ios_boot', {
      phase: 'simslim_reboot',
      pidBefore: springBoardBefore,
      pidAfter: springBoardAfter,
      msg: `ios boot ${record.deviceUdid}: simslim_reboot (SpringBoard pid ${springBoardBefore ?? 'unknown'} to ${springBoardAfter ?? 'unknown'})`,
    });
  }
  return { record: updated, rebooted };
}

type IosBootArgs = {
  device?: OwnedDeviceRecord | null;
  projectPath: string;
  slot?: string;
  origin?: IosBootOrigin;
  deviceSlotWait?: DeviceSlotWaitPolicy;
  simulatorApp?: IosSimulatorApp;
  timeoutMs: number;
  pollMs: number;
  out: Notify;
};

type IosBootAttempt = BootResult & { springBoardDown?: true };

const SPRINGBOARD_RESPAWN_POLLS = 20;

export async function ensureIosBooted(args: IosBootArgs): Promise<BootResult> {
  const { springBoardDown, ...first } = await bootOwnedIosSim(args);
  const { device, projectPath, out } = args;
  const udid = device?.deviceUdid;
  if (!springBoardDown || !device || !udid) return first;
  out(chalk.yellow(phaseLine('device', `SpringBoard is not running on ${udid}; restarting the simulator once`)));
  const record = iosBootRecorder(projectPath, args.slot, udid);
  await preserveSpringBoardReports(record, udid, projectPath);
  record('ios_boot', {
    phase: 'restart',
    level: 'warn',
    msg: `ios boot ${udid}: restart (SpringBoard is not running after boot; restarting once)`,
  });
  const stopped = await teardownOwnedIosSim(udid, { workspace: projectPath });
  if (stopped.status !== 'torn-down') {
    return { ...first, reason: `${first.reason} The restart did not run: ${stopped.reason ?? stopped.status}.` };
  }
  const { booted: _booted, booting: _booting, ...unbooted } = device;
  const { springBoardDown: stillDown, ...second } = await bootOwnedIosSim({
    ...args,
    device: unbooted,
    origin: 'restart',
  });
  if (stillDown) await preserveSpringBoardReports(record, udid, projectPath);
  return stillDown
    ? {
        ...second,
        reason: `${second.reason} Stim already restarted the simulator once, so it did not restart it again.`,
      }
    : second;
}

async function preserveSpringBoardReports(record: IosBootRecorder, udid: string, root: string): Promise<void> {
  const dir = workspaceLogsDir(root);
  try {
    const files = await copySpringBoardCrashReports({ udid, destDir: dir });
    record('springboard_crash_reports', {
      level: files.length ? 'warn' : 'info',
      files,
      dir,
      msg: files.length
        ? `copied ${files.length} SpringBoard crash report(s) for ${udid} to ${dir}: ${files.join(', ')}`
        : `no SpringBoard crash report for ${udid} from the last 10 minutes`,
    });
  } catch (error) {
    record('springboard_crash_reports', {
      level: 'warn',
      files: [],
      dir,
      msg: `could not copy SpringBoard crash reports for ${udid}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function bootOwnedIosSim({
  device,
  projectPath,
  slot,
  origin,
  deviceSlotWait,
  simulatorApp,
  timeoutMs,
  pollMs,
  out,
}: IosBootArgs): Promise<IosBootAttempt> {
  const udid = device?.deviceUdid;
  if (!udid) return { failed: true, reason: 'No iOS simulator is recorded for this project.' };
  const record = iosBootRecorder(projectPath, slot, udid);
  const onPhase = recordBootPhase(record, udid, origin ?? (device.adoptionPending ? 'adopted' : 'existing'));
  const openViewer = async () => {
    await configuredIosSimulatorViewer(simulatorApp, ambientContext()?.env).open(udid);
    onPhase({ phase: 'viewer_opened' });
  };
  const ready = async (): Promise<IosBootAttempt> => {
    try {
      // Apple simctl spawn searches the device PATH for bare names; absolute paths use the host root.
      const listSpringBoard = () =>
        getExecutor().runFileAsync('xcrun', ['simctl', 'spawn', udid, 'launchctl', 'list'], { timeoutMs: 30000 });
      let listing = await listSpringBoard();
      for (let poll = 0; !springBoardRunning(listing) && poll < SPRINGBOARD_RESPAWN_POLLS; poll++) {
        await cancellableSleep(pollMs);
        listing = await listSpringBoard();
      }
      if (!springBoardRunning(listing)) {
        return {
          failed: true,
          springBoardDown: true,
          reason: `Simulator ${udid} reports Booted, but SpringBoard (the system shell) is not running, so apps cannot launch. Run \`stim stop\`, then \`stim ios\` again. If it repeats, look for SpringBoard crash reports in ~/Library/Logs/DiagnosticReports.`,
        };
      }
      return { ok: true, udid };
    } catch (error) {
      return {
        failed: true,
        reason: `Simulator ${udid} failed its process-spawn readiness check: ${(error as Error)?.message || error}. ${await iosSimulatorFailureAdvice()}`,
      };
    }
  };
  const booting = device?.booting;
  if (booting?.udid === udid) {
    try {
      await booting.done;
    } catch (e) {
      return bootFailure(udid, e);
    }
    return ready();
  }
  const readiness = device?.booted === udid ? await ready() : null;
  if (readiness?.ok) {
    if (simulatorApp !== undefined) await openViewer();
    return readiness;
  }

  let resolved;
  try {
    resolved = resolveOwnedIosSim(udid, await listAllIosSimsAsync());
  } catch (e) {
    return { failed: true, reason: `Could not list simulators: ${(e as Error)?.message || e}` };
  }
  if (resolved.missing) {
    return {
      failed: true,
      reason: `Simulator ${udid} no longer exists. Run \`stim ios\` again to create a fresh owned sim.`,
    };
  }
  if (resolved.notOwned) {
    return {
      failed: true,
      reason: `Simulator ${udid} is now named "${resolved.notOwned}" and is not Stim-owned; refusing to boot it.`,
    };
  }
  const sim = resolved.sim as SimRecord;
  if (sim.state === 'Booted') {
    const result = readiness ?? (await ready());
    if (result.ok && simulatorApp !== undefined) await openViewer();
    return result;
  }

  const bootDeadline = Date.now() + timeoutMs;
  try {
    await withDeviceBootAdmission(
      { platform: 'ios', key: udid },
      async () => {
        out(chalk.dim(phaseLine('device', `booting ${sim.name} (${udid})`)));
        await bootIosSim(udid, {
          timeoutMs,
          label: sim.name,
          out,
          simulatorApp,
          env: ambientContext()?.env,
          onPhase,
        });
        await muteBootedSimulator(udid, out);
      },
      { ...deviceSlotWait, root: projectPath, out },
    );
  } catch (e) {
    return bootFailure(udid, e);
  }

  const deadline = Math.max(bootDeadline, Date.now() + 2 * pollMs);
  while (Date.now() < deadline) {
    await cancellableSleep(pollMs);
    let state = null;
    try {
      state = (await listAllIosSimsAsync({ timeoutMs: 30000 })).find((s) => s.udid === udid)?.state ?? null;
    } catch {}
    if (state === 'Booted') return ready();
  }
  return {
    failed: true,
    reason: `Simulator ${udid} did not reach the Booted state within ${Math.round(timeoutMs / 1000)}s.`,
  };
}

function bootFailure(udid: string, error: unknown): BootResult {
  const refusal = error instanceof DeviceAdmissionRefusal ? error : claimFailure(error, 'stim ios');
  if (refusal) return { failed: true, code: refusal.code, reason: refusal.message, remedy: refusal.remedy };
  return { failed: true, reason: `Could not boot simulator ${udid}: ${(error as Error)?.message || error}` };
}
