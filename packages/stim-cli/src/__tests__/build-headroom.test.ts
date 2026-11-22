import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as volumeBudget from '../stimd/passes/budget.ts';
import * as daemonClient from '../daemon/client.ts';
import * as worktree from '../workspace/worktree.ts';
import { createBuildHeadroom } from '../engine/build-headroom-run.ts';
import { takeBuildBytes } from '../engine/build-bytes.ts';
import { saveConfig } from '../workspace/config.ts';
import { testContext } from './_context.ts';
import type { BuildLedgerRecord } from '@stim-cli/core/state';
import { DEFAULT_BUILD_GB, estimateBuildBytes } from '../engine/build-headroom.ts';

const GB = 1024 ** 3;
const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const DAY = 24 * 60 * 60_000;

function record(overrides: Partial<BuildLedgerRecord> & { gb?: number }): BuildLedgerRecord {
  const { gb, ...rest } = overrides;
  return {
    ts: NOW - DAY,
    src: 'builds',
    level: 'info',
    msg: '',
    event: 'build',
    id: `id-${Math.random()}`,
    startedAt: NOW - DAY,
    project: '/work/app',
    projectKey: '/repo/app',
    workspace: 'app',
    branch: null,
    platform: 'ios',
    configuration: 'Debug',
    placement: { where: 'local' },
    cache: { result: 'miss', key: null, fingerprint: null },
    durationMs: 1,
    phases: {},
    outcome: 'succeeded',
    stimVersion: '1',
    ...(gb === undefined ? {} : { bytesWritten: gb * GB }),
    ...rest,
  };
}

const ask = (records: BuildLedgerRecord[]) =>
  estimateBuildBytes({ records, projectKey: '/repo/app', platform: 'ios', type: 'expo', now: NOW });

describe('estimateBuildBytes', () => {
  it('takes the median of the project and platform builds, ignoring hits, failures, other platforms, other projects, old builds and non-positive records', () => {
    const estimate = ask([
      record({ gb: 3 }),
      record({ gb: 9 }),
      record({ gb: 4 }),
      record({ gb: 0 }),
      record({ gb: 40, cache: { result: 'hit', key: null, fingerprint: null } }),
      record({ gb: 40, outcome: 'failed' }),
      record({ gb: 40, platform: 'android' }),
      record({ gb: 40, projectKey: '/repo/other' }),
      record({ gb: 40, ts: NOW - 31 * DAY }),
    ]);
    expect(estimate).toEqual({ bytes: 4 * GB, source: 'history' });
  });

  it('uses only the ten newest records, so an old large one cannot pin the estimate', () => {
    const newest = Array.from({ length: 10 }, (_, index) => record({ gb: 2, ts: NOW - index * 1000 }));
    const estimate = ask([record({ gb: 50, ts: NOW - DAY }), ...newest]);
    expect(estimate).toEqual({ bytes: 2 * GB, source: 'history' });
  });

  it('uses the default of the project type when the project has no positive measured build', () => {
    expect(ask([record({}), record({ gb: 0 })])).toEqual({
      bytes: (DEFAULT_BUILD_GB.expo.ios ?? 0) * GB,
      source: 'default',
    });
  });
});

