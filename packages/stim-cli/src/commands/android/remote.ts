import { automaticDevicePlacement, devicePlacementLine } from '../../device-host/auto-placement.ts';
import { budgetGate } from '../../budget.ts';
import type { AndroidRunPlan } from './plan.ts';
import type { DevicePlacement, HostedDeviceSelectors } from '@stim-cli/core/state';
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

export async function selectAndroidPlacement({
  target: selected,
  automatic = automaticDevicePlacement,
  checkBudget = budgetGate,
  note,
  phase,
  noWait,
  buildMachine,
  localSelectors,
  ...args
}: Omit<Parameters<typeof connectAndroidHosting>[0], 'machine' | 'selectors'> & {
  target: AndroidRunPlan['target'];
  automatic?: typeof automaticDevicePlacement;
  checkBudget?: typeof budgetGate;
  note: (line: string) => void;
  phase: (label: string, line: string) => void;
  noWait: boolean;
  buildMachine?: string;
  localSelectors: (target: {
    systemImage: string | null;
    deviceProfile: string | null;
  }) => { code: string; message: string; remedy: string } | null;
}): Promise<
  | {
      target: AndroidRunPlan['target'];
      hostedTarget: HostedAndroidTarget | null;
      budget: Awaited<ReturnType<typeof budgetGate>>;
      selectors: HostedDeviceSelectors;
      devicePlacement?: DevicePlacement;
    }
  | { failure: { code: string; message: string; remedy?: string } }
> {
  const selectors =
    selected.kind === 'hosted'
      ? {
          ...(selected.systemImage ? { systemImage: selected.systemImage } : {}),
          ...(selected.deviceProfile ? { deviceProfile: selected.deviceProfile } : {}),
        }
      : {};
  if (selected.kind !== 'hosted' || selected.machine !== 'auto') {
    const connected = await connectAndroidHosting({
      ...args,
      selectors,
      machine: selected.kind === 'hosted' ? selected.machine : null,
    });
    if ('failure' in connected) return connected;
    return {
      target: selected,
      hostedTarget: connected.target,
      selectors,
      budget: connected.target ? { reclaimed: [], refusal: null } : await checkBudget({ root: args.root, note }),
    };
  }
  const refusal = localSelectors(selected);
  if (refusal) return { failure: refusal };
  try {
    const placed = await automatic({
      root: args.root,
      slot: args.slot,
      platform: 'android',
      selectors,
      buildMachine,
      noWait,
    });
    phase('placement:', devicePlacementLine(placed.placement, placed.skipped));
    if (placed.target && !args.release && !args.metroCheck)
      return {
        failure: {
          code: 'STIM_BAD_ARG',
          message: 'Hosted Debug runs require the local Metro supervisor; --no-metro-check cannot be used.',
          remedy: 'Run stim stop; stim start, then retry without --no-metro-check.',
        },
      };
    return {
      target: placed.target
        ? { ...selected, machine: placed.target.host.machine }
        : { kind: 'emulator', systemImage: selected.systemImage, deviceProfile: selected.deviceProfile },
      hostedTarget: placed.target as HostedAndroidTarget | null,
      selectors,
      budget: placed.target ? { reclaimed: [], refusal: null } : await checkBudget({ root: args.root, note }),
      devicePlacement: placed.placement,
    };
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
