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
