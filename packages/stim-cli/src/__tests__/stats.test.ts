import { getSwiftpmCacheUsage } from '../devices/swiftpm-cache-usage.ts';
import { getAgentDeviceUsage } from '../devices/agent-device-usage.ts';
import assert from 'node:assert';
import { execFileSync, execSync } from 'node:child_process';
import { runStats as runServerStats } from '../../../server/src/stats.ts';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { Command } from 'commander';
import { resetExecutor, setExecutor } from '../exec.ts';
import statsCommand from '../commands/stats.ts';
import {
  createRunRecorder,
  emptyStats,
  offloadSummary,
  PLACEMENT_LIMIT,
  readRunEstimates,
  readStats,
  recordRunStats,
  statsFile,
  statsProjectKey,
  updateStats,
  type StatsBucket,
  type StatsRecord,
  type StatsRun,
} from '../engine/stats.ts';

const T0 = Date.parse('2026-09-01T10:00:00.000Z');
const T1 = Date.parse('2026-09-02T10:00:00.000Z');

let tmpHome: string;
let root: string;

beforeEach(() => {
  tmpHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-test-')));
  process.env.STIM_HOME = tmpHome;
  vi.stubEnv('HOME', tmpHome);
  vi.stubEnv('USERPROFILE', tmpHome);
  vi.stubEnv('XDG_CACHE_HOME', join(tmpHome, '.cache'));
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', '');
  vi.stubEnv('AGENT_DEVICE_IOS_RUNNER_LEASE_DIR', '');
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-ws-')));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
  setExecutor({
    run: () => '',
    runQuiet: () => null,
    runFileQuiet: () => null,
    spawn() {
      throw new Error('stats spawns nothing');
    },
  });
});

