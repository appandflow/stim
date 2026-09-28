import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureProcessToken, inspectProcessIdentity } from '@stim-cli/core/process-identity';
import { deviceViewersDir, readJsonObject, type DeviceViewersRecord, type ViewedDevice } from '@stim-cli/core/state';
import type { Device } from './frames.ts';

/**
 * Records which simulators and emulators have frame subscribers, in this server's file under
 * `deviceViewersDir()`, so Stim's idle checks count a device someone is watching as in use. A physical device is
 * left out: its lease is the only state it leaves.
 */
export class DeviceViewers {
  private readonly viewed = new Map<string, { device: ViewedDevice; count: number }>();
  private readonly file: string;
  private token: string | null | undefined;

  constructor(dir: string = deviceViewersDir()) {
    this.file = join(dir, `${process.pid}.json`);
  }

  add(device: Device): () => void {
    if (device.platform === 'web' || device.physical) return () => {};
    const viewed: ViewedDevice =
      device.platform === 'ios' ? { platform: 'ios', id: device.udid } : { platform: 'android', id: device.serial };
    const key = `${viewed.platform}:${viewed.id}`;
    const entry = this.viewed.get(key) ?? { device: viewed, count: 0 };
    this.viewed.set(key, entry);
    if (++entry.count === 1) this.write();
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      if (--entry.count > 0) return;
      this.viewed.delete(key);
      this.write();
    };
  }

  clear(): void {
    this.viewed.clear();
    this.write();
  }

  private write(): void {
    try {
      if (this.viewed.size === 0) {
        rmSync(this.file, { force: true });
        return;
      }
      if (this.token === undefined) {
        this.token = captureProcessToken(process.pid);
        pruneGoneServers(join(this.file, '..'));
      }
      if (!this.token) return;
      const record: DeviceViewersRecord = {
        pid: process.pid,
        processToken: this.token,
        devices: [...this.viewed.values()].map((entry) => entry.device),
      };
      mkdirSync(join(this.file, '..'), { recursive: true });
      const temporary = `${this.file}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(record)}\n`);
      renameSync(temporary, this.file);
    } catch (error) {
      console.error(`stim-server: could not record device viewers: ${(error as Error).message}`);
    }
  }
}

function pruneGoneServers(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return;
  }
  for (const name of names) {
    const file = join(dir, name);
    const identity = inspectProcessIdentity(readJsonObject(file));
    if (identity === 'gone' || identity === 'different') rmSync(file, { force: true });
  }
}
