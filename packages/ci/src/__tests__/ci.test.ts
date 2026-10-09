import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCI, type CIOptions } from '../index.ts';
import type { StimOptions } from 'stim';
import { main } from '../cli.ts';

const lifecycle = vi.hoisted(() => ({
  create: vi.fn<(options: StimOptions) => void>(),
  run: vi.fn<(options: { signal?: AbortSignal }) => Promise<unknown>>(),
  diagnostics: vi.fn<() => Promise<unknown>>(),
  stop: vi.fn<(options: { signal: AbortSignal }) => Promise<unknown>>(),
}));
vi.mock('stim', () => ({
  createStim: (options: StimOptions) => {
    lifecycle.create(options);
    return lifecycle;
  },
}));

let root: string;
let active: string;
let options: CIOptions;

beforeEach(() => {
  lifecycle.create.mockClear();
  vi.stubEnv('GITHUB_ACTIONS', 'false');
  vi.stubEnv('RUNNER_ENVIRONMENT', '');
  vi.stubEnv('STIM_HOME', undefined);
  vi.stubEnv('STIM_BUILD_CACHE', undefined);
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-ci-lifecycle-')));
  active = join(root, 'native-session');
  options = {
    projectRoot: root,
    artifactsDir: join(root, 'artifacts'),
    run: { platform: 'ios' },
    command: [process.execPath, '-e', 'process.exitCode = 0'],
  };
  lifecycle.run.mockReset().mockImplementation(async () => {
    writeFileSync(active, 'running');
    writeFileSync(join(root, 'native.log'), 'running');
    return { platform: 'ios', facts: { udid: 'owned-device', bundleId: 'test.app', metroPort: 8181 } };
  });
  lifecycle.diagnostics.mockReset().mockImplementation(async () => ({
    directory: root,
    records: [{ message: readFileSync(join(root, 'native.log'), 'utf8') }],
  }));
  lifecycle.stop.mockReset().mockImplementation(async () => {
    rmSync(active);
    return { ok: true, outcomes: {}, summary: 'Stopped' };
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it('gives the command exact target facts and retains persisted diagnostics after cleanup', async () => {
  const cwd = process.cwd();
  const home = process.env.STIM_HOME;
  const output = join(root, 'seen.json');
  options.home = join(root, 'ci-home');
  options.command = [
    process.execPath,
    '-e',
    `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({ cwd:process.cwd(), device:process.env.STIM_CI_DEVICE_ID, app:process.env.STIM_CI_APP_ID, metro:process.env.STIM_CI_METRO_PORT, home:process.env.STIM_HOME, run:JSON.parse(fs.readFileSync(process.env.STIM_CI_RUN_RESULT,'utf8')) }));`,
  ];
  const result = await runCI(options);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({
    cwd: root,
    device: 'owned-device',
    app: 'test.app',
    metro: '8181',
    home: options.home,
    run: { platform: 'ios', facts: { udid: 'owned-device', bundleId: 'test.app', metroPort: 8181 } },
  });
  expect(JSON.parse(readFileSync(result.diagnostics.path!, 'utf8')).records).toEqual([{ message: 'running' }]);
  expect(existsSync(active)).toBe(false);
  expect(JSON.parse(readFileSync(result.resultPath, 'utf8')).exitCode).toBe(0);
  expect(process.cwd()).toBe(cwd);
  expect(process.env.STIM_HOME).toBe(home);
});

it('preserves a test failure when diagnostics and cleanup also fail', async () => {
  options.command = [process.execPath, '-e', 'process.exitCode = 23'];
  lifecycle.diagnostics.mockRejectedValue(new Error('cannot read logs'));
  lifecycle.stop.mockRejectedValue(new Error('cannot stop device'));
  const result = await runCI(options);
  expect(result.exitCode).toBe(23);
  expect(result.failure?.code).toBe('STIM_CI_TEST_FAILED');
  expect(result.diagnostics.error?.message).toBe('cannot read logs');
  expect(result.cleanup.error?.message).toBe('cannot stop device');
  expect(JSON.parse(readFileSync(result.resultPath, 'utf8')).exitCode).toBe(23);
});

it('reports a missing test executable as exit code 1 in the result and saved JSON', async () => {
  options.command = [join(root, 'missing-executable')];
  const result = await runCI(options);
  expect(result.exitCode).toBe(1);
  expect(result.failure?.code).toBe('STIM_CI_TEST_FAILED');
  expect(result.test?.error).toContain('ENOENT');
  expect(JSON.parse(readFileSync(result.resultPath, 'utf8')).exitCode).toBe(1);
  expect(existsSync(active)).toBe(false);
});

test.skipIf(process.platform === 'win32')('preserves a command failure when output reporting also fails', async () => {
  options.command = [
    process.execPath,
    '-e',
    "process.on('SIGTERM', () => {}); console.log('test output'); setTimeout(() => process.exit(23), 100);",
  ];
  options.onProgress = () => {
    throw new Error('cannot relay output');
  };
  const result = await runCI(options);
  expect(result.test?.error).toContain('cannot relay output');
  expect(result.reportingError?.message).toBe('cannot relay output');
  expect(result.exitCode).toBe(23);
  expect(existsSync(active)).toBe(false);
});

it('preserves a test failure when the result file cannot be replaced', async () => {
  options.command = [
    process.execPath,
    '-e',
    "require('node:fs').mkdirSync(require('node:path').join(process.env.STIM_CI_ARTIFACTS_DIR, 'result.json')); process.exitCode = 23;",
  ];
  const result = await runCI(options);
  expect(result.test?.exitCode).toBe(23);
  expect(result.exitCode).toBe(23);
  expect(result.failure?.code).toBe('STIM_CI_TEST_FAILED');
  expect(result.reportingError).toBeDefined();
  expect(existsSync(active)).toBe(false);
});

it('stops partial setup without running the test command', async () => {
  lifecycle.run.mockImplementation(async () => {
    writeFileSync(active, 'partially started');
    throw Object.assign(new Error('build failed'), { code: 'STIM_BUILD_FAILED', remedy: 'Fix the build.' });
  });
  const marker = join(root, 'test-started');
  options.command = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad');`];
  const result = await runCI(options);
  expect(result.exitCode).toBe(1);
  expect(result.failure).toEqual({ code: 'STIM_BUILD_FAILED', message: 'build failed', remedy: 'Fix the build.' });
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(active)).toBe(false);
  expect(result.test).toBe(null);
});

it('turns an incomplete cleanup into a failure after a passing test', async () => {
  lifecycle.stop.mockResolvedValue({ ok: false, outcomes: {}, summary: 'Device still running' });
  const result = await runCI(options);
  expect(result.test?.exitCode).toBe(0);
  expect(result.exitCode).toBe(1);
  expect(result.failure?.code).toBe('STIM_CI_CLEANUP_FAILED');
});

it('does not touch native resources when cancelled before setup', async () => {
  const result = await runCI({ ...options, signal: AbortSignal.abort() });
  expect(result.exitCode).toBe(130);
  expect(existsSync(active)).toBe(false);
  expect(result.cleanup.result).toBe(null);
  expect(result.test).toBe(null);
});

it('refuses reused artifacts before setup so earlier evidence cannot describe a new run', async () => {
  const first = await runCI(options);
  const evidence = readFileSync(first.resultPath, 'utf8');
  lifecycle.run.mockImplementation(async () => {
    writeFileSync(active, 'should not start');
    throw new Error('a later setup failure');
  });
  await expect(runCI(options)).rejects.toThrow(/Artifacts directory must be empty/);
  expect(existsSync(active)).toBe(false);
  expect(readFileSync(first.resultPath, 'utf8')).toBe(evidence);
});

it('uses a fresh signal for cleanup after a real test process times out', async () => {
  options.command = [process.execPath, '-e', 'setInterval(() => {}, 1000)'];
  lifecycle.stop.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
    signal.throwIfAborted();
    rmSync(active);
    return { ok: true, outcomes: {}, summary: 'Stopped' };
  });
  const result = await runCI({ ...options, timeoutMs: 100 });
  expect(result.exitCode).toBe(124);
  expect(result.failure?.code).toBe('STIM_CI_TIMEOUT');
  expect(existsSync(active)).toBe(false);
  expect(result.cleanup.result?.ok).toBe(true);
});

it.each([['invalid\0'], [process.execPath, '\0'], [process.execPath, 123]])(
  'refuses invalid command arguments %j before native setup',
  async (...command) => {
    await expect(runCI({ ...options, command: command as CIOptions['command'] })).rejects.toThrow(
      'Test command arguments must be strings without null bytes.',
    );
    expect(lifecycle.run).not.toHaveBeenCalled();
    expect(existsSync(active)).toBe(false);
  },
);

it.each([0, 23])(
  'records cancellation during cleanup while preserving a completed test failure (%i)',
  async (exitCode) => {
    const controller = new AbortController();
    options.command = [process.execPath, '-e', `process.exitCode = ${exitCode}`];
    lifecycle.stop.mockImplementation(async ({ signal }) => {
      controller.abort();
      signal.throwIfAborted();
      rmSync(active);
      return { ok: true, outcomes: {}, summary: 'Stopped' };
    });
    const result = await runCI({ ...options, signal: controller.signal });
    expect(result.exitCode).toBe(exitCode || 130);
    expect(result.failure?.code).toBe(exitCode ? 'STIM_CI_TEST_FAILED' : 'STIM_CI_CANCELLED');
    expect(result.cleanup.result?.ok).toBe(true);
    expect(existsSync(active)).toBe(false);
    expect(JSON.parse(readFileSync(result.resultPath, 'utf8')).exitCode).toBe(exitCode || 130);
  },
);

it('records cancellation during diagnostics before saving the result', async () => {
  const controller = new AbortController();
  lifecycle.diagnostics.mockImplementation(async () => {
    controller.abort();
    return { directory: root, records: [] };
  });
  const result = await runCI({ ...options, signal: controller.signal });
  expect(result.exitCode).toBe(130);
  expect(JSON.parse(readFileSync(result.resultPath, 'utf8')).failure.code).toBe('STIM_CI_CANCELLED');
  expect(existsSync(active)).toBe(false);
});

it('does not extend the setup and test timeout into cleanup', async () => {
  const timeout = new AbortController();
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeoutSpy = vi
    .spyOn(AbortSignal, 'timeout')
    .mockImplementation((ms) => (ms === 1234 ? timeout.signal : nativeTimeout(ms)));
  lifecycle.stop.mockImplementation(async ({ signal }) => {
    timeout.abort(new DOMException('Expired', 'TimeoutError'));
    signal.throwIfAborted();
    rmSync(active);
    return { ok: true, outcomes: {}, summary: 'Stopped' };
  });
  try {
    const result = await runCI({ ...options, timeoutMs: 1234 });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(result.resultPath, 'utf8')).exitCode).toBe(0);
    expect(result.cleanup.result?.ok).toBe(true);
  } finally {
    timeoutSpy.mockRestore();
  }
});

