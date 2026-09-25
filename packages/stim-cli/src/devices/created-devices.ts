import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withDirLock } from '../dir-lock.ts';
import { getConfigDir } from '../workspace/config.ts';

export type CreatedDevicePlatform = 'ios' | 'android';

export interface CreatedDevices {
  ios: ReadonlySet<string>;
  android: ReadonlySet<string>;
}

function ledgerFile(): string {
  return join(getConfigDir(), 'created-devices.json');
}

function ids(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    : [];
}

export function readCreatedDevices(): CreatedDevices {
  try {
    const parsed = JSON.parse(readFileSync(ledgerFile(), 'utf8')) as Record<string, unknown>;
    return { ios: new Set(ids(parsed?.ios)), android: new Set(ids(parsed?.android)) };
  } catch {
    return { ios: new Set(), android: new Set() };
  }
}

function update(platform: CreatedDevicePlatform, change: (entries: Set<string>) => boolean): void {
  const dir = getConfigDir();
  withDirLock(
    join(dir, 'created-devices.lock'),
    () => {
      const current = readCreatedDevices();
      const entries = new Set(current[platform]);
      if (!change(entries)) return;
      const next = { version: 1, ios: [...current.ios], android: [...current.android], [platform]: [...entries] };
      const file = ledgerFile();
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
