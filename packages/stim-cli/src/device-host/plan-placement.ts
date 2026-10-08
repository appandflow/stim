import type { HostedAndroidChoice, HostedDeviceSelectors, HostedIosChoice } from '@stim-cli/core/state';
import { automaticDevicePlacement, probeHost } from './auto-placement.ts';
import { readHostedNative } from './ios-state.ts';
import { hostingMachines } from './machines.ts';

type Choice = HostedIosChoice | HostedAndroidChoice;

export type PlannedDevice =
  | { kind: 'local'; placement: string }
  | { kind: 'hosted'; choice: Choice; placement: string }
  | { kind: 'unknown'; reason: string };

/**
 * Where `--plan` assumes the next run puts its simulator or emulator, with no session, reservation or state write.
 * A named Mac, or the Mac a recorded session already holds, answers with the device its `device-host.offer` would
 * give; `auto` repeats the placement decision a run makes now and, when that stays on this Mac, notes any Mac
 * whose device would key differently. The result predicts the cache key only; a run reads its own device.
 */
export async function planHostedDevice({
  root,
  slot,
  platform,
  machine,
  selectors,
  sameKey,
  deps = {},
}: {
  root: string;
  slot: string;
  platform: 'ios' | 'android';
  machine: string;
  selectors: HostedDeviceSelectors;
  /** Whether the choice keys the build as this Mac's own device would; null when this Mac's key is unknown. */
  sameKey: (choice: Choice) => boolean | null;
  deps?: { automatic?: typeof automaticDevicePlacement; probe?: typeof probeHost; machines?: typeof hostingMachines };
}): Promise<PlannedDevice> {
  const { automatic = automaticDevicePlacement, probe = probeHost, machines = hostingMachines } = deps;
  const named = async (name: string): Promise<PlannedDevice> => {
    const result = await probe(name, platform, selectors);
    if ('failure' in result.probe)
      return { kind: 'unknown', reason: `${name} did not give a ${platform} device (${result.probe.failure})` };
    const { choice, declined } = result.probe.offer;
    if (!choice)
      return {
        kind: 'unknown',
        reason: `${name} has no ${platform} device for this selection${declined ? ` (${declined})` : ''}`,
      };
    return { kind: 'hosted', choice, placement: `on ${name}` };
  };
  if (machine !== 'auto') return named(machine);
  const recorded = readHostedNative(root, platform, slot)[slot];
  if (recorded) return named(recorded.machine);
  try {
    const placed = await automatic(
      { root, slot, platform, selectors, noWait: false },
      { read: () => ({}), write: () => {} },
    );
    if (placed.target)
      return {
        kind: 'hosted',
        choice: placed.target.choice,
        placement: `on ${placed.target.host.machine}, as auto would now`,
      };
    const names = machines() ?? [];
    const offers = await Promise.all(names.map((name) => probe(name, platform, selectors)));
    const differs = offers.flatMap(({ probe: each }) =>
      'offer' in each && each.offer.choice && sameKey(each.offer.choice) === false ? [each.machine] : [],
    );
    if (differs.length)
      return {
        kind: 'local',
        placement: `this Mac; auto may use ${differs.join(', ')}, which builds for another architecture, so its key differs`,
      };
    return { kind: 'local', placement: names.length ? `this Mac; auto may use ${names.join(', ')}` : 'this Mac' };
  } catch (error) {
    return { kind: 'unknown', reason: (error as Error).message };
  }
}
