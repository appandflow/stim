import chalk from 'chalk';
import { phaseLine } from '../command-output.ts';
import {
  allConsolePortsAndSerials,
  clearDevice,
  loadConfig,
  releaseAndroidConsolePort,
  setDevice,
  withConfigLock,
} from '../workspace/config.ts';
import { pidExists } from '../metro.ts';
import { readHostMemoryPressure, type HostMemoryPressure } from '../host-memory.ts';
import { listAllIosSims } from '../devices/ios.ts';
import { adoptParked, isLegacyDeletionClaim, parkedMaxSetting, readParked } from '../devices/sim-pool.ts';
import {
  assertOwnedAvdStopped,
  avdPoolConfiguration,
  DEFAULT_AVD_DEVICE_PROFILE,
  OWNED_AVD_CONFIG_DEFAULTS,
  ownedAvdDeviceProfile,
  ownedAvdMatchesConfiguration,
  pickDefaultSystemImage,
  listInstalledSystemImages,
  bootAndroidEmulator,
  configureNewOwnedAvd,
  getAvdNameForSerial,
  listAdbDevices,
  listAvds,
  nextConsolePort,
  ownedAvdSystemImage,
  resolveOwnedAvdSerial,
  waitForBoot,
} from '../devices/android.ts';
import { androidAvdConfigSetting, androidDataPartitionSizeGbSetting } from '../workspace/settings.ts';
import { teardownOwnedAvd, teardownParkedAvd } from '../devices/teardown.ts';
import { AvdBootError, AvdRecoveryError, prepareOwnedAvd } from './android-avd-setup.ts';
import { liveOwnedDeviceCount } from './device-capacity.ts';
import type {
  BootResult,
  DeviceFlags,
  DeviceSettings,
  EmulatorLogging,
  Liveness,
  Notify,
  OwnedDeviceRecord,
} from './device.ts';

export { AvdBootError, AvdRecoveryError } from './android-avd-setup.ts';

// WHPX is the only Android accelerator on Windows and boots a cold system image far slower than
// HVF or KVM: measured on a windows-latest host, a first emulator took 9m38s and a second one
// beside it 9m37s, and a GitHub runner exceeded both. Both Android waits take 20 minutes there.
const ANDROID_FRESH_BOOT_TIMEOUT_MS = process.platform === 'win32' ? 1200000 : 120000;
export const ANDROID_BOOT_TIMEOUT_MS: number = process.platform === 'win32' ? 1200000 : 240000;

