import type { HostedIosChoice, HostedIosPlacement, HostedDeviceSelectors } from '@stim-cli/core/state';
import { prepareHostedNative, placeHostedNative, stopHostedNative, type HostedNativeTarget } from './hosted-native.ts';
export interface HostedIosTarget extends HostedNativeTarget {
  choice: HostedIosChoice;
}
export async function prepareHostedIos(
  machine: string,
  selectors: HostedDeviceSelectors,
  recorded?: HostedIosPlacement,
): Promise<HostedIosTarget> {
  return (await prepareHostedNative(machine, selectors, recorded, 'ios', false)) as HostedIosTarget;
}
export async function placeHostedIos(
  target: HostedIosTarget,
  options: Omit<Parameters<typeof placeHostedNative>[1], 'platform' | 'reserved'> & {
    reserved: (placement: HostedIosPlacement) => unknown;
  },
): Promise<{ placement: HostedIosPlacement; launched: true | 'unverified' }> {
  return (await placeHostedNative(target, {
    ...options,
    platform: 'ios',
    reserved: (placement) => options.reserved(placement as HostedIosPlacement),
  })) as { placement: HostedIosPlacement; launched: true | 'unverified' };
}
export const stopHostedIos: (root: string, slot?: string, signal?: AbortSignal) => Promise<void> = stopHostedNative;
