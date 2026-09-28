import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureProcessToken } from '@stim-cli/core/process-identity';
import { readViewedDevices } from '@stim-cli/core/state';
import { DeviceViewers } from '../src/viewers.ts';

let dir: string;

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'stim-viewers-')), 'viewers');
});

afterEach(() => {
  rmSync(join(dir, '..'), { recursive: true, force: true });
});

const sim = { platform: 'ios' as const, udid: 'SIM-1', foldable: false };
const emulator = { platform: 'android' as const, serial: 'emulator-5554' };

describe('DeviceViewers', () => {
  test('Stim reads a device as viewed from its first subscriber until its last one leaves', () => {
    const viewers = new DeviceViewers(dir);
    const first = viewers.add(sim);
    const second = viewers.add(sim);
    const other = viewers.add(emulator);
    expect(readViewedDevices(dir)).toEqual([
      { platform: 'ios', id: 'SIM-1' },
      { platform: 'android', id: 'emulator-5554' },
    ]);

    first();
    first();
    other();
    expect(readViewedDevices(dir)).toEqual([{ platform: 'ios', id: 'SIM-1' }]);

    second();
    expect(readViewedDevices(dir)).toEqual([]);
    expect(existsSync(join(dir, `${process.pid}.json`))).toBe(false);
  });

  test('a web page is not recorded', () => {
    new DeviceViewers(dir).add({
      platform: 'web',
      endpoint: 'http://127.0.0.1:1',
      pid: 1,
      targetId: 't',
    });
    expect(existsSync(dir)).toBe(false);
  });

  test("a crashed server's record counts for nothing and the next server removes it", async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
    const token = captureProcessToken(child.pid!);
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, `${child.pid}.json`);
    writeFileSync(
      stale,
      JSON.stringify({
        pid: child.pid,
        processToken: token,
        devices: [{ platform: 'ios', id: 'X' }],
      }),
    );
    expect(readViewedDevices(dir)).toEqual([]);

    new DeviceViewers(dir).add(sim);
    expect(existsSync(stale)).toBe(false);
    expect(readViewedDevices(dir)).toEqual([{ platform: 'ios', id: 'SIM-1' }]);
  });
});
