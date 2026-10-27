import { mkdirSync, mkdtempSync, realpathSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { hostSystemImageArch } from '../devices/android.ts';
import { offerHostedAndroidDevice } from '../device-host/android.ts';
import { saveConfig } from '../workspace/config.ts';

vi.mock('../devices/android.ts', async (original) => ({
  ...(await original<typeof import('../devices/android.ts')>()),
  listAvdDeviceProfiles: () => ['pixel_6'],
}));

const previous = { home: process.env.STIM_HOME, sdk: process.env.ANDROID_HOME, root: process.env.ANDROID_SDK_ROOT };
const tmpFree = statfsSync(tmpdir());
const roomToInstall = tmpFree.bavail * tmpFree.bsize >= 9 * 1024 ** 3;
let root: string;
let sdk: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-hosted-offer-')));
  sdk = join(root, 'sdk');
  mkdirSync(join(sdk, 'cmdline-tools', 'latest', 'bin'), { recursive: true });
  writeFileSync(
    join(sdk, 'cmdline-tools', 'latest', 'bin', process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager'),
    '',
  );
  process.env.STIM_HOME = join(root, 'home');
  process.env.ANDROID_HOME = sdk;
  delete process.env.ANDROID_SDK_ROOT;
});

afterEach(() => {
  for (const [key, value] of [
    ['STIM_HOME', previous.home],
    ['ANDROID_HOME', previous.sdk],
    ['ANDROID_SDK_ROOT', previous.root],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

test.skipIf(!roomToInstall)(
  "a host offers a missing image for install only when its own setting and licenses allow it, else declines with the host's command",
  () => {
    const pkg = `system-images;android-36;google_apis;${hostSystemImageArch()}`;
    expect(() => offerHostedAndroidDevice({})).toThrow(/--licenses/);

    mkdirSync(join(sdk, 'licenses'));
    writeFileSync(join(sdk, 'licenses', 'android-sdk-license'), 'accepted');
    saveConfig({ version: 2, projects: {}, repos: {}, android: { installImages: 'never' } });
    expect(() => offerHostedAndroidDevice({})).toThrow(new RegExp(`--install "${pkg}"`));

    saveConfig({ version: 2, projects: {}, repos: {}, android: { installImages: 'auto' } });
    expect(offerHostedAndroidDevice({})).toEqual({
      choice: { systemImage: pkg, deviceProfile: 'pixel_6', architecture: hostSystemImageArch() },
      installImage: pkg,
    });
  },
);
