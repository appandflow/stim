import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { readFingerprint, runFingerprintVerification } from '../fingerprint-precompute.ts';
import { fingerprintPendingVerifyDir } from '@stim-cli/core/state';
import { writeWorkspaceEnv } from '../fingerprint/index-store.ts';
import { workspaceEnv } from '../fingerprint/env.ts';
import { captureProcessIdentity, inspectProcessIdentity } from '../process-identity.ts';
import { runReport } from '../report-runtime.ts';
import { reactNativeProjectDoctor } from '../integrations/react-native-doctor.ts';
import { testContext } from './_context.ts';
import { makeChildProcess } from './_factories.ts';
import { fingerprint, fingerprintRuntime, type EvalUncertain, type Fingerprint } from '../fingerprint/evaluate.ts';
import { fingerprintOffloadInputs } from '../fingerprint/operation.ts';
import { isUncertain } from '../fingerprint/key.ts';
import { withAmbientContext, workspaceName } from '@stim-cli/core';
import { NATIVE_RUN_LOCK } from '../engine/native-run.ts';
import { workspaceProcessLockPath } from '../engine/workspace-process-lock.ts';
import { readClaimSet, releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';

const MOBILE_MODULES = fileURLToPath(new URL('../../../../apps/mobile/node_modules', import.meta.url));
const SLOW = { timeout: 120_000 };
const temps: string[] = [];
let spawned: string[][] = [];

beforeEach(() => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-eval-home-')));
  temps.push(home);
  process.env.STIM_HOME = home;
});

afterEach(() => {
  delete process.env.STIM_HOME;
  resetExecutor();
  spawned = [];
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/**
 * A CNG Expo app outside any git work tree that installs nothing of its own: its node_modules is apps/mobile's, so
 * the evaluators run the Expo SDK, autolinking and expo-constants this repository installs.
 */
function expoApp(files: Record<string, string>, dependencies = ['expo', 'expo-constants', 'react-native']): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-eval-')));
  temps.push(root);
  const manifest = {
    name: 'fp-app',
    version: '1.0.0',
    dependencies: Object.fromEntries(dependencies.map((name) => [name, '*'])),
  };
  write(join(root, 'package.json'), JSON.stringify(manifest));
  write(join(root, 'pnpm-lock.yaml'), readFileSync(join(MOBILE_MODULES, '..', '..', '..', 'pnpm-lock.yaml'), 'utf8'));
  write(
    join(root, 'app.json'),
    JSON.stringify({ expo: { name: 'fp', slug: 'fp', ios: { config: { usesNonExemptEncryption: false } } } }),
  );
  for (const [path, text] of Object.entries(files)) write(join(root, path), text);
  symlinkSync(MOBILE_MODULES, join(root, 'node_modules'));
  return root;
}

const baseEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  STIM_HOME: process.env.STIM_HOME,
  ...extra,
});

function recordSpawns(): void {
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileAsync: (file, args, options) => {
      spawned.push([file, ...args]);
      return real.runFileAsync(file, args, options);
    },
  });
}

test('evaluates with the selected operation environment and home when ambient context differs', SLOW, async () => {
  const selectedHome = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-selected-context-')));
  const selectedTemp = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-selected-temp-')));
  temps.push(selectedHome, selectedTemp);
  const observation = join(selectedHome, 'observation.json');
  const root = expoApp({
    'app.config.js': `require('node:fs').writeFileSync(${JSON.stringify(observation)}, JSON.stringify({ flag: process.env.FP_SELECTED, cwd: process.cwd() })); module.exports = { expo: { name: 'fp', slug: 'fp' } };`,
  });
  const env = baseEnv({ STIM_HOME: selectedHome, STIM_TMPDIR: selectedTemp, FP_SELECTED: 'selected' });
  const selected = testContext({ home: selectedHome, projectRoot: root, cwd: root, env });
  const ambient = testContext({ env: baseEnv({ FP_SELECTED: 'ambient' }) });
  let result;
  try {
    result = await withAmbientContext(ambient, () =>
      fingerprint(root, { platform: 'ios' }, { env, operation: selected, embedMode: 'development' }),
    );
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'reportCleanup' in error)
      for (const path of [root, selectedHome, selectedTemp]) {
        const index = temps.indexOf(path);
        if (index >= 0) temps.splice(index, 1);
      }
    throw error;
  }
  expect(isUncertain(result)).toBe(false);
  expect(JSON.parse(readFileSync(observation, 'utf8'))).toEqual({ flag: 'selected', cwd: root });
  expect(existsSync(join(selectedHome, 'fingerprint'))).toBe(true);
  expect(readdirSync(selectedTemp)).toEqual([]);
});

test('honors an operation cancellation when no separate fingerprint signal is supplied', SLOW, async () => {
  const root = expoApp({});
  const controller = new AbortController();
  const reason = new Error('selected operation cancelled');
  const operation = testContext({ projectRoot: root, env: baseEnv(), signal: controller.signal });
  controller.abort(reason);
  await expect(
    fingerprint(root, { platform: 'ios' }, { env: operation.env, operation, embedMode: 'development' }),
  ).rejects.toBe(reason);
});

test('honors a distinct cancelled fingerprint signal before acquiring ownership', SLOW, async () => {
  const root = expoApp({});
  const controller = new AbortController();
  const reason = new Error('fingerprint cancelled');
  const operation = testContext({ projectRoot: root, env: baseEnv() });
  controller.abort(reason);
  await expect(
    fingerprint(
      root,
      { platform: 'ios' },
      { env: operation.env, operation, signal: controller.signal, embedMode: 'development' },
    ),
  ).rejects.toBe(reason);
  const lock = workspaceProcessLockPath(join(operation.home, 'workspaces', workspaceName(root)), NATIVE_RUN_LOCK, true);
  expect(readClaimSet(lock).live).toEqual([]);
});

test('honors a standalone fingerprint signal without an operation', SLOW, async () => {
  const root = expoApp({});
  const controller = new AbortController();
  const reason = new Error('standalone fingerprint cancelled');
  controller.abort(reason);
  await expect(
    fingerprint(root, { platform: 'ios' }, { env: baseEnv(), signal: controller.signal, embedMode: 'development' }),
  ).rejects.toBe(reason);
});

test('the report child uses the selected operation temp root and environment', SLOW, async () => {
  const selectedHome = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-report-home-')));
  const selectedTemp = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-report-temp-')));
  temps.push(selectedHome, selectedTemp);
  const observation = join(selectedHome, 'observation.json');
  const root = expoApp({
    'app.config.js': `require('node:fs').writeFileSync(${JSON.stringify(observation)}, JSON.stringify({ flag: process.env.FP_SELECTED, cwd: process.cwd() })); module.exports = { expo: { name: 'fp', slug: 'fp' } };`,
  });
  const env = baseEnv({ STIM_HOME: selectedHome, STIM_TMPDIR: selectedTemp, FP_SELECTED: 'selected' });
  const selected = testContext({ home: selectedHome, projectRoot: root, cwd: root, env });
  const ambient = testContext({ env: baseEnv({ FP_SELECTED: 'ambient' }) });
  const executor = getExecutor();
  let ownerDirectory = '';
  setExecutor({
    ...executor,
    runFileAsync: (file, args, options) => {
      if (options.input) ownerDirectory = JSON.parse(options.input).ownership.directory;
      return executor.runFileAsync(file, args, options);
    },
  });
  let result;
  try {
    result = await withAmbientContext(ambient, () =>
      readFingerprint(selected, { root, platform: 'ios', embedMode: 'development' }),
    );
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'reportCleanup' in error)
      for (const path of [root, selectedHome, selectedTemp]) {
        const index = temps.indexOf(path);
        if (index >= 0) temps.splice(index, 1);
      }
    throw error;
  }
  expect(result && !isUncertain(result)).toBe(true);
  expect(JSON.parse(readFileSync(observation, 'utf8'))).toEqual({ flag: 'selected', cwd: root });
  expect(dirname(ownerDirectory)).toBe(selectedTemp);
  expect(readdirSync(selectedTemp)).toEqual([]);
});

