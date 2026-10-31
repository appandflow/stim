import assert from 'node:assert';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PREBUILD_ERROR, planPrebuild, planPrebuildAsync, recordPrebuild, runPrebuild } from '../engine/prebuild.ts';

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
  test.each([planPrebuild, planPrebuildAsync])(
    'prebuild planning compares the recorded fingerprint and refuses a git-tracked or unreadable checkout',
    async (planner) => {
      process.env.STIM_HOME = join(root, 'stim-home');
      try {
        mkdirSync(join(root, 'ios'), { recursive: true });
        writeFileSync(join(root, 'ios', 'Podfile'), '');
        const plan = (fingerprint: string) =>
          planner(root, 'ios', {
            isExpo: true,
            fingerprint,
            sources: [{ type: 'dir', filePath: 'ios', reasons: ['bareNativeDir'], hash: null }],
          });
        expect(await plan('abc')).toBe('regenerate');
        recordPrebuild(root, 'ios', 'abc');
        recordPrebuild(root, 'android', 'def');
        expect(await plan('abc')).toBe('none');
        expect(await plan('abd')).toBe('regenerate');

        writeFileSync(join(root, '.git'), 'gitdir: /nonexistent/stim-broken-worktree\n');
        expect(await plan('abd')).toBe('refuse');
        rmSync(join(root, '.git'));

        execFileSync('git', ['init', '-q', root]);
        execFileSync('git', ['-C', root, 'add', 'ios/Podfile']);
        expect(await plan('abd')).toBe('refuse');
      } finally {
        delete process.env.STIM_HOME;
      }
    },
  );
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
  test.each([
    ['57.0.26', false, ['--no-clean']],
    ['56.1.16', false, []],
    ['57.0.26', true, ['--clean']],
  ])('a prebuild over an existing ios/ with expo %s and clean %s', async (version, clean, extra) => {
    installFakeExpoBin();
    mkdirSync(join(root, 'node_modules', 'expo'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'expo', 'package.json'), JSON.stringify({ name: 'expo', version }));
    mkdirSync(join(root, 'ios'), { recursive: true });
    const spawnCalls: SpawnCall[] = [];
    const result = await runPrebuild(root, 'ios', collectingWriter(), {
      isExpo: true,
      clean,
      spawnFn: (cmd, args, opts) => {
        spawnCalls.push({ cmd, args, opts });
        return fakeExpoChild({ lines: ['Error: [ios.dangerous]: withIosDangerousBaseMod'], code: 1 });
      },
    });
    expect(spawnCalls[0]?.args).toEqual(['prebuild', '-p', 'ios', '--no-install', ...extra]);
    expect(result.failed).toBe(true);
    expect(result.remedy ?? '').toMatch(clean ? /^$/ : /delete ios\/ and run again/);
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
});
