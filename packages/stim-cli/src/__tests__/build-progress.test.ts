import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseClaim, tryAcquireClaim, type ClaimHandle } from '../ownership-claim.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import {
  ACTIVE_BUILD_KEY,
  activeBuildState,
  buildReport,
  buildStatusLine,
  bundlingActivity,
  parseActiveBuild,
  recordBuildPhase,
  recordFinishedBuild,
  startBuildProgress,
  type ActiveBuildRecord,
} from '../engine/build-progress.ts';
import { BUILD_HISTORY_LIMIT, readBuildDetail, readBuildHistory, readLastBuilds } from '@stim-cli/core/state';
import { type RunHistory } from '../engine/stats.ts';
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
      vi.clearAllTimers();
    }
  });

  test('reports where the build runs: local, then the remote machine and its phase there, then local again', () => {
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

  test('the launch activity takes Metro percent only for its own request and ends with the phase', () => {
    const claim = takeClaim();
    let now = T0;
    const progress = startBuildProgress({ root, platform: 'ios', slot: 'default', claim, now: () => now });
    const report = () => buildReport(activeRecord()!, { state: 'running', history: undefined });
    progress.step('launch');
    now += 4_000;
    progress.activity('bundling', T0 + 3_000);
    const startedAt = new Date(T0 + 3_000).toISOString();
    expect(report().activity).toEqual({ name: 'bundling', startedAt });

    const own = { bundling: true, platform: 'ios' as const, startedAt, percent: 45 };
    expect(bundlingActivity(report().activity, 'ios', own)).toEqual({ name: 'bundling', startedAt, percent: 45 });
    const prefetch = { ...own, startedAt: new Date(T0 + 1_000).toISOString() };
    expect(bundlingActivity(report().activity, 'ios', prefetch)).toEqual({ name: 'bundling', startedAt });
    expect(bundlingActivity(report().activity, 'ios', { ...own, platform: 'android' })?.percent).toBeUndefined();
    expect(
      buildStatusLine({ ...report(), activity: bundlingActivity(report().activity, 'ios', own) }, now + 2_000),
    ).toBe('build: ios launch (bundling JS 45%, 3s), 6s elapsed');

    progress.activity('waiting-ready');
    expect(buildStatusLine(report(), now)).toBe('build: ios launch (waiting for app ready, 0s), 4s elapsed');
    progress.activity(null);
    expect(report().activity).toBeUndefined();
    progress.activity('bundling');
    progress.step('device');
    expect(report().activity).toBeUndefined();
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

  test('a record whose claim was released or whose owner is gone is stale, never running', () => {
    const claim = takeClaim();
    startBuildProgress({ root, platform: 'ios', slot: 'default', claim });
    releaseClaim(claim);
    expect(activeBuildState(activeRecord()!.claim)).toBe('stale');

    const lock = join(home, 'gone.lock');
    const path = plantClaim(lock, 'exclusive', goneClaimOwner(), { claimId: 'gone-claim' });
    expect(activeBuildState({ root: lock, path, claimId: 'gone-claim', pid: 1 })).toBe('stale');
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
});

describe('macOS builds', () => {
  const macosFinished = {
    platform: 'macos',
    status: 'ok',
    configuration: 'Debug',
    fingerprint: null,
    cacheKey: null,
    cacheHit: false,
    cacheSkipped: false,
    durationMs: 90_000,
    startedAt: '2026-09-24T10:00:00.000Z',
  };

  test('a run reports its phases and SwiftPM counts without a cache outcome, and keeps only history', () => {
    vi.useFakeTimers({ now: T0 });
    try {
      const claim = takeClaim();
      let now = T0;
      const progress = startBuildProgress({ root, platform: 'macos', slot: 'default', claim, now: () => now });
      now += 2_000;
      progress.step('compile');
      progress.output({ src: 'build', level: 'debug', msg: '[12 / 40] StimDesktop' });
      vi.advanceTimersByTime(0);
      expect(readBuildDetail(root, claim.claimId)).toMatchObject({
        step: 'compile',
        unit: 'steps',
        done: 12,
        total: 40,
      });

      const record = activeRecord()!;
      expect(record).toMatchObject({ platform: 'macos', phase: 'compile' });
      expect(record.outcome).toBeUndefined();
      const report = buildReport(record, { state: 'running', history: undefined });
      expect(report).toMatchObject({ platform: 'macos', phase: 'compile', outcome: null, plannedPhases: null });

      now += 60_000;
      progress.step('install');
      now += 3_000;
      expect(progress.steps()).toBe(40);
      recordFinishedBuild(root, { ...macosFinished, compileSteps: progress.steps() }, { now: () => now });
      progress.step('launch');
      now += 1_500;
      recordBuildPhase(root, 'macos', macosFinished.startedAt, 'launch', progress.durations().launch!);
      progress.clear();
      releaseClaim(claim);

      const state = readWorkspaceState(root);
      expect(state?.lastBuild).toBeUndefined();
      expect(readLastBuilds(state).ios).toBeUndefined();
      expect(readBuildHistory(state).macos).toEqual([
        expect.objectContaining({
          platform: 'macos',
          result: 'succeeded',
          phases: { prepare: 2_000, compile: 60_000, install: 3_000, launch: 1_500 },
          compileSteps: 40,
        }),
      ]);
    } finally {
      vi.clearAllTimers();
    }
  });

  test('a finished macOS run is not mistaken for an interrupted one', () => {
    const first = takeClaim();
    startBuildProgress({ root, platform: 'macos', slot: 'default', claim: first, now: () => T0 });
    recordFinishedBuild(root, macosFinished);
    releaseClaim(first);
    const second = takeClaim();
    startBuildProgress({ root, platform: 'macos', slot: 'default', claim: second, now: () => T0 + 60_000 }).clear();
    releaseClaim(second);

    expect(readBuildHistory(readWorkspaceState(root)).macos!.map((entry) => entry.result)).toEqual(['succeeded']);
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
});
