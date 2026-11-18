import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteProjectDevices } from '../commands/gc/devices.ts';
import { recordCreatedDevice } from '../devices/created-devices.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { ensureConfig, upsertProject } from '../workspace/config.ts';

let home: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-ios-orphan-refs-')));
  saved = { STIM_HOME: process.env.STIM_HOME, HOME: process.env.HOME };
  process.env.HOME = home;
  process.env.STIM_HOME = join(home, 'stim');
  ensureConfig();
  recordCreatedDevice('ios', 'U1');
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
  resetExecutor();
});

test('an orphaned iOS simulator that a project record references by delete time is kept', async () => {
  const calls: string[] = [];
  const answer = (cmd: string) => {
    calls.push(cmd);
    if (cmd.includes('simctl list devices --json')) {
      return JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
            { udid: 'U1', name: 'stim-app', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: 'iphone-17' },
          ],
        },
      });
    }
    return '';
  };
  setExecutor({
    run: answer,
    runFile: (file: string, args: string[] = []) => answer([file, ...args].join(' ')),
    runQuiet: answer,
    runFileQuiet: (file: string, args: string[] = []) => answer([file, ...args].join(' ')),
    spawn: () => {},
  });
  upsertProject('/tmp/new-workspace', {
    platforms: { ios: { deviceUdid: 'U1', deviceName: 'stim-app', owned: true } },
  });

  const failures = await deleteProjectDevices([{ kind: 'ios', id: 'U1', name: 'stim-app' }], [], []);

  expect(failures).toBe(1);
  expect(calls.some((c) => /simctl delete U1/.test(c))).toBe(false);
});
