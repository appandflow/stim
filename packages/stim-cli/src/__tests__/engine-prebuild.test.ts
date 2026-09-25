import assert from 'node:assert';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PREBUILD_ERROR,
  nativeDirInFingerprint,
  nativeDirName,
  needsPrebuild,
  planPrebuild,
  prebuildAction,
  prebuildRefusal,
  recordPrebuild,
  runPrebuild,
  shouldPrebuild,
} from '../engine/prebuild.ts';
import { acquireBuildLock, releaseBuildLock } from '../engine/build-lock.ts';
import { readClaimSet } from '../ownership-claim.ts';
import { makeChildProcess, makeWriter } from './_factories.ts';

type WriteRecord = { src: string; level: string; msg: string; event?: string };

type SpawnCall = { cmd: string; args: string[]; opts: Record<string, unknown> };

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-prebuild-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { expo: '52.0.0' } }));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function installFakeExpoBin() {
  const dir = join(root, 'node_modules', '.bin');
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'expo');
  writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  chmodSync(bin, 0o755);
  return bin;
}

describe('the decision', () => {
  test('shouldPrebuild is expo AND no native directory, nothing else', () => {
    expect(shouldPrebuild({ isExpo: true, nativeDirExists: false })).toBe(true);
    expect(shouldPrebuild({ isExpo: true, nativeDirExists: true })).toBe(false);
    expect(shouldPrebuild({ isExpo: false, nativeDirExists: false })).toBe(false);
    expect(shouldPrebuild({ isExpo: false, nativeDirExists: true })).toBe(false);
  });

  test('nativeDirName maps the platform to its directory', () => {
    expect(nativeDirName('ios')).toBe('ios');
    expect(nativeDirName('android')).toBe('android');
  });

  test('needsPrebuild reads the directory off the disk', () => {
    expect(needsPrebuild(root, 'ios', true)).toBe(true);
    mkdirSync(join(root, 'ios'), { recursive: true });
    expect(needsPrebuild(root, 'ios', true)).toBe(false);
    expect(needsPrebuild(root, 'android', true)).toBe(true);
    expect(needsPrebuild(root, 'android', false)).toBe(false);
  });

  test('prebuildAction regenerates a native dir outside the key unless its recorded prebuild ran on this fingerprint', () => {
    const base = {
      isExpo: true,
      nativeDirExists: true,
      nativeDirFingerprinted: false,
      nativeDirTracked: false,
      generatedFrom: 'old',
      fingerprint: 'new',
    };
    expect(prebuildAction(base)).toBe('regenerate');
    expect(prebuildAction({ ...base, generatedFrom: null })).toBe('regenerate');
    expect(prebuildAction({ ...base, generatedFrom: 'new' })).toBe('none');
    expect(prebuildAction({ ...base, nativeDirFingerprinted: true })).toBe('none');
    expect(prebuildAction({ ...base, nativeDirTracked: true })).toBe('refuse');
    expect(prebuildAction({ ...base, nativeDirExists: false })).toBe('generate');
    expect(prebuildAction({ ...base, isExpo: false })).toBe('none');
  });

  test('nativeDirInFingerprint is true only when the fingerprint hashed that native dir', () => {
    expect(
      nativeDirInFingerprint([{ type: 'dir', filePath: 'ios', reasons: ['bareNativeDir'], hash: 'abc' }], 'ios'),
    ).toBe(true);
    expect(
      nativeDirInFingerprint([{ type: 'dir', filePath: 'ios', reasons: ['bareNativeDir'], hash: null }], 'ios'),
    ).toBe(false);
    expect(
      nativeDirInFingerprint([{ type: 'dir', filePath: 'ios', reasons: ['bareNativeDir'], hash: 'abc' }], 'android'),
    ).toBe(false);
  });

  test('planPrebuild compares the recorded prebuild fingerprint and refuses a git-tracked or unreadable checkout', () => {
    process.env.STIM_HOME = join(root, 'stim-home');
    try {
      mkdirSync(join(root, 'ios'), { recursive: true });
      writeFileSync(join(root, 'ios', 'Podfile'), '');
      const plan = (fingerprint: string) =>
        planPrebuild(root, 'ios', {
          isExpo: true,
          fingerprint,
          sources: [{ type: 'dir', filePath: 'ios', reasons: ['bareNativeDir'], hash: null }],
        });
      expect(plan('abc')).toBe('regenerate');
      recordPrebuild(root, 'ios', 'abc');
      recordPrebuild(root, 'android', 'def');
      expect(plan('abc')).toBe('none');
      expect(plan('abd')).toBe('regenerate');

      writeFileSync(join(root, '.git'), 'gitdir: /nonexistent/stim-broken-worktree\n');
      expect(plan('abd')).toBe('refuse');
      rmSync(join(root, '.git'));

      execFileSync('git', ['init', '-q', root]);
      execFileSync('git', ['-C', root, 'add', 'ios/Podfile']);
      expect(plan('abd')).toBe('refuse');
    } finally {
      delete process.env.STIM_HOME;
    }
  });

  test('prebuildRefusal names the bare-project case and nothing else', () => {
    const refusal = prebuildRefusal({ isExpo: false, platform: 'ios', nativeDirExists: false });
    assert(refusal);
    expect(refusal.code).toBe(PREBUILD_ERROR);
    expect(refusal.message).toMatch(/no ios\/ directory and is not an Expo/);
    expect(refusal.remedy).toMatch(/expo/);
    expect(prebuildRefusal({ isExpo: true, platform: 'ios', nativeDirExists: false })).toBe(null);
    expect(prebuildRefusal({ isExpo: false, platform: 'ios', nativeDirExists: true })).toBe(null);
  });
});

