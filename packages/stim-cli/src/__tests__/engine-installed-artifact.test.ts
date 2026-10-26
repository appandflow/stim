import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Executor } from '../exec.ts';
import {
  artifactsMatch,
  deviceHoldsApk,
  deviceHoldsBundle,
  deviceTailProbeScript,
  hashBundle,
  hashFile,
  parseAppContainerPath,
  parseDeviceSha256,
  parseDeviceTailProbe,
  parseInstalledApkPath,
} from '../engine/installed-artifact.ts';

import { writeSignedApk, type SignedApk } from './_signed-apk.ts';

const SHA = 'a'.repeat(64);
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-artifact-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface RecordingExec extends Executor {
  calls: string[][];
}

function recordingExec({
  outputs = {},
  fail = null,
}: { outputs?: Record<string, string>; fail?: string | null } = {}): RecordingExec {
  const calls: string[][] = [];
  const record = (file: string, args: string[] = []) => {
    calls.push([file, ...args]);
    const key = [file, ...args].join(' ');
    if (fail && key.includes(fail)) throw new Error(`Command failed: ${key}`);
    for (const [match, value] of Object.entries(outputs)) if (key.includes(match)) return value;
    return '';
  };
  return {
    calls,
    runFileAsync: async (file: string, args: string[] = []) => record(file, args),
    run: () => {
      throw new Error('the identity check must use runFileAsync, not the shell');
    },
    runQuiet: () => {
      throw new Error('the identity check must use runFileAsync, not the shell');
    },
    runFile: () => {
      throw new Error('the identity check must use runFileAsync, not runFile');
    },
    runFileQuiet: () => {
      throw new Error('the identity check must use runFileAsync, not runFileQuiet');
    },
    runFileQuietAsync: () => {
      throw new Error('the identity check must use runFileAsync, not runFileQuietAsync');
    },
    spawn: () => {
      throw new Error('the identity check does not spawn');
    },
    findExecutable: () => null,
  };
}

describe('parseInstalledApkPath', () => {
  test('reads the one package path pm reports', () => {
    expect(parseInstalledApkPath('package:/data/app/~~aB0==/com.example.app-x9/base.apk\n')).toBe(
      '/data/app/~~aB0==/com.example.app-x9/base.apk',
    );
  });

  test('a package that is not installed reports nothing', () => {
    expect(parseInstalledApkPath('')).toBe(null);
    expect(parseInstalledApkPath('\n')).toBe(null);
    expect(parseInstalledApkPath(null)).toBe(null);
  });

  test('a split install has no single artifact to compare, so it reads as unknown', () => {
    const text = ['package:/data/app/a/base.apk', 'package:/data/app/a/split_config.arm64_v8a.apk', ''].join('\n');
    expect(parseInstalledApkPath(text)).toBe(null);
  });

  test('an error line is not a path', () => {
    expect(parseInstalledApkPath('Error: android.content.pm.PackageManager$NameNotFoundException')).toBe(null);
    expect(parseInstalledApkPath('package:')).toBe(null);
  });
});

describe('parseDeviceSha256', () => {
  test('reads the digest sha256sum prints beside the path', () => {
    expect(parseDeviceSha256(`${SHA}  /data/app/a/base.apk\n`)).toBe(SHA);
  });

  test('a device without sha256sum reads as unknown, never as a match', () => {
    expect(parseDeviceSha256('/system/bin/sh: sha256sum: not found')).toBe(null);
    expect(parseDeviceSha256('sha256sum: /data/app/a/base.apk: No such file or directory')).toBe(null);
    expect(parseDeviceSha256('')).toBe(null);
    expect(parseDeviceSha256(null)).toBe(null);
  });

  test('a digest of the wrong width is not a sha256', () => {
    expect(parseDeviceSha256(`${'b'.repeat(32)}  /data/app/a/base.apk`)).toBe(null);
    expect(parseDeviceSha256(`${'c'.repeat(40)}  /data/app/a/base.apk`)).toBe(null);
    expect(parseDeviceSha256(`${'d'.repeat(65)}  /data/app/a/base.apk`)).toBe(null);
  });
});

