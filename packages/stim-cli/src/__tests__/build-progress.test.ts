import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseClaim, tryAcquireClaim, type ClaimHandle } from '../ownership-claim.ts';
import { readWorkspaceState, writeWorkspaceState } from '../workspace/workspace-state.ts';
import {
  ACTIVE_BUILD_KEY,
  activeBuildState,
  buildReport,
  buildStatusLine,
  estimateBuild,
  parseActiveBuild,
  recordFinishedBuild,
  startBuildProgress,
  type ActiveBuildRecord,
} from '../engine/build-progress.ts';
import { BUILD_HISTORY_LIMIT, readBuildHistory, readLastBuilds } from '@stim-cli/core/state';
import {
  emptyStats,
  HISTORY_LIMIT,
  readStats,
  recordRunStats,
  updateStats,
  type RunHistory,
  type StatsRun,
} from '../engine/stats.ts';
import { goneClaimOwner, plantClaim } from './_factories.ts';

const T0 = Date.parse('2026-09-24T10:00:00.000Z');

let home: string;
let root: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-build-progress-'));
  process.env.STIM_HOME = home;
  root = join(home, 'app');
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

function takeClaim(): ClaimHandle {
  const attempt = tryAcquireClaim({ root: join(home, 'native-run.lock'), mode: 'exclusive', label: 'native-run lock' });
  if (!attempt.acquired) throw new Error('claim not acquired');
  return attempt.acquired;
}

function activeRecord(): ActiveBuildRecord | null {
  return parseActiveBuild(readWorkspaceState(root)?.[ACTIVE_BUILD_KEY]);
}

describe('active build record', () => {
  test('records phase transitions under the run claim, reports running, and clears on exit', () => {
    const claim = takeClaim();
    let now = T0;
    const progress = startBuildProgress({ root, platform: 'ios', slot: 'default', claim, now: () => now });
    expect(activeRecord()).toMatchObject({ phase: 'prepare', startedAt: '2026-09-24T10:00:00.000Z' });

    now += 2_000;
    progress.step('cache-lookup');
    now += 3_000;
    progress.step('compile');
    progress.step('compile');
    now += 60_000;

    const record = activeRecord()!;
    expect(record.phase).toBe('compile');
    expect(record.phaseStartedAt).toBe('2026-09-24T10:00:05.000Z');
    expect(record.phases.map((entry) => entry.phase)).toEqual(['prepare', 'cache-lookup', 'compile']);
    expect(activeBuildState(record.claim)).toBe('running');
    expect(progress.durations()).toEqual({ prepare: 2_000, 'cache-lookup': 3_000, compile: 60_000 });

    progress.clear();
    expect(readWorkspaceState(root)?.[ACTIVE_BUILD_KEY]).toBeUndefined();
    releaseClaim(claim);
  });

  test('clear leaves a record that a later run wrote', () => {
    const first = takeClaim();
    const progress = startBuildProgress({ root, platform: 'android', slot: 'default', claim: first });
    releaseClaim(first);
    const second = takeClaim();
    startBuildProgress({ root, platform: 'android', slot: 'default', claim: second });

    progress.clear();

    expect(activeRecord()?.claim.claimId).toBe(second.claimId);
    releaseClaim(second);
  });

  test('a record whose claim was released or whose owner is gone is stale, never running', () => {
    const claim = takeClaim();
    startBuildProgress({ root, platform: 'ios', slot: 'default', claim });
    releaseClaim(claim);
    expect(activeBuildState(activeRecord()!.claim)).toBe('stale');

    const lock = join(home, 'gone.lock');
    const path = plantClaim(lock, 'exclusive', goneClaimOwner(), { claimId: 'gone-claim' });
    expect(activeBuildState({ root: lock, path, claimId: 'gone-claim', pid: 1 })).toBe('stale');
  });

  test('a record the state file cannot describe is ignored', () => {
    writeWorkspaceState(root, { [ACTIVE_BUILD_KEY]: { platform: 'ios', phase: 'compiling' } });
    expect(activeRecord()).toBeNull();
  });
});

