import {
  mayRunHere,
  prefersRemote,
  type AutomaticPlacement,
  type HostedAndroidChoice,
  type HostedIosChoice,
  type HostedMacosChoice,
} from '@stim-cli/core/state';

export interface PlacementHere {
  localEnabled?: boolean;
  loadPerCore: number;
  maxLoadPerCore: number;
  memoryPressure: 'normal' | 'warning' | 'critical' | null;
  devices: { count: number | null; max: number; queued: number };
  budgetRefusal: string | null;
}

export interface PlacementOffer {
  platform: 'ios' | 'android' | 'macos';
  choice: HostedIosChoice | HostedAndroidChoice | HostedMacosChoice | null;
  declined: string | null;
  capacity: { available: number | null };
  resources: {
    loadPerCore: number | null;
    maxLoadPerCore?: number;
    memoryFreeBytes: number;
    memoryPressure: string | null;
  };
}

export type PlacementProbe = { machine: string } & ({ offer: PlacementOffer } | { failure: string });
export interface PlacementSkip {
  machine: string;
  code: string;
  reason: string;
}
/** Whether an EAS Simulator can take this run, checked only when remote.easFallback is on and this machine is full. */
export type EasFallbackCheck = { usable: true } | { usable: false; code: string; reason: string };

export type DevicePlacementDecision = (
  | { kind: 'local'; reason: string; atCapacity?: true }
  | { kind: 'host'; machines: { machine: string; reason: string }[]; reason: string }
  | { kind: 'eas'; reason: string }
  | { kind: 'refused'; reason: string; atCapacity?: true; hostsFull?: true }
) & { code: string; skipped: PlacementSkip[] };

function local(
  code: string,
  reason: string,
  skipped: PlacementSkip[] = [],
  atCapacity = false,
): DevicePlacementDecision {
  return { kind: 'local', code, reason, skipped, ...(atCapacity ? { atCapacity: true as const } : {}) };
}

export function decideDevicePlacement(
  inputs:
    | { sticky: { machine: string } | { local: true } }
    | {
        platform: 'ios' | 'android' | 'macos';
        placement?: AutomaticPlacement;
        here: PlacementHere;
        offers: PlacementProbe[];
        buildMachine?: string;
        noWait: boolean;
        eas?: EasFallbackCheck;
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
  const { platform, placement = 'auto', here, offers, buildMachine, noWait, eas } = inputs;
  const remoteFirst = prefersRemote(placement);
  const { count, max, queued } = here.devices;
  const room = max === 0 || (count !== null && count < max);
  const localEnabled = here.localEnabled !== false && mayRunHere(placement);
  const cannotTake = !localEnabled || !room || queued > 0;
  const atCapacity = count !== null && (!room || queued > 0);
  const usage = max > 0 ? `${count} of ${max} devices in use` : `${count} devices in use, no device cap`;
  const localReason = !mayRunHere(placement)
    ? 'remote-only never runs here'
    : !localEnabled
      ? 'local is disabled in remote.devicePoolDisabled'
      : count === null
        ? 'cannot tell how many devices run here; local boot admission decides'
        : cannotTake
          ? `${usage}${queued ? `, ${queued} runs queued ahead` : ''}`
          : (here.budgetRefusal ??
            (here.memoryPressure !== 'normal'
              ? `host memory pressure ${here.memoryPressure ?? 'unknown'} here`
              : `load ${here.loadPerCore.toFixed(1)}/core here, ${usage}`));
  let hostsFull = false;
  const nowhere = (
    code: string,
    reason: string,
    skipped: PlacementSkip[] = [],
    waiting = '',
  ): DevicePlacementDecision => {
    if (!mayRunHere(placement))
      return {
        kind: 'refused',
        code: 'pool-unavailable',
        reason,
        skipped,
        ...(hostsFull ? { hostsFull: true as const } : {}),
      };
    if (!localEnabled && !atCapacity) return { kind: 'refused', code: 'pool-unavailable', reason, skipped };
    if (!cannotTake || count === null) return local(code, reason + waiting, skipped);
    if (eas?.usable)
      return { kind: 'eas', code: 'eas-fallback', reason: `${reason}; EAS Simulator (remote.easFallback)`, skipped };
    const why = eas ? [...skipped, { machine: 'eas', code: eas.code, reason: eas.reason }] : skipped;
    return localEnabled
      ? local(code, reason + waiting, why, true)
      : { kind: 'refused', code: 'pool-unavailable', reason, skipped: why, atCapacity: true };
  };
  if (!offers.length) return nowhere('no-remote-mac', 'no remote machines configured; ' + localReason);
  if (localEnabled && count === null && !remoteFirst) return local('device-count-unknown', localReason);
  if (
    !remoteFirst &&
    !cannotTake &&
    here.memoryPressure === 'normal' &&
    !here.budgetRefusal &&
    here.loadPerCore < here.maxLoadPerCore
  )
    return local('this-mac-free', localReason);
  const ceiling = (offer: PlacementOffer) => offer.resources.maxLoadPerCore ?? here.maxLoadPerCore;
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
        [code, reason] = [
          'memory',
          offer.resources.memoryPressure === null
            ? 'host memory pressure could not be read'
            : `host memory pressure is ${offer.resources.memoryPressure}`,
        ];
      else if (offer.capacity.available === 0) [code, reason] = ['no-capacity', 'no hosted device capacity available'];
      else if (offer.resources.loadPerCore !== null && offer.resources.loadPerCore >= ceiling(offer))
        [code, reason] = [
          'load',
          `saturated: load ${offer.resources.loadPerCore.toFixed(1)}/core there, at or above ${ceiling(offer)}/core`,
        ];
      else if (placement === 'auto' && !cannotTake && offer.resources.loadPerCore === null)
        [code, reason] = ['load', 'host load unknown while this machine has room'];
      else admitted.push({ machine: probe.machine, offer, index });
    }
    if (reason) skipped.push({ machine: probe.machine, code, reason });
    if (
      reason &&
      ('offer' in probe
        ? ['no-capacity', 'load', 'memory'].includes(code) ||
          (code === 'declined' &&
            (probe.offer.capacity.available === 0 || probe.offer.resources.memoryPressure !== 'normal'))
        : false)
    )
      hostsFull = true;
  });
  admitted.sort((a, b) => Number(b.machine === buildMachine) - Number(a.machine === buildMachine) || a.index - b.index);
  if (!admitted.length)
    return nowhere(
      'no-host-admits',
      `${localReason}; no host admits`,
      skipped,
      localEnabled && cannotTake && !noWait ? '; waiting locally if needed' : '',
    );
  const machines = admitted.map(({ machine, offer }) => ({
    machine,
    reason: `${remoteFirst && !cannotTake ? `${placement} tries remote machines first` : localReason}; ${machine}${machine === buildMachine ? ' is the explicit remote machine,' : ''} load ${offer.resources.loadPerCore === null ? 'unknown' : offer.resources.loadPerCore.toFixed(1) + '/core'}`,
  }));
  return { kind: 'host', code: 'placed', machines, reason: machines[0]!.reason, skipped };
}