afterEach(() => {
  resetExecutor();
  vi.unstubAllEnvs();
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function run(overrides: Partial<StatsRun> = {}): StatsRun {
  return {
    platform: 'ios',
    projectKey: '/repo/app',
    failed: false,
    cacheHit: false,
    waitedForBuild: false,
    durationMs: 60_000,
    ...overrides,
  };
}

function bucketOf(record: StatsRecord, key: string): StatsBucket {
  const bucket = record.projects[key]?.ios;
  assert(bucket);
  return bucket;
}

describe('the update rule', () => {
  test('a miss records a cold run and creates the bucket with both timestamps', () => {
    const record = updateStats(emptyStats(), run({ durationMs: 240_000 }), T0);
    const bucket = bucketOf(record, '/repo/app');

    expect(bucket).toEqual({
      runs: 1,
      failed: 0,
      hits: 0,
      misses: 1,
      coldRuns: 1,
      coldRunMs: 240_000,
      hitRuns: 0,
      hitRunMs: 0,
      timeSavedMs: 0,
      firstRunAt: '2026-09-01T10:00:00.000Z',
      lastRunAt: '2026-09-01T10:00:00.000Z',
    });
    expect(record.machine.ios).toEqual(bucket);
    expect(record.version).toBe(1);
  });

  test('a hit after a cold run is credited the mean cold run minus its own duration', () => {
    let record = updateStats(emptyStats(), run({ durationMs: 240_000 }), T0);
    record = updateStats(record, run({ durationMs: 120_000 }), T0);
    record = updateStats(record, run({ cacheHit: 'local', durationMs: 30_000 }), T1);
    const bucket = bucketOf(record, '/repo/app');

    expect(bucket.runs).toBe(3);
    expect(bucket.hits).toBe(1);
    expect(bucket.misses).toBe(2);
    expect(bucket.hitRuns).toBe(1);
    expect(bucket.hitRunMs).toBe(30_000);
    expect(bucket.timeSavedMs).toBe(150_000);
    expect(bucket.coldRunMs).toBe(360_000);
    expect(bucket.firstRunAt).toBe('2026-09-01T10:00:00.000Z');
    expect(bucket.lastRunAt).toBe('2026-09-02T10:00:00.000Z');
  });

  test('a remote hit counts like a local one', () => {
    let record = updateStats(emptyStats(), run({ durationMs: 200_000 }), T0);
    record = updateStats(record, run({ cacheHit: 'remote', durationMs: 20_000 }), T1);

    expect(bucketOf(record, '/repo/app').hits).toBe(1);
    expect(bucketOf(record, '/repo/app').timeSavedMs).toBe(180_000);
  });

  test('a hit slower than the mean cold run credits nothing rather than a negative', () => {
    let record = updateStats(emptyStats(), run({ durationMs: 20_000 }), T0);
    record = updateStats(record, run({ cacheHit: 'local', durationMs: 90_000 }), T1);

    expect(bucketOf(record, '/repo/app').timeSavedMs).toBe(0);
    expect(bucketOf(record, '/repo/app').hitRunMs).toBe(90_000);
  });

  test('a hit that waited for another workspace counts as a hit and nothing else', () => {
    let record = updateStats(emptyStats(), run({ durationMs: 240_000 }), T0);
    record = updateStats(record, run({ cacheHit: 'local', waitedForBuild: true, durationMs: 30_000 }), T1);
    const bucket = bucketOf(record, '/repo/app');

    expect(bucket.runs).toBe(2);
    expect(bucket.hits).toBe(1);
    expect(bucket.hitRuns).toBe(0);
    expect(bucket.hitRunMs).toBe(0);
    expect(bucket.timeSavedMs).toBe(0);
    expect(record.machine.ios?.timeSavedMs).toBe(0);
  });

  test('a hit with no cold run for this project and platform credits nothing', () => {
    let record = updateStats(emptyStats(), run({ platform: 'android', durationMs: 600_000 }), T0);
    record = updateStats(record, run({ projectKey: '/repo/other', durationMs: 600_000 }), T0);
    record = updateStats(record, run({ cacheHit: 'local', durationMs: 30_000 }), T1);
    const bucket = bucketOf(record, '/repo/app');

    expect(record.machine.ios?.coldRuns).toBe(1);
    expect(bucket.hits).toBe(1);
    expect(bucket.timeSavedMs).toBe(0);
    expect(record.machine.ios?.timeSavedMs).toBe(0);
  });

  test('a failed run counts as a run and a failure and nothing else', () => {
    let record = updateStats(emptyStats(), run({ durationMs: 240_000 }), T0);
    record = updateStats(record, run({ failed: true, cacheHit: 'local', durationMs: 5_000 }), T1);
    const bucket = bucketOf(record, '/repo/app');

    expect(bucket.runs).toBe(2);
    expect(bucket.failed).toBe(1);
    expect(bucket.hits).toBe(0);
    expect(bucket.misses).toBe(1);
    expect(bucket.hitRuns).toBe(0);
    expect(bucket.coldRuns).toBe(1);
    expect(bucket.lastRunAt).toBe('2026-09-02T10:00:00.000Z');
  });

  test('the machine bucket moves in lockstep with the projects that feed it', () => {
    let record = updateStats(emptyStats(), run({ durationMs: 240_000 }), T0);
    record = updateStats(record, run({ projectKey: '/repo/other', durationMs: 400_000 }), T0);
    record = updateStats(record, run({ cacheHit: 'local', durationMs: 40_000 }), T1);
    record = updateStats(record, run({ projectKey: '/repo/other', cacheHit: 'local', durationMs: 40_000 }), T1);

    const machine = record.machine.ios;
    assert(machine);
    expect(machine.runs).toBe(4);
    expect(machine.hits).toBe(2);
    expect(machine.coldRunMs).toBe(640_000);
    expect(machine.timeSavedMs).toBe(200_000 + 360_000);
    expect(machine.timeSavedMs).toBe(
      bucketOf(record, '/repo/app').timeSavedMs + bucketOf(record, '/repo/other').timeSavedMs,
    );
  });

  test('a platform keeps its own bucket', () => {
    let record = updateStats(emptyStats(), run({ durationMs: 100_000 }), T0);
    record = updateStats(record, run({ platform: 'android', durationMs: 300_000 }), T0);

    expect(record.projects['/repo/app']?.ios?.coldRunMs).toBe(100_000);
    expect(record.projects['/repo/app']?.android?.coldRunMs).toBe(300_000);
    expect(record.machine.android?.runs).toBe(1);
  });

  test('milliseconds stay whole numbers', () => {
    let record = updateStats(emptyStats(), run({ durationMs: 240_000.6 }), T0);
    record = updateStats(record, run({ durationMs: 100_001 }), T0);
    record = updateStats(record, run({ cacheHit: 'local', durationMs: 30_000.4 }), T1);
    const bucket = bucketOf(record, '/repo/app');

    expect(bucket.coldRunMs).toBe(340_002);
    expect(bucket.hitRunMs).toBe(30_000);
    expect(bucket.timeSavedMs).toBe(140_001);
    expect(Number.isInteger(bucket.timeSavedMs)).toBe(true);
  });

  test('a miss that compiled records the build phase, in both buckets', () => {
    const record = updateStats(emptyStats(), run({ durationMs: 240_000, coldBuildMs: 190_000 }), T0);

    expect(bucketOf(record, '/repo/app').lastColdBuildMs).toBe(190_000);
    expect(record.machine.ios?.lastColdBuildMs).toBe(190_000);
  });

  test('a pod install records its own duration, in both buckets', () => {
    const record = updateStats(emptyStats(), run({ durationMs: 240_000, podsMs: 100_000 }), T0);

    expect(bucketOf(record, '/repo/app').lastPodsMs).toBe(100_000);
    expect(record.machine.ios?.lastPodsMs).toBe(100_000);
  });

  test('a run that compiled and then failed still records the cold build it paid for', () => {
    const record = updateStats(emptyStats(), run({ failed: true, durationMs: 200_000, coldBuildMs: 190_000 }), T0);
    const bucket = bucketOf(record, '/repo/app');

    expect(bucket.lastColdBuildMs).toBe(190_000);
    expect(record.machine.ios?.lastColdBuildMs).toBe(190_000);
    expect(bucket.failed).toBe(1);
    expect(bucket.coldRuns).toBe(0);
    expect(bucket.coldRunMs).toBe(0);
    expect(bucket.misses).toBe(0);
  });

  test('the last value wins: a later cold build replaces the one before it', () => {
    let record = updateStats(emptyStats(), run({ durationMs: 240_000, coldBuildMs: 190_000, podsMs: 100_000 }), T0);
    record = updateStats(record, run({ durationMs: 300_000, coldBuildMs: 250_000 }), T1);
    const bucket = bucketOf(record, '/repo/app');

    expect(bucket.lastColdBuildMs).toBe(250_000);
    expect(bucket.lastPodsMs).toBe(100_000);
  });

  test('a run with no long phase leaves both fields exactly as they were', () => {
    let record = updateStats(emptyStats(), run({ durationMs: 240_000, coldBuildMs: 190_000, podsMs: 100_000 }), T0);
    record = updateStats(record, run({ cacheHit: 'local', durationMs: 30_000 }), T1);
    record = updateStats(record, run({ failed: true, durationMs: 5_000 }), T1);
    const bucket = bucketOf(record, '/repo/app');

    expect(bucket.lastColdBuildMs).toBe(190_000);
    expect(bucket.lastPodsMs).toBe(100_000);
  });

  test('a bucket that never compiled carries neither field, so the payload is unchanged', () => {
    const record = updateStats(emptyStats(), run({ durationMs: 240_000 }), T0);
    const bucket = bucketOf(record, '/repo/app');

    expect('lastColdBuildMs' in bucket).toBe(false);
    expect('lastPodsMs' in bucket).toBe(false);
  });

  test('the input record is not mutated', () => {
    const before = updateStats(emptyStats(), run({ durationMs: 240_000 }), T0);
    const snapshot = JSON.stringify(before);
    updateStats(before, run({ cacheHit: 'local', durationMs: 10_000 }), T1);

    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('build placements', () => {
  const here = { decision: 'here' as const, reason: 'load 0.6/core, 1 of 3 build slots busy here' };

  test('a compiling run records where it built, why, and the local estimate it is compared with', () => {
    let record = updateStats(emptyStats(), run({ coldBuildMs: 300_000 }), T0);
    record = updateStats(
      record,
      run({
        placement: { decision: 'offloaded', machine: 'mini', reason: 'this Mac is busy: slots', buildMs: 180_000 },
      }),
      T0 + 1000,
    );

    expect(record.placements).toEqual([
      {
        at: new Date(T0 + 1000).toISOString(),
        project: '/repo/app',
        platform: 'ios',
        decision: 'offloaded',
        reason: 'this Mac is busy: slots',
        machine: 'mini',
        buildMs: 180_000,
        localEstimateMs: 300_000,
      },
    ]);
    expect(record.buildMachines).toEqual({
      mini: {
        offloaded: 1,
        offloadedMs: 180_000,
        savedMs: 120_000,
        fallbacks: 0,
        lastOffloadAt: new Date(T0 + 1000).toISOString(),
      },
    });
  });

  test('a build here takes its compile time, counts for no machine, and a failed one is marked', () => {
    const record = updateStats(emptyStats(), run({ failed: true, coldBuildMs: 250_000, placement: here }), T0);

    expect(record.placements?.[0]).toMatchObject({ decision: 'here', buildMs: 250_000, failed: true });
    expect(record.buildMachines).toBeUndefined();
  });

  test.each([
    { slotWaitMs: 12.6, expected: { slotWaitMs: 13 } },
    { slotWaitMs: 0, expected: {} },
  ])('a compiling run persists whole positive slot wait milliseconds ($slotWaitMs)', ({ slotWaitMs, expected }) => {
    const recorder = createRunRecorder({
      platform: 'ios',
      write: recordRunStats,
      now: () => T0,
      note: () => {},
    });
    recorder.setProject(root);
    recorder.setCacheKey('ios-abc');
    recorder.setBuildMs(250_000);
    recorder.setPlacement({ ...here, slotWaitMs });
    recorder.record({ failed: false, durationMs: 300_000 });

    const stored = JSON.parse(readFileSync(statsFile(), 'utf-8')).placements[0];
    const loaded = readStats().record?.placements?.[0];
    expect(stored).toEqual({
      ...here,
      at: new Date(T0).toISOString(),
      project: root,
      platform: 'ios',
      buildMs: 250_000,
      ...expected,
    });
    expect(loaded).toEqual(stored);
  });

  test.each([-1, 0, 'invalid', 'Infinity', null, {}])(
    'invalid slot wait values are dropped on read (%s)',
    (slotWaitMs) => {
      writeFileSync(
        statsFile(),
        JSON.stringify({
          ...emptyStats(),
          placements: [
            { ...here, at: new Date(T0).toISOString(), project: root, platform: 'ios', buildMs: 250_000, slotWaitMs },
          ],
        }),
      );

      const placement = readStats().record?.placements?.[0];
      expect(placement?.buildMs).toBe(250_000);
      expect(placement).not.toHaveProperty('slotWaitMs');
    },
  );

  test('a fallback counts against its machine', () => {
    const record = updateStats(
      emptyStats(),
      run({
        placement: { decision: 'fell-back', machine: 'mini', reason: 'mini: toolchain mismatch: Xcode 26.1 there' },
      }),
      T0,
    );

    expect(record.buildMachines?.mini).toEqual({
      offloaded: 0,
      offloadedMs: 0,
      savedMs: 0,
      fallbacks: 1,
      lastFallbackAt: new Date(T0).toISOString(),
    });
  });

  test('a run without a placement leaves the list alone', () => {
    const record = updateStats(emptyStats(), run({ cacheHit: 'local' }), T0);

    expect(record).not.toHaveProperty('placements');
  });

  test('the list keeps the newest entries within a week', () => {
    let record = updateStats(emptyStats(), run({ placement: { ...here, reason: 'old' } }), T0);
    for (let i = 0; i < PLACEMENT_LIMIT + 5; i++) {
      record = updateStats(record, run({ placement: { ...here, reason: `r${i}` } }), T0 + 8 * 86_400_000 + i);
    }

    expect(record.placements).toHaveLength(PLACEMENT_LIMIT);
    expect(record.placements?.[0]?.reason).toBe('r5');
    expect(record.placements?.some((each) => each.reason === 'old')).toBe(false);
  });

  test('today follows local midnight, with signed savings and lifetime totals', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'America/Toronto';
    try {
      const yesterday = Date.parse('2026-09-02T03:59:00Z');
      const today = Date.parse('2026-09-02T04:01:00Z');
      let record = updateStats(emptyStats(), run({ coldBuildMs: 50_000, placement: here }), yesterday);
      record = updateStats(
        record,
        run({ placement: { decision: 'offloaded', machine: 'mini', reason: 'busy', buildMs: 100_000 } }),
        today,
      );
      const summary = offloadSummary(record, today);
      expect(summary.today).toEqual({ here: 0, offloaded: 1, fellBack: 0 });
      expect(summary.machines.mini?.today).toMatchObject({ offloaded: 1, savedMs: -50_000 });
      expect(summary.machines.mini?.total).toMatchObject({ offloaded: 1, savedMs: -50_000 });
      expect(summary.placements.map((entry) => entry.decision)).toEqual(['offloaded', 'here']);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  test('a file written before placements, or with malformed ones, still reads', () => {
    writeFileSync(
      statsFile(),
      JSON.stringify({
        version: 1,
        machine: {},
        projects: {},
        placements: [
          { decision: 'teleported', platform: 'ios', reason: 'x', project: '/p' },
          'junk',
          { ...here, platform: 'ios', project: '/p', at: 'x' },
        ],
        buildMachines: { mini: { offloaded: 'two', savedMs: -5 } },
      }),
    );

    const { record } = readStats();

    expect(record?.placements).toEqual([{ ...here, platform: 'ios', project: '/p', at: 'x' }]);
    expect(record?.buildMachines?.mini).toEqual({ offloaded: 0, offloadedMs: 0, savedMs: -5, fallbacks: 0 });
  });
});

describe('the stats file', () => {
  test('a run is written under the config lock and read back', () => {
    const outcome = recordRunStats(run({ projectKey: root, durationMs: 240_000 }), T0);

    expect(outcome).toEqual({ recorded: true, note: null });
    expect(existsSync(statsFile())).toBe(true);
    expect(readStats().record?.projects[root]?.ios?.coldRunMs).toBe(240_000);
    expect(readFileSync(statsFile(), 'utf-8').split('\n')).toHaveLength(2);
  });

  test('a file from a newer Stim is left untouched and the run records nothing', () => {
    const newer = JSON.stringify({ version: 2, machine: {}, projects: {} });
    writeFileSync(statsFile(), newer);

    const outcome = recordRunStats(run({ projectKey: root }), T0);

    expect(outcome.recorded).toBe(false);
    expect(outcome.note).toMatch(/version 2/);
    expect(readFileSync(statsFile(), 'utf-8')).toBe(newer);
    expect(readStats().record).toBe(null);
    expect(readStats().note).toMatch(/version 2/);
  });

  test('a corrupt file is renamed aside, a fresh one is started, and the run is recorded', () => {
    writeFileSync(statsFile(), '{ this is not json');

    const outcome = recordRunStats(run({ projectKey: root, durationMs: 5_000 }), T0);

    expect(outcome.recorded).toBe(true);
    expect(outcome.note).toMatch(/moved to /);
    expect(readFileSync(`${statsFile()}.corrupt-${T0}`, 'utf-8')).toBe('{ this is not json');
    expect(readStats().record?.projects[root]?.ios?.runs).toBe(1);
  });

  test('a file that parses to something other than a versioned object is corrupt too', () => {
    writeFileSync(statsFile(), JSON.stringify([1, 2, 3]));
    expect(recordRunStats(run({ projectKey: root }), T0).note).toMatch(/moved to /);

    writeFileSync(statsFile(), JSON.stringify({ machine: {}, projects: {} }));
    expect(recordRunStats(run({ projectKey: root }), T1).note).toMatch(/moved to /);
    expect(readdirSync(tmpHome).filter((name) => name.includes('corrupt-'))).toHaveLength(2);
  });

  test('the recorder writes nowhere but STIM_HOME and creates no config.json', () => {
    recordRunStats(run({ projectKey: root }), T0);

    expect(statsFile()).toBe(join(tmpHome, 'stats.json'));
    expect(existsSync(join(tmpHome, 'config.json'))).toBe(false);
  });

  test('the project key is the app path in the source checkout, canonical', () => {
    const repo = join(realpathSync.native(tmpHome), 'repo');
    mkdirSync(repo);
    const worktree = join(repo, 'worktrees', 'agent-1');

    expect(
      statsProjectKey({ root: join(worktree, 'apps', 'mobile'), commonDir: join(repo, '.git'), repoRoot: worktree }),
    ).toBe(join(repo, 'apps', 'mobile'));
    expect(statsProjectKey({ root, commonDir: null, repoRoot: null })).toBe(root);
    expect(statsProjectKey({ root, commonDir: join(repo, 'bare.git'), repoRoot: repo })).toBe(root);

    mkdirSync(join(worktree, 'apps', 'mobile'), { recursive: true });
    const alias = join(repo, 'alias');
    symlinkSync(worktree, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const key = statsProjectKey({
      root: join(alias, 'apps', 'mobile'),
      commonDir: join(repo, '.git'),
      repoRoot: worktree,
    });
    expect(key).toBe(join(repo, 'apps', 'mobile'));
    recordRunStats(run({ projectKey: key, coldBuildMs: 1200 }), T0);
    expect(readRunEstimates({ projectKey: join(repo, 'apps', 'mobile'), platform: 'ios' }).coldBuildMs).toBe(1200);
    expect(Object.keys(readStats().record!.projects)).toEqual([key]);

    rmSync(repo, { recursive: true, force: true });
  });
});

describe('the run recorder', () => {
  function recorderFor(writes: { run: StatsRun; now: number }[]) {
    const recorder = createRunRecorder({
      platform: 'ios',
      write: (statsRun, at) => {
        writes.push({ run: statsRun, now: at });
        return { recorded: true, note: null };
      },
      now: () => T0,
      note: () => {},
    });
    recorder.setProject('/repo/app');
    recorder.setCacheKey('ios-abc');
    return recorder;
  }

  test('the build and pod install durations reach the record', () => {
    const writes: { run: StatsRun; now: number }[] = [];
    const recorder = recorderFor(writes);
    recorder.setPodsMs(100_000);
    recorder.setBuildMs(190_000);
    recorder.record({ failed: false, cacheHit: false, durationMs: 300_000 });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.run.coldBuildMs).toBe(190_000);
    expect(writes[0]?.run.podsMs).toBe(100_000);
  });

  test('the placement set during the run reaches the record, failed or not', () => {
    const writes: { run: StatsRun; now: number }[] = [];
    const recorder = recorderFor(writes);
    recorder.setPlacement({ decision: 'fell-back', machine: 'mini', reason: 'mini: unreachable' });
    recorder.record({ failed: true, durationMs: 5_000 });

    expect(writes[0]?.run.placement).toEqual({ decision: 'fell-back', machine: 'mini', reason: 'mini: unreachable' });
  });

  test('a run with neither phase sends neither field', () => {
    const writes: { run: StatsRun; now: number }[] = [];
    recorderFor(writes).record({ failed: false, cacheHit: 'local', durationMs: 30_000 });

    expect(writes[0]?.run).not.toHaveProperty('coldBuildMs');
    expect(writes[0]?.run).not.toHaveProperty('podsMs');
  });
});

describe('the estimates a run reads back', () => {
  test('the project bucket supplies the last cold build and the last pod install', () => {
    const record = updateStats(emptyStats(), run({ projectKey: root, coldBuildMs: 190_000, podsMs: 100_000 }), T0);
    writeFileSync(statsFile(), JSON.stringify(record));

    expect(readRunEstimates({ projectKey: root, platform: 'ios' })).toEqual({
      coldBuildMs: 190_000,
      podsMs: 100_000,
    });
  });

  test('another project, another platform, and no file at all all read as no record', () => {
    const record = updateStats(emptyStats(), run({ projectKey: root, coldBuildMs: 190_000 }), T0);
    writeFileSync(statsFile(), JSON.stringify(record));

    expect(readRunEstimates({ projectKey: '/elsewhere', platform: 'ios' })).toEqual({
      coldBuildMs: null,
      podsMs: null,
    });
    expect(readRunEstimates({ projectKey: root, platform: 'android' })).toEqual({
      coldBuildMs: null,
      podsMs: null,
    });
    rmSync(statsFile(), { force: true });
    expect(readRunEstimates({ projectKey: root, platform: 'ios' })).toEqual({ coldBuildMs: null, podsMs: null });
    expect(readRunEstimates({ projectKey: null, platform: 'ios' })).toEqual({ coldBuildMs: null, podsMs: null });
  });

  test('a corrupt file and a throwing read are silent: the run gets no estimate and no note', () => {
    writeFileSync(statsFile(), 'not json at all');

    expect(readRunEstimates({ projectKey: root, platform: 'ios' })).toEqual({ coldBuildMs: null, podsMs: null });
    expect(
      readRunEstimates({
        projectKey: root,
        platform: 'ios',
        read: () => {
          throw new Error('nope');
        },
      }),
    ).toEqual({ coldBuildMs: null, podsMs: null });
    expect(readFileSync(statsFile(), 'utf-8')).toBe('not json at all');
  });
});

async function runStats(argv: string[] = []): Promise<{ out: string[]; err: string[] }> {
  const program = new Command();
  statsCommand(program);
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (msg) => out.push(String(msg));
  console.error = (msg) => err.push(String(msg));
  try {
    await program.parseAsync(['node', 'stim', 'stats', ...argv]);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { out, err };
}

async function inDir<T>(dir: string, fn: () => T): Promise<Awaited<T>> {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

describe('stim stats', async () => {
  test('prints the project section and the machine section', async () => {
    let record = updateStats(emptyStats(), run({ projectKey: root, durationMs: 252_000 }), T0);
    record = updateStats(record, run({ projectKey: root, cacheHit: 'local', durationMs: 31_000 }), T1);
    record = updateStats(record, run({ projectKey: root, failed: true, durationMs: 4_000 }), T1);
    record = updateStats(record, run({ projectKey: '/elsewhere', platform: 'android', durationMs: 400_000 }), T1);
    writeFileSync(statsFile(), JSON.stringify(record));

    const { out: lines, err } = await inDir(root, () => runStats());

    expect(lines[0]).toBe(`project ${root}`);
    expect(lines[1]).toMatch(
      /^ {2}ios {6}3 runs \(1 failed\) {3}1 hits \(50%\) {3}cold run 4m12s avg {3}hit run 31s avg {3}saved ~3m41s \(estimated\) {3}since 2026-09-01$/,
    );
    expect(err).toEqual([]);
    expect(lines).toContain('machine');
    const machine = lines.slice(lines.indexOf('machine') + 1);
    expect(machine.some((line) => line.includes('android') && line.includes('cold run 6m40s avg'))).toBe(true);
    expect(existsSync(join(tmpHome, 'config.json'))).toBe(false);
  });

  test('an hours estimate reads in hours', async () => {
    let record = updateStats(emptyStats(), run({ projectKey: root, durationMs: 8_000_000 }), T0);
    record = updateStats(record, run({ projectKey: root, cacheHit: 'local', durationMs: 20_000 }), T1);
    writeFileSync(statsFile(), JSON.stringify(record));

    const { out: lines } = await inDir(root, () => runStats());

    expect(lines[1]).toContain('saved ~2h13m (estimated)');
  });

  test('a section with no bucket says so, and a column with no denominator prints -', async () => {
    const record = updateStats(emptyStats(), run({ projectKey: '/elsewhere', durationMs: 100_000 }), T0);
    record.projects[root] = {
      android: {
        runs: 1,
        failed: 1,
        hits: 0,
        misses: 0,
        coldRuns: 0,
        coldRunMs: 0,
        hitRuns: 0,
        hitRunMs: 0,
        timeSavedMs: 0,
        firstRunAt: '2026-09-01T10:00:00.000Z',
        lastRunAt: '2026-09-01T10:00:00.000Z',
      },
    };
    writeFileSync(statsFile(), JSON.stringify(record));

    const { out: lines } = await inDir(root, () => runStats());

    expect(lines[1]).toContain('1 runs (1 failed)   0 hits (-)   cold run - avg   hit run - avg');
    expect(lines[1]).not.toContain('ios');
  });

  test('with no file at all both sections report no runs', async () => {
    const { out: lines, err } = await inDir(root, () => runStats());

    expect(err).toEqual([]);
    expect(lines).toEqual([
      `project ${root}`,
      '  no runs recorded',
      'machine',
      '  no runs recorded',
      'archive',
      '  archived workspaces: 0, 0K',
    ]);
    expect(existsSync(statsFile())).toBe(false);
  });

  test('outside a project only the machine section prints', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'stim-outside-')));
    writeFileSync(statsFile(), JSON.stringify(updateStats(emptyStats(), run({ projectKey: '/elsewhere' }), T0)));

    const { out: lines } = await inDir(outside, () => runStats());

    expect(lines[0]).toBe('machine');
    expect(lines.some((line) => line.startsWith('project '))).toBe(false);

    rmSync(outside, { recursive: true, force: true });
  });

  test('--json prints exactly one parseable line in the documented shape', async () => {
    const record = updateStats(emptyStats(), run({ projectKey: root, durationMs: 240_000 }), T0);
    writeFileSync(statsFile(), JSON.stringify(record));

    const { out: lines, err } = await inDir(root, () => runStats(['--json']));

    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0] as string);
    expect(payload.version).toBe(1);
    expect(payload.project.key).toBe(root);
    expect(payload.project.ios.coldRunMs).toBe(240_000);
    expect(payload.project.android).toBe(null);
    expect(payload.machine.ios.runs).toBe(1);
    expect(payload.machine.android).toBe(null);
    expect(payload.agentDevice).toMatchObject({ version: 1, bytes: 0, complete: true });
    expect(payload.swiftpmCache).toMatchObject({ version: 1, present: false, bytes: 0, complete: true });
    expect(err).toEqual([]);
  });

  test('a file this Stim cannot use costs one stderr line and leaves stdout alone', async () => {
    writeFileSync(statsFile(), JSON.stringify({ version: 2, machine: {}, projects: {} }));
    const newer = await inDir(root, () => runStats());

    expect(newer.err).toHaveLength(1);
    expect(newer.err[0]).toMatch(/are version 2, which this Stim does not understand/);
    expect(newer.out).toEqual([
      `project ${root}`,
      '  no runs recorded',
      'machine',
      '  no runs recorded',
      'archive',
      '  archived workspaces: 0, 0K',
    ]);

    writeFileSync(statsFile(), '{ this is not json');
    const corrupt = await inDir(root, () => runStats(['--json']));

    expect(corrupt.err).toHaveLength(1);
    expect(corrupt.err[0]).toMatch(/could not be read; the next ios or android run moves them aside/);
    expect(corrupt.out).toHaveLength(1);
    expect(JSON.parse(corrupt.out[0] as string).project.ios).toBe(null);
    expect(readFileSync(statsFile(), 'utf-8')).toBe('{ this is not json');
  });

  test('--json outside a project reports a null project', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'stim-outside-')));

    const { out: lines } = await inDir(outside, () => runStats(['--json']));

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({
      version: 1,
      project: null,
      machine: { ios: null, android: null },
      offload: { today: { here: 0, offloaded: 0, fellBack: 0 }, machines: {}, placements: [] },
      agentDevice: await getAgentDeviceUsage(),
      swiftpmCache: await getSwiftpmCacheUsage(),
    });

    rmSync(outside, { recursive: true, force: true });
  });

  test('--json and the plain output carry the build placements', async () => {
    const now = Date.now();
    let record = updateStats(emptyStats(), run({ coldBuildMs: 300_000 }), now);
    record = updateStats(
      record,
      run({
        coldBuildMs: 290_000,
        placement: { decision: 'here', reason: 'load 0.6/core, 1 build here', slotWaitMs: 25_000 },
      }),
      now,
    );
    record = updateStats(
      record,
      run({ placement: { decision: 'offloaded', machine: 'mini', reason: 'this Mac is busy', buildMs: 200_000 } }),
      now,
    );
    writeFileSync(statsFile(), JSON.stringify(record));

    const json = JSON.parse((await inDir(root, () => runStats(['--json']))).out[0] as string);
    const plain = await (await inDir(root, () => runStats())).out;

    expect(json.offload.today).toEqual({ here: 1, offloaded: 1, fellBack: 0 });
    expect(json.offload.machines.mini.today).toEqual({
      offloaded: 1,
      offloadedMs: 200_000,
      savedMs: 90_000,
      fallbacks: 0,
    });
    expect(json.offload.placements.map((each: { decision: string }) => each.decision)).toEqual(['offloaded', 'here']);
    expect(json.offload.placements[1].slotWaitMs).toBe(25_000);
    expect(json.offload.placements[0]).not.toHaveProperty('slotWaitMs');
    expect(plain).toContain('build placement');
    expect(plain.some((line) => line.includes('here: load 0.6/core, 1 build here'))).toBe(true);
  });
});