describe('parseAppContainerPath', () => {
  test('reads the container simctl prints', () => {
    const path = '/Users/x/Library/Developer/CoreSimulator/Devices/BF2A/data/Containers/Bundle/App/1/Fixture.app';
    expect(parseAppContainerPath(`${path}\n`)).toBe(path);
  });

  test('an app that is not installed reads as unknown', () => {
    expect(parseAppContainerPath('No such file or directory')).toBe(null);
    expect(parseAppContainerPath('')).toBe(null);
    expect(parseAppContainerPath(null)).toBe(null);
  });
});

describe('artifactsMatch', () => {
  test('two known, equal digests match', () => {
    expect(artifactsMatch(SHA, SHA)).toBe(true);
  });

  test('an unknown digest on either side NEVER matches', () => {
    expect(artifactsMatch(null, SHA)).toBe(false);
    expect(artifactsMatch(SHA, null)).toBe(false);
    expect(artifactsMatch(null, null)).toBe(false);
  });

  test('different digests do not match', () => {
    expect(artifactsMatch(SHA, 'b'.repeat(64))).toBe(false);
  });
});

describe('hashFile', () => {
  test('equal bytes hash equal, one changed byte does not', () => {
    writeFileSync(join(dir, 'a'), 'payload');
    writeFileSync(join(dir, 'b'), 'payload');
    writeFileSync(join(dir, 'c'), 'payloae');
    expect(hashFile(join(dir, 'a'))).toBe(hashFile(join(dir, 'b')));
    expect(hashFile(join(dir, 'a'))).not.toBe(hashFile(join(dir, 'c')));
  });

  test('an unreadable file is unknown, not a digest', () => {
    expect(hashFile(join(dir, 'missing'))).toBe(null);
  });
});

describe('hashBundle', () => {
  function bundle(name: string, files: Record<string, string>) {
    const root = join(dir, name);
    for (const [path, body] of Object.entries(files)) {
      const abs = join(root, path);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, body);
    }
    return root;
  }

  test('the same file set hashes equal whatever order it was written in', () => {
    const left = bundle('left', { Info: 'plist', 'Frameworks/A/A': 'binary', Fixture: 'macho' });
    const right = bundle('right', { Fixture: 'macho', 'Frameworks/A/A': 'binary', Info: 'plist' });
    expect(hashBundle(left)).toBe(hashBundle(right));
  });

  test('a changed byte, a renamed file, and a moved file each change the hash', () => {
    const base = hashBundle(bundle('base', { Info: 'plist', 'Frameworks/A/A': 'binary' }));
    expect(hashBundle(bundle('edited', { Info: 'plist!', 'Frameworks/A/A': 'binary' }))).not.toBe(base);
    expect(hashBundle(bundle('renamed', { Info2: 'plist', 'Frameworks/A/A': 'binary' }))).not.toBe(base);
    expect(hashBundle(bundle('moved', { Info: 'plist', 'Frameworks/B/A': 'binary' }))).not.toBe(base);
  });

  test('a missing directory is unknown', () => {
    expect(hashBundle(join(dir, 'missing.app'))).toBe(null);
  });

  test('an entry that is not a plain file or directory is unknown, not a match', () => {
    const root = bundle('linked', { Info: 'plist' });
    symlinkSync(join(root, 'Info'), join(root, 'Alias'));
    expect(hashBundle(root)).toBe(null);
  });
});

