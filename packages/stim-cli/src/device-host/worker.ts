import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withDirLock } from '@stim-cli/core';
import {
  assertHostedDeviceLedger,
  readHostedDevice,
  type HostedDeviceSelectors,
  type HostedDevice,
  type HostedIosChoice,
  type HostedIosDevice,
} from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import { readHostMemoryPressure } from '../host-memory.ts';
import { bootIosSim, createOwnedIosSim, listAllIosSims, resolveIosCreation } from '../devices/ios.ts';
import { teardownOwnedIosSim } from '../devices/teardown.ts';
import { installHostedApp } from './app.ts';

export type HostedWorkerResult = {
  state: 'ready' | 'stopped' | 'installed' | 'unknown';
  device: HostedDevice | null;
  notice?: string;
  launched?: true | 'unverified';
  /** The registered hosted macOS app process, for the host's agent driver. */
  pid?: number;
};

function inventory(): ReturnType<typeof listAllIosSims> {
  return listAllIosSims({ includeUnavailable: true });
}

export function selectHostedIosDevice(selectors: HostedDeviceSelectors): HostedIosChoice {
  inventory();
  if (readHostMemoryPressure(getExecutor()) !== 'normal')
    throw new Error('Host memory pressure is unknown or elevated.');
  const selected = resolveIosCreation(selectors);
  if (!selected.deviceType || !selected.runtime)
    throw new Error('The installed simulator type or runtime could not be established.');
  if (process.arch !== 'arm64' && process.arch !== 'x64') throw new Error('Unsupported simulator host architecture.');
  return {
    ...selected,
    deviceType: selected.deviceType,
    runtime: selected.runtime,
    architecture: process.arch === 'arm64' ? 'arm64' : 'x86_64',
  };
}

/** Called only in the private server-owned worker home; native effects use Stim's existing ownership and teardown. */
export async function runHostedDevice(
  mode: 'prepare' | 'stop' | 'install',
  selectors: HostedDeviceSelectors,
  app?: { session: string; attempt: string; metroPort?: number },
): Promise<HostedWorkerResult> {
  const home = process.env.STIM_HOME;
  if (!home) throw new Error('Hosted workers require their isolated STIM_HOME.');
  let device: HostedIosDevice | null = null;
  let creationStarted = false;
  try {
    if (mode === 'prepare') {
      creationStarted = existsSync(join(home, 'hosted-device.json')) || existsSync(join(home, 'created-devices.json'));
      if (creationStarted)
        throw new Error('This hosted worker home already has a device record. Attach or stop its existing session.');
      const selected = selectHostedIosDevice(selectors);
      creationStarted = true;
      const created = createOwnedIosSim('hosted', {}, selected);
      device = { ...selected, udid: created.udid, name: created.name };
      withDirLock(join(home, 'hosted-device.lock'), () => {
        const temporary = join(home, 'hosted-device.json.tmp');
        writeFileSync(temporary, JSON.stringify(device), { mode: 0o600 });
        renameSync(temporary, join(home, 'hosted-device.json'));
      });
      assertHostedDeviceLedger(home, device.udid);
      await bootIosSim(device.udid, { openViewer: false });
      if (inventory().find((sim) => sim.udid === device!.udid)?.state !== 'Booted')
        throw new Error('Hosted simulator boot could not be verified.');
      return { state: 'ready', device };
    }
    device = readHostedDevice(home);
    assertHostedDeviceLedger(home, device.udid);
    const current = inventory().find((sim) => sim.udid === device!.udid);
    if (mode === 'install') {
      if (!app || current?.state !== 'Booted')
        throw new Error('Hosted app installation requires its booted owned simulator.');
      const launched = await installHostedApp(home, app.session, app.attempt, device, app.metroPort);
      return { state: 'installed', device, launched };
    }
    if (!current) return { state: 'stopped', device };
    const outcome = teardownOwnedIosSim(device.udid);
    if (outcome.status !== 'torn-down' && outcome.status !== 'missing')
      throw new Error(outcome.reason ?? 'Hosted simulator teardown was not established.');
    const after = inventory().find((sim) => sim.udid === device!.udid);
    if (after && after.state !== 'Shutdown') throw new Error('Hosted simulator shutdown could not be verified.');
    return { state: 'stopped', device };
  } catch (error) {
    return {
      state: mode === 'prepare' && !creationStarted && !device ? 'stopped' : 'unknown',
      device,
      notice: (error as Error).message,
    };
  }
}
