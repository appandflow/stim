import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureProcessToken, inspectProcessIdentity } from '@stim-cli/core/process-identity';
import { deviceViewersDir, readJsonObject, type DeviceViewersRecord, type ViewedDevice } from '@stim-cli/core/state';
import type { Device } from './frames.ts';

const INPUT_WRITE_MS = 1000;

function viewedDevice(device: Device): ViewedDevice | null {
  if (device.platform === 'web' || device.platform === 'macos' || device.physical) return null;
  return device.platform === 'ios' ? { platform: 'ios', id: device.udid } : { platform: 'android', id: device.serial };
}

/**
 * Records which simulators and emulators have frame subscribers, and when this server last forwarded input to each,
 * in this server's file under `deviceViewersDir()`. Stim's idle decisions count a device's input as activity; frames
 * streamed without input count for nothing. A physical device is left out: its lease is the only state it leaves.
 */
export class DeviceViewers {
  private readonly viewed = new Map<string, { device: ViewedDevice; count: number }>();
  private readonly inputs = new Map<string, ViewedDevice>();
  private readonly file: string;
  private token: string | null | undefined;
  private readonly now: () => number;
  private writtenAt = 0;
  private pending: NodeJS.Timeout | null = null;

  constructor(dir: string = deviceViewersDir(), now: () => number = Date.now) {
    this.file = join(dir, `${process.pid}.json`);
    this.now = now;
  }

  /** Records that this server forwarded input to `device` now, writing the record at most once a second. */
  input(device: Device): void {
    const viewed = viewedDevice(device);
    if (!viewed) return;
    this.inputs.set(`${viewed.platform}:${viewed.id}`, { ...viewed, lastInputAt: new Date(this.now()).toISOString() });
    if (this.pending) return;
    const wait = this.writtenAt + INPUT_WRITE_MS - this.now();
    if (wait <= 0) return this.write();
    this.pending = setTimeout(() => {
      this.pending = null;
      this.write();
    }, wait);
    this.pending.unref?.();
  }

  add(device: Device): () => void {
    const viewed = viewedDevice(device);
    if (!viewed) return () => {};
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
    this.inputs.clear();
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
    this.write();
  }

  private devices(): ViewedDevice[] {
    const devices = new Map<string, ViewedDevice>();
    for (const [key, entry] of this.viewed) devices.set(key, entry.device);
    for (const [key, device] of this.inputs) devices.set(key, device);
    return [...devices.values()];
  }

  private write(): void {
    this.writtenAt = this.now();
    try {
      const devices = this.devices();
      if (devices.length === 0) {
        rmSync(this.file, { force: true });
        return;
      }
      if (this.token === undefined) {
        this.token = captureProcessToken(process.pid);
        pruneGoneServers(join(this.file, '..'));
      }
      if (!this.token) return;
      const record: DeviceViewersRecord = { pid: process.pid, processToken: this.token, devices };
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