describe('deviceHoldsApk with a recorded signed tail', () => {
  const adb = (...args: string[]) => ['adb', '-s', 'emulator-5584', 'shell', ...args];
  const answer = (size: number, sha: string) => `path /data/app/a/base.apk\nsize ${size}\n${sha}  -\n`;

  function setup(output: (apk: SignedApk) => string, extra: Record<string, string> = {}) {
    const apkPath = join(dir, 'app-debug.apk');
    const apk = writeSignedApk(apkPath);
    const exec = recordingExec({ outputs: { 'tail -c': output(apk), ...extra } });
    const held = () => deviceHoldsApk({ serial: 'emulator-5584', packageName: 'com.example.app', apkPath }, { exec });
    return { apk, exec, held };
  }

  test('the same size and tail digest skip the install in one adb call that never hashes the whole APK', async () => {
    const { apk, exec, held } = setup((a) => answer(a.size, a.tailSha256));
    expect(await held()).toBe(true);
    expect(exec.calls).toEqual([adb(deviceTailProbeScript('com.example.app', apk.size - apk.tailOffset))]);
  });

  test.each([
    ['a different tail digest', (a: SignedApk) => answer(a.size, SHA)],
    ['a different size', (a: SignedApk) => answer(1, a.tailSha256)],
  ])('%s means a different APK: reinstall, with no whole-file hash', async (_label, output) => {
    const { exec, held } = setup(output);
    expect(await held()).toBe(false);
    expect(exec.calls).toHaveLength(1);
  });

  test('a package that is not installed, or installed in splits, is never a match', async () => {
    expect(await setup(() => '').held()).toBe(false);
    const split = setup((a) => answer(a.size, a.tailSha256) + answer(a.size, a.tailSha256));
    expect(await split.held()).toBe(false);
    expect(split.exec.calls).toHaveLength(1);
  });

  test('a device that cannot answer falls back to hashing the whole installed APK', async () => {
    const { exec, held } = setup(() => 'tail: not found\n', {
      'pm path': 'package:/data/app/a/base.apk\n',
      'sha256sum /data': `${SHA}  /data/app/a/base.apk\n`,
    });
    expect(await held()).toBe(false);
    expect(exec.calls.map((call) => call.at(-1))).toEqual([
      expect.stringContaining('tail -c'),
      'com.example.app',
      '/data/app/a/base.apk',
    ]);
  });

  test('an APK with no recorded tail keeps the whole-file comparison', async () => {
    const apkPath = join(dir, 'plain.apk');
    writeFileSync(apkPath, 'apk bytes');
    const exec = recordingExec({
      outputs: {
        'pm path': 'package:/data/app/a/base.apk\n',
        sha256sum: `${hashFile(apkPath)}  /data/app/a/base.apk\n`,
      },
    });
    expect(await deviceHoldsApk({ serial: 'emulator-5584', packageName: 'com.example.app', apkPath }, { exec })).toBe(
      true,
    );
    expect(exec.calls.map((call) => call.at(-1))).toEqual(['com.example.app', '/data/app/a/base.apk']);
  });

  test('a package name the device shell could misread is never put in the tail script', async () => {
    const apkPath = join(dir, 'app-debug.apk');
    writeSignedApk(apkPath);
    const exec = recordingExec();
    await deviceHoldsApk({ serial: 'emulator-5584', packageName: 'com.example; reboot', apkPath }, { exec });
    expect(exec.calls.flat().some((part) => part.includes('tail -c'))).toBe(false);
  });
});

describe('deviceHoldsApk', () => {
  function localApk(body = 'apk bytes') {
    const path = join(dir, 'app-debug.apk');
    writeFileSync(path, body);
    return path;
  }

  test('an identical APK on the device is a match, asked for by pm path then sha256sum', async () => {
    const apkPath = localApk();
    const exec = recordingExec({
      outputs: {
        'pm path': 'package:/data/app/a/base.apk\n',
        sha256sum: `${hashFile(apkPath)}  /data/app/a/base.apk\n`,
      },
    });
    expect(await deviceHoldsApk({ serial: 'emulator-5584', packageName: 'com.example.app', apkPath }, { exec })).toBe(
      true,
    );
    expect(exec.calls).toEqual([
      ['adb', '-s', 'emulator-5584', 'shell', 'pm', 'path', 'com.example.app'],
      ['adb', '-s', 'emulator-5584', 'shell', 'sha256sum', '/data/app/a/base.apk'],
    ]);
  });

  test('a different APK on the device is not a match', async () => {
    const exec = recordingExec({
      outputs: { 'pm path': 'package:/data/app/a/base.apk\n', sha256sum: `${SHA}  /data/app/a/base.apk\n` },
    });
    const apkPath = localApk();
    expect(await deviceHoldsApk({ serial: 'emulator-5584', packageName: 'com.example.app', apkPath }, { exec })).toBe(
      false,
    );
  });

  test('a device with no sha256sum is unknown, so it never matches', async () => {
    const exec = recordingExec({
      outputs: { 'pm path': 'package:/data/app/a/base.apk\n', sha256sum: 'sha256sum: not found' },
    });
    const apkPath = localApk();
    expect(await deviceHoldsApk({ serial: 'emulator-5584', packageName: 'com.example.app', apkPath }, { exec })).toBe(
      false,
    );
  });

  test('a package that is not installed is asked once and never hashed', async () => {
    const exec = recordingExec();
    const apkPath = localApk();
    expect(await deviceHoldsApk({ serial: 'emulator-5584', packageName: 'com.example.app', apkPath }, { exec })).toBe(
      false,
    );
    expect(exec.calls).toEqual([['adb', '-s', 'emulator-5584', 'shell', 'pm', 'path', 'com.example.app']]);
  });

  test('an adb that fails is unknown, so it never matches', async () => {
    const apkPath = localApk();
    const failPath = recordingExec({ fail: 'pm path' });
    expect(
      await deviceHoldsApk({ serial: 'emulator-5584', packageName: 'com.example.app', apkPath }, { exec: failPath }),
    ).toBe(false);
    const failHash = recordingExec({ outputs: { 'pm path': 'package:/data/app/a/base.apk\n' }, fail: 'sha256sum' });
    expect(
      await deviceHoldsApk({ serial: 'emulator-5584', packageName: 'com.example.app', apkPath }, { exec: failHash }),
    ).toBe(false);
  });

  test('a local APK that cannot be read is unknown, so it never matches', async () => {
    const exec = recordingExec({
      outputs: { 'pm path': 'package:/data/app/a/base.apk\n', sha256sum: `${SHA}  /data/app/a/base.apk\n` },
    });
    const apkPath = join(dir, 'gone.apk');
    expect(await deviceHoldsApk({ serial: 'emulator-5584', packageName: 'com.example.app', apkPath }, { exec })).toBe(
      false,
    );
  });
});

