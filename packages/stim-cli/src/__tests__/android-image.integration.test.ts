import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readCreatedDevices } from '@stim-cli/core/state';
import * as ownership from '../ownership-claim.ts';
import * as identities from '../process-identity.ts';
import { decideSystemImage, ensureSystemImage, installSystemImage } from '../devices/android-image.ts';
import { hostSystemImageArch } from '../devices/android.ts';
import { resetExecutor, setExecutor } from '../exec.ts';

const ARM = 'system-images;android-36;google_apis;arm64-v8a';
const HOST = `system-images;android-36;google_apis;${hostSystemImageArch()}`;
const tmpFree = statfsSync(tmpdir());
const roomToInstall = tmpFree.bavail * tmpFree.bsize >= 9 * 1024 ** 3;
let root: string;
let sdk: string;
let env: NodeJS.ProcessEnv;
const previousHome = process.env.STIM_HOME;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-android-image-')));
  sdk = join(root, 'sdk');
  mkdirSync(join(sdk, 'cmdline-tools', 'latest', 'bin'), { recursive: true });
  writeFileSync(
    join(sdk, 'cmdline-tools', 'latest', 'bin', process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager'),
    '',
  );
  mkdirSync(join(sdk, 'licenses'));
  writeFileSync(join(sdk, 'licenses', 'android-sdk-license'), 'accepted');
  process.env.STIM_HOME = join(root, 'home');
  env = { ...process.env, ANDROID_HOME: sdk };
});

afterEach(() => {
  resetExecutor();
  if (previousHome === undefined) delete process.env.STIM_HOME;
  else process.env.STIM_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

test('an image that is not installed is installed only for the host ABI and only when the policy allows', () => {
  const installed = [
    { api: 34, tag: 'google_apis', arch: 'x86_64', pkg: 'system-images;android-34;google_apis;x86_64' },
  ];
  expect(decideSystemImage({ requested: null, installed, policy: 'auto', hostArch: 'arm64-v8a' })).toEqual({
    kind: 'install',
    pkg: ARM,
  });
  expect(
    decideSystemImage({ requested: 'system-images;android-34;google_apis;x86_64', installed, policy: 'never' }),
  ).toEqual({ kind: 'installed', pkg: 'system-images;android-34;google_apis;x86_64' });
  expect(
    decideSystemImage({
      requested: 'system-images;android-35;google_apis;x86_64',
      installed,
      policy: 'auto',
      hostArch: 'arm64-v8a',
    }),
  ).toMatchObject({ kind: 'refuse', code: 'STIM_BAD_ARG' });
  expect(decideSystemImage({ requested: null, installed, policy: 'never', hostArch: 'arm64-v8a' })).toMatchObject({
    kind: 'refuse',
    code: 'STIM_NO_DEVICE',
    remedy: expect.stringContaining(`--install "${ARM}"`),
  });
});

test.skipIf(!roomToInstall)(
  'two concurrent runs for one SDK run sdkmanager once, both report the image as newly installed, and it is recorded once',
  async () => {
    const calls: string[][] = [];
    const stdin: unknown[] = [];
    setExecutor({
      runFileAsync: async (_file: string, args: string[], options: { input?: string }) => {
        calls.push(args);
        stdin.push(options.input);
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const installed = join(sdk, 'system-images', 'android-36', 'google_apis', hostSystemImageArch());
        mkdirSync(installed, { recursive: true });
        writeFileSync(join(installed, 'package.xml'), '<package/>');
        return 'done';
      },
    });
    const run = () => ensureSystemImage({ requested: HOST, policy: 'auto', env, note: () => {} });
    const results = await Promise.all([run(), run()]);
    expect(calls).toEqual([[`--sdk_root=${sdk}`, '--install', HOST]]);
    expect(stdin).toEqual(['n\n']);
    expect(results).toEqual([
      { ok: true, installed: true },
      { ok: true, installed: true },
    ]);
    expect([...readCreatedDevices().systemImages]).toEqual([
      join(sdk, 'system-images', 'android-36', 'google_apis', hostSystemImageArch()),
    ]);
  },
);

test.skipIf(!roomToInstall)(
  'an unaccepted license refuses with the sdkmanager --licenses command and records nothing',
  async () => {
    setExecutor({
      runFileAsync: async () =>
        'Accept? (y/N): Skipping following packages as the license is not accepted:\nGoogle APIs ARM 64 v8a System Image\n',
    });
    const result = await installSystemImage({ pkg: ARM, env, note: () => {} });
    expect(result).toMatchObject({ ok: false, remedy: expect.stringContaining('--licenses') });
    expect(readCreatedDevices().systemImages.size).toBe(0);

    rmSync(join(sdk, 'licenses'), { recursive: true });
    setExecutor({
      runFileAsync: async () => {
        throw new Error('sdkmanager must not run before the licenses are accepted');
      },
    });
    expect(await installSystemImage({ pkg: ARM, env, note: () => {} })).toMatchObject({
      ok: false,
      remedy: expect.stringContaining('--licenses'),
    });
    expect(existsSync(join(sdk, 'system-images'))).toBe(false);
  },
);

test.skipIf(!roomToInstall || process.platform === 'win32')(
  'an sdkmanager that exits before its identity is read refuses with its own output',
  async () => {
    const tool = join(sdk, 'cmdline-tools', 'latest', 'bin', 'sdkmanager');
    writeFileSync(tool, `#!${process.execPath}\nprocess.stdout.write('sdkmanager broke\\n');process.exit(1);\n`);
    chmodSync(tool, 0o755);
    const real = identities.captureProcessIdentity;
    vi.spyOn(identities, 'captureProcessIdentity').mockImplementation((pid) =>
      pid === process.pid ? real(pid) : { ok: false, reason: 'NOT_FOUND (forced)', code: 'NOT_FOUND' },
    );
    const result = await installSystemImage({ pkg: ARM, env, note: () => {} });
    vi.restoreAllMocks();
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('sdkmanager broke') });
    expect(JSON.stringify(result)).not.toContain('Cannot record');
  },
);

