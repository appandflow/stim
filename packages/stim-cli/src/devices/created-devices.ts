import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import {
  createdDevicesFile,
  createdDevicesLock,
  readCreatedDevices,
  type CreatedDevicePlatform,
} from '@stim-cli/core/state';
import { withDirLock } from '../dir-lock.ts';
import { getConfigDir } from '../workspace/config.ts';

export { readCreatedDevices, type CreatedDevicePlatform, type CreatedDevices } from '@stim-cli/core/state';

function update(platform: CreatedDevicePlatform, change: (entries: Set<string>) => boolean): void {
  const dir = getConfigDir();
  withDirLock(
    createdDevicesLock(),
    () => {
      const current = readCreatedDevices();
      const entries = new Set(current[platform]);
      if (!change(entries)) return;
      const next = { version: 1, ios: [...current.ios], android: [...current.android], [platform]: [...entries] };
      const file = createdDevicesFile();
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
      try {
        renameSync(tmp, file);
      } catch (error) {
        rmSync(tmp, { force: true });
        throw error;
      }
    },
    { ensureParent: () => mkdirSync(dir, { recursive: true }) },
  );
}

export function recordCreatedDevice(platform: CreatedDevicePlatform, id: string): void {
  update(platform, (entries) => entries.size !== entries.add(id).size);
}

export function forgetCreatedDevice(platform: CreatedDevicePlatform, id: string): void {
  update(platform, (entries) => entries.delete(id));
}
