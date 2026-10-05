import { statfsSync } from 'node:fs';
import { availableParallelism, freemem, loadavg } from 'node:os';
import { configDir } from '@stim-cli/core';
import type { HostedDeviceOfferRequest, HostedNativeOffer } from '@stim-cli/core/state';
import { readHostMemoryPressure } from '../host-memory.ts';
import { selectHostedIosDevice } from './worker.ts';
import { selectHostedAndroidDevice } from './android.ts';

export function inspectHostedDevice(request: HostedDeviceOfferRequest): HostedNativeOffer {
  const cpus = availableParallelism();
  let workerDiskFreeBytes: number | null = null;
  try {
    const disk = statfsSync(configDir());
    workerDiskFreeBytes = disk.bavail * disk.bsize;
  } catch {}
  const resources: HostedNativeOffer['resources'] = {
    cpus,
    loadPerCore: loadavg()[1]! / cpus,
    memoryFreeBytes: freemem(),
    memoryPressure: readHostMemoryPressure(),
    workerDiskFreeBytes,
  };
  try {
    if (process.platform !== 'darwin') throw new Error('Hosted device sessions require a Mac.');
    if (resources.memoryPressure !== 'normal') throw new Error('Host memory pressure is unknown or elevated.');
    return request.platform === 'ios'
      ? { platform: 'ios', choice: selectHostedIosDevice(request), resources, declined: null }
      : { platform: 'android', choice: selectHostedAndroidDevice(request), resources, declined: null };
  } catch (error) {
    return { platform: request.platform, choice: null, resources, declined: (error as Error).message.slice(0, 4000) };
  }
}