test.skipIf(!roomToInstall || process.platform === 'win32')(
  'an sdkmanager still running after a NOT_FOUND read is recorded by a second read',
  async () => {
    const tool = join(sdk, 'cmdline-tools', 'latest', 'bin', 'sdkmanager');
    writeFileSync(
      tool,
      `#!${process.execPath}\nsetTimeout(()=>{process.stdout.write('sdkmanager late\\n');process.exit(1)},2600);\n`,
    );
    chmodSync(tool, 0o755);
    const real = identities.captureProcessIdentity;
    let forced = 0;
    vi.spyOn(identities, 'captureProcessIdentity').mockImplementation((pid) => {
      if (pid === process.pid || forced++ > 0) return real(pid);
      return { ok: false, reason: 'NOT_FOUND (forced)', code: 'NOT_FOUND' };
    });
    const recorded = vi.spyOn(ownership, 'setClaimChild');
    try {
      const result = await installSystemImage({ pkg: ARM, env, note: () => {} });
      expect(result).toMatchObject({ ok: false, message: expect.stringContaining('sdkmanager late') });
      expect(recorded).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  },
  20_000,
);

test('an image left mid-install is never used, and under never it is refused instead of installed', async () => {
  const image = (api: number) => join(sdk, 'system-images', `android-${api}`, 'google_apis', hostSystemImageArch());
  mkdirSync(join(image(37), '.installer'), { recursive: true });
  mkdirSync(image(36), { recursive: true });
  writeFileSync(join(image(36), 'package.xml'), '<package/>');
  setExecutor({
    runFileAsync: async () => {
      throw new Error('sdkmanager must not run');
    },
  });
  expect(await ensureSystemImage({ requested: null, policy: 'auto', env, note: () => {} })).toEqual({
    ok: true,
    installed: false,
  });
  expect(
    await ensureSystemImage({
      requested: `system-images;android-37;google_apis;${hostSystemImageArch()}`,
      policy: 'never',
      env,
      note: () => {},
    }),
  ).toMatchObject({ ok: false, code: 'STIM_BAD_ARG', remedy: expect.stringContaining('--install') });
});
