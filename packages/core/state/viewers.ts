import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inspectProcessIdentity } from '../process-identity.ts';
import { readJsonObject } from './json-file.ts';
import { deviceViewersDir } from './paths.ts';

export interface ViewedDevice {
  platform: 'ios' | 'android';
  /** The simulator UDID or the emulator serial. */
  id: string;
}

/** A stim-server's viewer record: the devices it streams frames of, and the server's process identity. */
export interface DeviceViewersRecord {
  pid: number;
  processToken: string;
  devices: ViewedDevice[];
}

function parseViewedDevices(value: unknown): ViewedDevice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const { platform, id } = (entry ?? {}) as Partial<ViewedDevice>;
    return (platform === 'ios' || platform === 'android') && typeof id === 'string' && id ? [{ platform, id }] : [];
  });
}

/**
 * The devices a running stim-server streams frames of. A record whose server is not proven to be the same live
 * process counts for nothing.
 */
export function readViewedDevices(dir: string = deviceViewersDir()): ViewedDevice[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const record = readJsonObject(join(dir, name));
    if (!record || inspectProcessIdentity(record) !== 'same') return [];
    return parseViewedDevices(record.devices);
  });
}