export async function ensureOwnedAndroidDevice({
  record,
  projectPath,
  slot,
  settingsRoot,
  label,
  settings,
  flags,
  note,
  out,
  logFile,
  alive,
  configureAvd,
  teardownAvd,
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
  configureAvd: typeof configureNewOwnedAvd;
  teardownAvd: typeof teardownOwnedAvd;
} & EmulatorLogging): Promise<OwnedDeviceRecord> {
  const projectAvdConfig = androidAvdConfigSetting(settings, settingsRoot);
  const avdConfig = { ...OWNED_AVD_CONFIG_DEFAULTS, ...projectAvdConfig };
  const requestedProfile = flags.deviceProfile || settings.android?.deviceProfile || null;
  const deviceProfile = requestedProfile ?? DEFAULT_AVD_DEVICE_PROFILE;
  const configuration = avdPoolConfiguration(androidDataPartitionSizeGbSetting(settings), avdConfig, deviceProfile);
  const configurationBeforeDefaults = avdPoolConfiguration(
    androidDataPartitionSizeGbSetting(settings),
    projectAvdConfig,
    deviceProfile,
  );
  if (record?.setupIncomplete && record.avdName) {
    const avdName = record.avdName;
    const cleanup = teardownAvd(avdName, {
      del: true,
      owner: { projectPath, slot, expectedRecord: record },
      onRemoved: () => {
        clearDevice(projectPath, 'android', slot, avdName);
      },
    });
    if (cleanup.status === 'failed' || cleanup.status === 'skipped') {
      throw new AvdRecoveryError(
        `Owned AVD ${record.avdName} has incomplete setup and could not be deleted (${cleanup.reason || cleanup.status}). Fix the cause, then retry; Stim kept the device record for cleanup.`,
        'Wait for any active AVD operation to finish. If the refusal names an unresolved claim, inspect its creator and native processes before removing only that claim. Retry `stim android` to reconcile the incomplete device.',
      );
    }
    record = null;
  }
  if (record?.avdName) {
    if (record.owned) {
      const resolved = resolveOwnedAvdSerial(record.avdName);
      const currentProfile = resolved.notOwned || resolved.missing ? null : ownedAvdDeviceProfile(record.avdName);
      if (requestedProfile && currentProfile && currentProfile !== requestedProfile) {
        throw new AvdRecoveryError(
          `this project's emulator uses device profile ${currentProfile}, but ${requestedProfile} was requested. Stim will not silently boot a different model.`,
          'Run `stim worktree remove` (or `stim gc --delete`) to reap the current emulator, then `stim android` again to create the requested one, or pass `--slot <name>` to create it beside the current one.',
        );
      }
      if (resolved.notOwned) {
        note(
          chalk.yellow(
            `Note: recorded AVD ${record.avdName} is not Stim-owned by name -- creating a fresh owned AVD instead of reusing it.`,
          ),
        );
      } else if (resolved.serial) {
        const consolePort = Number(resolved.serial.replace(/^emulator-/, ''));
        if (record.consolePort && record.consolePort !== consolePort) {
          out(
            phaseLine(
              'device',
              `${record.avdName} changed serial (emulator-${record.consolePort} -> ${resolved.serial}); reconnecting this run, reopen agent-device on ${resolved.serial}`,
            ),
          );
        }
        const updated = {
          ...record,
          avdName: record.avdName,
          consolePort,
          owned: true,
          deviceName: record.deviceName ?? record.avdName,
        };
        setDevice(projectPath, 'android', updated, slot);
        return {
          ...updated,
          systemImage: ownedAvdSystemImage(record.avdName),
          deviceProfile: currentProfile,
        };
      } else if (!resolved.missing) {
        out(
          chalk.dim(
            `Recorded port for owned AVD ${record.avdName} is not currently ours; booting it on a freshly allocated port...`,
          ),
        );
        return {
          ...(await bootOwnedAvdOnFreshPort({
            avdName: record.avdName,
            metadata: record,
            projectPath,
            slot,
            deviceName: record.deviceName,
            out,
            logFile,
            alive,
          })),
          systemImage: ownedAvdSystemImage(record.avdName),
          deviceProfile: currentProfile,
        };
      }
    } else {
      const avdExists = listAvds().includes(record.avdName);
      if (avdExists) {
        const adb = listAdbDevices();
        const running = adb.emulators.some((e) => e.consolePort === record.consolePort);
        if (!running) {
          note(
            chalk.yellow(
              `Note: assigned AVD ${record.avdName} (emulator-${record.consolePort}) is shut down and is not owned by Stim, so it will not be booted automatically.`,
            ),
          );
          note(
            chalk.dim(
              'Boot it yourself, or run `stim gc --delete` to clear the assignment so Stim can create an owned AVD.',
            ),
          );
        }
        return record;
      }
    }
  } else if (record?.serial) {
    note(
      chalk.yellow(
        `Note: this project has a stored assignment to physical device ${record.serial}, which Stim no longer keeps.`,
      ),
    );
    note(chalk.dim('Creating an owned emulator instead. Pass `--device` to build for a connected device.'));
  }

  if (parkedMaxSetting('android').max > 0) {
    const systemImage = pickDefaultSystemImage(listInstalledSystemImages(), {
      systemImage: flags.systemImage || settings.android?.systemImage,
    })?.pkg;
    const candidates = readParked('android')
      .filter(
        (entry) =>
          entry.systemImage === systemImage &&
          (entry.configuration === configuration || entry.configuration === configurationBeforeDefaults),
      )
      .toSorted((a, b) => a.parkedAt.localeCompare(b.parkedAt));
    for (const parked of candidates) {
      if (isLegacyDeletionClaim(parked.deletionClaim)) continue;
      const resolved = resolveOwnedAvdSerial(parked.name);
      if (resolved.missing) {
        const result = teardownParkedAvd(parked.name);
        if (result.status === 'failed') out(phaseLine('device', `kept ${parked.name}: ${result.reason}`));
        continue;
      }
      if (resolved.notOwned || resolved.serial) continue;
      try {
        assertOwnedAvdStopped(parked.name);
      } catch (error) {
        out(phaseLine('device', `kept parked ${parked.name}: ${String((error as Error)?.message || error)}`));
        continue;
      }
      if (
        ownedAvdSystemImage(parked.name) !== systemImage ||
        !ownedAvdMatchesConfiguration(parked.name, parked.configuration)
      ) {
        const result = teardownParkedAvd(parked.name);
        if (result.status === 'failed') out(phaseLine('device', `kept ${parked.name}: ${result.reason}`));
        continue;
      }
      const adopted = {
        avdName: parked.name,
        deviceName: parked.name,
        owned: true,
        poolConfiguration: parked.configuration,
        adoptionPending: true,
      };
      if (!adoptParked({ platform: 'android', projectPath, slot, udid: parked.udid, device: adopted })) continue;
      if (parked.configuration !== configuration) {
        try {
          configureAvd(parked.name, { dataPartitionSizeGb: androidDataPartitionSizeGbSetting(settings), avdConfig });
          adopted.poolConfiguration = configuration;
        } catch (error) {
          out(
            phaseLine(
              'device',
              `${parked.name} keeps its old AVD settings: ${String((error as Error)?.message || error)}`,
            ),
          );
        }
      }
      return {
        ...(await bootOwnedAvdOnFreshPort({
          avdName: parked.name,
          projectPath,
          slot,
          metadata: adopted,
          out,
          logFile,
          alive,
        })),
        adopted: true,
        systemImage,
        deviceProfile,
      };
    }
  }
  const created = await prepareOwnedAvd({
    projectPath,
    slot,
    label,
    previousAvdName: record?.avdName,
    systemImage: flags.systemImage || settings.android?.systemImage || undefined,
    deviceProfile,
    configuration,
    configure: (avdName) =>
      configureAvd(avdName, {
        dataPartitionSizeGb: androidDataPartitionSizeGbSetting(settings),
        avdConfig,
      }),
    teardown: teardownAvd,
  });
  if (!created.created) {
    out(chalk.dim(phaseLine('device', `recovered ${created.avdName} (unrecorded from a prior run)`)));
    if (created.serial) return { ...created, owned: true, deviceName: created.avdName };
  }
  return {
    ...(await bootOwnedAvdOnFreshPort({
      avdName: created.avdName,
      metadata: created.created ? { poolConfiguration: configuration } : undefined,
      projectPath,
      slot,
      deviceName: created.avdName,
      out,
      logFile,
      alive,
    })),
    created: created.created,
    systemImage: created.systemImage,
    deviceProfile: created.deviceProfile,
  };
}

