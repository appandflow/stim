import { describe, expect, it } from 'vitest';
import { invocation } from '../stimd/forwarded.ts';

describe('forwarded invocation', () => {
  it('forwards app variables but strips sensitive settings and internal credentials', () => {
    const result = invocation('/app', {
      APP_ENV: 'staging',
      STIM_ASC_KEY_PATH: '/secret',
      STIM_PARENT_LEASE: 'lease',
      STIM_LOCAL_KEY: 'key',
      STIM_METRO_PORT: '8088',
    });
    expect(result).toEqual({
      forwarded: { cwd: '/app', env: { APP_ENV: 'staging', STIM_METRO_PORT: '8088' } },
      overrides: { 'metro.port': { value: 8088, raw: '8088' } },
    });
  });

  it('treats Windows environment names case-insensitively while retaining spelling', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(
        invocation('/app', { stim_asc_key_path: 'secret', stim_parent_lease: 'secret', stim_metro_port: '8088' }),
      ).toMatchObject({
        forwarded: { env: { stim_metro_port: '8088' } },
        overrides: { 'metro.port': { value: 8088, raw: '8088' } },
      });
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });

  it('retains a validation error until the affected setting is used', () => {
    expect(invocation('/app', { STIM_METRO_PORT: '80' })).toMatchObject({
      overrides: { 'metro.port': { raw: '80', value: 80, error: expect.any(String) } },
    });
  });

  it('rejects oversized environments without including their values in the error', () => {
    const result = invocation('/app', { LARGE: 's'.repeat(512 * 1024) });
    expect(result).toMatchObject({ code: 'STIM_ENV_TOO_LARGE', message: expect.stringContaining('LARGE') });
    expect(JSON.stringify(result)).not.toContain('ssss');
  });
});

it('keeps cache overrides isolated to each asynchronous operation', async () => {
  const { metroCacheRoot } = await import('@stim-cli/core');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const firstPath = join(tmpdir(), 'cache-first');
  const secondPath = join(tmpdir(), 'cache-second');
  const { withInvocation } = await import('../stimd/forwarded.ts');
  const first = invocation('/app', { STIM_METRO_CACHE: firstPath });
  const second = invocation('/app', { STIM_METRO_CACHE: secondPath });
  if ('code' in first || 'code' in second) throw new Error('valid invocations were refused');
  const signal = new AbortController().signal;
  const results = await Promise.all([
    withInvocation({ ...first, workspace: '/app' }, signal, async () => {
      await Promise.resolve();
      return metroCacheRoot();
    }),
    withInvocation({ ...second, workspace: '/app' }, signal, async () => {
      await Promise.resolve();
      return metroCacheRoot();
    }),
  ]);
  expect(results).toEqual([firstPath, secondPath]);
});

it('classifies each environment-named setting by the process that makes its decision', async () => {
  const { SETTINGS } = await import('@stim-cli/core/state');
  const operation = ['metro.port', 'caches.metroCache'];
  const background = [
    'archive.enabled',
    'archive.maxAgeDays',
    'archive.maxCount',
    'archive.maxTotalGb',
    'archive.logs.maxAgeDays',
    'archive.logs.maxMbPerWorkspace',
    'archive.recordings.maxAgeDays',
    'archive.recordings.maxTotalGb',
    'archive.agentActions.maxAgeDays',
    'maintenance.logMaxMb',
    'maintenance.logRetentionDays',
    'maintenance.logChecks',
    'maintenance.worktreeCheckMinutes',
    'maintenance.idleStopHours',
    'maintenance.sweepHours',
    'maintenance.olderThanDays',
    'maintenance.protectRecentHours',
    'maintenance.gradleVersionIdleDays',
    'maintenance.removeFinishedWorktrees',
    'maintenance.removeIdleWorktrees',
    'maintenance.workspaceOutputsMaxGb',
    'caches.buildCacheMaxGb',
    'caches.metroCacheMaxGb',
    'caches.swiftCompilationCacheMaxGb',
    'caches.ccacheMaxGb',
    'gc.worktreeGraceMinutes',
    'pool.iosParkedMax',
    'pool.androidParkedMax',
    'pool.bootedGraceMinutes',
    'daemon.mode',
    'debug.logs',
  ];
  const cli = [
    'optimizations.android.casToolchain',
    'ios.appStoreConnectKeyId',
    'ios.appStoreConnectIssuerId',
    'recording.enabled',
    'concurrency.maxBuilds',
    'concurrency.maxDevices',
    'concurrency.maxIosDevices',
    'concurrency.maxAndroidDevices',
    'concurrency.maxMacosApps',
    'disk.minFreeGb',
    'disk.hardFloorGb',
    'disk.criticalFreeGb',
    'remote.build',
    'caches.buildCache',
    'tempDir',
  ];
  const classified = [...operation, ...background, ...cli];
  expect(new Set(classified).size).toBe(classified.length);
  expect(classified.toSorted()).toEqual(
    SETTINGS.filter((entry) => entry.env && !entry.sensitive)
      .map((entry) => entry.key)
      .toSorted(),
  );
});

it('appends spans to each operation trace without crossing paths', async () => {
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { traceInvocation } = await import('../stimd/forwarded.ts');
  const dir = mkdtempSync(join(tmpdir(), 'stim-traces-'));
  const firstPath = join(dir, 'first.json');
  const secondPath = join(dir, 'second.json');
  writeFileSync(firstPath, '[\n');
  try {
    const first = invocation('/app', { STIM_TRACE: firstPath });
    const second = invocation('/app', { STIM_TRACE: secondPath });
    if ('code' in first || 'code' in second) throw new Error('valid trace paths were refused');
    await Promise.all([
      traceInvocation(first, 'first', async () => {}),
      traceInvocation(second, 'second', async () => {}),
    ]);
    expect(readFileSync(firstPath, 'utf8')).toContain('"name":"first"');
    expect(readFileSync(firstPath, 'utf8')).not.toContain('"name":"second"');
    expect(readFileSync(secondPath, 'utf8')).toMatch(/^\[\n/);
    expect(readFileSync(secondPath, 'utf8')).toContain('"name":"second"');
    expect(readFileSync(secondPath, 'utf8')).not.toContain('"name":"first"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