it('the CLI reports SIGTERM during cleanup as exit 130 and saves the same result', async () => {
  lifecycle.stop.mockImplementation(async ({ signal }) => {
    process.emit('SIGTERM');
    signal.throwIfAborted();
    rmSync(active);
    return { ok: true, outcomes: {}, summary: 'Stopped' };
  });
  const exitCode = process.exitCode;
  const stdout: string[] = [];
  const output = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  try {
    await main([
      'run',
      '--platform',
      'ios',
      '--project',
      root,
      '--artifacts',
      options.artifactsDir!,
      '--',
      process.execPath,
      '-e',
      'process.exitCode = 0',
    ]);
    expect(process.exitCode).toBe(130);
    const result = JSON.parse(stdout.join(''));
    expect(result.failure.code).toBe('STIM_CI_CANCELLED');
    expect(JSON.parse(readFileSync(result.resultPath, 'utf8'))).toEqual(result);
    expect(existsSync(active)).toBe(false);
  } finally {
    output.mockRestore();
    process.exitCode = exitCode;
  }
});

function recordEnvironment(): string {
  const output = join(root, 'environment.json');
  options.command = [
    process.execPath,
    '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({home:process.env.STIM_HOME, cache:process.env.STIM_BUILD_CACHE}));`,
  ];
  return output;
}