export interface AndroidConsolePortClaim {
  avdName: string;
  consolePort: number;
  owned: true;
  deviceName: string;
  [key: string]: unknown;
}

export function claimAndroidConsolePort(
  {
    projectPath,
    slot,
    avdName,
    deviceName,
    livePorts = [],
    metadata,
  }: {
    projectPath: string;
    slot?: string;
    avdName: string;
    deviceName?: string;
    livePorts?: number[];
    metadata?: OwnedDeviceRecord;
  },
  {
    lock = withConfigLock,
    recordedPorts = () => allConsolePortsAndSerials().androidConsolePorts,
    record = setDevice,
  }: {
    lock?: <T>(fn: () => T) => T;
    recordedPorts?: () => number[];
    record?: typeof setDevice;
  } = {},
): AndroidConsolePortClaim {
  return lock(() => {
    const consolePort = nextConsolePort([...recordedPorts(), ...livePorts]);
    const claim: AndroidConsolePortClaim = {
      ...(metadata?.poolConfiguration ? { poolConfiguration: metadata.poolConfiguration } : {}),
      ...(metadata?.adoptionPending ? { adoptionPending: true } : {}),
      avdName,
      consolePort,
      owned: true,
      deviceName: deviceName ?? avdName,
    };
    record(projectPath, 'android', claim, slot);
    return claim;
  });
}