function finished(startedAt: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    platform: 'ios',
    fingerprint: 'abc',
    cacheKey: 'abc-debug-sim',
    cacheHit: false,
    cacheSkipped: false,
    durationMs: 90_000,
    appPath: '/tmp/App.app',
    bundleId: 'com.example.app',
    startedAt,
    status: 'ok',
    configuration: 'Debug',
    ...extra,
  };
}

describe('build history', () => {
  test("a finished run is its platform's last build and newest history entry, with the run's slot and phases", () => {
    const claim = takeClaim();
    let now = T0;
    const progress = startBuildProgress({ root, platform: 'ios', slot: 'tablet', claim, now: () => now });
    now += 5_000;
    progress.step('compile');
    now += 80_000;
    progress.step('install');
    now += 5_000;
    recordFinishedBuild(root, finished('2026-09-24T10:00:00.100Z'), { now: () => now });
    progress.clear();
    releaseClaim(claim);

    const state = readWorkspaceState(root);
    expect(state?.lastIosBuild).toEqual(state?.lastBuild);
    const [entry] = readBuildHistory(state).ios!;
    expect(entry).toMatchObject({
      result: 'succeeded',
      slot: 'tablet',
      configuration: 'Debug',
      cacheKey: 'abc-debug-sim',
      phases: { prepare: 5_000, compile: 80_000, install: 5_000 },
    });
    expect(entry).toMatchObject(readLastBuilds(state).ios!);
  });

  test('keeps the newest runs of each platform, newest first, and names cancelled and failed runs', () => {
    for (let i = 0; i < BUILD_HISTORY_LIMIT + 2; i += 1) {
      recordFinishedBuild(root, finished(new Date(T0 + i * 60_000).toISOString()));
    }
    recordFinishedBuild(root, finished('2026-09-24T11:00:00.000Z', { status: 'failed', errorCode: 'STIM_CANCELLED' }));
    recordFinishedBuild(
      root,
      finished('2026-09-24T11:01:00.000Z', { platform: 'android', status: 'failed', errorCode: 'STIM_BUILD_FAILED' }),
    );

    const history = readBuildHistory(readWorkspaceState(root));
    expect(history.ios).toHaveLength(BUILD_HISTORY_LIMIT);
    expect(history.ios!.map((entry) => entry.result).slice(0, 2)).toEqual(['cancelled', 'succeeded']);
    expect(history.ios!.at(-1)!.startedAt).toBe(new Date(T0 + 3 * 60_000).toISOString());
    expect(history.android!.map((entry) => entry.result)).toEqual(['failed']);
  });

  test("a run that finds an earlier run's active-build record records that run as interrupted", () => {
    let now = T0;
    const first = takeClaim();
    const killed = startBuildProgress({ root, platform: 'android', slot: 'default', claim: first, now: () => now });
    now += 4_000;
    killed.step('compile');
    releaseClaim(first);

    now += 30_000;
    const second = takeClaim();
    startBuildProgress({ root, platform: 'ios', slot: 'default', claim: second, now: () => now }).clear();
    releaseClaim(second);

    expect(readBuildHistory(readWorkspaceState(root)).android).toEqual([
      expect.objectContaining({
        result: 'interrupted',
        status: 'failed',
        startedAt: '2026-09-24T10:00:00.000Z',
        durationMs: null,
        finishedAt: null,
        phases: { prepare: 4_000, compile: 0 },
      }),
    ]);
  });

  test('an active-build record whose run recorded its result is not an interrupted run', () => {
    const first = takeClaim();
    startBuildProgress({ root, platform: 'ios', slot: 'default', claim: first, now: () => T0 });
    recordFinishedBuild(root, finished('2026-09-24T10:00:00.100Z'));
    releaseClaim(first);

    const second = takeClaim();
    startBuildProgress({ root, platform: 'ios', slot: 'default', claim: second, now: () => T0 + 60_000 }).clear();
    releaseClaim(second);

    expect(readBuildHistory(readWorkspaceState(root)).ios!.map((entry) => entry.result)).toEqual(['succeeded']);
  });
});

