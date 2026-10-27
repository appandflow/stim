import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectAndroidHosting } from '../commands/android/remote.ts';
import { setDevice, upsertProject } from '../workspace/config.ts';

let home: string;
let saved: Record<string, string | undefined>;
const root = () => join(home, 'project');
const envKeys = ['STIM_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_AVD_HOME', 'HOME', 'USERPROFILE'];
const enoent = (path: string) => Object.assign(new Error(`spawn ${path} ENOENT`), { code: 'ENOENT', path });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-android-remote-'));
  saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.STIM_HOME = join(home, 'stim');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.ANDROID_HOME;
  delete process.env.ANDROID_SDK_ROOT;
  delete process.env.ANDROID_AVD_HOME;
  upsertProject(root(), {});
  setDevice(root(), 'android', { avdName: 'stim-project', owned: true, deviceName: 'stim-project' });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function connect(error: Error) {
  return connectAndroidHosting({
    root: root(),
    slot: 'default',
    machine: 'mini',
    release: false,
    metroCheck: true,
    selectors: {},
    read: () => ({}),
    resolveSerial: async () => {
      throw error;
    },
    prepare: async () => {
      throw new Error('reached hosted preparation');
    },
  });
}

describe('hosting from a workspace whose recorded Android emulator cannot be inspected', () => {
  test('proceeds when the emulator tool does not exist and no SDK is configured', async () => {
    const result = await connect(enoent('emulator'));
    expect(result).toMatchObject({ failure: { message: 'reached hosted preparation' } });
  });

  test('refuses when the failure is not a missing tool', async () => {
    const result = await connect(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
    expect(result).toMatchObject({ failure: { code: 'STIM_BAD_ARG' } });
  });

  test('refuses when the recorded emulator still has AVD data on disk', async () => {
    mkdirSync(join(home, '.android', 'avd'), { recursive: true });
    writeFileSync(join(home, '.android', 'avd', 'stim-project.ini'), 'path=unused\n');
    const result = await connect(enoent('emulator'));
    expect(result).toMatchObject({ failure: { code: 'STIM_BAD_ARG' } });
  });

  test('refuses when the failing path is an existing emulator rather than a missing one', async () => {
    const result = await connect(enoent('/opt/sdk/emulator/emulator'));
    expect(result).toMatchObject({ failure: { code: 'STIM_BAD_ARG' } });
  });

  test('refuses when the missing tool is adb, since the emulator may still be running', async () => {
    const result = await connect(enoent('adb'));
    expect(result).toMatchObject({ failure: { code: 'STIM_BAD_ARG' } });
  });

  test('refuses when ANDROID_HOME names an SDK that may be on an unmounted volume', async () => {
    process.env.ANDROID_HOME = join(home, 'sdk');
    const result = await connect(enoent('emulator'));
    expect(result).toMatchObject({ failure: { code: 'STIM_BAD_ARG' } });
  });
});
