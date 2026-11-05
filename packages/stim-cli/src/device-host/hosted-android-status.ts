import { hostedAndroidStatus, type HostedAndroidPlacement, type AndroidDeviceState } from '@stim-cli/core/state';
import { probeHostedSession, type HostedSessionProbe } from './hosted-client.ts';
import { hostedNativeProbe } from './hosted-native-status.ts';

export function applyHostedAndroidProbe(
  placement: HostedAndroidPlacement,
  probe: HostedSessionProbe,
  slot = 'default',
): { android: AndroidDeviceState; warning?: string } {
  const { state, warning } = hostedNativeProbe(placement, probe, slot, 'android');
  const host = { ...hostedAndroidStatus(placement), state };
  return {
    android: { host, name: host.device?.name, serial: null, owned: false, physical: false, state },
    ...(warning ? { warning } : {}),
  };
}

export async function readHostedAndroidStatus(
  placements: Record<string, HostedAndroidPlacement>,
): Promise<Record<string, ReturnType<typeof applyHostedAndroidProbe>>> {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(placements).map(async ([slot, placement]) => [
        slot,
        applyHostedAndroidProbe(placement, await probeHostedSession({ ...placement, platform: 'android' }), slot),
      ]),
    ),
  );
}
