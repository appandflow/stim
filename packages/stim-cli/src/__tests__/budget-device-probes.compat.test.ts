import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inject } from 'vitest';
import { createActivityReaderAsync } from '../devices/activity.ts';
import {
  getAvdNameForSerialAsync,
  listAdbDevicesAsync,
  listAvdsAsync,
  ownedAvdSerialResolverAsync,
} from '../devices/android.ts';
import { createIosSimSnapshot } from '../devices/ios.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    agentDeviceAndroidSerial: string;
  }
}

test('async simulator snapshots accept native simctl output and share their cached listing', async () => {
  assert.equal(process.platform, 'darwin', 'This compatibility probe requires macOS and Xcode.');
  const snapshot = createIosSimSnapshot();
  assert(snapshot.readAsync);
  const sims = await snapshot.readAsync();
  expect(snapshot.read()).toBe(sims);
}, 35000);

test('async owned AVD and activity reads accept real emulator/adb/ps output on the validation device', async () => {
  const serial = inject('agentDeviceAndroidSerial');
  assert(
    typeof serial === 'string' && serial.startsWith('emulator-'),
    'Set STIM_AGENT_DEVICE_ANDROID_SERIAL to an emulator owned exclusively by this validation.',
  );
  const devices = await listAdbDevicesAsync();
  expect(devices.emulators.some((device) => device.serial === serial)).toBe(true);
  const name = await getAvdNameForSerialAsync(serial);
  assert(name, 'The validation emulator must answer its AVD name.');
  expect(await listAvdsAsync()).toContain(name);
  const resolve = ownedAvdSerialResolverAsync({ timeoutMs: 10000 });
  expect(await resolve(name)).toEqual({ serial });
  expect(await resolve(name)).toEqual({ serial });
  const home = mkdtempSync(join(tmpdir(), 'stim-native-activity-'));
  try {
    const read = createActivityReaderAsync({ home, leaseFiles: () => [], viewers: () => [] });
    const activity = await read({ platform: 'android', id: serial, slot: 'default', workspace: null });
    expect(activity.basis).not.toContain('driver-process');
    expect(activity.basis).not.toContain('instrumentation');
    expect(activity.state).not.toBe('unknown');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 60000);