test('CLI and the server read child agree for a real monorepo worktree and its symlink', async () => {
  resetExecutor();
  root = realpathSync.native(root);
  tmpHome = realpathSync.native(tmpHome);
  process.env.STIM_HOME = tmpHome;
  const git = (args: string[], cwd = root) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
  git(['init']);
  const app = join(root, 'apps', 'example');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'package.json'), '{}');
  git(['add', '.']);
  git([
    '-c',
    'user.name=Stats test',
    '-c',
    'user.email=stats@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'fixture',
  ]);
  const worktree = join(tmpHome, 'worktree');
  git(['worktree', 'add', '--detach', worktree]);
  const alias = join(tmpHome, 'alias');
  symlinkSync(join(worktree, 'apps', 'example'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const record = updateStats(emptyStats(), run({ projectKey: app, coldBuildMs: 1200 }), T0);
  writeFileSync(statsFile(), JSON.stringify(record));
  const inputs: [string, string][] = [
    [app, root],
    [join(worktree, 'apps', 'example'), worktree],
    [alias, worktree],
  ];
  if (process.platform === 'win32') {
    const shortInputs = inputs.map(([path, repository]): [string, string] => {
      const short = execSync('for %I in ("%STIM_STATS_TEST_PATH%") do @echo %~sI', {
        encoding: 'utf8',
        shell: 'cmd.exe',
        env: { ...process.env, STIM_STATS_TEST_PATH: path },
      }).trim();
      assert.notStrictEqual(
        short.toLowerCase(),
        path.toLowerCase(),
        'Windows stats regression requires an actual 8.3 alias',
      );
      assert.strictEqual(realpathSync.native(short), realpathSync.native(path));
      return [short, repository];
    });
    inputs.push(...shortInputs);
  }
  for (const [cwd, repository] of inputs) {
    const gitPath = (args: string[]) =>
      git(['rev-parse', ...args], cwd)
        .toString()
        .trim()
        .replaceAll('/', sep);
    const commonDir = gitPath(['--path-format=absolute', '--git-common-dir']);
    const repoRoot = gitPath(['--show-toplevel']);
    const operands = JSON.stringify({ root: cwd, commonDir, repoRoot });
    if (process.platform === 'win32') console.info(`Windows stats operands: ${operands}`);
    assert.strictEqual(realpathSync.native(commonDir), join(root, '.git'), operands);
    assert.strictEqual(realpathSync.native(repoRoot), repository, operands);
    assert.strictEqual(statsProjectKey({ root: cwd, commonDir, repoRoot }), app, operands);
    const cli = await inDir(cwd, () => runStats(['--json']));
    const child = runServerStats({ ...process.env }, cwd, { timeoutMs: 10_000, maxOutputBytes: 1024 * 1024 });
    try {
      const outcome = await child.outcome;
      assert(outcome.ok);
      expect(JSON.parse(outcome.stdout)).toEqual(JSON.parse(cli.out[0]!));
      expect(JSON.parse(outcome.stdout).project).toMatchObject({
        key: app,
        ios: { lastColdBuildMs: 1200 },
        android: null,
      });
    } finally {
      await child.cancel();
    }
  }
});