function fakeExpoChild({
  lines = [],
  code = 0,
  signal = null,
  error = null,
  onExitSideEffect = null,
}: {
  lines?: string[];
  code?: number;
  signal?: NodeJS.Signals | null;
  error?: Error | null;
  onExitSideEffect?: (() => void) | null;
} = {}) {
  const child = makeChildProcess();
  setImmediate(() => {
    for (const line of lines) child.stdout?.emit('data', `${line}\n`);
    if (error) {
      child.emit('error', error);
      return;
    }
    onExitSideEffect?.();
    child.emit('exit', code, signal);
  });
  return child;
}

function collectingWriter() {
  const records: WriteRecord[] = [];
  const writer = makeWriter({
    write: (r: WriteRecord) => {
      records.push(r);
      return true;
    },
  });
  return Object.assign(writer, { records });
}

describe('runPrebuild', () => {
  test('declares expo prebuild on the build lock before it starts, and clears it once prebuild exits', async () => {
    installFakeExpoBin();
    process.env.STIM_HOME = join(root, 'stim-home');
    const lock = acquireBuildLock({ platform: 'ios', key: 'prebuild-debug', root });
    try {
      assert(lock.path);
      const lockPath = lock.path;
      let declaredAtSpawn: boolean | undefined;
      const result = await runPrebuild(root, 'ios', collectingWriter(), {
        isExpo: true,
        spawnFn: () => {
          declaredAtSpawn = readClaimSet(lockPath).live[0]?.childDeclared;
          return fakeExpoChild({ onExitSideEffect: () => mkdirSync(join(root, 'ios'), { recursive: true }) });
        },
      });
      expect(result.ok).toBe(true);
      expect(declaredAtSpawn).toBe(true);
      expect(readClaimSet(lockPath).live[0]?.childDeclared).toBe(false);
    } finally {
      releaseBuildLock(lock);
      delete process.env.STIM_HOME;
    }
  });

  test("runs the PROJECT's own expo bin with `prebuild -p <platform> --no-install`", async () => {
    const bin = installFakeExpoBin();
    const writer = collectingWriter();
    const spawnCalls: SpawnCall[] = [];
    const result = await runPrebuild(root, 'ios', writer, {
      isExpo: true,
      spawnFn: (cmd, args, opts) => {
        spawnCalls.push({ cmd, args, opts });
        return fakeExpoChild({
          lines: ['Creating native directory (./ios)'],
          onExitSideEffect: () => mkdirSync(join(root, 'ios'), { recursive: true }),
        });
      },
    });
    expect(result.ok).toBe(true);
    const spawned = spawnCalls[0];
    assert(spawned);
    expect(spawned.cmd).toBe(bin);
    expect(spawned.args).toEqual(['prebuild', '-p', 'ios', '--no-install']);
    expect(spawned.opts.cwd).toBe(root);
    expect(writer.records.map((r) => [r.src, r.level, r.msg])).toEqual([
      ['build', 'debug', 'Creating native directory (./ios)'],
    ]);
  });

  test('regenerating adds --clean to the fixed prebuild invocation', async () => {
    installFakeExpoBin();
    mkdirSync(join(root, 'ios'), { recursive: true });
    const spawnCalls: SpawnCall[] = [];
    const result = await runPrebuild(root, 'ios', collectingWriter(), {
      isExpo: true,
      clean: true,
      spawnFn: (cmd, args, opts) => {
        spawnCalls.push({ cmd, args, opts });
        return fakeExpoChild({});
      },
    });
    expect(result.ok).toBe(true);
    expect(spawnCalls[0]?.args).toEqual(['prebuild', '-p', 'ios', '--no-install', '--clean']);
  });

  test('a non-zero exit comes back as {failed, lastLines}', async () => {
    installFakeExpoBin();
    const writer = collectingWriter();
    const result = await runPrebuild(root, 'android', writer, {
      isExpo: true,
      spawnFn: () => fakeExpoChild({ lines: ['Error: Cannot determine the package name'], code: 1 }),
    });
    expect(result.failed).toBe(true);
    expect(result.code).toBe(PREBUILD_ERROR);
    expect(result.reason).toMatch(/exit code 1/);
    assert(result.lastLines);
    expect(result.lastLines.join('\n')).toMatch(/package name/);
    expect(writer.records.at(-1)).toMatchObject({
      src: 'build',
      level: 'error',
      event: 'prebuild_failed',
      msg: '`expo prebuild -p android` failed (exit code 1).',
    });
  });

  test('an exit-0 prebuild that produced no native directory is still a failure', async () => {
    installFakeExpoBin();
    const result = await runPrebuild(root, 'ios', collectingWriter(), {
      isExpo: true,
      spawnFn: () => fakeExpoChild({ lines: ['nothing to do'] }),
    });
    expect(result.failed).toBe(true);
    expect(result.reason).toMatch(/did not create ios\//);
  });

  test('refuses a bare project with no native directory, with a remedy', async () => {
    const result = await runPrebuild(root, 'ios', collectingWriter(), {
      isExpo: false,
      spawnFn: () => {
        throw new Error('must not spawn prebuild for a bare project');
      },
    });
    expect(result.failed).toBe(true);
    expect(result.code).toBe(PREBUILD_ERROR);
    expect(result.reason).toMatch(/not an Expo/);
    expect(result.remedy).toMatch(/react-native-community/);
    assert(result.error);
    expect(result.error.code).toBe(PREBUILD_ERROR);
  });

  test('reports a project from which expo cannot be resolved', async () => {
    const result = await runPrebuild(root, 'ios', collectingWriter(), {
      isExpo: true,
      spawnFn: () => {
        throw new Error('must not spawn');
      },
    });
    expect(result.failed).toBe(true);
    expect(result.reason).toMatch(/not resolvable/);
    expect(result.remedy).not.toMatch(/^Run `npm install`/);
    expect(result.remedy).toMatch(/workspace root/);
  });

  test('a spawn error is a failure, not a hang', async () => {
    installFakeExpoBin();
    const result = await runPrebuild(root, 'ios', collectingWriter(), {
      isExpo: true,
      spawnFn: () => fakeExpoChild({ error: new Error('EACCES') }),
    });
    expect(result.failed).toBe(true);
    expect(result.reason).toMatch(/EACCES/);
  });
});
