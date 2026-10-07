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
  completedPhaseDurations,
  estimateBuild,
  parseActiveBuild,
  recordFinishedBuild,
  startBuildProgress,
  type ActiveBuildRecord,
} from '../engine/build-progress.ts';
import { BUILD_HISTORY_LIMIT, readBuildDetail, readBuildHistory, readLastBuilds } from '@stim-cli/core/state';
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

describe('completedPhaseDurations', () => {
  const at = (ms: number) => new Date(T0 + ms).toISOString();

  test('reports elapsed time for completed phases, excluding the current visit', () => {
    expect(
      completedPhaseDurations([
        { phase: 'prepare', startedAt: at(0) },
        { phase: 'cache-lookup', startedAt: at(2000) },
        { phase: 'compile', startedAt: at(5000) },
      ]),
    ).toEqual({ prepare: 2000, 'cache-lookup': 3000 });
  });

  test('sums completed repeat visits even when that phase is current again', () => {
    expect(
      completedPhaseDurations([
        { phase: 'cache-lookup', startedAt: at(0) },
        { phase: 'prebuild', startedAt: at(1000) },
        { phase: 'cache-lookup', startedAt: at(5000) },
        { phase: 'pods', startedAt: at(7000) },
        { phase: 'cache-lookup', startedAt: at(9000) },
      ]),
    ).toEqual({ 'cache-lookup': 3000, prebuild: 4000, pods: 2000 });
  });

  test('omits durations before a phase completes', () => {
    expect(completedPhaseDurations([{ phase: 'prepare', startedAt: at(0) }])).toBeUndefined();
  });

  test('ignores intervals with an unparsable start or end', () => {
    expect(
      completedPhaseDurations([
        { phase: 'prepare', startedAt: at(0) },
        { phase: 'cache-lookup', startedAt: 'invalid' },
        { phase: 'prebuild', startedAt: at(3000) },
        { phase: 'compile', startedAt: at(5000) },
      ]),
    ).toEqual({ prebuild: 2000 });
  });
});

