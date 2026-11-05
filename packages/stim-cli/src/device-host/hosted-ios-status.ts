import { hostedNativeProbe } from './hosted-native-status.ts';
import { hostedIosStatus, type HostedIosPlacement, type SimulatorState } from '@stim-cli/core/state';
import { probeHostedSession, type HostedSessionProbe } from './hosted-client.ts';

export function applyHostedIosProbe(
  placement: HostedIosPlacement,
  probe: HostedSessionProbe,
  slot = 'default',
): { ios: SimulatorState; warning?: string } {
  const { state, warning } = hostedNativeProbe(placement, probe, slot, 'ios');
  return {
    ios: {
      host: {
        ...hostedIosStatus(placement),
        state,
      },
      name: placement.device?.name ?? null,
      udid: '',
      owned: false,
      state,
    },
    ...(warning ? { warning } : {}),
  };
}

export async function readHostedIosStatus(
  placements: Record<string, HostedIosPlacement>,
): Promise<Record<string, ReturnType<typeof applyHostedIosProbe>>> {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(placements).map(async ([slot, placement]) => [
        slot,
        applyHostedIosProbe(placement, await probeHostedSession(placement), slot),
      ]),
    ),
  );
}
