import assert from 'node:assert';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceName } from '@stim-cli/core';
import { readClaimSet, releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { operationState } from '../engine/operation-state.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';
import { testContext } from './_context.ts';
import { acquireWarmClaim } from '../engine/warm-claim.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import {
  PREBUILD_ERROR,
  planPrebuild,
  planPrebuildAsync,
  planUnfingerprintedPrebuild,
  nativeDirCarry,
  prebuildPlanRefusal,
  prebuildRecordStatus,
  recordPrebuild,
  runPrebuild,
} from '../engine/prebuild.ts';
import { makeChildProcess, makeWriter } from './_factories.ts';
import { FINGERPRINT_SCHEMA } from '../fingerprint/key.ts';
import { writeWorkspaceState } from '../workspace/workspace-state.ts';

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
        const plan = (fingerprint: string, hash: string | null = null) =>
          planner(root, 'ios', {
            isExpo: true,
            fingerprint,
            native: hash ? 'tracked' : 'generated',
          });
        expect(await plan('abc')).toBe('regenerate');
        expect(await plan('abc', 'native-directory-hash')).toBe('none');
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

test('an uncertain key never regenerates existing generated native files', async () => {
  execFileSync('git', ['init', '-q', root]);
  expect(await planUnfingerprintedPrebuild(root, 'ios', true)).toBe('generate');
  mkdirSync(join(root, 'ios'));
  writeFileSync(join(root, 'ios', 'Podfile'), '');
  expect(await planUnfingerprintedPrebuild(root, 'ios', true)).toBe('refuse');
  execFileSync('git', ['-C', root, 'add', 'ios/Podfile']);
  expect(await planUnfingerprintedPrebuild(root, 'ios', true)).toBe('none');
  expect(await planUnfingerprintedPrebuild(root, 'ios', false)).toBe('none');
});

test.skipIf(process.platform === 'win32')(
  'an uncertain key recognizes tracked native files through a checkout alias',
  async () => {
    const alias = `${root}-alias`;
    try {
      execFileSync('git', ['init', '-q', root]);
      mkdirSync(join(root, 'ios'));
      writeFileSync(join(root, 'ios', 'Podfile'), '');
      execFileSync('git', ['-C', root, 'add', 'ios/Podfile']);
      symlinkSync(root, alias);
      expect(await planUnfingerprintedPrebuild(alias, 'ios', true)).toBe('none');
    } finally {
      rmSync(alias, { force: true });
    }
  },
);

test('an uncertain key refuses an existing native directory outside Git', async () => {
  mkdirSync(join(root, 'ios'));
  expect(await planUnfingerprintedPrebuild(root, 'ios', true)).toBe('refuse');
});

test('unverified Git cleanup refuses prebuild instead of treating tracking as unknown', async () => {
  const failure = Object.assign(new Error('Git cleanup unverified'), {
    code: 'STIM_CLAIM_UNAVAILABLE',
    reportCleanup: true,
  });
  setExecutor({
    ...getExecutor(),
    runFileAsync: async () => {
      throw failure;
    },
  });
  try {
    await expect(planUnfingerprintedPrebuild(root, 'ios', true, new AbortController().signal)).rejects.toBe(failure);
  } finally {
    resetExecutor();
  }
});

test('warm carry does not wait on a source native-run owner', async () => {
  const home = join(root, 'home');
  const claimRoot = join(home, 'workspaces', workspaceName(root), 'native-run.lock');
  const acquired = tryAcquireClaim({ root: claimRoot, mode: 'exclusive' });
  assert(acquired.acquired);
  try {
    const operation = testContext({ home, projectRoot: root });
    const result = await nativeDirCarry(root, 'ios', operation);
    expect(result).toMatchObject({ reason: expect.stringContaining('busy or unresolved') });
  } finally {
    releaseClaim(acquired.acquired);
  }
});

test('independent unresolved source checks retain both transferred native claims', async () => {
  const home = join(root, 'home');
  const apps = ['one', 'two'].map((name) => join(root, name));
  for (const app of apps) mkdirSync(app);
  const operation = testContext({ home, projectRoot: root });
  const releases: ((failures: readonly unknown[]) => void)[] = [];
  await Promise.all(apps.map((app) => nativeDirCarry(app, 'ios', operation, (release) => releases.push(release))));
  const claims = [...operationState(operation).declaring];
  expect(claims).toHaveLength(2);
  const failures = claims.map((claim) => new WorkspaceProcessCleanupError([claim], 'Unverified cleanup', 'Inspect.'));
  try {
    for (const release of releases) release(failures);
    for (const claim of claims)
      expect(readClaimSet(claim.root).live.some((entry) => entry.claimId === claim.claimId)).toBe(true);
  } finally {
    for (const claim of claims) releaseClaim(claim);
  }
});

