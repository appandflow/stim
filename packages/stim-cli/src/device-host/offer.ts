import { statfsSync } from 'node:fs';
import { availableParallelism, freemem, loadavg } from 'node:os';
import { configDir } from '@stim-cli/core';
import { hostedMemoryRefusal, type HostedDeviceOfferRequest, type HostedNativeOffer } from '@stim-cli/core/state';
import { readHostMemoryPressure } from '../host-memory.ts';
import { countLiveOwnedDevices, type DeviceCountExclusion } from '../engine/device-capacity.ts';
import { selectHostedIosDevice } from './worker.ts';
import { selectHostedAndroidDevice } from './android.ts';
import { selectHostedMacos } from './macos.ts';

export async function inspectHostedDevice(
  request: HostedDeviceOfferRequest,
  options?: { exclude?: DeviceCountExclusion[] },
): Promise<HostedNativeOffer> {
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
    memoryPressure: readHostMemoryPressure() ?? readHostMemoryPressure(),
    workerDiskFreeBytes,
    ...(options ? { localDevices: countLiveOwnedDevices({}, options) } : {}),
  };
  try {
    if (process.platform !== 'darwin') throw new Error('Hosted device sessions require a Mac.');
    const memoryRefusal = hostedMemoryRefusal(resources.memoryPressure);
    if (memoryRefusal) throw new Error(memoryRefusal);
    return request.platform === 'macos'
      ? { platform: 'macos', choice: selectHostedMacos(), resources, declined: null }
      : request.platform === 'ios'
        ? { platform: 'ios', choice: await selectHostedIosDevice(request), resources, declined: null }
        : { platform: 'android', choice: selectHostedAndroidDevice(request), resources, declined: null };
  } catch (error) {
    return { platform: request.platform, choice: null, resources, declined: (error as Error).message.slice(0, 4000) };
  }
}