it('uses the same job-local home and cache for native work and commands across hosted steps', async () => {
  vi.stubEnv('GITHUB_ACTIONS', 'true');
  vi.stubEnv('RUNNER_ENVIRONMENT', 'github-hosted');
  vi.stubEnv('RUNNER_TEMP', join(root, 'job'));
  const output = recordEnvironment();
  const expected = { home: join(root, 'job', 'stim-ci', 'home'), cache: join(root, 'job', 'stim-ci', 'build-cache') };
  const first = await runCI(options);
  const second = await runCI({ ...options, artifactsDir: join(root, 'second-results') });
  expect([first.exitCode, second.exitCode]).toEqual([0, 0]);
  expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(expected);
  expect(lifecycle.create.mock.calls.map(([value]) => ({ home: value.home, cache: value.buildCache }))).toEqual([
    expected,
    expected,
  ]);
  expect(options.home).toBeUndefined();
  expect(process.env.STIM_HOME).toBeUndefined();
  expect(process.env.STIM_BUILD_CACHE).toBeUndefined();
});

it.each(['self-hosted', ''])('keeps normal coordination paths for a %s runner', async (runner) => {
  vi.stubEnv('CI', 'true');
  vi.stubEnv('GITHUB_ACTIONS', 'true');
  vi.stubEnv('RUNNER_ENVIRONMENT', runner);
  vi.stubEnv('RUNNER_TEMP', join(root, 'job'));
  const output = recordEnvironment();
  expect((await runCI(options)).exitCode).toBe(0);
  expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({});
  expect(lifecycle.create.mock.calls[0]?.[0]).toMatchObject({ home: undefined, buildCache: undefined });
});

