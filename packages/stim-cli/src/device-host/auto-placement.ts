import {
  automaticMachineEnabled,
  isJsonObject,
  machineCapacity,
  parseHostedChoice,
  parseHostedNativeOffer,
  type DevicePlacement,
  type HostedDeviceSelectors,
  type HostedNativePlacement,
  type HostedIosDevice,
  type HostedAndroidDevice,
  type HostedAppOffer,
} from '@stim-cli/core/state';
import { peekBudget } from '../budget.ts';
import { namedBuildMachine, resolveBuildMachine } from '../offload/selection.ts';
import { readHostMemoryPressure } from '../host-memory.ts';
import { peekDeviceSlots } from '../engine/device-capacity.ts';
import { getProject, loadConfig } from '../workspace/config.ts';
import { hostingMachines } from './machines.ts';
import { call, connectHost, requireHostedAppMode, type HostConnection } from './hosted-client.ts';
import { prepareHostedNative, type HostedNativeTarget } from './hosted-native.ts';
import { readHostedNative, writeHostedNative } from './ios-state.ts';
import {
  decideDevicePlacement,
  type EasFallbackCheck,
  type PlacementHere,
  type PlacementProbe,
  type PlacementSkip,
} from './placement.ts';

export async function probeHost(
  machine: string,
  platform: 'ios' | 'android',
  selectors: HostedDeviceSelectors,
  appMode?: HostedAppOffer['mode'],
): Promise<{ probe: PlacementProbe; target?: HostedNativeTarget }> {
  let host: HostConnection | undefined;
  const deadline = Date.now() + 3000;
  try {
    host = await connectHost(machine, 3000, true);
    requireHostedAppMode(host, platform, appMode);
    const offer = await call(host, 'device-host.offer', { platform, ...selectors }, Math.max(1, deadline - Date.now()));
    const resources = isJsonObject(offer.resources) ? offer.resources : {};
    const parsed = parseHostedNativeOffer({
      ...offer,
      resources: { ...resources, loadPerCore: resources.loadPerCore ?? 0 },
    });
    let choice =
      platform === 'ios'
        ? offer.platform === 'ios'
          ? parseHostedChoice(offer.choice)
          : null
        : parsed?.platform === 'android'
          ? parsed.choice
          : null;
    if (
      choice &&
      ('runtime' in choice
        ? (selectors.deviceType && selectors.deviceType !== choice.deviceType) ||
          (selectors.runtime && selectors.runtime.replace(/^iOS /, '') !== choice.runtime.replace(/^iOS /, ''))
        : (selectors.systemImage && selectors.systemImage !== choice.systemImage) ||
          (selectors.deviceProfile && selectors.deviceProfile !== choice.deviceProfile))
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
      ...(choice ? { target: { host, choice, session: null } } : {}),
    };
  } catch (error) {
    return { probe: { machine, failure: error instanceof Error ? error.message : String(error) } };
  } finally {
    host?.connection.close();
  }
}

function hosted(target: HostedNativeTarget, code: string, reason: string, skipped: PlacementSkip[] = []) {
  target.selection = { selected: 'auto', reason };
  return {
    target,
    placement: { decision: 'hosted' as const, machine: target.host.machine, reason },
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
    selectors,
    appMode,
    buildMachine,
    noWait,
    eas,
  }: {
    root: string;
    slot: string;
    platform: 'ios' | 'android';
    selectors: HostedDeviceSelectors;
    appMode?: HostedAppOffer['mode'];
    buildMachine?: string;
    noWait: boolean;
    eas?: () => Promise<EasFallbackCheck>;
  },
  {
    machines = hostingMachines,
    read = readHostedNative,
    write = writeHostedNative,
    resume = prepareHostedNative,
    peek = () => peekDeviceSlots({ platform, project: getProject(root), slot }),
    capacity = machineCapacity,
    memory = readHostMemoryPressure,
    probe = probeHost,
    budget = peekBudget,
  }: {
    machines?: typeof hostingMachines;
    read?: typeof readHostedNative;
    write?: typeof writeHostedNative;
    resume?: typeof prepareHostedNative;
    peek?: () => ReturnType<typeof peekDeviceSlots>;
    capacity?: typeof machineCapacity;
    memory?: typeof readHostMemoryPressure;
    probe?: typeof probeHost;
    budget?: typeof peekBudget;
  } = {},
): Promise<{
  target: HostedNativeTarget | null;
  placement: DevicePlacement;
  code: string;
  skipped: PlacementSkip[];
  sticky?: true;
}> {
  const recorded: HostedNativePlacement<HostedIosDevice | HostedAndroidDevice> | undefined = read(root, platform, slot)[
    slot
  ];
  if (recorded) {
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
    write(root, slot, null, platform);
  }
  const devices = peek();
  if (devices.localLive)
    return { ...local('sticky', decideDevicePlacement({ sticky: { local: true } }).reason), sticky: true };
  const configured = machines();
  if (configured === null)
    throw Object.assign(new Error('remote.machines is invalid. Run stim guide settings and correct it.'), {
      code: 'STIM_HOSTING_REFUSED',
    });
  const config = loadConfig();
  const entries = configured.filter((machine) => automaticMachineEnabled('device', machine, config));
  const preference = resolveBuildMachine(buildMachine, process.env.STIM_REMOTE_BUILD, config?.remote?.build);
  buildMachine = namedBuildMachine(preference) ? preference : undefined;
  const load = capacity();
  const here: PlacementHere = {
    localEnabled: automaticMachineEnabled('device', 'local', config),
    loadPerCore: load.loadPerCore,
    maxLoadPerCore: load.maxLoadPerCore,
    memoryPressure: memory(),
    devices,
    budgetRefusal: await budget(root),
  };
  const inputs = (offers: PlacementProbe[]) => ({ platform, here, offers, buildMachine, noWait });
  const notProbed = entries.map((machine) => ({ machine, failure: 'not probed' }));
  const early = decideDevicePlacement(inputs(notProbed));
  const probes =
    early.kind === 'local' && early.skipped.length === 0
      ? []
      : await Promise.all(entries.map((machine) => probe(machine, platform, selectors, appMode)));
  const offers = probes.length ? probes.map((each) => each.probe) : notProbed;
  let decision = decideDevicePlacement(inputs(offers));
  if ((decision.kind === 'local' || decision.kind === 'refused') && decision.atCapacity && eas)
    decision = decideDevicePlacement({ ...inputs(offers), eas: await eas() });
  if (decision.kind === 'refused')
    throw Object.assign(
      new Error(devicePlacementLine({ decision: 'local', reason: decision.reason }, decision.skipped)),
      {
        code: 'STIM_HOSTING_REFUSED',
        remedy: 'Enable an available member in remote.devicePoolDisabled or select a machine explicitly.',
      },
    );
  if (decision.kind === 'eas') return viaEas(decision.code, decision.reason, decision.skipped);
  if (decision.kind === 'local') return local(decision.code, decision.reason, decision.skipped);
  const target = probes.find((each) => each.probe.machine === decision.machines[0]!.machine)!.target!;
  return hosted(target, decision.code, decision.reason, decision.skipped);
}

export function devicePlacementLine(placement: DevicePlacement, skipped: PlacementSkip[]): string {
  return `${placement.machine ?? 'local'}, ${placement.reason}${placement.decision !== 'hosted' && skipped.length ? '; ' + skipped.map((each) => `${each.machine}: ${each.reason}`).join('; ') : ''}`;
}