function liveAndroidConsolePorts(): number[] {
  const adbLive = listAdbDevices();
  return [
    ...adbLive.emulators.map((e) => e.consolePort),
    ...adbLive.unhealthy.map((u) => u.consolePort).filter((p): p is number => p != null),
  ];
}

async function bootOwnedAvdOnFreshPort({
  avdName,
  metadata,
  projectPath,
  slot,
  deviceName,
  out,
  logFile = null,
  alive = pidExists,
}: {
  avdName: string;
  metadata?: OwnedDeviceRecord;
  projectPath: string;
  slot?: string;
  deviceName?: string;
  out: Notify;
} & EmulatorLogging): Promise<OwnedDeviceRecord> {
  const claim = claimAndroidConsolePort({
    projectPath,
    slot,
    avdName,
    deviceName,
    livePorts: liveAndroidConsolePorts(),
    metadata,
  });
  const serial = `emulator-${claim.consolePort}`;
  try {
    reportAndroidMemoryPressure(out);
    const pid = bootAndroidEmulator(avdName, claim.consolePort, { logFile });
    out(chalk.dim(phaseLine('device', `waiting for ${serial} to finish booting`)));
    const result = await waitForAndroidBoot({ serial, timeoutMs: ANDROID_FRESH_BOOT_TIMEOUT_MS, pid, alive, out });
    if (result.failed) throw new AvdBootError(result.reason!, result.remedy!);
    const running = getAvdNameForSerial(serial);
    if (running && running !== avdName) {
      throw new Error(
        `${serial} is running AVD ${running}, not this workspace's owned AVD ${avdName}; refusing to use it.`,
      );
    }
    return { ...claim, serial };
  } catch (error) {
    releaseAndroidConsolePort(projectPath, claim.consolePort, slot);
    throw error;
  }
}

function reportAndroidMemoryPressure(out: Notify): void {
  const pressure = readHostMemoryPressure();
  if (pressure === 'warning' || pressure === 'critical') {
    out(
      chalk.dim(
        phaseLine(
          'memory',
          `macOS reports ${pressure} host memory pressure; emulator boot may be slow. Free memory with \`stim stop\` only in workspaces you own; ask before closing other apps or devices.`,
        ),
      ),
    );
  }
}

function androidBootRemedy(pressure: HostMemoryPressure | null): string {
  let count: number | null = null;
  try {
    count = liveOwnedDeviceCount({
      sims: process.platform === 'darwin' ? listAllIosSims({ timeoutMs: 2000 }) : [],
      adbEmulators: listAdbDevices({ timeoutMs: 2000 }).emulators,
      config: loadConfig(),
    });
  } catch {}
  const observation =
    pressure === 'warning' || pressure === 'critical' ? `macOS reports ${pressure} host memory pressure. ` : '';
  const devices = count ? `${count} Stim-owned ${count === 1 ? 'device is' : 'devices are'} running. ` : '';
  if (observation || devices) {
    return `${observation}${devices}Stop an unneeded device with \`stim stop\` only in a workspace you own, then run \`stim android\` again; ask before closing other apps or devices. These observations do not establish the cause of the timeout or an OOM crash.`;
  }
  return 'Inspect the emulator log and run `stim doctor` to check JAVA_HOME, ANDROID_HOME, and installed system images, then run `stim android` again.';
}

