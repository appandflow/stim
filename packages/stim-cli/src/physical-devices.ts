import { clockTime, formatElapsed } from './command-output.ts';
import { parseDeviceSlotKey } from './devices/device-slots.ts';
import type { AdbDevices } from './devices/android.ts';
import { leaseIsExpired, type LeaseFileEntry, type WorkspaceLeases } from './engine/device-lease.ts';
import { isReachable, type IosDeviceEntry } from './engine/ios-device.ts';
import type { PhysicalDeviceConnection, PhysicalDeviceState, StatsPlatform } from '@stim-cli/core/state';

const EMULATOR_SERIAL = /^emulator-\d+$/;

export interface PhysicalDeviceReading {
  name: string | null;
  model: string | null;
  connection: PhysicalDeviceConnection;
}

/**
 * The physical devices a workspace holds: each lease its state records whose file still carries the same token,
 * names this workspace as holder, and has not expired. A lease on a simulator (a UDID in `simulatorUdids`) or an
 * emulator (an `emulator-<port>` serial), which `device lock` also takes, is not a physical device. `read` is
 * called once per device.
 */
export function physicalDeviceStates(
  entries: readonly LeaseFileEntry[],
  held: WorkspaceLeases,
  {
    root,
    now,
    simulatorUdids,
    read,
  }: {
    root: string;
    now: number;
    simulatorUdids: ReadonlySet<string>;
    read: (platform: StatsPlatform, id: string) => PhysicalDeviceReading;
  },
): PhysicalDeviceState[] {
  const out: PhysicalDeviceState[] = [];
  for (const [key, record] of Object.entries(held)) {
    const parsed = parseDeviceSlotKey(key);
    const lease = entries.find((entry) => entry.lease?.token === record.token)?.lease;
    if (!parsed || !lease || lease.platform !== parsed.platform || lease.id !== record.id) continue;
    if (lease.holder !== root || leaseIsExpired(lease, now)) continue;
    if (parsed.platform === 'ios' ? simulatorUdids.has(lease.id.toUpperCase()) : EMULATOR_SERIAL.test(lease.id)) {
      continue;
    }
    const reading = read(parsed.platform, lease.id);
    out.push({
      platform: parsed.platform,
      slot: parsed.slot,
      id: lease.id,
      name: reading.name ?? lease.deviceName,
      model:
        reading.model ?? (parsed.platform === 'android' && lease.deviceName !== lease.id ? lease.deviceName : null),
      owned: false,
      physical: true,
      connection: reading.connection,
      lease: { holder: lease.holder, kind: record.kind, grantedAt: lease.grantedAt, expiresAt: lease.expiresAt },
    });
  }
  return out;
}

/** A phone's reading from devicectl's device list; null `devices` means devicectl could not be read. */
export function iosPhysicalReading(devices: readonly IosDeviceEntry[] | null, udid: string): PhysicalDeviceReading {
  if (!devices) return { name: null, model: null, connection: 'unknown' };
  const device = devices.find((entry) => entry.udid.toUpperCase() === udid.toUpperCase());
  if (!device) return { name: null, model: null, connection: 'disconnected' };
  return {
    name: device.name,
    model: device.model ?? null,
    connection: isReachable(device) ? 'connected' : 'disconnected',
  };
}

/**
 * A phone's reading from `adb devices`; null `devices` means adb could not be read. `android --device` and `device lock`
 * record the phone's model as the lease's device name, so the model comes from there.
 */
export function androidPhysicalReading(devices: AdbDevices | null, serial: string): PhysicalDeviceReading {
  const connection = !devices
    ? 'unknown'
    : devices.physical.some((entry) => entry.serial === serial)
      ? 'connected'
      : 'disconnected';
  return { name: null, model: null, connection };
}

export function physicalDeviceLine(device: PhysicalDeviceState, now: number): string {
  const slot = device.slot === 'default' ? '' : ` [${device.slot}]`;
  const name = device.name ?? device.id;
  const model = device.model && device.model !== name ? `, ${device.model}` : '';
  const remaining = formatElapsed(Date.parse(device.lease.expiresAt) - now);
  return `${device.platform}${slot}: ${name} (physical${model}) ${device.connection} -- leased until ${clockTime(device.lease.expiresAt)} (${remaining} left)`;
}
