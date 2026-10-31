import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectAndroidHosting } from '../commands/android/remote.ts';
import { setDevice, upsertProject } from '../workspace/config.ts';

let home: string;
let saved: Record<string, string | undefined>;
const root = () => join(home, 'project');
const androidKeys = [
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'ANDROID_AVD_HOME',
  'ANDROID_EMULATOR_HOME',
  'ANDROID_USER_HOME',
  'ANDROID_SDK_HOME',
];
const envKeys = ['STIM_HOME', 'HOME', 'USERPROFILE', ...androidKeys];
const enoent = (path: string) => Object.assign(new Error(`spawn ${path} ENOENT`), { code: 'ENOENT', path });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-android-remote-'));
  saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.STIM_HOME = join(home, 'stim');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  for (const key of androidKeys) delete process.env[key];
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
});