test('stats prints the archive usage section', async () => {
  const { archiveWorkspace } = await import('../archive.ts');
  const { ensureWorkspaceStorage } = await import('../workspace/paths.ts');
  process.env.STIM_ARCHIVE_ENABLED = 'true';
  try {
    const dir = ensureWorkspaceStorage(root);
    writeFileSync(join(dir, 'state.json'), '{}');
    archiveWorkspace(root, 'gc');
    expect((await inDir(root, () => runStats())).out).toEqual(
      expect.arrayContaining(['archive', expect.stringMatching(/^  archived workspaces: 1, /)]),
    );
  } finally {
    delete process.env.STIM_ARCHIVE_ENABLED;
  }
});

test('plain stats reports agent-device state after the machine section', async () => {
  const dir = join(tmpHome, '.agent-device');
  mkdirSync(join(dir, 'sessions', 'a'), { recursive: true });
  setExecutor({
    runFileAsync: async () => `10\t${join(dir, 'sessions')}\n12\t${dir}`,
    runFileQuiet: () => null,
    runQuiet: () => null,
  });
  const { out } = await inDir(root, () => runStats());
  expect(out.join('\n')).toMatch(/agent-device .*measured .* ago/);
  expect(out.join('\n')).toContain('sessions: 10K, 1 entries');
  expect(out.join('\n')).toContain(
    'never trims or deletes the shared runner builds, sessions, logs and other state or the hosted driver dir',
  );
  expect(out.at(-1)).toContain("a workspace's own agent-device dir goes only with its workspace");
});

