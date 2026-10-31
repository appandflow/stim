import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

it('reports a missing test executable as exit code 1 in the result and saved JSON', async () => {
  options.command = [join(root, 'missing-executable')];
  const result = await runCI(options);
  expect(result.exitCode).toBe(1);
  expect(result.failure?.code).toBe('STIM_CI_TEST_FAILED');
  expect(result.test?.error).toContain('ENOENT');
  expect(JSON.parse(readFileSync(result.resultPath ?? '', 'utf8')).exitCode).toBe(1);
  expect(existsSync(active)).toBe(false);
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
    expect(JSON.parse(readFileSync(result.resultPath ?? '', 'utf8')).exitCode).toBe(exitCode || 130);
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
  expect(JSON.parse(readFileSync(result.resultPath ?? '', 'utf8')).failure.code).toBe('STIM_CI_CANCELLED');
  expect(existsSync(active)).toBe(false);
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
    expect(JSON.parse(readFileSync(result.resultPath ?? '', 'utf8'))).toEqual(result);
    expect(existsSync(active)).toBe(false);
  } finally {
    output.mockRestore();
    process.exitCode = exitCode;
  }
});

it('the CLI runs without a test command when -- is absent and refuses an empty one after --', async () => {
  const exitCode = process.exitCode;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const output = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  const errors = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  try {
    await main(['run', '--platform', 'ios', '--project', root]);
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({ exitCode: 0, test: null });
    expect(lifecycle.stop).toHaveBeenCalledTimes(1);
    await main(['run', '--platform', 'ios', '--project', root, '--']);
    expect(process.exitCode).toBe(1);
    expect(stderr.join('')).toContain('A test command is required after --.');
    expect(lifecycle.run).toHaveBeenCalledTimes(1);
  } finally {
    output.mockRestore();
    errors.mockRestore();
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

it('names the stim-ci build command when no build is recorded', async () => {
  options.run = { platform: 'android', variant: 'productionRelease' };
  lifecycle.run.mockRejectedValue(
    Object.assign(new Error('No recorded android build exists.'), { code: 'STIM_NO_RECORDED_BUILD' }),
  );
  const result = await runCI(options);
  expect(result.exitCode).toBe(1);
  expect(result.test).toBeNull();
  expect(result.failure).toMatchObject({
    code: 'STIM_NO_RECORDED_BUILD',
    remedy: expect.stringMatching(
      /^Run stim-ci build --platform android --project ".+" --variant "productionRelease" first\.$/,
    ),
  });
});

it('writes no result, test or diagnostic file without an artifacts directory', async () => {
  const { artifactsDir: _unused, ...withoutArtifacts } = options;
  const before = readdirSync(root).toSorted();
  const result = await runCI(withoutArtifacts);
  expect(result).toMatchObject({ exitCode: 0, artifactsDir: null, resultPath: null, runPath: null });
  expect(result.diagnostics.path).toBeNull();
  expect(readdirSync(root).toSorted()).toEqual([...before, 'native.log'].toSorted());
  expect(lifecycle.diagnostics).not.toHaveBeenCalled();
});
