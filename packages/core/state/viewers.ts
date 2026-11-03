import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inspectProcessIdentity } from '../process-identity.ts';
import { readJsonObject } from './json-file.ts';
import { deviceViewersDir } from './paths.ts';

export interface ViewedDevice {
  platform: 'ios' | 'android';
  /** The simulator UDID or the emulator serial. */
  id: string;
  /** When the server last forwarded input to the device; absent when it only streamed frames. */
  lastInputAt?: string;
}

/**
 * A stim-server's viewer record: the devices it streams frames of or forwarded input to, and the server's process
 * identity.
 */
export interface DeviceViewersRecord {
  pid: number;
  processToken: string;
  devices: ViewedDevice[];
}

function parseViewedDevices(value: unknown): ViewedDevice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const { platform, id, lastInputAt } = (entry ?? {}) as Partial<ViewedDevice>;
    if ((platform !== 'ios' && platform !== 'android') || typeof id !== 'string' || !id) return [];
    return [
      {
        platform,
        id,
        ...(typeof lastInputAt === 'string' && Number.isFinite(Date.parse(lastInputAt)) ? { lastInputAt } : {}),
      },
    ];
  });
}

/**
 * The devices a running stim-server streams frames of or forwarded input to. A record whose server is not proven to
 * be the same live process counts for nothing.
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
