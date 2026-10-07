import type { HostedAndroidChoice, HostedAndroidPlacement, HostedDeviceSelectors } from '@stim-cli/core/state';
import { prepareHostedNative, placeHostedNative, stopHostedNative, type HostedNativeTarget } from './hosted-native.ts';
import { connectHost, call } from './hosted-client.ts';
import { requestHostedMetro } from './metro-gateway.ts';
export { androidAgentRemoteConfig } from './hosted-native.ts';
export interface HostedAndroidTarget extends HostedNativeTarget {
  choice: HostedAndroidChoice;
}
export async function prepareHostedAndroid(
  machine: string,
  selectors: HostedDeviceSelectors,
  recorded?: HostedAndroidPlacement,
): Promise<HostedAndroidTarget> {
  return (await prepareHostedNative(machine, selectors, recorded, 'android')) as HostedAndroidTarget;
}
export async function placeHostedAndroid(
  target: HostedAndroidTarget,
  options: Omit<Parameters<typeof placeHostedNative>[1], 'platform' | 'reserved'> & {
    reserved: (placement: HostedAndroidPlacement) => void;
  },
): Promise<{ placement: HostedAndroidPlacement; launched: true | 'unverified' }> {
  return (await placeHostedNative(target, {
    ...options,
    platform: 'android',
    reserved: (placement) => options.reserved(placement as HostedAndroidPlacement),
  })) as { placement: HostedAndroidPlacement; launched: true | 'unverified' };
}
export async function stopHostedAndroid(root: string, slot?: string): Promise<void> {
  await stopHostedNative(root, slot, 'android');
}
export async function reopenHostedAndroidMetro(
  root: string,
  placement: HostedAndroidPlacement,
  clientMetroPort: number,
): Promise<void> {
  const host = await connectHost(placement.machine, undefined, true);
  try {
    const gateway = await requestHostedMetro(root, placement.session, host.credential);
    await call(host, 'device-host.metro.open', { session: placement.session, clientMetroPort, ...gateway });
  } finally {
    host.connection.close();
  }
}
