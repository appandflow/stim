import { ambientEnv } from '@stim-cli/core';
import {
  automaticMachineEnabled,
  isJsonObject,
  machineCapacity,
  parseHostedChoice,
  parseHostedNativeOffer,
  type AutomaticPlacement,
  type DevicePlacement,
  type HostedAndroidChoice,
  type HostedIosChoice,
  type HostedMacosChoice,
  type HostedDeviceSelectors,
  type HostedNativePlacement,
  type HostedIosDevice,
  type HostedAndroidDevice,
  type HostedAppOffer,
} from '@stim-cli/core/state';
import { peekBudget } from '../budget.ts';
import { namedBuildMachine, resolveBuildMachine } from '../offload/selection.ts';
import { readHostMemoryPressureAsync, type HostMemoryPressure } from '../host-memory.ts';
import { DEFAULT_DEVICE_SLOT_WAIT_MS, peekDeviceSlots } from '../engine/device-capacity.ts';
import { setTimeout as delay } from 'node:timers/promises';
import type { IosSimRecord } from '../devices/ios.ts';
import { getProject, loadConfig } from '../workspace/config.ts';
import { hostingMachines } from './machines.ts';
import { call, connectHost, requireHostedAppMode, type HostConnection } from './hosted-client.ts';
import { prepareHostedNative, type HostedNativeTarget } from './hosted-native.ts';
import { readHostedNative, writeHostedNativeAsync } from './ios-state.ts';
import {
  decideDevicePlacement,
  type EasFallbackCheck,
  type PlacementHere,
  type PlacementProbe,
  type PlacementSkip,
} from './placement.ts';

const HOST_WAIT_POLL_MS = 5000;

function refusalText(decision: { reason: string; skipped: PlacementSkip[] }, waitedMs: number | null): string {
  return [
    decision.reason,
    ...decision.skipped.map((each) => `${each.machine}: ${each.reason}`),
    ...(waitedMs === null ? [] : [`waited ${Math.round(waitedMs / 1000)}s for a remote machine with room`]),
  ].join('; ');
}

export async function probeHost(
  machine: string,
  platform: 'ios' | 'android' | 'macos',
  selectors: HostedDeviceSelectors,
  appMode?: HostedAppOffer['mode'],
  signal?: AbortSignal,
): Promise<{ probe: PlacementProbe; target?: HostedNativeTarget }> {
  let host: HostConnection | undefined;
  const deadline = Date.now() + 3000;
  const cancel = () => host?.connection.close();
  try {
    host = await connectHost(machine, 3000, true, signal);
    signal?.addEventListener('abort', cancel, { once: true });
    signal?.throwIfAborted();
    if (platform !== 'macos') requireHostedAppMode(host, platform, appMode);
    const offer = await call(host, 'device-host.offer', { platform, ...selectors }, Math.max(1, deadline - Date.now()));
    signal?.throwIfAborted();
    const resources = isJsonObject(offer.resources) ? offer.resources : {};
    const parsed = parseHostedNativeOffer({
      ...offer,
      resources: { ...resources, loadPerCore: resources.loadPerCore ?? 0 },
    });
    let choice: HostedIosChoice | HostedAndroidChoice | HostedMacosChoice | null =
      platform === 'ios'
        ? offer.platform === 'ios'
          ? parseHostedChoice(offer.choice)
          : null
        : parsed?.platform === platform
          ? parsed.choice
          : null;
    if (
      choice &&
      platform !== 'macos' &&
      ('runtime' in choice
        ? (selectors.deviceType && selectors.deviceType !== choice.deviceType) ||
          (selectors.runtime && selectors.runtime.replace(/^iOS /, '') !== choice.runtime.replace(/^iOS /, ''))
        : 'systemImage' in choice &&
          ((selectors.systemImage && selectors.systemImage !== choice.systemImage) ||
            (selectors.deviceProfile && selectors.deviceProfile !== choice.deviceProfile)))
    )
      choice = null;
    if (!isJsonObject(offer.capacity) || (offer.declined !== null && typeof offer.declined !== 'string'))
      throw new Error('unreadable device offer');
    return {
      probe: {
        machine,
        offer: {
          platform,
          choice,
          declined: offer.declined,
          capacity: { available: typeof offer.capacity.available === 'number' ? offer.capacity.available : null },
          resources: {
            ...(typeof resources.maxLoadPerCore === 'number' &&
            Number.isFinite(resources.maxLoadPerCore) &&
            resources.maxLoadPerCore > 0
              ? { maxLoadPerCore: resources.maxLoadPerCore }
              : {}),
            loadPerCore:
              typeof resources.loadPerCore === 'number' &&
              Number.isFinite(resources.loadPerCore) &&
              resources.loadPerCore >= 0
                ? resources.loadPerCore
                : null,
            memoryFreeBytes: typeof resources.memoryFreeBytes === 'number' ? resources.memoryFreeBytes : 0,
            memoryPressure: typeof resources.memoryPressure === 'string' ? resources.memoryPressure : null,
          },
        },
      },
      ...(choice && ('runtime' in choice || 'systemImage' in choice)
        ? { target: { host, choice, session: null } }
        : {}),
    };
  } catch (error) {
    signal?.throwIfAborted();
    return { probe: { machine, failure: error instanceof Error ? error.message : String(error) } };
  } finally {
    signal?.removeEventListener('abort', cancel);
    host?.connection.close();
  }
}

