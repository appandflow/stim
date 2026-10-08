import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCI, type CIOptions } from '../index.ts';

const lifecycle = vi.hoisted(() => ({
  run: vi.fn<(options: { signal?: AbortSignal }) => Promise<unknown>>(),
  diagnostics: vi.fn<() => Promise<unknown>>(),
  stop: vi.fn<(options: { signal: AbortSignal }) => Promise<unknown>>(),
}));
vi.mock('stim', () => ({ createStim: () => lifecycle }));

let root: string;
let active: string;
let options: CIOptions;

beforeEach(() => {
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

afterEach(() => rmSync(root, { recursive: true, force: true }));

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

it('preserves a test failure when the results directory becomes unwritable', async () => {
  options.command = [
    process.execPath,
    '-e',
    "const fs = require('node:fs'); const path = process.env.STIM_CI_ARTIFACTS_DIR; fs.renameSync(path, path + '-moved'); fs.writeFileSync(path, 'no longer a directory'); process.exitCode = 23;",
  ];
  const result = await runCI(options);
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
