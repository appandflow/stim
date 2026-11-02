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

describe('DeviceViewers', () => {
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

describe('forwarded input', () => {
  test('dates the device, keeps the record once frames stop, and writes at most once a second', () => {
    let now = Date.parse('2026-11-02T10:00:00.000Z');
    const viewers = new DeviceViewers(dir, () => now);
    viewers.input(sim);
    expect(readViewedDevices(dir)).toEqual([{ platform: 'ios', id: 'SIM-1', lastInputAt: '2026-11-02T10:00:00.000Z' }]);

    now += 200;
    viewers.input(sim);
    expect(readViewedDevices(dir)[0]?.lastInputAt).toBe('2026-11-02T10:00:00.000Z');
    now += 800;
    vi.advanceTimersByTime(800);
    expect(readViewedDevices(dir)[0]?.lastInputAt).toBe('2026-11-02T10:00:00.200Z');

    viewers.add(sim)();
    expect(readViewedDevices(dir)).toEqual([{ platform: 'ios', id: 'SIM-1', lastInputAt: '2026-11-02T10:00:00.200Z' }]);
    viewers.input({ platform: 'ios', udid: 'PHONE', foldable: false, physical: true });
    expect(readViewedDevices(dir).map((device) => device.id)).toEqual(['SIM-1']);
  });
});
