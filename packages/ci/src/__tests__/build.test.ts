import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCI, type CIBuildOptions } from '../index.ts';
import { main } from '../cli.ts';
import type { StimBuildResult, StimOptions } from 'stim';

const lifecycle = vi.hoisted(() => ({
  create: vi.fn<(options: StimOptions) => void>(),
  build: vi.fn<(options: { signal?: AbortSignal }) => Promise<StimBuildResult>>(),
  diagnostics: vi.fn<() => Promise<unknown>>(),
  stop: vi.fn<() => Promise<unknown>>(),
}));
vi.mock('stim', () => ({
  createStim: (options: StimOptions) => {
    lifecycle.create(options);
    return lifecycle;
  },
}));
let root: string;
let active: string;
let options: CIBuildOptions;

beforeEach(() => {
  vi.stubEnv('GITHUB_ACTIONS', 'false');
  vi.stubEnv('STIM_HOME', undefined);
  vi.stubEnv('STIM_BUILD_CACHE', undefined);
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-ci-build-')));
  active = join(root, 'existing-session');
  writeFileSync(active, 'running');
  const apkPath = join(root, 'built.apk');
  writeFileSync(apkPath, 'compiled apk');
  options = { projectRoot: root, build: { platform: 'android' }, artifactsDir: join(root, 'artifacts') };
  lifecycle.create.mockClear();
  lifecycle.build.mockReset().mockResolvedValue({ platform: 'android', facts: { apkPath } } as StimBuildResult);
  lifecycle.stop.mockReset().mockImplementation(async () => {
    rmSync(active);
    return { ok: true };
  });
  lifecycle.diagnostics.mockReset().mockResolvedValue({ directory: root, records: [] });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

test('exports APK bytes and diagnostics without stopping an existing session', async () => {
  const result = await buildCI(options);
  expect(result.exitCode).toBe(0);
  expect(readFileSync(result.artifactPath!, 'utf8')).toBe('compiled apk');
  expect(JSON.parse(readFileSync(result.resultPath, 'utf8')).stage).toBe('build');
  expect(existsSync(result.diagnostics.path!)).toBe(true);
  expect(readFileSync(active, 'utf8')).toBe('running');
  expect(lifecycle.stop).not.toHaveBeenCalled();
});

test('export failure reports an artifact failure, removes the partial export and keeps the reports', async () => {
  lifecycle.build.mockResolvedValue({
    platform: 'android',
    facts: { apkPath: join(root, 'missing.apk') },
  } as StimBuildResult);
  const result = await buildCI(options);
  expect(result.exitCode).toBe(1);
  expect(result.failure?.code).toBe('STIM_CI_ARTIFACT_FAILED');
  expect(result.failure?.message).toContain('ENOENT');
  expect(result.artifactPath).toBeNull();
  expect(readdirSync(options.artifactsDir!).filter((name) => name.startsWith('app.'))).toEqual([]);
  expect(JSON.parse(readFileSync(result.resultPath, 'utf8')).failure).toEqual(result.failure);
  expect(existsSync(result.diagnostics.path!)).toBe(true);
  expect(existsSync(active)).toBe(true);
  expect(lifecycle.stop).not.toHaveBeenCalled();
});

test('cancellation during diagnostics keeps a completed export', async () => {
  const controller = new AbortController();
  lifecycle.diagnostics.mockImplementation(async () => {
    controller.abort();
    return { directory: root, records: [] };
  });
  const result = await buildCI({ ...options, signal: controller.signal });
  expect(result.exitCode).toBe(0);
  expect(result.failure).toBeUndefined();
  expect(readFileSync(result.artifactPath!, 'utf8')).toBe('compiled apk');
  expect(existsSync(result.diagnostics.path!)).toBe(true);
});

test.skipIf(process.platform === 'win32')(
  'exported Apple archive preserves executable mode and framework links',
  async () => {
    const app = join(root, 'Native.app');
    mkdirSync(join(app, 'Contents'), { recursive: true });
    const executable = join(app, 'Contents', 'Native');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);
    symlinkSync('Native', join(app, 'Contents', 'Current'));
    lifecycle.build.mockResolvedValue({ platform: 'macos', facts: { bundle: app } } as StimBuildResult);
    const result = await buildCI({ ...options, build: { platform: 'macos' } });
    expect(result.exitCode).toBe(0);
    const extracted = join(root, 'extracted');
    mkdirSync(extracted);
    execFileSync('tar', ['-xzf', result.artifactPath!, '-C', extracted]);
    expect(statSync(join(extracted, 'Native.app', 'Contents', 'Native')).mode & 0o777).toBe(0o755);
    expect(readlinkSync(join(extracted, 'Native.app', 'Contents', 'Current'))).toBe('Native');
    expect(existsSync(active)).toBe(true);
  },
);

test.each(['failure', 'cancel'])(
  'build %s leaves existing runtime alone and keeps diagnostic results',
  async (mode) => {
    const controller = new AbortController();
    lifecycle.build.mockImplementation(async () => {
      if (mode === 'cancel') controller.abort();
      throw Object.assign(new Error('build interrupted'), { code: 'STIM_BUILD_FAILED' });
    });
    const result = await buildCI({ ...options, signal: controller.signal });
    expect(result.exitCode).toBe(mode === 'cancel' ? 130 : 1);
    expect(result.failure?.code).toBe(mode === 'cancel' ? 'STIM_CI_CANCELLED' : 'STIM_BUILD_FAILED');
    expect(result.artifactPath).toBeNull();
    expect(existsSync(result.diagnostics.path!)).toBe(true);
    expect(existsSync(active)).toBe(true);
    expect(lifecycle.stop).not.toHaveBeenCalled();
  },
);

test('CLI build needs no command and refuses platform-incompatible selectors before invoking Stim', async () => {
  const output: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const errors: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    errors.push(String(chunk));
    return true;
  });
  const prior = process.exitCode;
  try {
    await main(['build', '--platform', 'android', '--project', root, '--artifacts', options.artifactsDir!]);
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(output.join('')).stage).toBe('build');
    const calls = lifecycle.build.mock.calls.length;
    await main(['build', '--platform', 'android', '--scheme', 'App', '--project', root]);
    expect(process.exitCode).toBe(1);
    expect(lifecycle.build).toHaveBeenCalledTimes(calls);
    await main(['run', '--platform', 'ios', '--abi', 'x86', '--project', root, '--', 'true']);
    expect(process.exitCode).toBe(1);
    expect(errors.join('')).toContain('--arch and --abi only apply to build-only.');
  } finally {
    process.exitCode = prior;
  }
});
