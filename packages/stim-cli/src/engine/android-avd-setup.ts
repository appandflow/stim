import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { acquireAvdClaim } from '../avd-claim.ts';
import { clearDevice, loadConfig, setDevice, withConfigLock } from '../config.ts';
import { deviceSlotPlatforms, projectDeviceSlots } from '../device-slots.ts';
import { clearClaimChild, markClaimChildPending, releaseClaim } from '../ownership-claim.ts';
import { readParked } from '../sim-pool.ts';
import {
  assertOwnedAvdStopped,
  createOwnedAvd,
  listAvds,
  ownedAvdName,
  ownedAvdSystemImage,
  resolveOwnedAvdSerial,
} from '../sim/android.ts';
import { teardownOwnedAvd } from '../teardown.ts';

export class AvdBootError extends Error {
  readonly remedy: string;

  constructor(message: string, remedy: string, cause?: unknown) {
    super(message, { cause });
    this.remedy = remedy;
  }
}

export class AvdRecoveryError extends AvdBootError {}

interface PreparedAvd {
  avdName: string;
  systemImage: string | null;
  created: boolean;
  serial?: string;
  consolePort?: number;
}

function findOtherOwner(avdName: string, projectPath: string, selectedSlot = 'default'): string | null {
  for (const [path, project] of Object.entries(loadConfig()?.projects ?? {})) {
    if (
      projectDeviceSlots(project).some(
        ({ slot, platforms }) =>
          (path !== projectPath || slot !== selectedSlot) &&
          platforms.android?.avdName?.toLowerCase() === avdName.toLowerCase(),
      )
    )
      return path;
  }
  return null;
}

export function prepareOwnedAvd({
  projectPath,
  slot,
  label,
  previousAvdName,
  systemImage,
  configuration,
  configure,
  teardown = teardownOwnedAvd,
}: {
  projectPath: string;
  slot?: string;
  label: string;
  previousAvdName?: string;
  systemImage?: string;
  configuration: string;
  configure: (avdName: string) => void;
  teardown?: typeof teardownOwnedAvd;
}): PreparedAvd {
  const allocation = withConfigLock(() => {
    const previous = deviceSlotPlatforms(loadConfig()?.projects?.[projectPath], slot)?.android;
    if (previous?.avdName && previous.avdName !== previousAvdName) {
      throw new Error(`Another Stim run assigned AVD ${previous.avdName} to this workspace. Retry to use it.`);
    }
    if (
      readParked('android').some((entry) => entry.name === ownedAvdName(label)) ||
      findOtherOwner(ownedAvdName(label), projectPath, slot)
    )
      label = `${label}-${randomUUID().slice(0, 8)}`;
    const avdName = ownedAvdName(label);
    const claim = acquireAvdClaim(avdName);
    const reservation = {
      avdName,
      owned: true,
      deviceName: avdName,
      setupIncomplete: true,
      poolConfiguration: configuration,
    };
    try {
      setDevice(projectPath, 'android', reservation, slot);
      return { claim, reservation, previous, avdName };
    } catch (error) {
      releaseClaim(claim);
      throw error;
    }
  });
  const { claim, reservation, previous, avdName } = allocation;
  const currentRecord = () => deviceSlotPlatforms(loadConfig()?.projects?.[projectPath], slot)?.android;
  const assertReservation = () => {
    if (readParked('android').some((entry) => entry.name === avdName)) {
      throw new Error(`AVD ${avdName} was parked by another Stim run. Retry to adopt it safely.`);
    }
    const owner = findOtherOwner(avdName, projectPath, slot);
    if (owner) {
      throw new Error(
        `AVD ${avdName} already exists and is owned by another project (${owner}). Retry to allocate a distinct owned emulator.`,
      );
    }
    const current = currentRecord();
    if (!isDeepStrictEqual(current, reservation)) {
      const state = current?.setupIncomplete ? 'has incomplete setup' : 'was registered or removed';
      throw new Error(
        `AVD ${current?.avdName ?? avdName} ${state} by another concurrent Stim run. Retry after that run finishes so the recorded device is resolved safely.`,
      );
    }
  };
  let prepared: PreparedAvd;
  let configurationFailure: { error: unknown } | undefined;
  try {
    try {
      markClaimChildPending(claim);
      try {
        prepared = { ...createOwnedAvd(label, { systemImage }), created: true };
      } finally {
        clearClaimChild(claim);
      }
    } catch (error) {
      const message = String((error as Error)?.message || error);
      if (!message.includes('already exists')) throw error;
      try {
        if (!listAvds().includes(avdName)) {
          throw new AvdRecoveryError(
            `AVD ${avdName} already exists on disk but is not listed by the emulator. ${message}`,
            'Run `npx stim gc` to inspect orphaned owned AVDs, then `npx stim gc --delete` to reclaim those safe to delete. Retry `stim android` after cleanup; keep any AVD that GC cannot verify.',
            error,
          );
        }
        withConfigLock(assertReservation);
        const resolved = resolveOwnedAvdSerial(avdName);
        if (resolved.missing || resolved.notOwned) {
          throw new Error(`AVD ${avdName} could not be verified for recovery. Retry after checking its registration.`, {
            cause: error,
          });
        }
        if (!resolved.serial) assertOwnedAvdStopped(avdName);
        prepared = {
          avdName,
          created: false,
          systemImage: ownedAvdSystemImage(avdName),
          ...(resolved.serial
            ? { serial: resolved.serial, consolePort: Number(resolved.serial.replace(/^emulator-/, '')) }
            : {}),
        };
      } catch (recoveryError) {
        withConfigLock(() => {
          if (!isDeepStrictEqual(currentRecord(), reservation)) return;
          if (previous) setDevice(projectPath, 'android', previous, slot);
          else clearDevice(projectPath, 'android', slot, avdName);
        });
        if (recoveryError instanceof AvdRecoveryError) throw recoveryError;
        throw new AvdRecoveryError(
          `Could not recover owned AVD ${avdName}: ${String((recoveryError as Error)?.message || recoveryError)}`,
          'Inspect `npx stim status` and `adb devices`. Wait for any other Stim run using this AVD to finish, then retry `stim android`. Keep the AVD and its process locks while its state is unverified.',
          recoveryError,
        );
      }
    }
    if (prepared.created) {
      try {
        configure(avdName);
      } catch (error) {
        configurationFailure = { error };
      }
    }
    if (!configurationFailure) {
      withConfigLock(() => {
        assertReservation();
        setDevice(
          projectPath,
          'android',
          {
            avdName,
            owned: true,
            deviceName: avdName,
            ...(prepared.created ? { poolConfiguration: configuration } : {}),
            ...(prepared.consolePort ? { consolePort: prepared.consolePort } : {}),
          },
          slot,
        );
      });
    }
  } finally {
    releaseClaim(claim);
  }
  if (configurationFailure) {
    const { error } = configurationFailure;
    const cleanup = teardown(avdName, {
      del: true,
      owner: { projectPath, slot, expectedRecord: reservation },
      onRemoved: () => {
        clearDevice(projectPath, 'android', slot, avdName);
      },
    });
    const kept = cleanup.status === 'failed' || cleanup.status === 'skipped';
    const orphan = kept
      ? ` The owned AVD remains tracked for cleanup (${cleanup.reason || cleanup.status}); fix the cause, then retry or run \`stim gc --delete\`.`
      : '';
    throw new Error(
      `Created owned AVD ${avdName}, but could not configure its AVD settings: ${String((error as Error)?.message || error)}${orphan}`,
      { cause: error },
    );
  }
  return prepared;
}
