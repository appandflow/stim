import {
  decodeStats,
  readStatsReport,
  CAPACITY_REFUSAL_LIMIT,
  CAPACITY_REFUSAL_MAX_AGE_MS,
  statsFile,
} from '@stim-cli/core/state';
import { getSwiftpmCacheUsage } from '../devices/swiftpm-cache-usage.ts';
import { getAgentDeviceUsage } from '../devices/agent-device-usage.ts';
import assert from 'node:assert';
import { execFileSync, execSync } from 'node:child_process';
import { createStim } from '../api.ts';
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
  recordCapacityWait,
  emptyStats,
  readStats,
  recordRunStats,
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
});

describe('build placements', () => {
  const here = { decision: 'here' as const, reason: 'load 0.6/core, 1 of 3 build slots busy here' };

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

  test('a file that parses to something other than a versioned object is corrupt too', () => {
    writeFileSync(statsFile(), JSON.stringify([1, 2, 3]));
    expect(recordRunStats(run({ projectKey: root }), T0).note).toMatch(/moved to /);

    writeFileSync(statsFile(), JSON.stringify({ machine: {}, projects: {} }));
    expect(recordRunStats(run({ projectKey: root }), T1).note).toMatch(/moved to /);
    expect(readdirSync(tmpHome).filter((name) => name.includes('corrupt-'))).toHaveLength(2);
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
      run({ placement: { decision: 'offloaded', machine: 'mini', reason: 'this machine is busy', buildMs: 200_000 } }),
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

test('CLI and createStim().stats() agree for a real monorepo worktree and its symlink', async () => {
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
    const report = await createStim({ projectRoot: cwd }).stats();
    expect(report).toEqual(JSON.parse(cli.out[0]!));
    expect(report.project).toMatchObject({
      key: app,
      ios: { lastColdBuildMs: 1200 },
      android: null,
    });
  }
});

test('stats prints the archive usage section', async () => {
  const { archiveWorkspace } = await import('../archive.ts');
  const { ensureWorkspaceStorage } = await import('../workspace/paths.ts');
  process.env.STIM_ARCHIVE_ENABLED = 'true';
  try {
    const dir = ensureWorkspaceStorage(root);
    writeFileSync(join(dir, 'state.json'), '{}');
    await archiveWorkspace(root, 'gc');
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

describe('capacity waits', () => {
  const event = {
    at: new Date(T0).toISOString(),
    kind: 'device-wait' as const,
    platform: 'ios' as const,
    ms: 1200,
    max: 2,
    workspace: 'fixture',
  };

  test('normalization drops malformed wait events and rounds valid durations', () => {
    const malformed = [
      null,
      {},
      { ...event, ms: -1 },
      { ...event, ms: '1200' },
      { ...event, ms: null },
      { ...event, kind: 'device' },
      { ...event, platform: 'web' },
      { ...event, max: 0 },
      { ...event, workspace: '' },
      { ...event, at: 'invalid' },
    ];
    const record = decodeStats(
      JSON.stringify({ ...emptyStats(), capacityWaits: [...malformed, { ...event, ms: 12.6 }] }),
    ).record;
    expect(record?.capacityWaits).toEqual([{ ...event, ms: 13 }]);
    expect(decodeStats(JSON.stringify({ ...emptyStats(), capacityWaits: malformed })).record).not.toHaveProperty(
      'capacityWaits',
    );
    expect(decodeStats(JSON.stringify({ ...emptyStats(), capacityWaits: {} })).record).not.toHaveProperty(
      'capacityWaits',
    );
  });

  test.each([0, -1, 1.5, '2', null])('invalid or zero reclaim counts are omitted: %j', (reclaimed) => {
    expect(
      decodeStats(JSON.stringify({ ...emptyStats(), capacityWaits: [{ ...event, reclaimed }] })).record?.capacityWaits,
    ).toEqual([event]);
  });

  test('recorded waits survive a normal run and the JSON report bounds, sorts and expires them', async () => {
    const capacityWaits = [
      { ...event, at: new Date(T0 - CAPACITY_REFUSAL_MAX_AGE_MS - 1).toISOString() },
      ...Array.from({ length: 55 }, (_, i) => ({ ...event, workspace: `w${i}`, at: new Date(T0 + i).toISOString() })),
    ];
    writeFileSync(statsFile(), JSON.stringify({ ...emptyStats(), capacityWaits }));
    recordCapacityWait({ platform: 'android', max: 3, workspace: 'new', ms: 20.6, reclaimed: 2 }, T0 + 55);
    const stored = readStats().record!;
    expect(stored.capacityWaits).toHaveLength(CAPACITY_REFUSAL_LIMIT);
    expect(stored.capacityWaits?.[0]?.workspace).toBe('w6');
    expect(stored.capacityWaits?.at(-1)).toMatchObject({ workspace: 'new', ms: 21 });
    expect(updateStats(stored, run(), T0 + 55).capacityWaits).toEqual(stored.capacityWaits);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(T0 + 55);
    const { out } = await inDir(root, () => runStats(['--json']));
    const plain = await inDir(root, () => runStats([]));
    clock.mockRestore();
    expect(plain.out.join('\n')).toContain('device queue reclaim\n');
    expect(plain.out.join('\n')).toContain('reclaimed 2');
    const json = JSON.parse(out[0]!);
    expect(json.capacityWaits[0]).toMatchObject({ kind: 'device-wait', ms: 21, workspace: 'new', reclaimed: 2 });
    expect(json.capacityWaits).toHaveLength(CAPACITY_REFUSAL_LIMIT);
    expect(readStatsReport(null, T0 + 55 + CAPACITY_REFUSAL_MAX_AGE_MS + 1).report).not.toHaveProperty('capacityWaits');
  });
});
