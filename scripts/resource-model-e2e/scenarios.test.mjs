import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageError, parseArgs } from './args.mjs';
import { createAssertions, STATUS } from './assertions.mjs';
import { renderReport, resultLine } from './report.mjs';
import { batchAssertions } from './scenarios/stress.mjs';
import { remoteArguments, workspaceClosure } from './ssh.mjs';
import { stimEnvironment, parseJsonOutput } from './stim.mjs';

const base = ['--scenario', 'normal', '--project', '/p', '--stim', '/s'];

describe('arguments', () => {
  it('refuses a dormant clock that is not longer than the idle clock', () => {
    expect(() => parseArgs([...base, '--idle-minutes', '5', '--dormant-minutes', '5'])).toThrow(UsageError);
    expect(() => parseArgs([...base, '--dormant-minutes', '10'])).toThrow(/exceed the idle clock \(15 min\)/);
  });
  it('needs enough worktrees for the disk roles and defaults per scenario', () => {
    expect(() => parseArgs(['--scenario', 'disk', '--project', '/p', '--stim', '/s', '--workspaces', '3'])).toThrow(
      UsageError,
    );
    expect(parseArgs(['--scenario', 'stress', '--project', '/p', '--stim', '/s']).workspaces).toBe(16);
  });
  it('reads --env pairs and the ssh target', () => {
    const opts = parseArgs([...base, '--target', 'ssh:me@host', '--env', 'A=b=c']);
    expect(opts.extraEnv).toEqual({ A: 'b=c' });
    expect(() => parseArgs([...base, '--target', 'host'])).toThrow(UsageError);
  });
  it('passes every option through to the run on the target', () => {
    const opts = parseArgs([
      ...base,
      '--target',
      'ssh:me@host',
      '--idle-minutes',
      '2',
      '--home-dir',
      '/h',
      '--work-dir',
      '/w',
    ]);
    const args = remoteArguments(opts, { cli: 'c', out: 'o' });
    expect(args).toEqual(
      expect.arrayContaining([
        '--target',
        'local',
        '--idle-minutes',
        '2',
        '--home-dir',
        '/h',
        '--work-dir',
        '/w',
        '--stim',
        'c',
      ]),
    );
  });
});

describe('stim child environment', () => {
  it('drops STIM_ variables and CI from the parent and pins the private home', () => {
    const env = stimEnvironment(
      '/home',
      { STIM_MAINTENANCE: 'on' },
      { PATH: '/bin', CI: '1', STIM_BUILD_CACHE: '/real', STIM_HOME: '/real-home' },
    );
    expect(env).toMatchObject({ PATH: '/bin', STIM_HOME: '/home', STIM_MAINTENANCE: 'on' });
    expect(env.CI).toBeUndefined();
    expect(env.STIM_BUILD_CACHE).toBeUndefined();
  });
  it('reads a failure payload from the last stdout line', () => {
    expect(parseJsonOutput('noise\n{"code":"STIM_LOW_DISK"}\n')).toEqual({ code: 'STIM_LOW_DISK' });
  });
});

const at = (name) => join('/r', 'packages', name);

describe('workspace closure for the ssh package', () => {
  it('follows workspace dependencies transitively and stops at published ones', () => {
    const manifests = {
      [join(at('cli'), 'package.json')]: { name: 'stim', dependencies: { '@x/core': 'workspace:*', chalk: '^6' } },
      [join(at('core'), 'package.json')]: { name: '@x/core', dependencies: { '@x/cache': 'workspace:*' } },
      [join(at('cache'), 'package.json')]: { name: '@x/cache' },
    };
    const dirs = workspaceClosure(
      '/r',
      'stim',
      (file) => manifests[file],
      () => ['cli', 'core', 'cache'],
    );
    expect(dirs.toSorted()).toEqual([at('cache'), at('cli'), at('core')]);
  });
});

const sample = (epoch, extra) => ({ epoch, booted_ours: 0, booting_ours: 0, pressure: 1, ...extra });
const run = (ctx, runs) => {
  batchAssertions(ctx, { startedAt: 0, runs }, ctx.rows);
  return Object.fromEntries(ctx.assertions.list.map((a) => [a.id, a.status]));
};

function stressContext({ rows, snapshots = [], cap = 8 }) {
  const assertions = createAssertions();
  return { assertions, snapshots, deviceCap: cap, sampleIntervalSec: 5, emit() {}, rows };
}
const ok = (label) => ({
  workspace: { label },
  result: { ok: true, code: 0, ms: 1000, json: null, stdout: '', stderr: '' },
});