describe('active build record', () => {
  test('writes the tool detail for its own claim at most every 2 seconds, and the miss reason once known', () => {
    vi.useFakeTimers({ now: T0 });
    try {
      const claim = takeClaim();
      const progress = startBuildProgress({ root, platform: 'ios', slot: 'default', claim, now: Date.now });
      const line = (msg: string) => progress.output({ src: 'build', level: 'debug', msg });
      line('note: Target dependency graph (3 targets)');
      expect(readBuildDetail(root, claim.claimId)).toMatchObject({ unit: 'targets', done: 0, total: 3 });

      line(
        "CompileC /d/x.o /src/x.c normal arm64 c com.apple.compilers.llvm.clang.1_0.compiler (in target 'A' from project 'P')",
      );
      line("Touch /d/A.framework (in target 'A' from project 'P')");
      expect(readBuildDetail(root, claim.claimId)).toMatchObject({ done: 0 });
      vi.advanceTimersByTime(2000);
      expect(readBuildDetail(root, claim.claimId)).toEqual({
        step: 'compile',
        unit: 'targets',
        done: 1,
        total: 3,
        line: 'CompileC x.c (A)',
        updatedAt: '2026-09-24T10:00:02.000Z',
      });
      expect(readBuildDetail(root, 'another-run')).toBeNull();

      progress.miss({
        kind: 'changed',
        summary: 'native dependency added: expo-clipboard',
        changes: [{ source: 'expo-clipboard', change: 'added', category: 'native-dependency' }],
        changeCount: 1,
        baseline: { fingerprint: 'abc', cacheKey: 'ios-abc', from: 'workspace' },
        rekeyedBy: [],
      });
      expect(buildReport(activeRecord()!, { state: 'running', history: undefined }).missReason).toEqual({
        kind: 'changed',
        summary: 'native dependency added: expo-clipboard',
        changes: [{ source: 'expo-clipboard', change: 'added', category: 'native-dependency' }],
        changeCount: 1,
        baseline: { fingerprint: 'abc', from: 'workspace' },
        rekeyedBy: [],
      });

      expect(buildReport(activeRecord()!, { state: 'running', history: undefined })).toMatchObject({
        phase: 'prepare',
        outcome: 'cold',
        outcomeKnown: true,
      });
      progress.hit();
      expect(buildReport(activeRecord()!, { state: 'running', history: undefined })).toMatchObject({
        phase: 'prepare',
        outcome: 'hit',
        outcomeKnown: true,
      });
      expect(activeRecord()?.missReason).toBeUndefined();
      progress.clear();
      expect(readBuildDetail(root, claim.claimId)).toBeNull();
      releaseClaim(claim);
    } finally {
      vi.useRealTimers();
    }
  });

  test('reports where the build runs: local, then the build machine and its phase there, then local again', () => {
    const claim = takeClaim();
    let now = T0;
    const progress = startBuildProgress({ root, platform: 'ios', slot: 'default', claim, now: () => now });
    const report = () => buildReport(activeRecord()!, { state: 'running', history: undefined });
    expect(report().placement).toBe('local');

    now += 10_000;
    progress.place({ host: 'mini', phase: 'sync' });
    now += 5_000;
    progress.place({ host: 'mini', phase: 'build' });
    progress.place({ host: 'mini', phase: 'build' });
    expect(report().placement).toEqual({
      host: 'mini',
      phase: 'build',
      startedAt: '2026-09-24T10:00:10.000Z',
      phaseStartedAt: '2026-09-24T10:00:15.000Z',
    });
    now += 65_000;
    expect(buildStatusLine(report(), now)).toBe('build: ios prepare on mini (build, 1m05s), 1m20s elapsed');

    progress.place(null);
    expect(report().placement).toBe('local');
    progress.clear();
    releaseClaim(claim);
  });

  test('names the workspace a waiting build waits on and drops it when the run leaves the wait', () => {
    const claim = takeClaim();
    let now = T0;
    const progress = startBuildProgress({ root, platform: 'ios', slot: 'default', claim, now: () => now });
    const report = () => buildReport(activeRecord()!, { state: 'running', history: undefined });
    expect(report().waitingOn).toBeUndefined();

    now += 10_000;
    progress.step('wait');
    progress.waitingOn('/w/app-a');
    expect(report().waitingOn).toEqual({ path: '/w/app-a' });
    expect(buildStatusLine(report(), now + 5_000)).toBe('build: ios wait on /w/app-a, 15s elapsed');

    progress.waitingOn('/w/app-b');
    expect(report().waitingOn).toEqual({ path: '/w/app-b' });
    progress.waitingOn(null);
    expect(report().waitingOn).toBeUndefined();

    progress.waitingOn('/w/app-a');
    progress.step('device');
    expect(report().waitingOn).toBeUndefined();
    progress.clear();
    releaseClaim(claim);
  });

  test('slot waits stay independent of phase and overlapping waits show the earliest until it ends', () => {
    const claim = takeClaim();
    const progress = startBuildProgress({ root, platform: 'ios', slot: 'default', claim, now: () => T0 });
    const report = () => buildReport(activeRecord()!, { state: 'running', history: undefined });
    const device = { kind: 'device-slot' as const, inUse: 2, max: 2, since: new Date(T0).toISOString() };
    const build = { kind: 'build-slot' as const, inUse: 1, max: 1, since: new Date(T0 + 1000).toISOString() };
    progress.waitingFor(device);
    progress.step('compile');
    progress.waitingFor(build);
    expect(report()).toMatchObject({ phase: 'compile', waitingFor: device });
    progress.waitingFor(null, 'device-slot');
    expect(report()).toMatchObject({ phase: 'compile', waitingFor: build });
    progress.waitingFor(null, 'build-slot');
    expect(report().waitingFor).toBeUndefined();
    progress.clear();
    releaseClaim(claim);
  });

  test('malformed slot wait state is ignored without losing an older active build', () => {
    const claim = takeClaim();
    const progress = startBuildProgress({ root, platform: 'android', slot: 'default', claim });
    const record = activeRecord()!;
    for (const waitingFor of [
      null,
      {},
      { kind: 'device-slot', inUse: -1, max: 2, since: 'bad' },
      { kind: 'build-slot', inUse: 2, max: 2, since: 'bad' },
    ]) {
      expect(parseActiveBuild({ ...record, waitingFor })).toEqual(record);
    }
    progress.clear();
    releaseClaim(claim);
  });

  test('records phase transitions under the run claim, reports running, and clears on exit', () => {
    const claim = takeClaim();
    let now = T0;
    const progress = startBuildProgress({ root, platform: 'ios', slot: 'default', claim, now: () => now });
    expect(activeRecord()).toMatchObject({ phase: 'prepare', startedAt: '2026-09-24T10:00:00.000Z' });
    expect(buildReport(activeRecord()!, { state: 'running', history: undefined })).not.toHaveProperty(
      'completedPhaseMs',
    );

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
    expect(buildReport(record, { state: 'running', history: undefined }).completedPhaseMs).toEqual({
      prepare: 2000,
      'cache-lookup': 3000,
    });

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

    recordFinishedBuild(root, finished('2026-09-24T12:00:00.000Z', { offloadedTo: 'mini' }));
    recordFinishedBuild(
      root,
      finished('2026-09-24T12:05:00.000Z', { offloadFallback: 'mini: busy (all 1 build slots busy)' }),
    );
    const [fellBack, offloaded] = readBuildHistory(readWorkspaceState(root)).ios!;
    expect(fellBack).toMatchObject({ offloadFallback: 'mini: busy (all 1 build slots busy)' });
    expect(offloaded).toMatchObject({ offloadedTo: 'mini' });
  });

  test("a run that finds an earlier run's active-build record records that run as interrupted", () => {
    let now = T0;
    const first = takeClaim();
    const killed = startBuildProgress({ root, platform: 'android', slot: 'default', claim: first, now: () => now });
    now += 1_000;
    killed.step('device');
    now += 3_000;
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
        phases: { prepare: 1_000, device: 3_000, compile: 0 },
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

  test('tags samples with the device situation and keeps setup runs beside a flood of reruns', () => {
    let record = emptyStats();
    record = updateStats(record, run({ deviceSetup: true, durationMs: 60_000 }), T0);
    for (let i = 1; i <= HISTORY_LIMIT + 2; i++)
      record = updateStats(record, run({ deviceSetup: false, durationMs: i * 1000 }), T0 + i);
    record = updateStats(record, run({ durationMs: 5_000 }), T0);

    const cold = record.history?.['/repo/app']?.ios?.cold ?? [];
    expect(cold.filter((sample) => sample.deviceSetup === true).map((sample) => sample.durationMs)).toEqual([60_000]);
    expect(cold.filter((sample) => sample.deviceSetup === false)).toHaveLength(HISTORY_LIMIT - 1);
    expect(cold.at(-1)).not.toHaveProperty('deviceSetup');
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
        histSample(100_000, { prepare: 1_000, compile: 80_000 }),
        histSample(300_000, { prepare: 3_000, pods: 40_000, compile: 250_000 }),
        histSample(200_000, { prepare: 2_000, compile: 150_000 }),
        histSample(400_000, { prepare: 2_000 }),
      ],
      hit: [histSample(20_000, { install: 5_000 }, T0 + 1)],
    },
  };

  test('medians comparable runs of the known outcome and plans the phases at least half of them entered', () => {
    expect(estimateBuild(history, 'ios', 'cold')).toEqual({
      outcome: 'cold',
      expectedMs: 250_000,
      basis: 4,
      phaseMs: { prepare: 2_000, pods: 40_000, compile: 150_000 },
      planned: ['prepare', 'compile'],
    });
  });

  test('uses the latest outcome before the cache outcome is known, and nothing without history', () => {
    expect(estimateBuild(history, 'ios', null)).toMatchObject({ outcome: 'hit', expectedMs: 20_000 });
    expect(estimateBuild(undefined, 'android', null)).toEqual({
      outcome: null,
      expectedMs: null,
      basis: 0,
      phaseMs: {},
      planned: [],
    });
  });

  describe("matching the run's device situation", () => {
    const tagged = (durationMs: number, device: number, deviceSetup?: boolean) => ({
      ...histSample(durationMs, { prepare: 1_000, device }),
      ...(deviceSetup === undefined ? {} : { deviceSetup }),
    });
    const mixed: RunHistory = {
      android: {
        hit: [
          tagged(50_000, 45_000, true),
          tagged(60_000, 50_000, true),
          tagged(9_000, 300, false),
          tagged(8_000, 400, false),
          tagged(8_500, 500, false),
          tagged(7_000, 200),
        ],
      },
    };

    test('a run that sets up its device is estimated, every phase included, from setup runs only', () => {
      expect(estimateBuild(mixed, 'android', 'hit', true)).toMatchObject({
        expectedMs: 55_000,
        basis: 2,
        phaseMs: { prepare: 1_000, device: 47_500 },
      });
    });

    test('a run that reuses its device ignores setup runs', () => {
      expect(estimateBuild(mixed, 'android', 'hit', false)).toMatchObject({
        expectedMs: 8_500,
        basis: 3,
        phaseMs: { device: 400 },
      });
    });

    test('fewer than 3 reuse runs are joined by the untagged ones; a setup run never uses them', () => {
      const legacy: RunHistory = {
        android: { hit: [tagged(7_000, 200), tagged(9_000, 600), tagged(30_000, 20_000, false)] },
      };
      expect(estimateBuild(legacy, 'android', 'hit', false)).toMatchObject({
        expectedMs: 9_000,
        basis: 3,
        phaseMs: { device: 600 },
      });
      expect(estimateBuild(legacy, 'android', 'hit', true)).toMatchObject({ expectedMs: null, basis: 0 });
      expect(estimateBuild(mixed, 'android', 'hit')).toMatchObject({ basis: 6 });
    });
  });

  test("a record without the run's estimate is reported from history, and a phase outside the plan keeps its median", () => {
    const at = (ms: number) => new Date(T0 + ms).toISOString();
    const record: ActiveBuildRecord = {
      platform: 'ios',
      slot: 'default',
      startedAt: at(0),
      phase: 'pods',
      phaseStartedAt: at(10_000),
      phases: [
        { phase: 'prepare', startedAt: at(0) },
        { phase: 'pods', startedAt: at(10_000) },
      ],
      claim: { root: '/x', path: '/x/c', claimId: 'c', pid: 1 },
      outcome: 'cold',
    };
    const report = buildReport(record, { state: 'running', history });
    expect(report).toMatchObject({
      outcome: 'cold',
      outcomeKnown: true,
      expectedMs: 250_000,
      expectedPhaseMs: 40_000,
      basis: 4,
      plannedPhases: [
        { phase: 'prepare', expectedMs: 2_000 },
        { phase: 'compile', expectedMs: 150_000 },
      ],
    });
    expect(buildStatusLine(report, T0 + 70_000)).toBe(
      'build: ios pods, 1m10s elapsed -- about 3 min left (median of 4 cold runs)',
    );
    expect(buildStatusLine(report, T0 + 300_000)).toBe(
      'build: ios pods, 5m00s elapsed (usually ~4m10s, median of 4 cold runs)',
    );
    const { outcome: _, ...unsettled } = record;
    expect(buildReport(unsettled, { state: 'running', history })).toMatchObject({
      outcome: 'hit',
      outcomeKnown: false,
      expectedMs: 20_000,
      plannedPhases: [{ phase: 'install', expectedMs: 5_000 }],
    });
    expect(buildReport(unsettled, { state: 'running', history: undefined }).plannedPhases).toBeNull();
  });

  describe('a live run', () => {
    const projectKey = '/repo/app';
    let recorded = 0;
    const sample = (
      durationMs: number,
      phases: Record<string, number>,
      deviceSetup: boolean,
      cacheHit: 'local' | false,
    ) => recordRunStats(run({ projectKey, durationMs, phases, deviceSetup, cacheHit }), T0 + recorded++);

    beforeEach(() => {
      for (const ms of [20_000, 22_000, 24_000]) sample(ms, { prepare: 1_000, install: 4_000 }, false, 'local');
      for (const ms of [60_000, 70_000, 80_000]) sample(ms, { prepare: 30_000, install: 4_000 }, true, 'local');
      sample(200_000, { prepare: 1_000, compile: 180_000 }, false, false);
    });

    function live() {
      const claim = takeClaim();
      let now = T0;
      const progress = startBuildProgress({ root, platform: 'ios', slot: 'default', claim, now: () => now });
      const report = () => buildReport(activeRecord()!, { state: 'running', history: undefined });
      return { claim, progress, report, advance: (ms: number) => (now += ms) };
    }

    test('estimates once from the latest outcome and once when its outcome is known, never on later history', () => {
      const { claim, progress, report, advance } = live();
      progress.estimate(projectKey);
      expect(report()).toMatchObject({ outcome: 'cold', outcomeKnown: false, expectedMs: 200_000, basis: 1 });
      progress.deviceSetup(false);
      advance(1_000);
      progress.step('cache-lookup');
      expect(report()).toMatchObject({ outcomeKnown: false, expectedMs: 200_000 });
      expect(report()).not.toHaveProperty('cacheLookupOutcome');

      advance(2_000);
      progress.step('device');
      const settled = report();
      expect(settled).toMatchObject({
        outcome: 'hit',
        outcomeKnown: true,
        cacheLookupOutcome: 'hit',
        expectedMs: 22_000,
        basis: 3,
        plannedPhases: [
          { phase: 'prepare', expectedMs: 1_000 },
          { phase: 'install', expectedMs: 4_000 },
        ],
      });

      sample(90_000, { prepare: 1_000, install: 80_000 }, false, 'local');
      advance(1_000);
      progress.step('install');
      const { expectedMs, basis, plannedPhases } = settled;
      expect(report()).toMatchObject({ phase: 'install', expectedPhaseMs: 4_000, expectedMs, basis, plannedPhases });
      progress.clear();
      releaseClaim(claim);
    });

    test("a miss before prebuild or pods is this run's cold outcome until the re-check hits", () => {
      const { claim, progress, report } = live();
      const reason = {
        kind: 'changed' as const,
        summary: 'native dependency added: expo-clipboard',
        changes: [],
        changeCount: 1,
        baseline: null,
        rekeyedBy: [],
      };
      progress.estimate(projectKey);
      progress.step('cache-lookup');
      progress.miss(reason, true);
      progress.step('pods');
      expect(report()).toMatchObject({
        outcome: 'cold',
        outcomeKnown: true,
        missProvisional: true,
        cacheLookupOutcome: 'miss',
        missReason: reason,
      });

      progress.hit();
      progress.step('device');
      const hit = report();
      expect(hit).toMatchObject({ outcome: 'hit', outcomeKnown: true, cacheLookupOutcome: 'hit' });
      expect(hit).not.toHaveProperty('missReason');
      expect(hit).not.toHaveProperty('missProvisional');
      progress.clear();
      releaseClaim(claim);
    });

    test('a run that skips cache lookup reports its outcome without inventing a lookup result', () => {
      const { claim, progress, report } = live();
      progress.estimate(projectKey);
      progress.step('device');
      expect(report()).not.toHaveProperty('cacheLookupOutcome');
      progress.step('install');
      expect(report()).toMatchObject({ outcome: 'hit', outcomeKnown: true });
      expect(report()).not.toHaveProperty('cacheLookupOutcome');
      progress.clear();
      releaseClaim(claim);
    });

    test('the final miss settles a provisional one', () => {
      const { claim, progress, report } = live();
      const reason = { kind: 'changed' as const, summary: 'x', changes: [], changeCount: 0, baseline: null };
      progress.miss({ ...reason, rekeyedBy: [] }, true);
      progress.miss({ ...reason, rekeyedBy: ['pod install'] });
      expect(report()).toMatchObject({ missReason: { rekeyedBy: ['pod install'] } });
      expect(report()).not.toHaveProperty('missProvisional');
      progress.clear();
      releaseClaim(claim);
    });

    test('a native build step settles a cold outcome, and a run that set up its device uses setup runs', () => {
      const { claim, progress, report } = live();
      progress.estimate(projectKey);
      progress.deviceSetup(true);
      progress.step('cache-lookup');
      progress.step('compile');
      expect(report()).toMatchObject({ outcome: 'cold', outcomeKnown: true, expectedMs: null, basis: 0 });
      progress.step('device');
      expect(report()).toMatchObject({ outcome: 'cold', basis: 0 });
      progress.clear();
      releaseClaim(claim);
    });
  });
});