async function key(
  root: string,
  env: NodeJS.ProcessEnv,
  embedMode: 'development' | 'production' = 'development',
  platform: 'ios' | 'android' = 'ios',
): Promise<Fingerprint> {
  const result = await fingerprint(root, { platform }, { env, embedMode });
  if (isUncertain(result)) throw new Error(JSON.stringify(result, null, 2));
  return result;
}

async function refusal(root: string, env = baseEnv()): Promise<EvalUncertain> {
  const result = await fingerprint(root, { platform: 'ios' }, { env, embedMode: 'development' });
  if (!isUncertain(result)) throw new Error(`expected no key, got ${result.hash}`);
  return result;
}

const embedSpawns = () => spawned.filter((argv) => argv.includes('embed')).length;

test('a supplied environment selects the ownership home without an operation', SLOW, async () => {
  const root = expoApp({});
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-selected-home-')));
  temps.push(home);
  const lock = workspaceProcessLockPath(join(home, 'workspaces', workspaceName(root)), NATIVE_RUN_LOCK, true);
  const attempt = tryAcquireClaim({ root: lock, mode: 'exclusive' });
  if (!attempt.acquired) throw new Error('fixture did not acquire the selected home claim');
  try {
    await expect(
      fingerprint(
        root,
        { platform: 'ios' },
        {
          env: baseEnv({ STIM_HOME: home }),
          embedMode: 'development',
          index: 'skip',
        },
      ),
    ).rejects.toMatchObject({ code: 'STIM_LOCK_TIMEOUT' });
  } finally {
    releaseClaim(attempt.acquired);
  }
});

test('a clean report result after its deadline remains a timeout', async () => {
  const root = expoApp({});
  const context = testContext({ projectRoot: root, env: baseEnv() });
  let now = performance.now();
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileAsync: async (_file, _args, options) => {
      const request: { ownership: { acknowledgement: string; nonce: string } } = JSON.parse(String(options.input));
      options.onSpawn?.(makeChildProcess());
      writeFileSync(
        request.ownership.acknowledgement,
        JSON.stringify({ nonce: request.ownership.nonce, settled: true }),
      );
      now += 120_001;
      return JSON.stringify({ uncertain: 'fixture' });
    },
  });
  try {
    await expect(readFingerprint(context, { root, platform: 'ios', embedMode: 'development' })).rejects.toMatchObject({
      code: 'ETIMEDOUT',
    });
    const lock = workspaceProcessLockPath(join(context.home, 'workspaces', workspaceName(root)), NATIVE_RUN_LOCK, true);
    const claims = readClaimSet(lock);
    expect(claims.live).toEqual([]);
    expect(claims.unresolved).toEqual([]);
  } finally {
    clock.mockRestore();
  }
});

test('an unacknowledged late report retains ownership rather than returning an ordinary timeout', async () => {
  const root = expoApp({});
  const context = testContext({ projectRoot: root, env: baseEnv() });
  let now = performance.now();
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileAsync: async (_file, _args, options) => {
      const request: { ownership: { directory: string } } = JSON.parse(String(options.input));
      temps.push(request.ownership.directory);
      options.onSpawn?.(makeChildProcess());
      now += 120_001;
      return JSON.stringify({ uncertain: 'fixture' });
    },
  });
  try {
    await expect(readFingerprint(context, { root, platform: 'ios', embedMode: 'development' })).rejects.toMatchObject({
      code: 'STIM_CLAIM_UNAVAILABLE',
      reportCleanup: true,
    });
    const lock = workspaceProcessLockPath(join(context.home, 'workspaces', workspaceName(root)), NATIVE_RUN_LOCK, true);
    expect(readClaimSet(lock).live.some((claim) => claim.childDeclared)).toBe(true);
  } finally {
    clock.mockRestore();
  }
});

test.each([
  ['plain object', () => ({ reportCleanup: true, remedy: 'inspect the child' })],
  ['Error', () => Object.assign(new Error('unverified'), { reportCleanup: true, remedy: 'inspect the child' })],
] as const)('a marked %s outer cleanup failure overrides an acknowledgement', async (_kind, failure) => {
  const root = expoApp({});
  const context = testContext({ projectRoot: root, env: baseEnv() });
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileAsync: async (_file, _args, options) => {
      const request: {
        ownership: { directory: string; acknowledgement: string; nonce: string };
      } = JSON.parse(String(options.input));
      temps.push(request.ownership.directory);
      options.onSpawn?.(makeChildProcess());
      writeFileSync(
        request.ownership.acknowledgement,
        JSON.stringify({ nonce: request.ownership.nonce, settled: true }),
      );
      throw failure();
    },
  });
  await expect(readFingerprint(context, { root, platform: 'ios', embedMode: 'development' })).rejects.toMatchObject({
    code: 'STIM_CLAIM_UNAVAILABLE',
    reportCleanup: true,
  });
  const lock = workspaceProcessLockPath(join(context.home, 'workspaces', workspaceName(root)), NATIVE_RUN_LOCK, true);
  expect(readClaimSet(lock).live.some((claim) => claim.childDeclared)).toBe(true);
});

test('a verification child refuses a queued item for a different fenced workspace', SLOW, async () => {
  const first = expoApp({});
  const second = expoApp({});
  const context = testContext({ projectRoot: first, env: baseEnv() });
  const directory = fingerprintPendingVerifyDir();
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'pending.json'),
    JSON.stringify({
      root: second,
      target: { platform: 'ios' },
      embedMode: 'development',
      hash: 'a',
      inputs: [],
      envRef: { id: 'fixture', digest: 'fixture' },
    }),
  );
  expect(
    await runFingerprintVerification(context, { root: first, platform: 'ios', pendingFile: 'pending.json' }),
  ).toEqual({ verified: 0 });
  expect(readdirSync(directory)).toHaveLength(1);
  for (const root of [first, second]) {
    const lock = workspaceProcessLockPath(join(context.home, 'workspaces', workspaceName(root)), NATIVE_RUN_LOCK, true);
    expect(readClaimSet(lock).live).toEqual([]);
  }
});