async function waitForAndroidBoot({
  serial,
  timeoutMs,
  pid = null,
  alive = pidExists,
  out,
}: {
  serial: string;
  timeoutMs: number;
  pid?: number | null;
  alive?: Liveness;
  out: Notify;
}): Promise<BootResult> {
  const aborted = () => pid !== null && !alive(pid);
  const wait = (windowMs: number) => waitForBoot(serial, windowMs, { aborted, commandTimeoutMs: 5000 });
  let result = await wait(timeoutMs);
  if (result.ok) return { ok: true, serial };
  let pressure = readHostMemoryPressure();
  let elapsedMs = timeoutMs;
  if (!result.exited && pid !== null && !aborted() && (pressure === 'warning' || pressure === 'critical')) {
    const extensionMs = 240000;
    out(
      chalk.dim(
        phaseLine(
          'memory',
          `macOS reports ${pressure} host memory pressure; retrying the boot wait once for the same live emulator ${serial} (up to ${extensionMs / 1000}s more).`,
        ),
      ),
    );
    result = await wait(extensionMs);
    if (result.ok) return { ok: true, serial };
    elapsedMs += extensionMs;
    pressure = readHostMemoryPressure();
  }
  const exited = result.exited || aborted();
  const reason = exited
    ? `The emulator process for ${serial} exited before the device finished booting.`
    : `Emulator ${serial} did not finish booting within ${Math.round(elapsedMs / 1000)}s.`;
  return {
    failed: true,
    reason: `${reason} Diagnostic: ${JSON.stringify(result.diagnostic)}`,
    remedy: exited
      ? 'Inspect the emulator log for the process exit, fix what it reports, then run `stim android` again.'
      : androidBootRemedy(pressure),
  };
}

export async function ensureAndroidBooted({
  device,
  projectPath,
  slot,
  timeoutMs,
  out,
  logFile = null,
  alive = pidExists,
}: {
  device?: OwnedDeviceRecord | null;
  projectPath?: string;
  slot?: string;
  timeoutMs: number;
  out: Notify;
} & EmulatorLogging): Promise<BootResult> {
  if (!device?.avdName || !projectPath) {
    return { failed: true, reason: 'No owned Android emulator is recorded for this project.' };
  }

  let resolved;
  try {
    resolved = resolveOwnedAvdSerial(device.avdName);
  } catch (e) {
    return { failed: true, reason: `Could not list AVDs: ${(e as Error)?.message || e}` };
  }
  if (resolved.missing) {
    return {
      failed: true,
      reason: `AVD ${device.avdName} no longer exists. Run \`stim android\` again to create a fresh owned AVD.`,
    };
  }
  if (resolved.notOwned) {
    return { failed: true, reason: `AVD ${device.avdName} is not Stim-owned by name; refusing to boot it.` };
  }
  if (resolved.serial) {
    return waitForAndroidBoot({ serial: resolved.serial, timeoutMs, out });
  }

  const freshSerial = `emulator-${device.consolePort}`;
  if (device.owned && device.serial === freshSerial) {
    return waitForAndroidBoot({ serial: freshSerial, timeoutMs, out });
  }

  const claim = claimAndroidConsolePort({
    projectPath,
    slot,
    avdName: device.avdName,
    deviceName: device.deviceName,
    livePorts: liveAndroidConsolePorts(),
    metadata: device,
  });
  const serial = `emulator-${claim.consolePort}`;
  reportAndroidMemoryPressure(out);
  out(chalk.dim(phaseLine('device', `booting ${device.avdName} as ${serial}`)));
  let pid: number | null = null;
  try {
    pid = bootAndroidEmulator(device.avdName, claim.consolePort, { logFile });
  } catch (e) {
    releaseAndroidConsolePort(projectPath, claim.consolePort, slot);
    return {
      failed: true,
      reason: `Could not start emulator for AVD ${device.avdName}: ${(e as Error)?.message || e}`,
    };
  }
  const result = await waitForAndroidBoot({ serial, timeoutMs, pid, alive, out });
  if (result.failed) releaseAndroidConsolePort(projectPath, claim.consolePort, slot);
  return result;
}
