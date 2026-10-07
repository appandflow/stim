import type { HostedDeviceSelectors } from '@stim-cli/core/state';
import { prepareHostedAndroid, type HostedAndroidTarget } from '../../device-host/hosted-android.ts';
import { readHostedAndroid } from '../../device-host/ios-state.ts';
import { deviceSlotPlatforms } from '../../devices/device-slots.ts';
import { resolveOwnedAvdSerial } from '../../devices/android.ts';
import { getProject } from '../../workspace/config.ts';

export async function connectAndroidHosting({
  root,
  slot,
  machine,
  release,
  metroCheck,
  selectors,
  read = readHostedAndroid,
  resolveSerial = resolveOwnedAvdSerial,
  prepare = prepareHostedAndroid,
}: {
  root: string;
  slot: string;
  machine: string | null;
  release: boolean;
  metroCheck: boolean;
  selectors: HostedDeviceSelectors;
  read?: typeof readHostedAndroid;
  resolveSerial?: typeof resolveOwnedAvdSerial;
  prepare?: typeof prepareHostedAndroid;
}): Promise<{ target: HostedAndroidTarget | null } | { failure: { code: string; message: string; remedy?: string } }> {
  let recorded;
  try {
    recorded = read(root, slot)[slot];
  } catch (error) {
    return {
      failure: {
        code: 'STIM_HOSTING_REFUSED',
        message: (error as Error).message,
        remedy: `Restore that slot's recorded machine and session from the host, then run stim stop${slot === 'default' ? '' : ` --slot ${slot}`} to reconcile it.`,
      },
    };
  }
  if (recorded && recorded.machine !== machine)
    return {
      failure: {
        code: 'STIM_BAD_ARG',
        message: `This workspace's Android emulator runs on ${recorded.machine}; run stim stop first.`,
      },
    };
  if (!machine) return { target: null };
  if (!release && !metroCheck)
    return {
      failure: {
        code: 'STIM_BAD_ARG',
        message: 'Hosted Debug runs require the local Metro supervisor; --no-metro-check cannot be used.',
        remedy: 'Run stim stop; stim start, then retry without --no-metro-check.',
      },
    };
  const local = deviceSlotPlatforms(getProject(root), slot)?.android;
  if (local?.owned && local.avdName) {
    let running = true;
    try {
      const resolved = resolveSerial(local.avdName, { timeoutMs: 5000 });
      running = Boolean(resolved.serial) || (!resolved.notRunning && !resolved.missing);
    } catch {}
    if (running)
      return {
        failure: {
          code: 'STIM_BAD_ARG',
          message: `This workspace's Android emulator for slot ${slot} runs on this Mac; run stim stop first.`,
        },
      };
  }
  try {
    return { target: await prepare(machine, selectors, recorded) };
  } catch (error) {
    return {
      failure: {
        code: (error as Error & { code?: string }).code ?? 'STIM_HOSTING_REFUSED',
        message: (error as Error).message,
        ...(error instanceof Error && 'remedy' in error && typeof error.remedy === 'string'
          ? { remedy: error.remedy }
          : {}),
      },
    };
  }
}