test.skipIf(process.platform === 'win32')(
  'a killed verification child leaves its evaluator and exact workspace claim pending',
  { timeout: 30_000 },
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-verify-project-')));
    temps.push(root);
    const marker = join(root, 'evaluator-pid');
    write(join(root, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { 'react-native': '*' } }));
    write(
      join(root, 'node_modules/react-native/package.json'),
      JSON.stringify({ name: 'react-native', version: '0.81.0', main: 'index.js' }),
    );
    write(join(root, 'node_modules/react-native/index.js'), 'module.exports = {};');
    write(
      join(root, 'node_modules/@react-native-community/cli/package.json'),
      JSON.stringify({ name: '@react-native-community/cli', version: '1.0.0' }),
    );
    write(
      join(root, 'node_modules/@react-native-community/cli-config/package.json'),
      JSON.stringify({ name: '@react-native-community/cli-config', version: '1.0.0', main: 'index.js' }),
    );
    write(
      join(root, 'node_modules/@react-native-community/cli-config/index.js'),
      `
    exports.loadConfigAsync = () => {
      require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
      return { platforms: { ios: {} }, project: { ios: { sourceDir: 'ios' } } };
    };
  `,
    );
    const temporary = mkdtempSync(join(tmpdir(), 'stim-fp-verify-temp-'));
    temps.push(temporary);
    const previousTemporary = process.env.STIM_TMPDIR;
    process.env.STIM_TMPDIR = temporary;
    const env = baseEnv({ STIM_TMPDIR: temporary });
    const controller = new AbortController();
    const context = testContext({ projectRoot: root, env, signal: controller.signal });
    const directory = fingerprintPendingVerifyDir();
    mkdirSync(directory, { recursive: true });
    const digest = writeWorkspaceEnv(root, workspaceEnv(env));
    writeFileSync(
      join(directory, 'pending.json'),
      JSON.stringify({
        root,
        target: { platform: 'ios' },
        embedMode: 'development',
        hash: 'a'.repeat(64),
        inputs: [],
        envRef: { id: 'fixture', digest },
      }),
    );
    const real = getExecutor();
    const children: { outer: { pid: number; processToken: string } | null } = { outer: null };
    setExecutor({
      ...real,
      runFileAsync: (file, args, options) =>
        real.runFileAsync(file, args, {
          ...options,
          onSpawn: (child) => {
            options.onSpawn?.(child);
            if (args.some((arg: string) => arg.endsWith('fingerprint-precompute.mjs')) && child.pid) {
              const identity = captureProcessIdentity(child.pid);
              if (identity.ok) children.outer = { pid: child.pid, processToken: identity.token };
            }
          },
        }),
    });
    const running = runFingerprintVerification(context, { root, platform: 'ios', pendingFile: 'pending.json' });
    const settled = running.catch((error: unknown) => error);
    let evaluator: { pid: number; processToken: string } | null = null;
    let testFailure: { error: unknown } | undefined;
    try {
      const until = Date.now() + 10_000;
      while ((!children.outer || !existsSync(marker)) && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 25));
      const outer = children.outer;
      if (!outer || !existsSync(marker)) throw new Error('verification evaluator did not start');
      const pid = Number(readFileSync(marker, 'utf8'));
      const identity = captureProcessIdentity(pid);
      if (!identity.ok) throw new Error('evaluator identity unavailable');
      evaluator = { pid, processToken: identity.token };
      if (inspectProcessIdentity(outer) !== 'same') throw new Error('verification child identity changed');
      process.kill(outer.pid, 'SIGKILL');
      expect(await settled).toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true });
      expect(inspectProcessIdentity(evaluator)).toBe('same');
      const lock = workspaceProcessLockPath(
        join(context.home, 'workspaces', workspaceName(root)),
        NATIVE_RUN_LOCK,
        true,
      );
      expect(readClaimSet(lock).live).toEqual(
        expect.arrayContaining([expect.objectContaining({ childDeclared: true })]),
      );
      expect(readdirSync(directory)).toHaveLength(1);
    } catch (error) {
      testFailure = { error };
    }
    try {
      controller.abort();
      if (children.outer && inspectProcessIdentity(children.outer) === 'same')
        process.kill(children.outer.pid, 'SIGKILL');
      await settled;
      if (!evaluator && existsSync(marker)) {
        const pid = Number(readFileSync(marker, 'utf8'));
        const identity = captureProcessIdentity(pid);
        if (identity.ok) evaluator = { pid, processToken: identity.token };
        else {
          for (const path of [root, temporary, context.home]) {
            const index = temps.indexOf(path);
            if (index >= 0) temps.splice(index, 1);
          }
          throw new Error(`Could not verify evaluator cleanup; retained ${root}, ${temporary}, and ${context.home}.`);
        }
      }
      if (!evaluator) {
        for (const path of [root, temporary, context.home]) {
          const index = temps.indexOf(path);
          if (index >= 0) temps.splice(index, 1);
        }
        throw new Error(`Could not verify evaluator cleanup; retained ${root}, ${temporary}, and ${context.home}.`);
      }
      if (inspectProcessIdentity(evaluator) === 'same') process.kill(-evaluator.pid, 'SIGKILL');
      const until = Date.now() + 5000;
      while (inspectProcessIdentity(evaluator) === 'same' && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 25));
      const outerStatus = children.outer ? inspectProcessIdentity(children.outer) : 'unknown';
      if (inspectProcessIdentity(evaluator) !== 'gone' || (outerStatus !== 'gone' && outerStatus !== 'different')) {
        for (const path of [root, temporary, context.home]) {
          const index = temps.indexOf(path);
          if (index >= 0) temps.splice(index, 1);
        }
        throw new Error(`Could not verify child cleanup; retained ${root}, ${temporary}, and ${context.home}.`);
      }
    } finally {
      if (previousTemporary === undefined) delete process.env.STIM_TMPDIR;
      else process.env.STIM_TMPDIR = previousTemporary;
    }
    if (testFailure) throw testFailure.error;
  },
);

test.skipIf(process.platform === 'win32')(
  'a killed report child leaves its evaluator and workspace ownership pending',
  { timeout: 30_000 },
  async () => {
    const root = expoApp({});
    const marker = join(root, 'evaluator-pid');
    write(
      join(root, 'app.config.js'),
      `
    require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
    module.exports = { name: 'fp', slug: 'fp' };
  `,
    );
    const controller = new AbortController();
    const operation = testContext({ projectRoot: root, env: baseEnv(), signal: controller.signal });
    const real = getExecutor();
    const children: { outer: { pid: number; processToken: string } | null } = { outer: null };
    setExecutor({
      ...real,
      runFileAsync: (file, args, options) =>
        real.runFileAsync(file, args, {
          ...options,
          onSpawn: (child) => {
            options.onSpawn?.(child);
            if (args.some((arg: string) => arg.endsWith('fingerprint-precompute.mjs')) && child.pid) {
              const identity = captureProcessIdentity(child.pid);
              if (identity.ok) children.outer = { pid: child.pid, processToken: identity.token };
            }
          },
        }),
    });
    const pending = readFingerprint(operation, { root, platform: 'ios', embedMode: 'development' });
    const settled = pending.catch((error: unknown) => error);
    let evaluator: { pid: number; processToken: string } | null = null;
    try {
      const until = Date.now() + 10_000;
      while ((!children.outer || !existsSync(marker)) && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 25));
      expect(children.outer).not.toBeNull();
      expect(existsSync(marker)).toBe(true);
      const outer = children.outer;
      if (!outer) throw new Error('report child did not start');
      const pid = Number(readFileSync(marker, 'utf8'));
      const identity = captureProcessIdentity(pid);
      if (!identity.ok) throw new Error('evaluator identity unavailable');
      evaluator = { pid, processToken: identity.token };
      expect(inspectProcessIdentity(outer)).toBe('same');
      process.kill(outer.pid, 'SIGKILL');
      expect(await settled).toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true });
      expect(inspectProcessIdentity(evaluator)).toBe('same');
      const lock = workspaceProcessLockPath(
        join(operation.home, 'workspaces', workspaceName(root)),
        NATIVE_RUN_LOCK,
        true,
      );
      expect(readClaimSet(lock).live).toEqual(
        expect.arrayContaining([expect.objectContaining({ childDeclared: true })]),
      );
    } finally {
      controller.abort();
      if (children.outer && inspectProcessIdentity(children.outer) === 'same')
        process.kill(children.outer.pid, 'SIGKILL');
      if (evaluator && inspectProcessIdentity(evaluator) === 'same') process.kill(-evaluator.pid, 'SIGKILL');
      await settled;
      if (evaluator) {
        const until = Date.now() + 5000;
        while (inspectProcessIdentity(evaluator) === 'same' && Date.now() < until)
          await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(evaluator ? inspectProcessIdentity(evaluator) : null).toBe(evaluator ? 'gone' : null);
    }
  },
);