describe('stress batch assertions', () => {
  it('fails the cap when booted plus booting devices pass it, and the refusal check when a run was refused', () => {
    const ctx = stressContext({ rows: [sample(1, { booted_ours: 8, booting_ours: 1 })] });
    const refused = {
      workspace: { label: 'w2' },
      result: { ok: false, code: 1, ms: 5, json: { code: 'STIM_AT_CAPACITY' }, stdout: '', stderr: '' },
    };
    const result = run(ctx, [ok('w1'), refused]);
    expect(result).toMatchObject({ 'booted-cap': STATUS.fail, 'no-refusals': STATUS.fail, 'exit-zero': STATUS.fail });
  });

  it('allows memory pressure to stay critical for one 60 s tick but not longer', () => {
    const critical = (n) => Array.from({ length: n }, (_, i) => sample(i * 5, { pressure: 4 }));
    expect(run(stressContext({ rows: critical(12) }), [ok('w1')])['pressure-critical']).toBe(STATUS.pass);
    expect(run(stressContext({ rows: critical(13) }), [ok('w1')])['pressure-critical']).toBe(STATUS.fail);
  });

  it('reports boots in flight as unavailable unless status lists the boot holders', () => {
    const ctx = stressContext({
      rows: [sample(1)],
      snapshots: [{ bootsInFlight: null, waitingRuns: 0, deviceSlots: null }],
    });
    expect(run(ctx, [ok('w1')])['boots-in-flight']).toBe(STATUS.unavailable);
    const exposed = stressContext({
      rows: [sample(1)],
      snapshots: [{ bootsInFlight: 3, waitingRuns: 0, deviceSlots: { max: 8 } }],
    });
    expect(run(exposed, [ok('w1')])['boots-in-flight']).toBe(STATUS.fail);
  });
});

const blank = (epoch) => ({ epoch, booted_ours: null, booting_ours: null, pressure: null });

describe('stress batch assertions on missing sampler data', () => {
  it('reports N/A for each sampler check and fails the scenario when every row is empty', () => {
    const result = run(stressContext({ rows: [blank(1), blank(6), blank(11)] }), [ok('w1')]);
    expect(result).toMatchObject({
      'booted-cap': STATUS.unavailable,
      'booting-sampled': STATUS.unavailable,
      'pressure-critical': STATUS.unavailable,
      'sampler-data': STATUS.fail,
    });
  });

  it('ignores empty rows when computing a peak and says how many there were', () => {
    const ctx = stressContext({ rows: [blank(1), sample(6, { booted_ours: 9, booting_ours: 0 })] });
    const result = run(ctx, [ok('w1')]);
    expect(result).toMatchObject({ 'booted-cap': STATUS.fail, 'sampler-data': STATUS.pass });
    expect(ctx.assertions.list.find((a) => a.id === 'booted-cap').evidence[0]).toContain(
      '1 of 2 rows had no simulator reading',
    );
  });
});

describe('report result line', () => {
  const A = createAssertions();
  A.pass('s', 'a', 't', []);
  const none = createAssertions();
  none.unavailable('s', 'a', 't', []);

  it('does not say PASS for an interrupted run, a run that checked nothing, or one whose teardown failed', () => {
    expect(resultLine(A.list, { harnessError: 'interrupted' })).toMatch(/^INTERRUPTED/);
    expect(resultLine(none.list)).toMatch(/^NO RESULT/);
    expect(resultLine([], { harnessError: 'boom' })).toMatch(/^NO RESULT/);
    expect(resultLine(A.list, { harnessError: 'boom' })).toMatch(/^INCOMPLETE/);
    expect(resultLine(A.list, { teardownClean: false })).toMatch(/^INCOMPLETE/);
    expect(resultLine(A.list)).toMatch(/^PASS/);
  });
});

describe('report', () => {
  it('renders every status and survives a run with no samples', () => {
    const A = createAssertions();
    A.pass('normal', 'a', 'passes', ['fine']);
    A.fail('normal', 'b', 'fails | piped', ['bad']);
    A.unavailable('normal', 'c', 'missing', ['not available on this build']);
    const report = renderReport({
      meta: {
        runId: 'rme0',
        scenario: 'normal',
        targetLabel: 't',
        machineLabel: 'm',
        stimLabel: 's',
        projectLabel: 'p',
        workspaces: 2,
        startedAt: 0,
        durationMs: 90_000,
        sampleIntervalSec: 5,
      },
      assertions: A.list,
      workspaces: [{ label: 'w1', role: 'workspace', record: {} }],
      events: [{ t: 61_000, kind: 'launch', msg: 'w1 done' }],
      samples: [],
      teardown: null,
      harnessError: 'boom',
    });
    expect(report).toContain('FAIL: 1 passed, 1 failed, 1 not available on this build');
    expect(report).toContain('| 01:01 | launch | w1 done |');
    expect(report).toContain('b: fails \\| piped');
    expect(report).toContain('The harness stopped early: boom');
  });
});
