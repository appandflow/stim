import { deviceSlotPlatforms, projectDeviceSlots } from '../devices/device-slots.ts';
import chalk from 'chalk';
import { phaseLine } from '../command-output.ts';
import { workspaceId } from '../workspace/paths.ts';
import { clearDevice, getConfigDir, loadConfig, saveConfig, setDevice, withConfigLock } from '../workspace/config.ts';
import { configuredIosSimulatorViewer, type IosSimulatorApp } from '../devices/ios-simulator-viewer.ts';
import { getExecutor } from '../exec.ts';
import { hostMemoryPressureAdvice, readHostMemoryPressure } from '../host-memory.ts';
import {
  bootIosSim,
  createOwnedIosSim,
  iosSimulatorFailureAdvice,
  listAllIosSims,
  listIosDeviceTypes,
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
import { iosSimSlimProfileSetting } from '../workspace/settings.ts';
import { teardownParkedIosSim } from '../devices/teardown.ts';
import { reconcileSimSlim } from './simslim.ts';
import { withWorkspaceProcessLock } from './workspace-process-lock.ts';
import { deviceTypeMismatch } from './device-capacity.ts';
import type { BootResult, DeviceFlags, DeviceSettings, Notify, OwnedDeviceRecord } from './device.ts';

type SimRecord = ReturnType<typeof listAllIosSims>[number];

export interface IosBoot {
  udid: string;
  done: Promise<void>;
}

function startIosBoot(
  udid: string,
  configure: () => Promise<unknown>,
  label: string,
  out: Notify,
  simulatorApp?: IosSimulatorApp,
): IosBoot {
  const done = (async () => {
    await bootIosSim(udid, { label, out, simulatorApp });
    await configure();
  })();
  // Node ends the process on an unhandled rejection, and `ensureBooted` -- the
  // real handler -- does not run when an earlier step of the run refuses first.
  done.catch(() => {});
  return { udid, done };
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
}): Promise<OwnedDeviceRecord> {
  const memoryAdvice = hostMemoryPressureAdvice(readHostMemoryPressure());
  if (memoryAdvice) out(chalk.yellow(phaseLine('memory', memoryAdvice)));
  const simslimProfile = iosSimSlimProfileSetting(settings, settingsRoot);
  if (record?.deviceUdid) {
    if (record.owned) {
      const resolved = resolveOwnedIosSim(record.deviceUdid);
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
        const deviceTypes = listIosDeviceTypes();
        const mismatch = deviceTypeMismatch(sim.deviceTypeIdentifier, wantedType, deviceTypes);
        if (mismatch) {
          throw new Error(
            `${mismatch}. Stim will not silently boot a different model. ` +
              'Run `stim worktree remove` (or `stim gc --delete`) to reap the current sim, then `stim ios` again to create the requested one.',
          );
        }
        const model: SimModel = {
          model: deviceTypes.find((d) => d.identifier === sim.deviceTypeIdentifier)?.name ?? null,
          runtime: parseRuntimeVersion(sim.runtime),
        };
        const name = await withIosDeviceNameLock(() => renameToOwnedName(sim, label, model, projectPath));
        const updated = {
          deviceUdid: sim.udid,
          owned: true,
          deviceName: name,
          ...(record.simslimManaged ? { simslimManaged: true } : {}),
          ...(record.adopted ? { adopted: true } : {}),
          ...(record.adoptionPending ? { adoptionPending: true } : {}),
          ...(record.parkedCacheKey ? { parkedCacheKey: record.parkedCacheKey } : {}),
        };
        const configure = async () => {
          if (record.adoptionPending) resetAdoptedSim(sim.udid, out);
          return configureOwnedIosSim({
            record: updated,
            projectPath,
            slot,
            profile: simslimProfile,
            out,
            reconcileIosSimulator,
          });
        };
        const facts = {
          deviceType: model.model,
          runtime: model.runtime,
        };
        if (sim.state !== 'Booted') {
          out(chalk.dim(phaseLine('device', `booting ${name} (${sim.udid})`)));
          return { ...updated, booting: startIosBoot(sim.udid, configure, name, out, flags.simulatorApp), ...facts };
        }
        return { ...(await configure()), ...facts };
      }
    } else {
      const sim = listAllIosSims().find((s) => s.udid === record.deviceUdid);
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
    withConfigLock(() => {
      const current = deviceSlotPlatforms(loadConfig()?.projects?.[projectPath], slot)?.ios;
      if (!current) return;
      if (current.deviceUdid !== record.deviceUdid || current.owned !== record.owned) {
        throw new Error('The simulator assignment changed during recovery. Run `stim ios` again.');
      }
      clearDevice(projectPath, 'ios', slot);
    });
  }

  const choice = resolveIosCreation({
    deviceType: flags.deviceType || settings.ios?.deviceType,
    runtime: flags.runtime || settings.ios?.runtime,
  });

  const adopted =
    parkedMaxSetting('ios').max > 0
      ? await withIosDeviceNameLock(() => takeParkedIosSim({ projectPath, slot, label, choice, out }))
      : null;
  if (adopted) {
    out(chalk.dim(phaseLine('device', `booting ${adopted.deviceName} (${adopted.deviceUdid})`)));
    const booting = startIosBoot(
      adopted.deviceUdid,
      async () => {
        resetAdoptedSim(adopted.deviceUdid, out);
        await configureOwnedIosSim({
          record: adopted,
          projectPath,
          slot,
          profile: simslimProfile,
          out,
          reconcileIosSimulator,
        });
      },
      adopted.deviceName,
      out,
      flags.simulatorApp,
    );
    return { ...adopted, booting, deviceType: choice.deviceType, runtime: choice.runtime };
  }

  const created = await withIosDeviceNameLock(() => {
    const suffix = ownedIosNameSuffix(label, { model: choice.deviceType, runtime: choice.runtime }, projectPath);
    const result = createOwnedIosSim(label, { suffix }, choice);
    setDevice(projectPath, 'ios', { deviceUdid: result.udid, owned: true, deviceName: result.name }, slot);
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
        out,
        reconcileIosSimulator,
      }),
    created.name,
    out,
    flags.simulatorApp,
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

function ownedIosNameSuffix(label: string, model: SimModel, projectPath: string, udid?: string): string {
  const names = new Set(
    listAllIosSims({ includeUnavailable: true })
      .filter((sim) => sim.udid !== udid)
      .map((sim) => sim.name),
  );
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

function renameToOwnedName(sim: SimRecord, label: string, model: SimModel, projectPath: string): string {
  const wanted = ownedSimName(label, model, ownedIosNameSuffix(label, model, projectPath, sim.udid));
  if (sim.name === wanted) return wanted;
  try {
    renameIosSim(sim.udid, wanted);
    return wanted;
  } catch {
    return sim.name;
  }
}

function resetAdoptedSim(udid: string, out: Notify): void {
  out(chalk.dim(phaseLine('device', `resetting privacy grants and the keychain on ${udid}`)));
  resetIosPrivacy(udid);
  resetIosKeychain(udid);
}

type AdoptedRecord = OwnedDeviceRecord & { deviceUdid: string; deviceName: string };

function takeParkedIosSim({
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
}): AdoptedRecord | null {
  const candidates = selectParked(readParked('ios'), {
    deviceTypeIdentifier: choice.deviceTypeId,
    runtimeIdentifier: choice.runtimeId,
  });
  if (candidates.length === 0) return null;
  const listed = new Map(listAllIosSims({ includeUnavailable: true }).map((sim) => [sim.udid, sim]));
  for (const parked of candidates) {
    const sim = listed.get(parked.udid);
    if (!sim || !sim.available) {
      const result = sim ? teardownParkedIosSim(parked.udid, { label: parked.name }) : null;
      const removed = sim ? result?.status === 'torn-down' : dropParked('ios', parked.udid);
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
    const name = ownedSimName(label, model, ownedIosNameSuffix(label, model, projectPath, parked.udid));
    const device = {
      deviceUdid: parked.udid,
      owned: true,
      deviceName: name,
      adopted: true,
      adoptionPending: true,
      ...(parked.simslimManaged ? { simslimManaged: true } : {}),
      ...(parked.cacheKey ? { parkedCacheKey: parked.cacheKey } : {}),
    };
    if (!adoptParked({ platform: 'ios', projectPath, slot, udid: parked.udid, device })) continue;
    try {
      renameIosSim(parked.udid, name);
    } catch {}
    return device;
  }
  return null;
}

export function clearIosAdoptionPending(projectPath: string, slot = 'default'): void {
  withConfigLock(() => {
    const cfg = loadConfig();
    const ios = deviceSlotPlatforms(cfg?.projects?.[projectPath], slot)?.ios;
    if (!cfg || !ios?.adoptionPending) return;
    delete ios.adopted;
    delete ios.adoptionPending;
    delete ios.parkedCacheKey;
    saveConfig(cfg);
  });
}

async function configureOwnedIosSim({
  record,
  projectPath,
  slot,
  profile,
  out,
  reconcileIosSimulator,
}: {
  record: OwnedDeviceRecord & { deviceUdid: string };
  projectPath: string;
  slot?: string;
  profile: string | null;
  out: Notify;
  reconcileIosSimulator: typeof reconcileSimSlim;
}): Promise<OwnedDeviceRecord> {
  if (profile) out(chalk.dim(phaseLine('device', `applying the SimSlim profile to ${record.deviceUdid}`)));
  else if (record.simslimManaged)
    out(chalk.dim(phaseLine('device', `restoring stock simulator services on ${record.deviceUdid}`)));

  const previouslyManaged = Boolean(record.simslimManaged);
  if (profile && !record.simslimManaged) {
    const pending = { ...record, simslimManaged: true };
    setDevice(projectPath, 'ios', pending, slot);
    record = pending;
  }
  const result = await reconcileIosSimulator({
    udid: record.deviceUdid,
    profile,
    previouslyManaged,
    out,
  });
  const updated = { ...record };
  if (result.managed) updated.simslimManaged = true;
  else delete updated.simslimManaged;
  setDevice(projectPath, 'ios', updated, slot);
  return updated;
}

export async function ensureIosBooted({
  device,
  simulatorApp,
  timeoutMs,
  pollMs,
  out,
}: {
  device?: OwnedDeviceRecord | null;
  simulatorApp?: IosSimulatorApp;
  timeoutMs: number;
  pollMs: number;
  out: Notify;
}): Promise<BootResult> {
  const udid = device?.deviceUdid;
  if (!udid) return { failed: true, reason: 'No iOS simulator is recorded for this project.' };
  const ready = (): BootResult => {
    try {
      // Apple simctl spawn searches the device PATH for bare names; absolute paths use the host root.
      getExecutor().runFile('xcrun', ['simctl', 'spawn', udid, 'launchctl', 'list'], { timeoutMs: 30000 });
      return { ok: true, udid };
    } catch (error) {
      return {
        failed: true,
        reason: `Simulator ${udid} failed its process-spawn readiness check: ${(error as Error)?.message || error}. ${iosSimulatorFailureAdvice()}`,
      };
    }
  };
  const booting = device?.booting;
  if (booting?.udid === udid) {
    try {
      await booting.done;
    } catch (e) {
      return { failed: true, reason: `Could not boot simulator ${udid}: ${(e as Error)?.message || e}` };
    }
    return ready();
  }

  let resolved;
  try {
    resolved = resolveOwnedIosSim(udid);
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
    const result = ready();
    if (result.ok && simulatorApp !== undefined) configuredIosSimulatorViewer(simulatorApp).open(udid);
    return result;
  }

  out(chalk.dim(phaseLine('device', `booting ${sim.name} (${udid})`)));
  const bootDeadline = Date.now() + timeoutMs;
  try {
    await bootIosSim(udid, { timeoutMs, label: sim.name, out, simulatorApp });
  } catch (e) {
    return { failed: true, reason: `Could not boot simulator ${udid}: ${(e as Error)?.message || e}` };
  }

  const deadline = Math.max(bootDeadline, Date.now() + 2 * pollMs);
  while (Date.now() < deadline) {
    await sleep(pollMs);
    let state = null;
    try {
      state = listAllIosSims({ timeoutMs: 30000 }).find((s) => s.udid === udid)?.state ?? null;
    } catch {}
    if (state === 'Booted') return ready();
  }
  return {
    failed: true,
    reason: `Simulator ${udid} did not reach the Booted state within ${Math.round(timeoutMs / 1000)}s.`,
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