describe('the queued headroom budget of a local compile', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-headroom-'));
    vi.stubEnv('STIM_HOME', home);
    saveConfig({ version: 2, projects: {}, repos: {}, daemon: { mode: 'on' } });
    vi.spyOn(worktree, 'gitCommonDir').mockReturnValue(home);
    vi.spyOn(worktree, 'repoRoot').mockReturnValue(home);
  });
  afterEach(() => {
    takeBuildBytes(home, 'macos');
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });
  const space = (freeMb: number) => [{ volume: '/', freeMb, device: 7 }];
  const context = (root: string, signal = new AbortController().signal) =>
    testContext({ projectRoot: root, cwd: root, signal, env: { ...process.env, CI: undefined, STIM_DAEMON: 'on' } });

  test('initial reads and queued cleanup share 60 seconds, and a late completion cannot warn or record a baseline', async () => {
    const output = vi.fn<(stream: string, text: string) => void>();
    vi.spyOn(volumeBudget, 'readVolumeSpaceAsync').mockImplementation(async () => {
      vi.advanceTimersByTime(20_000);
      return space(100);
    });
    let entered!: () => void;
    const requested = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const request = vi.spyOn(daemonClient, 'runGcThroughStimd').mockImplementation(async () => {
      entered();
      await held;
      return { headroom: true };
    });
    const build = createBuildHeadroom({ root: home, platform: 'macos', context: { ...context(home), output } });
    let settled = false;
    const begin = build.begin().then(() => (settled = true));
    await requested;
    await vi.advanceTimersByTimeAsync(39_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await begin;
    expect(request.mock.calls[0]?.[2].aborted).toBe(true);
    finish();
    await vi.runAllTimersAsync();
    await build.finish();
    expect(output).not.toHaveBeenCalled();
    expect(takeBuildBytes(home, 'macos')).toBeUndefined();
    expect(volumeBudget.readVolumeSpaceAsync).toHaveBeenCalledTimes(1);
  });

  test('an uninterruptible volume read cannot hold the build past the total budget', async () => {
    let finish!: (value: Awaited<ReturnType<typeof volumeBudget.readVolumeSpaceAsync>>) => void;
    vi.spyOn(volumeBudget, 'readVolumeSpaceAsync').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const request = vi.spyOn(daemonClient, 'runGcThroughStimd');
    const build = createBuildHeadroom({ root: home, platform: 'macos', context: context(home) });
    const begin = build.begin();
    await vi.advanceTimersByTimeAsync(60_000);
    await begin;
    finish(space(100));
    await vi.runAllTimersAsync();
    await build.finish();
    expect(request).not.toHaveBeenCalled();
    expect(takeBuildBytes(home, 'macos')).toBeUndefined();
  });

  test('a cleanup failure does not refuse the compile, while true user cancellation propagates', async () => {
    vi.spyOn(volumeBudget, 'readVolumeSpaceAsync').mockResolvedValue(space(100));
    const request = vi.spyOn(daemonClient, 'runGcThroughStimd').mockRejectedValue(new Error('daemon unavailable'));
    const output = vi.fn<(stream: string, text: string) => void>();
    await expect(
      createBuildHeadroom({ root: home, platform: 'macos', context: { ...context(home), output } }).begin(),
    ).resolves.toBeUndefined();
    expect(output).toHaveBeenCalledWith('stderr', expect.stringContaining('building anyway'));
    const user = new AbortController();
    const reason = new Error('user cancelled build');
    request.mockImplementation(async () => {
      user.abort(reason);
      return { headroom: true };
    });
    await expect(
      createBuildHeadroom({ root: home, platform: 'macos', context: context(home, user.signal) }).begin(),
    ).rejects.toBe(reason);
  });

  test('measurement starts after cleanup and preserves the existing warning when space still falls short', async () => {
    const output = vi.fn<(stream: string, text: string) => void>();
    vi.spyOn(daemonClient, 'runGcThroughStimd').mockResolvedValue({ headroom: true });
    vi.spyOn(volumeBudget, 'readVolumeSpaceAsync')
      .mockResolvedValueOnce(space(100))
      .mockResolvedValueOnce(space(200))
      .mockResolvedValueOnce(space(200))
      .mockResolvedValueOnce(space(150));
    const build = createBuildHeadroom({ root: home, platform: 'macos', context: { ...context(home), output } });
    await build.begin();
    await build.finish();
    expect(takeBuildBytes(home, 'macos')).toBe(50 * 1024 ** 2);
    expect(output).toHaveBeenCalledTimes(1);
    expect(output).toHaveBeenCalledWith('stderr', expect.stringContaining('building anyway'));
  });
});