function run(overrides: Partial<StatsRun>): StatsRun {
  return {
    platform: 'ios',
    projectKey: '/repo/app',
    failed: false,
    cacheHit: false,
    waitedForBuild: false,
    durationMs: 100_000,
    phases: { compile: 90_000 },
    ...overrides,
  };
}

describe('run history', () => {
  test('keeps the last runs per outcome and skips failed and waited runs', () => {
    let record = emptyStats();
    for (let i = 1; i <= HISTORY_LIMIT + 2; i++) record = updateStats(record, run({ durationMs: i * 1000 }), T0 + i);
    record = updateStats(record, run({ cacheHit: 'local', durationMs: 7_000, phases: { install: 5_000 } }), T0);
    record = updateStats(record, run({ failed: true }), T0);
    record = updateStats(record, run({ cacheHit: 'local', waitedForBuild: true }), T0);

    const lists = record.history?.['/repo/app']?.ios;
    expect(lists?.cold?.map((sample) => sample.durationMs)).toEqual(
      Array.from({ length: HISTORY_LIMIT }, (_, i) => (i + 3) * 1000),
    );
    expect(lists?.hit).toEqual([{ at: new Date(T0).toISOString(), durationMs: 7_000, phases: { install: 5_000 } }]);
  });

  test('survives a write and read of stats.json', () => {
    recordRunStats(run({}), T0);
    expect(readStats().record?.history?.['/repo/app']?.ios?.cold).toHaveLength(1);
  });
});

function histSample(durationMs: number, phases: Record<string, number>, at = T0) {
  return { at: new Date(at).toISOString(), durationMs, phases };
}

describe('estimates', () => {
  const history: RunHistory = {
    ios: {
      cold: [
        histSample(100_000, { compile: 80_000 }),
        histSample(300_000, { compile: 250_000 }),
        histSample(200_000, { compile: 150_000 }),
        histSample(400_000, {}),
      ],
      hit: [histSample(20_000, { install: 5_000 }, T0 + 1)],
    },
  };

  test('medians comparable runs of the known outcome and counts the basis', () => {
    expect(estimateBuild(history, 'ios', 'cold', 'compile')).toEqual({
      outcome: 'cold',
      expectedMs: 250_000,
      expectedPhaseMs: 150_000,
      basis: 4,
    });
  });

  test('uses the latest outcome before the cache outcome is known, and nothing without history', () => {
    expect(estimateBuild(history, 'ios', null, 'cache-lookup')).toMatchObject({ outcome: 'hit', expectedMs: 20_000 });
    expect(estimateBuild(undefined, 'android', null, 'prepare')).toEqual({
      outcome: null,
      expectedMs: null,
      expectedPhaseMs: null,
      basis: 0,
    });
  });

  test('a live record that reached compile is estimated as a cold run', () => {
    const record: ActiveBuildRecord = {
      platform: 'ios',
      slot: 'default',
      startedAt: new Date(T0).toISOString(),
      phase: 'compile',
      phaseStartedAt: new Date(T0 + 10_000).toISOString(),
      phases: [
        { phase: 'prepare', startedAt: new Date(T0).toISOString() },
        { phase: 'compile', startedAt: new Date(T0 + 10_000).toISOString() },
      ],
      claim: { root: '/x', path: '/x/c', claimId: 'c', pid: 1 },
    };
    const report = buildReport(record, { state: 'running', history });
    expect(report).toMatchObject({ outcome: 'cold', expectedMs: 250_000, basis: 4, phase: 'compile' });
    expect(buildStatusLine(report, T0 + 70_000)).toBe(
      'build: ios compile, 1m10s elapsed -- about 3 min left (median of 4 cold runs)',
    );
    expect(buildStatusLine(report, T0 + 300_000)).toBe(
      'build: ios compile, 5m00s elapsed (usually ~4m10s, median of 4 cold runs)',
    );
  });
});