describe('parseDeviceTailProbe', () => {
  const probe = (path: string, size: string, sha: string) => `path ${path}\nsize ${size}\n${sha}  -\n`;

  test('one installed APK is its size and tail digest', () => {
    expect(parseDeviceTailProbe(probe('/data/app/a/base.apk', '1234', SHA))).toEqual({
      installs: 1,
      size: 1234,
      tailSha256: SHA,
    });
  });

  test('no output is a package that is not installed, and several APKs are a split install', () => {
    expect(parseDeviceTailProbe('')).toEqual({ installs: 0 });
    expect(
      parseDeviceTailProbe(probe('/data/app/a/base.apk', '1', SHA) + probe('/data/app/a/split_x.apk', '2', SHA)),
    ).toEqual({ installs: 'split' });
  });

  test.each([
    [
      'an error line among the answers',
      `tail: /data/app/a/base.apk: No such file or directory\n${probe('/a', '1', SHA)}`,
    ],
    [
      'the digest of an empty input, which is what a missing tail produces',
      probe('/data/app/a/base.apk', '1', EMPTY_SHA),
    ],
    ['a size that is not a number', probe('/data/app/a/base.apk', 'x', SHA)],
    ['no digest', 'path /data/app/a/base.apk\nsize 1\nsha256sum: not found\n'],
  ])('%s is not an answer', (_label, text) => {
    expect(parseDeviceTailProbe(text)).toBe(null);
  });
});

describe('deviceHoldsBundle', () => {
  function bundleAt(name: string, body: string) {
    const root = join(dir, name);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'Fixture'), body);
    return root;
  }

  test('an identical .app in the simulator container is a match', async () => {
    const installed = bundleAt('installed.app', 'macho');
    const appPath = bundleAt('built.app', 'macho');
    const exec = recordingExec({ outputs: { get_app_container: `${installed}\n` } });
    expect(await deviceHoldsBundle({ udid: 'BF2A', bundleId: 'com.example.app', appPath }, { exec })).toBe(true);
    expect(exec.calls).toEqual([['xcrun', 'simctl', 'get_app_container', 'BF2A', 'com.example.app']]);
  });

  test('a different .app in the container is not a match', async () => {
    const installed = bundleAt('installed.app', 'macho');
    const appPath = bundleAt('built.app', 'macho with fresh js');
    const exec = recordingExec({ outputs: { get_app_container: `${installed}\n` } });
    expect(await deviceHoldsBundle({ udid: 'BF2A', bundleId: 'com.example.app', appPath }, { exec })).toBe(false);
  });

  test('an app that is not installed, or a simctl that fails, is unknown', async () => {
    const appPath = bundleAt('built.app', 'macho');
    expect(
      await deviceHoldsBundle({ udid: 'BF2A', bundleId: 'com.example.app', appPath }, { exec: recordingExec() }),
    ).toBe(false);
    expect(
      await deviceHoldsBundle(
        { udid: 'BF2A', bundleId: 'com.example.app', appPath },
        { exec: recordingExec({ fail: 'get_app_container' }) },
      ),
    ).toBe(false);
  });
});
