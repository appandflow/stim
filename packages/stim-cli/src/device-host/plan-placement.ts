import type { StimContext } from '@stim-cli/core';
import {
  automaticMachineEnabled,
  type AutomaticPlacement,
  type HostedAndroidChoice,
  type HostedDeviceSelectors,
  type HostedIosChoice,
} from '@stim-cli/core/state';
import type { EasFallbackCheck, PlacementOffer } from './placement.ts';
import { automaticDevicePlacement, probeHost } from './auto-placement.ts';
import { readHostedNative } from './ios-state.ts';
import { hostingMachines } from './machines.ts';

type Choice = HostedIosChoice | HostedAndroidChoice;

function planChoice(choice: PlacementOffer['choice']): Choice | null {
  return choice && ('runtime' in choice || 'systemImage' in choice) ? choice : null;
}

export type PlannedDevice =
  | { kind: 'local'; placement: string }
  | { kind: 'hosted'; choice: Choice; placement: string }
  | { kind: 'unknown'; reason: string };

/**
 * Where `--plan` assumes the next run puts its simulator or emulator, with no session, reservation or state write.
 * A named Mac, or the Mac a recorded session already holds, answers with the device its `device-host.offer` would
 * give; `auto` repeats the placement decision a run makes now and, when that stays on this machine, notes any Mac
 * whose device would key differently. The result predicts the cache key only; a run reads its own device.
 */
export async function planHostedDevice({
  root,
  slot,
  platform,
  machine,
  placement = 'auto',
  selectors,
  sameKey,
  eas,
  deps = {},
  operation,
}: {
  root: string;
  operation?: StimContext;
  slot: string;
  platform: 'ios' | 'android';
  machine: string;
  placement?: AutomaticPlacement;
  selectors: HostedDeviceSelectors;
  /** Whether the choice keys the build as this machine's own device would; null when this machine's key is unknown. */
  sameKey: (choice: Choice) => boolean | null | Promise<boolean | null>;
  eas?: () => Promise<EasFallbackCheck>;
  deps?: {
    automatic?: typeof automaticDevicePlacement;
    probe?: typeof probeHost;
    machines?: () => string[] | null | Promise<string[] | null>;
  };
}): Promise<PlannedDevice> {
  const {
    automatic = automaticDevicePlacement,
    probe = probeHost,
    machines = () => hostingMachines(undefined, operation?.signal),
  } = deps;
  const named = async (name: string): Promise<PlannedDevice> => {
    const result = await probe(name, platform, selectors, undefined, operation?.signal);
    if ('failure' in result.probe)
      return { kind: 'unknown', reason: `${name} did not give a ${platform} device (${result.probe.failure})` };
    const { declined } = result.probe.offer;
    const choice = planChoice(result.probe.offer.choice);
    if (!choice)
      return {
        kind: 'unknown',
        reason: `${name} has no ${platform} device for this selection${declined ? ` (${declined})` : ''}`,
      };
    return { kind: 'hosted', choice, placement: `on ${name}` };
  };
  if (machine !== 'auto') return named(machine);
  try {
    const recorded = readHostedNative(root, platform, slot)[slot];
    if (recorded) return await named(recorded.machine);
    const placed = await automatic(
      {
        root,
        slot,
        platform,
        placement,
        selectors,
        noWait: false,
        waitMs: 0,
        signal: operation?.signal,
        ...(eas ? { eas } : {}),
      },
      { read: () => ({}), write: () => {} },
    );
    if (placed.placement.decision === 'eas')
      return {
        kind: 'unknown',
        reason: `${placement} would run on an EAS Simulator now (${placed.placement.reason}), which --plan cannot read without a session`,
      };
    if (placed.target)
      return {
        kind: 'hosted',
        choice: placed.target.choice,
        placement: `on ${placed.target.host.machine}, as ${placement} would now`,
      };
    const names = ((await machines()) ?? []).filter((name) => automaticMachineEnabled('device', name));
    operation?.signal.throwIfAborted();
    const offers = await Promise.all(
      names.map((name) => probe(name, platform, selectors, undefined, operation?.signal)),
    );
    const compared = await Promise.all(
      offers.map(async ({ probe: each }) => {
        const choice = 'offer' in each ? planChoice(each.offer.choice) : null;
        return choice && (await sameKey(choice)) === false ? [each.machine] : [];
      }),
    );
    const differs = compared.flat();
    if (differs.length)
      return {
        kind: 'local',
        placement: `this machine; ${placement} may use ${differs.join(', ')}, which builds for another architecture, so its key differs`,
      };
    return {
      kind: 'local',
      placement: names.length ? `this machine; ${placement} may use ${names.join(', ')}` : 'this machine',
    };
  } catch (error) {
    operation?.signal.throwIfAborted();
    return { kind: 'unknown', reason: (error as Error).message };
  }
}
