import type { HostedAndroidChoice, HostedIosChoice } from '@stim-cli/core/state';

export interface PlacementHere {
  loadPerCore: number;
  maxLoadPerCore: number;
  memoryPressure: 'normal' | 'warning' | 'critical' | null;
  devices: { count: number | null; max: number; queued: number };
  budgetRefusal: string | null;
}

export interface PlacementOffer {
  platform: 'ios' | 'android';
  choice: HostedIosChoice | HostedAndroidChoice | null;
  declined: string | null;
  capacity: { available: number | null };
  resources: { loadPerCore: number | null; memoryFreeBytes: number; memoryPressure: string | null };
}

export type PlacementProbe = { machine: string } & ({ offer: PlacementOffer } | { failure: string });
export interface PlacementSkip {
  machine: string;
  code: string;
  reason: string;
}
export type DevicePlacementDecision = (
  | { kind: 'local'; reason: string }
  | { kind: 'host'; machines: { machine: string; reason: string }[]; reason: string }
) & { code: string; skipped: PlacementSkip[] };

function local(code: string, reason: string, skipped: PlacementSkip[] = []): DevicePlacementDecision {
  return { kind: 'local', code, reason, skipped };
}

export function decideDevicePlacement(
  inputs:
    | { sticky: { machine: string } | { local: true } }
    | {
        platform: 'ios' | 'android';
        here: PlacementHere;
        offers: PlacementProbe[];
        buildMachine?: string;
        noWait: boolean;
      },
): DevicePlacementDecision {
  if ('sticky' in inputs) {
    if ('machine' in inputs.sticky) {
      const reason = `recorded session on ${inputs.sticky.machine}`;
      return {
        kind: 'host',
        code: 'sticky',
        reason,
        machines: [{ machine: inputs.sticky.machine, reason }],
        skipped: [],
      };
    }
    return { kind: 'local', code: 'sticky', reason: "this workspace's device runs here", skipped: [] };
  }
  const { platform, here, offers, buildMachine, noWait } = inputs;
  const { count, max, queued } = here.devices;
  const room = max === 0 || (count !== null && count < max);
  const cannotTake = !room || queued > 0;
  const usage = max > 0 ? `${count} of ${max} devices in use` : `${count} devices in use, no device cap`;
  const localReason =
    count === null
      ? 'cannot tell how many devices run here; local boot admission decides'
      : cannotTake
        ? `${usage}${queued ? `, ${queued} runs queued ahead` : ''}`
        : (here.budgetRefusal ??
          (here.memoryPressure !== 'normal'
            ? `host memory pressure ${here.memoryPressure ?? 'unknown'} here`
            : `load ${here.loadPerCore.toFixed(1)}/core here, ${usage}`));
  if (!offers.length) return local('no-remote-mac', 'no remote Macs configured; ' + localReason);
  if (count === null) return local('device-count-unknown', localReason);
  if (!cannotTake && here.memoryPressure === 'normal' && !here.budgetRefusal && here.loadPerCore < here.maxLoadPerCore)
    return local('this-mac-free', localReason);
  const skipped: PlacementSkip[] = [];
  const admitted: { machine: string; offer: PlacementOffer; index: number }[] = [];
  offers.forEach((probe, index) => {
    let reason: string | null = null;
    let code = 'unreachable';
    if ('failure' in probe) reason = probe.failure;
    else {
      const { offer } = probe;
      if (offer.declined !== null) [code, reason] = ['declined', `declined: ${offer.declined}`];
      else if (offer.platform !== platform || !offer.choice)
        [code, reason] = ['no-matching-device', `no matching ${platform} device choice`];
      else if (offer.resources.memoryPressure !== 'normal')
        [code, reason] = ['memory', 'host memory pressure unknown or elevated'];
      else if (offer.capacity.available === 0) [code, reason] = ['no-capacity', 'no hosted device capacity available'];
      else if (!cannotTake && (offer.resources.loadPerCore === null || offer.resources.loadPerCore >= here.loadPerCore))
        [code, reason] = [
          'load',
          offer.resources.loadPerCore === null
            ? 'host load unknown while this Mac has room'
            : 'host is not less loaded than this Mac',
        ];
      else admitted.push({ machine: probe.machine, offer, index });
    }
    if (reason) skipped.push({ machine: probe.machine, code, reason });
  });
  admitted.sort(
    (a, b) =>
      Number(b.machine === buildMachine) - Number(a.machine === buildMachine) ||
      (a.offer.resources.loadPerCore ?? Infinity) - (b.offer.resources.loadPerCore ?? Infinity) ||
      b.offer.resources.memoryFreeBytes - a.offer.resources.memoryFreeBytes ||
      a.index - b.index,
  );
  if (!admitted.length)
    return local(
      'no-host-admits',
      `${localReason}; no host admits${cannotTake && !noWait ? '; waiting locally if needed' : ''}`,
      skipped,
    );
  const machines = admitted.map(({ machine, offer }) => ({
    machine,
    reason: `${localReason}; ${machine}${machine === buildMachine ? ' is the explicit remote Mac,' : ''} load ${offer.resources.loadPerCore === null ? 'unknown' : offer.resources.loadPerCore.toFixed(1) + '/core'}`,
  }));
  return { kind: 'host', code: 'placed', machines, reason: machines[0]!.reason, skipped };
}