test(
  'normal doctor evaluates project config in the fingerprint child and reports unsupported options',
  SLOW,
  async () => {
    const root = expoApp({
      'fingerprint.config.js': 'module.exports = { preset: "strict" };',
    });
    const marker = join(root, 'doctor-config-ran');
    write(
      join(root, 'app.config.js'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, ''); module.exports = { name: 'fp', slug: 'fp' };`,
    );
    const operation = testContext({
      projectRoot: root,
      cwd: root,
      env: baseEnv(),
      signal: new AbortController().signal,
    });
    const doctor = reactNativeProjectDoctor(root);
    if (!doctor.inspectAsync) throw new Error('The fixture has no asynchronous doctor.');
    const findings = await doctor.inspectAsync({
      root,
      settings: {},
      repoRoot: root,
      optimizations: null,
      platforms: ['ios'],
      options: { platform: 'ios', host: 'linux', operation },
    });
    expect(existsSync(marker)).toBe(true);
    expect(findings.some((finding) => finding.detail.includes('fingerprint.config.js preset is ignored'))).toBe(true);
  },
);

test('private evaluator paths never enter the project env or change a repeated key', SLOW, async () => {
  const root = expoApp({
    'app.config.js': `
      if (process.env.STIM_FP_CONTROL !== undefined && process.env.STIM_FP_CONTROL !== 'user value') throw new Error('private evaluator paths leaked');
      module.exports = { name: 'fp', slug: 'fp', extra: { names: Object.keys(process.env).sort() } };
    `,
  });
  const options = {
    env: baseEnv({ APP_FLAG: 'stable', STIM_FP_CONTROL: 'user value' }),
    embedMode: 'development' as const,
    index: 'skip' as const,
  };
  const first = await fingerprint(root, { platform: 'ios' }, options);
  const second = await fingerprint(root, { platform: 'ios' }, options);
  expect(isUncertain(first)).toBe(false);
  expect(isUncertain(second)).toBe(false);
  if (isUncertain(first) || isUncertain(second)) throw new Error('fingerprint unavailable');
  expect(second.hash).toBe(first.hash);
});

test.skipIf(process.platform === 'win32').each(['direct', 'report-child'] as const)(
  '%s fingerprint timeout joins the evaluator descendant',
  { timeout: 30_000 },
  async (mode) => {
    const root = expoApp({});
    const marker = join(root, 'child-pid');
    write(
      join(root, 'app.config.js'),
      `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      writeFileSync(${JSON.stringify(marker)}, String(child.pid));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
      module.exports = { name: 'fp', slug: 'fp' };
    `,
    );
    const real = getExecutor();
    setExecutor({
      ...real,
      runFileAsync: (file, args, options) =>
        real.runFileAsync(file, args, {
          ...options,
          timeoutMs: args.some((arg: string) => arg.endsWith('fingerprint-precompute.mjs')) ? 'unbounded' : 6000,
        }),
    });
    const controller = new AbortController();
    const context = testContext({
      projectRoot: root,
      env: baseEnv(),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(7000)]),
    });
    const pending =
      mode === 'direct'
        ? fingerprint(
            root,
            { platform: 'ios' },
            { env: context.env, signal: context.signal, operation: context, embedMode: 'development' },
          )
        : runReport(
            context,
            (operation) => readFingerprint(operation, { root, platform: 'ios', embedMode: 'development' }),
            20_000,
          );
    let child: { pid: number; processToken: string } | null = null;
    const settled = pending.catch(() => null);
    try {
      const until = Date.now() + 5000;
      while (!existsSync(marker) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(existsSync(marker)).toBe(true);
      const pid = Number(readFileSync(marker, 'utf8'));
      const captured = captureProcessIdentity(pid);
      expect(captured.ok).toBe(true);
      if (!captured.ok) throw new Error('could not capture fixture child identity');
      child = { pid, processToken: captured.token };
      await settled;
      expect(inspectProcessIdentity(child)).toBe('gone');
    } finally {
      controller.abort();
      await settled;
      if (child && inspectProcessIdentity(child) === 'same') process.kill(child.pid, 'SIGKILL');
    }
  },
);

test('worker runtime identity changes when the resolved evaluator package changes', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-runtime-')));
  temps.push(root);
  const cli = join(root, 'node_modules', '@react-native-community', 'cli');
  const config = join(cli, 'node_modules', '@react-native-community', 'cli-config');
  write(join(cli, 'package.json'), JSON.stringify({ name: '@react-native-community/cli', version: '15.0.0' }));
  write(
    join(config, 'package.json'),
    JSON.stringify({ name: '@react-native-community/cli-config', version: '15.1.0' }),
  );
  const first = fingerprintRuntime(root, baseEnv());
  write(
    join(config, 'package.json'),
    JSON.stringify({ name: '@react-native-community/cli-config', version: '16.0.0' }),
  );
  const second = fingerprintRuntime(root, baseEnv());
  expect(first).not.toEqual(second);
});

describe.skipIf(!existsSync(MOBILE_MODULES))('fingerprint evaluators on the installed Expo SDK', () => {
  test('embedded env enumeration does not reuse the pinned prebuild config', SLOW, async () => {
    const root = expoApp({
      'app.config.js':
        "module.exports = ({ config }) => ({ ...config, extra: { ci: Object.entries(process.env).find(([key]) => key === 'CI')?.[1] ?? null } });\n",
    });
    const first = await key(root, baseEnv({ CI: 'one' }));
    const second = await key(root, baseEnv({ CI: 'two' }));
    expect(second.hash).not.toBe(first.hash);
  });

  test('embedded config that enumerates env keys app STIM_ values', SLOW, async () => {
    const root = expoApp({
      'app.config.js':
        "module.exports = ({ config }) => ({ ...config, extra: { push: Object.entries(process.env).find(([key]) => key === 'STIM_APP_PUSH')?.[1] ?? null } });\n",
    });
    const first = await key(root, baseEnv({ STIM_APP_PUSH: 'one' }));
    const second = await key(root, baseEnv({ STIM_APP_PUSH: 'two' }));
    expect(second.hash).not.toBe(first.hash);
  });

  test.skipIf(process.platform === 'win32')(
    'case-colliding inputs keep a local key but refuse offload',
    SLOW,
    async () => {
      const root = expoApp({
        'app.config.js':
          'module.exports = ({ config }) => ({ ...config, extra: { a: process.env.FP_FLAG, b: process.env.fp_flag } });\n',
      });
      const result = await key(root, baseEnv({ FP_FLAG: 'one', fp_flag: 'two' }));
      expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.portable).toBe(false);
    },
  );

  test('replay keeps a project input override instead of applying extraSources', SLOW, async () => {
    const root = expoApp({
      'fingerprint.config.js': "module.exports = { extraSources: [{ type: 'file', filePath: 'old.txt' }] };\n",
      'old.txt': 'old',
      'new.txt': 'new',
    });
    const env = baseEnv();
    const initial = await fingerprint(
      root,
      { platform: 'ios', fingerprintInputs: ['new.txt'] },
      { env, embedMode: 'development' },
    );
    if (isUncertain(initial)) throw new Error(initial.uncertain);
    const sources = initial.inputs.map(({ name, kind, hash }) => ({ id: name, kind, hash }));
    const replayed = await fingerprint(
      root,
      { platform: 'ios' },
      {
        env,
        embedMode: 'development',
        replay: { native: initial.native, sources },
      },
    );
    expect(isUncertain(replayed) ? replayed : replayed.hash).toBe(initial.hash);
  });

  test('inputs a project declares change the key', SLOW, async () => {
    const root = expoApp({
      'fingerprint.config.js':
        "module.exports = { extraSources: [{ type: 'file', filePath: 'declared.txt' }, { type: 'contents', id: 'flavor', contents: process.env.FP_DECLARED ?? '' }] };\n",
      'declared.txt': 'one',
      'listed.txt': 'one',
    });
    const compute = (env: NodeJS.ProcessEnv, fingerprintInputs?: string[]) =>
      fingerprint(root, { platform: 'ios', fingerprintInputs }, { env, embedMode: 'development' });
    const hashOf = async (result: ReturnType<typeof compute>) => {
      const value = await result;
      if (isUncertain(value)) throw new Error(value.uncertain);
      return value.hash;
    };
    const base = await hashOf(compute(baseEnv({ FP_DECLARED: 'a' })));
    expect(await hashOf(compute(baseEnv({ FP_DECLARED: 'a' })))).toBe(base);
    expect(await hashOf(compute(baseEnv({ FP_DECLARED: 'b' })))).not.toBe(base);
    write(join(root, 'declared.txt'), 'two');
    expect(await hashOf(compute(baseEnv({ FP_DECLARED: 'a' })))).not.toBe(base);
    const listed = await hashOf(compute(baseEnv(), ['listed.txt']));
    write(join(root, 'listed.txt'), 'two');
    expect(await hashOf(compute(baseEnv(), ['listed.txt']))).not.toBe(listed);
  });

  test('a copied Expo plugin callback is keyed and invalidates the evaluator index', SLOW, async () => {
    const root = expoApp({});
    const modules = join(root, 'node_modules');
    rmSync(modules);
    mkdirSync(modules);
    for (const name of readdirSync(MOBILE_MODULES))
      if (name !== '.package-lock.json' && name !== 'local-plugin')
        symlinkSync(join(MOBILE_MODULES, name), join(modules, name), 'junction');
    const dependency = join(modules, 'local-plugin');
    const plugin = join(dependency, 'app.plugin.js');
    write(join(dependency, 'package.json'), JSON.stringify({ name: 'local-plugin', version: '1.0.0' }));
    write(join(dependency, 'ios', 'Module.m'), '// unchanged native file\n');
    write(plugin, "module.exports = config => ({ ...config, mods: { ios: { dangerous: () => 'first' } } });\n");
    write(join(root, 'app.json'), JSON.stringify({ expo: { name: 'fp', slug: 'fp', plugins: ['local-plugin'] } }));
    write(join(modules, '.package-lock.json'), '{}');
    const compute = (index: 'use' | 'skip') =>
      fingerprint(root, { platform: 'ios' }, { env: baseEnv(), embedMode: 'development', index });
    const before = await compute('skip');
    const indexed = await compute('use');
    const warm = await compute('use');
    if (isUncertain(before) || isUncertain(indexed) || isUncertain(warm))
      throw new Error('The Expo plugin fixture did not produce a fingerprint.');
    expect(indexed.hash).toBe(before.hash);
    expect(warm).toMatchObject({ hash: before.hash, from: 'index' });
    write(plugin, "module.exports = config => ({ ...config, mods: { ios: { dangerous: () => 'changed' } } });\n");
    const after = await compute('skip');
    const indexedAfter = await compute('use');
    if (isUncertain(after) || isUncertain(indexedAfter)) throw new Error('The plugin edit produced no fingerprint.');
    expect(after.hash).not.toBe(before.hash);
    expect(indexedAfter.hash).toBe(after.hash);
  });

  test('listed-file replay ignores an unlisted file and refuses a changed listed file', SLOW, async () => {
    const root = expoApp({
      'fingerprint.config.js': "module.exports = { extraSources: [{ type: 'file', filePath: 'native-input.txt' }] };\n",
      'native-input.txt': 'before',
    });
    const env = baseEnv();
    const initial = await key(root, env);
    const sources = initial.inputs.map(({ name, kind, hash }) => ({ id: name, kind, hash }));
    write(join(root, 'unlisted.txt'), 'worker-only');
    const replay = () =>
      fingerprint(
        root,
        { platform: 'ios' },
        {
          env,
          embedMode: 'development',
          replay: { native: initial.native, sources },
        },
      );
    const same = await replay();
    expect(isUncertain(same) ? same : same.hash).toBe(initial.hash);
    write(join(root, 'native-input.txt'), 'changed');
    expect(isUncertain(await replay())).toBe(true);
  });

  test('a nested package env path keeps a local key but is not portable to a worker', SLOW, async () => {
    const root = expoApp({
      'app.config.js':
        'module.exports = ({ config }) => ({ ...config, extra: { nativePath: process.env.NATIVE_PATH } });\n',
    });
    const modules = join(root, 'node_modules');
    rmSync(modules);
    mkdirSync(modules);
    for (const name of ['expo', 'expo-constants', 'react-native'])
      symlinkSync(join(MOBILE_MODULES, name), join(modules, name));
    write(join(modules, 'dual', 'package.json'), JSON.stringify({ name: 'dual', version: '1.0.0' }));
    const nested = join(modules, 'owner', 'node_modules', 'dual');
    write(join(nested, 'package.json'), JSON.stringify({ name: 'dual', version: '2.0.0' }));
    write(join(nested, 'native.dat'), 'nested native content');
    const result = await key(root, baseEnv({ NATIVE_PATH: join(nested, 'native.dat') }));
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.portable).toBe(false);
  });

  test('a Terminal-shaped and a CI-shaped shell give one key, and no evaluator reaches npx', SLOW, async () => {
    const root = expoApp({
      'app.config.js': "module.exports = ({ config }) => ({ ...config, extra: { route: '/tmp' } });\n",
    });
    const trap = join(root, 'trap');
    write(join(trap, 'npx'), `#!/bin/sh\ntouch "${join(trap, 'ran')}"\nexit 1\n`);
    chmodSync(join(trap, 'npx'), 0o755);
    const path = [trap, process.env.PATH].join(delimiter);
    recordSpawns();
    const terminal = await key(
      root,
      baseEnv({
        PATH: path,
        HOME: '/Users/someone',
        USER: 'someone',
        SHELL: '/bin/zsh',
        TERM: 'xterm-256color',
        TERM_PROGRAM: 'Apple_Terminal',
        COLORTERM: 'truecolor',
        LANG: 'en_US.UTF-8',
        TMPDIR: '/var/folders/x/T/',
        SHLVL: '2',
        SSH_AUTH_SOCK: '/private/tmp/agent',
      }),
    );
    const ci = await key(
      root,
      baseEnv({
        PATH: [trap, '/usr/local/bin', process.env.PATH].join(delimiter),
        HOME: '/home/runner',
        USER: 'runner',
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        RUNNER_OS: 'Linux',
        LANG: 'C.UTF-8',
        NO_COLOR: '1',
        DEBUG: 'expo:*',
      }),
    );
    expect(ci.hash).toBe(terminal.hash);
    expect(terminal.native).toBe('generated');
    expect(terminal.portable).toBe(true);
    expect(terminal.nativePackages).toEqual(expect.arrayContaining(['expo', 'expo-constants']));
    expect(existsSync(join(trap, 'ran'))).toBe(false);
    expect(spawned.length).toBeGreaterThan(0);
    for (const [file, ...args] of spawned) {
      expect(file).toMatch(/[\\/]node(?:\.exe)?$/);
      expect(args.join(' ')).not.toMatch(/\bnpx\b/);
    }
  });

  test(
    "the embedded config follows the build env's NODE_ENV, as the installed expo-constants loads .env",
    SLOW,
    async () => {
      const root = expoApp({
        'app.config.js':
          "module.exports = ({ config }) => ({ ...config, extra: { api: process.env.NODE_ENV === 'development' ? process.env.DEV_API : process.env.API, push: process.env.STIM_APP_PUSH ?? null } });\n",
        '.env.production': 'API=one\n',
      });
      recordSpawns();
      const debug = await key(root, baseEnv({ API: 'p1' }));
      expect(embedSpawns()).toBe(1);
      expect((await key(root, baseEnv({ API: 'p2' }))).hash).not.toBe(debug.hash);
      expect((await key(root, baseEnv({ API: 'p1', STIM_APP_PUSH: '1' }))).hash).not.toBe(debug.hash);
      const release = await key(root, baseEnv(), 'production');
      const nodeEnvRelease = await key(root, baseEnv({ NODE_ENV: 'production' }), 'production');
      write(join(root, '.env.production'), 'API=two\n');
      expect((await key(root, baseEnv({ API: 'p1' }))).hash).toBe(debug.hash);
      const byMode = readFileSync(
        join(MOBILE_MODULES, 'expo-constants', 'scripts', 'getAppConfig.js'),
        'utf8',
      ).includes('loadProjectEnv');
      expect((await key(root, baseEnv(), 'production')).hash === release.hash).toBe(!byMode);
      expect((await key(root, baseEnv({ NODE_ENV: 'production' }), 'production')).hash).not.toBe(nodeEnvRelease.hash);
    },
  );

  test.each([
    { name: 'absent credential', code: 'process.env.STIM_ACCESS_TICKET', present: false, refused: false },
    { name: 'unread credential', code: "'constant'", present: true, refused: false },
    { name: 'read credential', code: 'process.env.STIM_ACCESS_TICKET', present: true, refused: true },
    { name: 'enumerated credential', code: 'Object.keys(process.env).length', present: true, refused: true },
  ])('embedded config handles an $name without persisting its value', SLOW, async ({ code, present, refused }) => {
    const secret = 'private-fingerprint-fixture-value';
    const root = expoApp({
      'app.config.js': `module.exports = ({ config }) => ({ ...config, extra: { value: ${code} } });\n`,
    });
    const env = baseEnv(present ? { STIM_ACCESS_TICKET: secret } : {});
    const result = await fingerprint(root, { platform: 'ios' }, { env, embedMode: 'development', index: 'use' });
    expect(isUncertain(result)).toBe(refused);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(isUncertain(result) ? result.uncertain : '').toContain(refused ? 'private Stim credential' : '');
    const home = process.env.STIM_HOME;
    if (!home) throw new Error('The fixture has no Stim home.');
    const files = readdirSync(home, { recursive: true });
    const contents = files
      .map((file) => join(home, String(file)))
      .filter((path) => statSync(path).isFile())
      .map((path) => readFileSync(path, 'utf8'));
    expect(contents.join('\n')).not.toContain(secret);
    const pending = fingerprintPendingVerifyDir();
    expect(refused && existsSync(pending) ? readdirSync(pending) : []).toEqual([]);
    expect(refused && existsSync(join(home, 'fingerprint', 'ios'))).toBe(false);
  });

  test(
    'package.json read by the config moves no key, and a workspace native package is keyed by content',
    SLOW,
    async () => {
      const mono = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-mono-')));
      temps.push(mono);
      const root = join(mono, 'apps', 'app');
      write(join(mono, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
      write(join(root, 'app.json'), JSON.stringify({ expo: { name: 'fp', slug: 'fp' } }));
      write(
        join(root, 'app.config.js'),
        "module.exports = ({ config }) => ({ ...config, extra: { name: require('./package.json').name } });\n",
      );
      const manifest = (version: string) =>
        JSON.stringify({
          name: 'fp-app',
          version,
          dependencies: { expo: '*', 'expo-constants': '*', 'react-native': '*', 'native-lib': '*' },
        });
      write(join(root, 'package.json'), manifest('1.0.0'));
      const lib = join(mono, 'packages', 'native-lib');
      write(join(lib, 'package.json'), JSON.stringify({ name: 'native-lib', version: '1.0.0' }));
      write(
        join(lib, 'expo-module.config.json'),
        JSON.stringify({ platforms: ['apple'], apple: { modules: ['NativeLibModule'] } }),
      );
      write(join(lib, 'ios', 'NativeLib.podspec'), "Pod::Spec.new do |s|\n  s.name = 'NativeLib'\nend\n");
      write(join(lib, 'ios', 'NativeLibModule.swift'), '// one\n');
      const modules = join(root, 'node_modules');
      mkdirSync(modules);
      for (const name of readdirSync(MOBILE_MODULES)) symlinkSync(join(MOBILE_MODULES, name), join(modules, name));
      symlinkSync(lib, join(modules, 'native-lib'));
      const before = await key(root, baseEnv());
      expect(before.nativePackages).toContain('native-lib');
      write(join(root, 'package.json'), manifest('2.0.0'));
      expect((await key(root, baseEnv())).hash).toBe(before.hash);
      write(join(lib, 'ios', 'NativeLibModule.swift'), '// two\n');
      expect((await key(root, baseEnv())).hash).not.toBe(before.hash);
    },
  );

  test('EAS_BUILD evaluates the config in production mode, so .env.production moves the Debug key', SLOW, async () => {
    const root = expoApp({
      'app.config.js':
        'module.exports = ({ config }) => ({ ...config, extra: { label: process.env.LABEL ?? null } });\n',
      '.env.production': 'LABEL=one\n',
    });
    const eas = baseEnv({ EAS_BUILD: 'true' });
    const before = await key(root, eas);
    expect(before.config?.extra).toEqual({ label: 'one' });
    write(join(root, '.env.production'), 'LABEL=two\n');
    expect((await key(root, eas)).hash).not.toBe(before.hash);
    expect((await key(root, baseEnv())).config?.extra).not.toEqual({ label: 'two' });
  });

  test(
    'a config branching on CI keys a Release build by the build env, which the pins do not reach',
    SLOW,
    async () => {
      const root = expoApp({
        'app.config.js': 'module.exports = ({ config }) => ({ ...config, extra: { ci: process.env.CI ?? null } });\n',
      });
      const local = await key(root, baseEnv(), 'production');
      const ci = await key(root, baseEnv({ CI: '1' }), 'production');
      expect(ci.hash).not.toBe(local.hash);
    },
  );

  test(
    'a config that spawns a child keys no unrelated env, and one reading a build script path name keys it once',
    SLOW,
    async () => {
      const root = expoApp({
        'app.config.js': [
          "const { execFileSync } = require('node:child_process');",
          "execFileSync(process.execPath, ['-e', '0']);",
          'module.exports = ({ config }) => ({ ...config, extra: { hermes: process.env.HERMES_ENGINE_TARBALL_PATH ?? null } });',
          '',
        ].join('\n'),
      });
      const tarball = join(root, 'hermes.tar.gz');
      write(tarball, 'tarball');
      const first = await key(root, baseEnv({ HERMES_ENGINE_TARBALL_PATH: tarball, ITERM_SESSION_ID: 'w0t0' }));
      expect(first.opaque).toEqual(expect.arrayContaining([expect.stringContaining('child_process')]));
      expect((await key(root, baseEnv({ HERMES_ENGINE_TARBALL_PATH: tarball, SOME_TAB: 'w1t3' }))).hash).toBe(
        first.hash,
      );
    },
  );

  test('a file the config only probes for is keyed', SLOW, async () => {
    const root = expoApp({
      'app.config.js': "require('node:fs').existsSync('./flag');\nmodule.exports = ({ config }) => config;\n",
    });
    const before = await key(root, baseEnv());
    write(join(root, 'flag'), '');
    expect((await key(root, baseEnv())).hash).not.toBe(before.hash);
  });

  test(
    'a file outside the app that the config names by a relative path is hashed, and an installed one keys its package',
    SLOW,
    async () => {
      const outside = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-outside-')));
      temps.push(outside);
      const plist = join(outside, 'GoogleService-Info.plist');
      write(plist, 'one');
      const root = expoApp({});
      write(
        join(root, 'app.config.js'),
        `module.exports = ({ config }) => ({ ...config, ios: { ...config.ios, googleServicesFile: ${JSON.stringify(relative(root, plist))} }, extra: { messages: require.resolve('@lingui/core/package.json') } });\n`,
      );
      const before = await key(root, baseEnv());
      expect(before.portable).toBe(false);
      expect(before.inputs.map((input) => input.name)).toContain('package:@lingui/core');
      write(plist, 'two');
      expect((await key(root, baseEnv())).hash).not.toBe(before.hash);
    },
  );

  test('a config that throws yields no key, naming the evaluator and its stderr', SLOW, async () => {
    const root = expoApp({ 'app.config.js': "throw new Error('config exploded');\n" });
    const result = await refusal(root);
    expect(result.evaluator).toBe('config');
    expect(result.uncertain).toMatch(/exited 1/);
    expect(result.stderrTail?.join('\n')).toContain('config exploded');
    expect(result.remedy).toBeTruthy();
  });

  test('autolinking output without the expo module yields no key', SLOW, async () => {
    const root = expoApp({}, []);
    const result = await refusal(root);
    expect(result.evaluator).toBe('expoAutolinking');
  });
});

/** A bare app whose community CLI is a stand-in exporting only the sync `loadConfig`, under pnpm's isolated layout. */
function bareApp(platforms: Record<string, unknown>, project: Record<string, unknown>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-bare-')));
  temps.push(root);
  write(join(root, 'package.json'), JSON.stringify({ name: 'bare', version: '1.0.0' }));
  write(join(root, 'package-lock.json'), '{}\n');
  const cli = join(root, 'node_modules', '@react-native-community', 'cli');
  write(join(cli, 'package.json'), JSON.stringify({ name: '@react-native-community/cli', version: '13.6.9' }));
  const config = join(cli, 'node_modules', '@react-native-community', 'cli-config');
  write(
    join(config, 'package.json'),
    JSON.stringify({ name: '@react-native-community/cli-config', version: '13.6.9', main: 'index.js' }),
  );
  write(
    join(config, 'index.js'),
    `exports.loadConfig = ({ projectRoot }) => ({ root: projectRoot, platforms: ${JSON.stringify(platforms)}, project: ${JSON.stringify(project)}, dependencies: {} });\n`,
  );
  write(join(root, 'ios', 'App', 'AppDelegate.swift'), '// app\n');
  return root;
}

const settleBareIndex = () => new Promise((resolve) => setTimeout(resolve, 2100));

describe('fingerprint evaluators on a bare React Native app', () => {
  test('a nested content module keys locally but refuses unresolvable worker replay', SLOW, async () => {
    const root = bareApp({ ios: {} }, { ios: { sourceDir: 'ios' } });
    const dependency = join(root, 'node_modules', 'container', 'node_modules', 'nested-plugin');
    const plugin = join(dependency, 'index.js');
    write(
      join(dependency, 'package.json'),
      JSON.stringify({ name: 'nested-plugin', version: '1.0.0', main: 'index.js' }),
    );
    write(join(dependency, 'ios', 'Module.m'), '// native\n');
    write(plugin, 'module.exports = () => "first";\n');
    write(join(root, 'node_modules', '.package-lock.json'), '{}');
    const config = join(
      root,
      'node_modules/@react-native-community/cli/node_modules/@react-native-community/cli-config/index.js',
    );
    write(
      config,
      `const plugin = require(${JSON.stringify(plugin)}); exports.loadConfig = ({ projectRoot }) => ({ root: projectRoot, platforms: { ios: {} }, project: { ios: { sourceDir: 'ios' } }, dependencies: { 'nested-plugin': { root: ${JSON.stringify(dependency)}, callback: plugin, platforms: { ios: {} } } } });`,
    );
    const env = baseEnv();
    const target = { platform: 'ios' as const };
    const compute = (index: 'use' | 'skip') => fingerprint(root, target, { env, embedMode: 'development', index });
    await settleBareIndex();
    const before = await compute('skip');
    const indexed = await compute('use');
    const warm = await compute('use');
    if (isUncertain(before) || isUncertain(indexed) || isUncertain(warm))
      throw new Error('The nested fixture did not produce a fingerprint.');
    expect(before.portable).toBe(false);
    expect(indexed).toMatchObject({ hash: before.hash, portable: false });
    expect(warm).toMatchObject({ hash: before.hash, portable: false, from: 'index' });
    expect(fingerprintOffloadInputs(root, target, before, env)).toMatchObject({ uncertain: expect.any(String) });
    write(plugin, 'module.exports = () => "changed";\n');
    const after = await compute('skip');
    const indexedAfter = await compute('use');
    if (isUncertain(after) || isUncertain(indexedAfter))
      throw new Error('The nested plugin edit produced no fingerprint.');
    expect(after.hash).not.toBe(before.hash);
    expect(indexedAfter).toMatchObject({ hash: after.hash, portable: false });
  });
  test(
    'a content dependency changes the full and indexed keys when its loaded plugin callback changes',
    SLOW,
    async () => {
      const root = bareApp({ ios: {} }, { ios: { sourceDir: 'ios' } });
      const dependency = join(root, 'node_modules', 'local-plugin');
      const plugin = join(dependency, 'app.plugin.js');
      write(
        join(dependency, 'package.json'),
        JSON.stringify({ name: 'local-plugin', version: '1.0.0', main: 'app.plugin.js' }),
      );
      write(join(dependency, 'ios', 'Module.m'), '// unchanged native file\n');
      write(plugin, 'module.exports = () => "first";\n');
      write(join(root, 'node_modules', '.package-lock.json'), '{}');
      const config = join(
        root,
        'node_modules/@react-native-community/cli/node_modules/@react-native-community/cli-config/index.js',
      );
      write(
        config,
        `const plugin = require(${JSON.stringify(plugin)}); exports.loadConfig = ({ projectRoot }) => ({ root: projectRoot, platforms: { ios: {} }, project: { ios: { sourceDir: 'ios' } }, dependencies: { 'local-plugin': { root: ${JSON.stringify(dependency)}, callback: plugin, platforms: { ios: {} } } } });`,
      );
      const compute = (index: 'use' | 'skip') =>
        fingerprint(root, { platform: 'ios' }, { env: baseEnv(), embedMode: 'development', index });
      await settleBareIndex();
      const before = await compute('skip');
      const indexed = await compute('use');
      const warm = await compute('use');
      if (isUncertain(before) || isUncertain(indexed) || isUncertain(warm))
        throw new Error('The fixture did not produce a fingerprint.');
      expect(indexed.hash).toBe(before.hash);
      expect(warm).toMatchObject({ hash: before.hash, from: 'index' });
      write(plugin, 'module.exports = () => "changed";\n');
      const after = await compute('skip');
      const indexedAfter = await compute('use');
      if (isUncertain(after) || isUncertain(indexedAfter)) throw new Error('The plugin edit produced no fingerprint.');
      expect(after.hash).not.toBe(before.hash);
      expect(indexedAfter.hash).toBe(after.hash);
    },
  );
  test.each(['--patch-dir "vendor patches"', "--patch-dir='vendor patches'"])(
    'full and indexed keys follow a quoted patch-package directory: %s',
    SLOW,
    async (flag) => {
      const root = bareApp({ ios: {} }, { ios: { sourceDir: 'ios' } });
      write(
        join(root, 'package.json'),
        JSON.stringify({ name: 'bare', version: '1.0.0', scripts: { postinstall: `patch-package ${flag}` } }),
      );
      const patch = join(root, 'vendor patches', 'nested', 'fixture.patch');
      write(patch, 'first patch');
      write(join(root, 'node_modules', '.package-lock.json'), '{}');
      const compute = (index: 'use' | 'skip') =>
        fingerprint(root, { platform: 'ios' }, { env: baseEnv(), embedMode: 'development', index });
      await settleBareIndex();
      const before = await compute('skip');
      const indexedBefore = await compute('use');
      const warm = await compute('use');
      if (isUncertain(before) || isUncertain(indexedBefore) || isUncertain(warm))
        throw new Error('The fixture did not produce a fingerprint.');
      expect(indexedBefore.hash).toBe(before.hash);
      expect(warm).toMatchObject({ hash: before.hash, from: 'index' });
      write(patch, 'changed patch');
      const after = await compute('skip');
      const indexedAfter = await compute('use');
      if (isUncertain(after) || isUncertain(indexedAfter)) throw new Error('The patch edit produced no fingerprint.');
      expect(after.hash).not.toBe(before.hash);
      expect(indexedAfter.hash).toBe(after.hash);
    },
  );

  test.each([
    'patch-package --patch-dir "vendor patches',
    'cd vendor && patch-package',
    'cd vendor\npatch-package --patch-dir custom-patches',
    '(patch-package --patch-dir custom-patches)',
    'patch-package --reverse',
    'patch-package --patch-dir --reverse',
    'patch-package --patch-dir "--reverse"',
    'patch-package --patch-dir vendor*',
    'patch-package --patch-dir vendor-patches>patch.log',
  ])('an unsupported patch-package invocation is uncertain: %s', SLOW, async (script) => {
    const root = bareApp({ ios: {} }, { ios: { sourceDir: 'ios' } });
    write(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'bare',
        version: '1.0.0',
        scripts: { postinstall: script },
      }),
    );
    const result = await fingerprint(root, { platform: 'ios' }, { env: baseEnv(), embedMode: 'development' });
    expect(isUncertain(result) && result.uncertain).toContain('patch-package');
  });

  test('full and indexed keys follow autolinked native source and CMake paths', SLOW, async () => {
    const root = bareApp({ ios: {} }, { ios: { sourceDir: 'ios' } });
    const dependency = join(root, 'local-module');
    const source = join(dependency, 'platforms', 'android');
    const cmake = join(dependency, 'native', 'CMakeLists.txt');
    const sibling = join(dependency, 'native', 'implementation.cpp');
    const cxx = join(dependency, 'cxx', 'CMakeLists.txt');
    const cxxSibling = join(dependency, 'cxx', 'implementation.cpp');
    const generated = join(root, 'generated-module');
    const generatedSource = join(generated, 'android', 'build', 'generated');
    write(join(dependency, 'package.json'), JSON.stringify({ name: 'local-module', version: '1.0.0' }));
    write(join(dependency, 'ios', 'Module.m'), '// ios\n');
    write(join(source, 'native.cpp'), '// first\n');
    write(cmake, '# first\n');
    write(sibling, '// first\n');
    write(cxx, '# first\n');
    write(cxxSibling, '// first\n');
    write(join(generated, 'package.json'), JSON.stringify({ name: 'generated-module', version: '1.0.0' }));
    write(join(generated, 'android', 'build.gradle'), '');
    write(join(generatedSource, 'CMakeLists.txt'), '# generated first\n');
    write(join(root, 'node_modules', '.package-lock.json'), '{}');
    const config = join(
      root,
      'node_modules/@react-native-community/cli/node_modules/@react-native-community/cli-config/index.js',
    );
    write(
      config,
      `exports.loadConfig = ({ projectRoot }) => ({ root: projectRoot, platforms: { ios: {} }, project: { ios: { sourceDir: 'ios' } }, dependencies: { 'local-module': { root: ${JSON.stringify(dependency)}, platforms: { android: { sourceDir: ${JSON.stringify(source)}, cmakeListsPath: ${JSON.stringify(cmake)}, cxxModuleCMakeListsPath: ${JSON.stringify(cxx)} } } }, 'generated-module': { root: ${JSON.stringify(generated)}, platforms: { android: { sourceDir: ${JSON.stringify(generatedSource)} } } } } });`,
    );
    const compute = (index: 'use' | 'skip') =>
      fingerprint(root, { platform: 'ios' }, { env: baseEnv(), embedMode: 'development', index });
    await settleBareIndex();
    const before = await compute('skip');
    const indexedBefore = await compute('use');
    const warm = await compute('use');
    if (isUncertain(before) || isUncertain(indexedBefore) || isUncertain(warm))
      throw new Error('The fixture did not produce a fingerprint.');
    expect(indexedBefore.hash).toBe(before.hash);
    expect(warm).toMatchObject({ hash: before.hash, from: 'index' });
    write(join(generatedSource, 'CMakeLists.txt'), '# generated changed\n');
    const afterGenerated = await compute('skip');
    const indexedGenerated = await compute('use');
    if (isUncertain(afterGenerated) || isUncertain(indexedGenerated))
      throw new Error('The generated edit produced no fingerprint.');
    expect(afterGenerated.inputs).toEqual(before.inputs);
    expect(afterGenerated.hash).toBe(before.hash);
    expect(indexedGenerated.hash).toBe(before.hash);
    write(join(source, 'native.cpp'), '// changed\n');
    const afterSource = await compute('skip');
    const indexedSource = await compute('use');
    if (isUncertain(afterSource) || isUncertain(indexedSource))
      throw new Error('The source edit produced no fingerprint.');
    expect(afterSource.hash).not.toBe(before.hash);
    expect(indexedSource.hash).toBe(afterSource.hash);
    write(cmake, '# changed\n');
    const afterCmake = await compute('skip');
    const indexedCmake = await compute('use');
    if (isUncertain(afterCmake) || isUncertain(indexedCmake))
      throw new Error('The CMake edit produced no fingerprint.');
    expect(afterCmake.hash).not.toBe(afterSource.hash);
    expect(indexedCmake.hash).toBe(afterCmake.hash);
    write(sibling, '// changed\n');
    const afterSibling = await compute('skip');
    const indexedSibling = await compute('use');
    if (isUncertain(afterSibling) || isUncertain(indexedSibling))
      throw new Error('The CMake sibling produced no fingerprint.');
    expect(afterSibling.hash).not.toBe(afterCmake.hash);
    expect(indexedSibling.hash).toBe(afterSibling.hash);
    write(cxxSibling, '// changed\n');
    const afterCxx = await compute('skip');
    const indexedCxx = await compute('use');
    if (isUncertain(afterCxx) || isUncertain(indexedCxx))
      throw new Error('The C++ module sibling produced no fingerprint.');
    expect(afterCxx.hash).not.toBe(afterSibling.hash);
    expect(indexedCxx.hash).toBe(afterCxx.hash);
  });

  test('keys the config the community CLI resolves from the app', SLOW, async () => {
    const root = bareApp({ ios: {} }, { ios: { sourceDir: 'ios' } });
    const result = await key(root, baseEnv());
    expect(result.native).toBe('tracked');
    expect(result.inputs.map((input) => input.name)).toEqual(
      expect.arrayContaining(['autolinking:rn', 'ios/App/AppDelegate.swift']),
    );
  });

  test('refuses a config without the platform, which a wrong cwd silently produces', SLOW, async () => {
    const root = bareApp({}, {});
    const result = await refusal(root);
    expect(result.evaluator).toBe('rnConfig');
    expect(result.stderrTail?.join('\n')).toMatch(/no ios platform/);
  });
});