function hosted(
  target: HostedNativeTarget | null,
  machine: string,
  code: string,
  reason: string,
  skipped: PlacementSkip[] = [],
) {
  if (target) target.selection = { selected: 'auto', reason };
  return {
    target,
    placement: { decision: 'hosted' as const, machine, reason },
    code,
    skipped,
  };
}

function local(code: string, reason: string, skipped: PlacementSkip[] = []) {
  return { target: null, placement: { decision: 'local' as const, reason }, code, skipped };
}

function viaEas(code: string, reason: string, skipped: PlacementSkip[]) {
  return { target: null, placement: { decision: 'eas' as const, machine: 'eas', reason }, code, skipped };
}

export async function automaticDevicePlacement(
  {
    root,
    slot,
    platform,
    placement = 'auto',
    selectors,
    appMode,
    buildMachine,
    noWait,
    waitMs = DEFAULT_DEVICE_SLOT_WAIT_MS,
    onWait = () => {},
    eas,
    signal,
    localSims,
  }: {
    root: string;
    slot: string;
    platform: 'ios' | 'android' | 'macos';
    placement?: AutomaticPlacement;
    selectors: HostedDeviceSelectors;
    appMode?: HostedAppOffer['mode'];
    buildMachine?: string;
    noWait: boolean;
    /** How long remote-only waits for a full or loaded host before it refuses with STIM_AT_CAPACITY. */
    waitMs?: number;
    onWait?: (line: string) => void;
    signal?: AbortSignal;
    eas?: () => Promise<EasFallbackCheck>;
    /** Available simulators already listed by this run, so the local device count does not list again. */
    localSims?: IosSimRecord[];
  },
  {
    machines = () => hostingMachines(undefined, signal),
    read = readHostedNative,
    write = writeHostedNativeAsync,
    resume = prepareHostedNative,
    peek = () =>
      peekDeviceSlots({
        platform: platform === 'macos' ? 'ios' : platform,
        project: getProject(root),
        slot,
        ...(localSims ? { sources: { sims: localSims } } : {}),
      }),
    capacity = machineCapacity,
    memory = () => readHostMemoryPressureAsync(undefined, undefined, signal),
    probe = probeHost,
    budget = (projectRoot) => peekBudget(projectRoot, {}, ambientEnv(), signal),
    now = Date.now,
    sleep = (ms) => delay(ms, undefined, { signal }),
  }: {
    machines?: () => string[] | null | Promise<string[] | null>;
    read?: typeof readHostedNative;
    write?: (...args: Parameters<typeof writeHostedNativeAsync>) => unknown;
    resume?: typeof prepareHostedNative;
    peek?: () => Awaited<ReturnType<typeof peekDeviceSlots>> | ReturnType<typeof peekDeviceSlots>;
    capacity?: typeof machineCapacity;
    memory?: () => HostMemoryPressure | null | Promise<HostMemoryPressure | null>;
    probe?: typeof probeHost;
    budget?: typeof peekBudget;
    now?: () => number;
    sleep?: (ms: number) => Promise<unknown>;
  } = {},
): Promise<{
  target: HostedNativeTarget | null;
  placement: DevicePlacement;
  code: string;
  skipped: PlacementSkip[];
  sticky?: true;
}> {
  const recorded: HostedNativePlacement<HostedIosDevice | HostedAndroidDevice> | undefined =
    platform === 'macos' ? undefined : read(root, platform, slot)[slot];
  if (recorded && platform !== 'macos') {
    const target = await resume(recorded.machine, selectors, recorded, platform, true, appMode);
    if (target)
      return {
        target,
        placement: {
          decision: 'hosted',
          machine: recorded.machine,
          reason: recorded.reason ?? decideDevicePlacement({ sticky: { machine: recorded.machine } }).reason,
        },
        code: 'sticky',
        skipped: [],
        sticky: true,
      };
    await write(root, slot, null, platform);
  }
  const devices = platform === 'macos' ? { count: 0, max: 0, queued: 0, localLive: false } : await peek();
  if (devices.localLive && placement === 'remote-only')
    throw Object.assign(
      new Error(
        `This workspace's ${platform} device for slot ${slot} runs on this machine, and remote-only never runs here.`,
      ),
      { code: 'STIM_HOSTING_REFUSED', remedy: 'Run stim stop, then retry.' },
    );
  if (devices.localLive)
    return { ...local('sticky', decideDevicePlacement({ sticky: { local: true } }).reason), sticky: true };
  const configured = await machines();
  signal?.throwIfAborted();
  if (configured === null)
    throw Object.assign(new Error('remote.machines is invalid. Run stim guide settings and correct it.'), {
      code: 'STIM_HOSTING_REFUSED',
    });
  const config = loadConfig();
  const entries = configured.filter((machine) => automaticMachineEnabled('device', machine, config));
  const preference = resolveBuildMachine(buildMachine, ambientEnv().STIM_REMOTE_BUILD, config?.remote?.build);
  buildMachine = namedBuildMachine(preference) ? preference : undefined;
  const load = capacity();
  const here: PlacementHere = {
    localEnabled: automaticMachineEnabled('device', 'local', config),
    loadPerCore: load.loadPerCore,
    maxLoadPerCore: load.maxLoadPerCore,
    memoryPressure: await memory(),
    devices,
    budgetRefusal: await budget(root),
  };
  signal?.throwIfAborted();
  const inputs = (offers: PlacementProbe[]) => ({ platform, placement, here, offers, buildMachine, noWait });
  const notProbed = entries.map((machine) => ({ machine, failure: 'not probed' }));
  const waitStarted = now();
  let announced = false;
  let probes: Awaited<ReturnType<typeof probe>>[] = [];
  let offers: PlacementProbe[] = notProbed;
  let decision: ReturnType<typeof decideDevicePlacement>;
  for (;;) {
    const early = decideDevicePlacement(inputs(notProbed));
    probes =
      early.kind === 'local' && early.skipped.length === 0
        ? []
        : await Promise.all(entries.map((machine) => probe(machine, platform, selectors, appMode, signal)));
    offers = probes.length ? probes.map((each) => each.probe) : notProbed;
    decision = decideDevicePlacement(inputs(offers));
    if (decision.kind !== 'refused' || !decision.hostsFull) break;
    const waited = now() - waitStarted;
    const immediate = noWait || waitMs <= 0;
    if (immediate || waited >= waitMs)
      throw Object.assign(new Error(refusalText(decision, immediate ? null : waited)), {
        code: 'STIM_AT_CAPACITY',
        remedy: `Wait for a remote machine in remote.machines to have room, ${platform === 'macos' ? 'retry later' : 'retry with a longer --wait <seconds>'}, or select a placement that may run here.`,
      });
    if (!announced) {
      announced = true;
      onWait(
        `remote-only waits up to ${Math.round(waitMs / 1000)}s for a remote machine with room (${decision.skipped.map((each) => `${each.machine}: ${each.reason}`).join('; ')})`,
      );
    }
    await sleep(Math.min(HOST_WAIT_POLL_MS, waitMs - waited));
    signal?.throwIfAborted();
  }
  if (
    (decision.kind === 'local' || decision.kind === 'refused') &&
    decision.atCapacity &&
    eas &&
    placement !== 'remote-only'
  )
    decision = decideDevicePlacement({ ...inputs(offers), eas: await eas() });
  if (decision.kind === 'refused')
    throw Object.assign(new Error(refusalText(decision, null)), {
      code: 'STIM_HOSTING_REFUSED',
      remedy:
        placement === 'remote-only'
          ? entries.length === 0
            ? 'Add an approved Mac to remote.machines (stim guide settings), or select a placement that may run here.'
            : 'Wait for a remote machine in remote.machines to have room, check stim doctor for the ones that are unreachable or unapproved, or select a placement that may run here.'
          : 'Enable an available member in remote.devicePoolDisabled or select a machine explicitly.',
    });
  if (decision.kind === 'eas') return viaEas(decision.code, decision.reason, decision.skipped);
  if (decision.kind === 'local') return local(decision.code, decision.reason, decision.skipped);
  const machine = decision.machines[0]!.machine;
  const target = probes.find((each) => each.probe.machine === machine)?.target ?? null;
  return hosted(target, machine, decision.code, decision.reason, decision.skipped);
}

export function devicePlacementLine(placement: DevicePlacement, skipped: PlacementSkip[]): string {
  return `${placement.machine ?? 'local'}, ${placement.reason}${placement.decision !== 'hosted' && skipped.length ? '; ' + skipped.map((each) => `${each.machine}: ${each.reason}`).join('; ') : ''}`;
}