test('warm carry skips while a build holding native-run waits for the warm claim', async () => {
  const previousHome = process.env.STIM_HOME;
  const home = join(root, 'home');
  process.env.STIM_HOME = home;
  const warm = await acquireWarmClaim({ repositoryRoot: root, phase: 'refresh' });
  const native = tryAcquireClaim({
    root: join(home, 'workspaces', workspaceName(root), 'native-run.lock'),
    mode: 'exclusive',
  }).acquired;
  assert(native);
  let resume!: () => void;
  let waiting!: () => void;
  const waitStarted = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const blocked = acquireWarmClaim({
    repositoryRoot: root,
    phase: 'refresh',
    sleep: () =>
      new Promise<void>((resolve) => {
        resume = resolve;
        waiting();
      }),
  });
  try {
    await Promise.race([
      waitStarted,
      blocked.then(() => {
        throw new Error('warm claim did not wait');
      }),
    ]);
    expect(await nativeDirCarry(root, 'ios', testContext({ home, projectRoot: root }))).toMatchObject({
      reason: expect.stringContaining('busy or unresolved'),
    });
    warm.release();
    resume();
    const acquired = await blocked;
    acquired.release();
  } finally {
    warm.release();
    resume?.();
    try {
      (await blocked).release();
    } finally {
      releaseClaim(native);
      if (previousHome === undefined) delete process.env.STIM_HOME;
      else process.env.STIM_HOME = previousHome;
    }
  }
});

test('a foreign record refuses until its generated directory is moved aside and rebuilt', async () => {
  process.env.STIM_HOME = join(root, 'stim-home');
  try {
    mkdirSync(join(root, 'ios'));
    writeWorkspaceState(root, { prebuild: { ios: 'legacy-fingerprint' } });
    const options = { isExpo: true, fingerprint: 'new-fingerprint', native: 'generated' as const };
    expect(await planPrebuildAsync(root, 'ios', options)).toBe('refuse');
    expect(await planPrebuildAsync(root, 'ios', { ...options, native: 'tracked' })).toBe('none');
    expect(prebuildPlanRefusal(root, 'ios').remedy).toContain('move or remove ios/');
    rmSync(join(root, 'ios'), { recursive: true });
    expect(await planPrebuildAsync(root, 'ios', { ...options, native: 'tracked' })).toBe('refuse');
    expect(await planPrebuildAsync(root, 'ios', options)).toBe('generate');
    mkdirSync(join(root, 'ios'));
    recordPrebuild(root, 'ios', 'new-fingerprint');
    expect(await planPrebuildAsync(root, 'ios', options)).toBe('none');
  } finally {
    delete process.env.STIM_HOME;
  }
});

describe('the prebuild record', () => {
  test.each([
    ['an unfinished prebuild', null, null, { kind: 'unfinished' }],
    ['no record', undefined, null, { kind: 'unrecorded' }],
    ['a legacy record', 'abc', 'abc', { kind: 'foreign' }],
    ['another schema', { schema: FINGERPRINT_SCHEMA + 1, hash: 'abc' }, 'abc', { kind: 'foreign' }],
    [
      'a record equal to the fingerprint',
      { schema: FINGERPRINT_SCHEMA, hash: 'abc' },
      'abc',
      { kind: 'current', generatedFrom: 'abc' },
    ],
    [
      'a record of another fingerprint',
      { schema: FINGERPRINT_SCHEMA, hash: 'abc' },
      'abd',
      { kind: 'moved', recorded: 'abc', current: 'abd' },
    ],
    [
      'a fingerprint that could not be computed',
      { schema: FINGERPRINT_SCHEMA, hash: 'abc' },
      null,
      { kind: 'unfingerprintable', recorded: 'abc' },
    ],
  ])('%s', (_name, recorded, current, status) => {
    expect(prebuildRecordStatus(recorded, current)).toEqual(status);
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
});