test('stats JSON returns its measured usage even when the cache cannot be replaced', async () => {
  const dir = join(tmpHome, '.agent-device');
  mkdirSync(dir);
  mkdirSync(join(tmpHome, 'agent-device-usage.json'));
  setExecutor({ runFileAsync: async () => `12\t${dir}`, runFileQuiet: () => null, runQuiet: () => null });
  const { out } = await inDir(root, () => runStats(['--json']));
  expect(out).toHaveLength(1);
  expect(JSON.parse(out[0]!).agentDevice).toMatchObject({ bytes: 12 * 1024, complete: true });
  expect(readdirSync(tmpHome).filter((name) => name.endsWith('.tmp'))).toEqual([]);
});

test('stats includes measured SwiftPM usage in one JSON payload and after agent-device in plain output', async () => {
  const dir =
    process.platform === 'darwin'
      ? join(tmpHome, 'Library', 'Caches', 'org.swift.swiftpm')
      : join(tmpHome, '.cache', 'org.swift.swiftpm');
  const agent = join(tmpHome, '.agent-device');
  mkdirSync(dir, { recursive: true });
  mkdirSync(agent);
  setExecutor({
    runFileAsync: async () => `1536\t${dir}\n12\t${agent}`,
    runFileQuiet: () => null,
    runQuiet: () => null,
  });
  const { out } = await inDir(root, () => runStats(['--json']));
  expect(out).toHaveLength(1);
  expect(JSON.parse(out[0]!).swiftpmCache).toMatchObject({ dir, present: true, bytes: 1536 * 1024, complete: true });
  const { out: plain } = await inDir(root, () => runStats());
  const text = plain.join('\n');
  expect(text.indexOf('SwiftPM cache (')).toBeGreaterThan(text.indexOf('agent-device ('));
  expect(text).toContain(dir);
  expect(plain.at(-1)).toContain('shared by every SwiftPM build on this machine');
});
