import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Executor } from '../exec.ts';
import { deviceHoldsApk, hashBundle, parseDeviceSha256 } from '../engine/installed-artifact.ts';

import { writeSignedApk, type SignedApk } from './_signed-apk.ts';

const SHA = 'a'.repeat(64);

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

describe('parseDeviceSha256', () => {
  test('a device without sha256sum reads as unknown, never as a match', () => {
    expect(parseDeviceSha256('/system/bin/sh: sha256sum: not found')).toBe(null);
    expect(parseDeviceSha256('sha256sum: /data/app/a/base.apk: No such file or directory')).toBe(null);
    expect(parseDeviceSha256('')).toBe(null);
    expect(parseDeviceSha256(null)).toBe(null);
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

  test('an entry that is not a plain file or directory is unknown, not a match', () => {
    const root = bundle('linked', { Info: 'plist' });
    symlinkSync(join(root, 'Info'), join(root, 'Alias'));
    expect(hashBundle(root)).toBe(null);
  });
});

describe('deviceHoldsApk with a recorded signed tail', () => {
  const answer = (size: number, sha: string) => `path /data/app/a/base.apk\nsize ${size}\n${sha}  -\n`;

  function setup(output: (apk: SignedApk) => string, extra: Record<string, string> = {}) {
    const apkPath = join(dir, 'app-debug.apk');
    const apk = writeSignedApk(apkPath);
    const exec = recordingExec({ outputs: { 'tail -c': output(apk), ...extra } });
    const held = () => deviceHoldsApk({ serial: 'emulator-5584', packageName: 'com.example.app', apkPath }, { exec });
    return { apk, exec, held };
  }

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
});
