import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testContext } from './_context.ts';
import { writeNativeXcodeProject } from './_native-xcode-project.ts';
import { nativeXcodeInputSnapshot } from '../integrations/native-xcode-inputs.ts';
import { selectNativeXcodeProject } from '../integrations/native-xcode-project.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { makeExecutor } from './_factories.ts';

let scratch: string;
let root: string;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'stim-xcode-input-context-')));
  root = join(scratch, 'app');
  mkdirSync(root);
  writeNativeXcodeProject(root);
});

afterEach(() => {
  resetExecutor();
  rmSync(scratch, { recursive: true, force: true });
});

async function snapshot(env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  const context = testContext({ home: join(scratch, 'home'), env, ...(signal ? { signal } : {}) });
  await Promise.resolve();
  return nativeXcodeInputSnapshot(
    root,
    selectNativeXcodeProject(root),
    {
      sdk: 'iphonesimulator',
      architecture: 'arm64',
      toolchain: { xcode: 'Xcode 26.0 build 17A', sdk: '26.0' },
      optimizations: {},
    },
    context.env,
    root,
    context.signal,
  );
}

test('concurrent operations fingerprint their own compiler flags without changing the host environment', async () => {
  const hostFlags = process.env.CFLAGS;
  const [alpha, beta] = await Promise.all([snapshot({ CFLAGS: '-DALPHA' }), snapshot({ CFLAGS: '-DBETA' })]);
  expect(alpha).toHaveProperty('hash');
  expect(beta).toHaveProperty('hash');
  expect(beta).not.toEqual(alpha);
  expect(await snapshot({ CFLAGS: '-DALPHA' })).toEqual(alpha);
  expect(process.env.CFLAGS).toBe(hostFlags);
});

test('a caller compiler override refuses reuse without contaminating another operation', async () => {
  const [overridden, ordinary] = await Promise.all([snapshot({ CC: '/client/clang' }), snapshot({})]);
  expect(overridden).toMatchObject({ cacheIneligible: expect.stringContaining('Environment CC') });
  expect(ordinary).toHaveProperty('hash');
});

test('caller configuration and include variables select the files that invalidate its cache', async () => {
  const config = join(scratch, 'Override.xcconfig');
  const alpha = join(scratch, 'Alpha.xcconfig');
  const beta = join(scratch, 'Beta.xcconfig');
  writeFileSync(config, '#include "$(CLIENT_CONFIG)"\n');
  writeFileSync(alpha, 'SWIFT_VERSION = 5.0\n');
  writeFileSync(beta, 'SWIFT_VERSION = 6.0\n');
  const env = { XCODE_XCCONFIG_FILE: config, CLIENT_CONFIG: alpha };
  const before = await snapshot(env);
  expect(before).toHaveProperty('hash');
  writeFileSync(beta, 'SWIFT_VERSION = 6.1\n');
  expect(await snapshot(env)).toEqual(before);
  writeFileSync(alpha, 'SWIFT_VERSION = 5.1\n');
  expect(await snapshot(env)).not.toEqual(before);
});

test('a pending Git input scan yields to other work and abort awaits only its owned child', async () => {
  mkdirSync(join(root, '.git'));
  const executor = getExecutor();
  const controller = new AbortController();
  const reason = new Error('cancel this input scan');
  let child: ChildProcess | undefined;
  setExecutor(
    makeExecutor({
      runFileAsync: (file, args, options) => {
        if (file !== 'git') return executor.runFileAsync(file, args, options);
        return executor.runFileAsync(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
          ...options,
          onSpawn(spawned) {
            child = spawned;
            options.onSpawn?.(spawned);
          },
        });
      },
    }),
  );
  const pending = snapshot({}, controller.signal);
  const result = pending.catch((error) => error);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(child).toBeDefined();
    expect(child?.exitCode).toBeNull();
    expect(await snapshot({}, AbortSignal.abort(new Error('another operation'))).catch((error) => error.message)).toBe(
      'another operation',
    );
    expect(child?.killed).toBe(false);
    controller.abort(reason);
    expect(await result).toBe(reason);
    expect(child?.signalCode).toBe('SIGKILL');
  } finally {
    controller.abort(reason);
    await pending.catch(() => {});
  }
});

test('each Git input scan uses its caller excludes without inheriting another operation environment', async () => {
  const executor = getExecutor();
  executor.runFile('git', ['-C', root, 'init', '-q'], { timeoutMs: 10_000 });
  const ignored = join(root, 'unreferenced.txt');
  const excludes = join(scratch, 'excludes');
  writeFileSync(excludes, 'unreferenced.txt\n');
  writeFileSync(ignored, 'first');
  const alpha = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: excludes };
  const beta = { GIT_CONFIG_COUNT: '0' };
  const [beforeAlpha, beforeBeta] = await Promise.all([snapshot(alpha), snapshot(beta)]);
  expect(beforeAlpha).toHaveProperty('hash');
  expect(beforeBeta).toHaveProperty('hash');
  writeFileSync(ignored, 'changed');
  const [afterAlpha, afterBeta] = await Promise.all([snapshot(alpha), snapshot(beta)]);
  expect(afterAlpha).toEqual(beforeAlpha);
  expect(afterBeta).not.toEqual(beforeBeta);
});