it.each(['environment', 'options'])('respects an explicit %s home and cache on hosted runners', async (source) => {
  vi.stubEnv('GITHUB_ACTIONS', 'true');
  vi.stubEnv('RUNNER_ENVIRONMENT', 'github-hosted');
  vi.stubEnv('RUNNER_TEMP', join(root, 'job'));
  const expected = { home: join(root, 'configured-home'), cache: join(root, 'configured-cache') };
  if (source === 'environment') {
    vi.stubEnv('STIM_HOME', expected.home);
    vi.stubEnv('STIM_BUILD_CACHE', expected.cache);
  } else {
    options.home = expected.home;
    options.buildCache = expected.cache;
  }
  const output = recordEnvironment();
  expect((await runCI(options)).exitCode).toBe(0);
  expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(expected);
  expect(lifecycle.create.mock.calls[0]?.[0]).toMatchObject(
    source === 'options'
      ? { home: expected.home, buildCache: expected.cache }
      : { home: undefined, buildCache: undefined },
  );
});

it('retains an explicit cache with the automatic hosted home', async () => {
  vi.stubEnv('GITHUB_ACTIONS', 'true');
  vi.stubEnv('RUNNER_ENVIRONMENT', 'github-hosted');
  vi.stubEnv('RUNNER_TEMP', join(root, 'job'));
  vi.stubEnv('STIM_BUILD_CACHE', join(root, 'restored-cache'));
  const output = recordEnvironment();
  expect((await runCI(options)).exitCode).toBe(0);
  expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({
    home: join(root, 'job', 'stim-ci', 'home'),
    cache: join(root, 'restored-cache'),
  });
});
