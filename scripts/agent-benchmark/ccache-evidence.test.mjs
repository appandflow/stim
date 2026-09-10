import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ccacheLogEvidence } from './ccache-evidence.mjs';
import { benchmarkCcache } from './run-guards.mjs';

let root, runDir, worktree, statsLog, meta, commands;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bench-ccache-evidence-'));
  runDir = join(root, 'run');
  worktree = join(root, 'worktree');
  statsLog = join(runDir, 'stim-home/workspaces/owned/logs/ccache-stats.log');
  mkdirSync(join(runDir, 'stim-home/workspaces/owned/logs'), { recursive: true });
  mkdirSync(worktree);
  writeFileSync(join(runDir, 'stim-home/config.json'), JSON.stringify({ projects: { [worktree]: {} } }));
  writeFileSync(join(runDir, 'events.jsonl'), 'captured events');
  writeFileSync(statsLog, '# a.cpp\ndirect_cache_hit\n# b.cpp\npreprocessed_cache_hit\n');
  meta = {
    runId: 'run',
    arm: 'stim',
    platform: 'android',
    variant: 'native',
    timingTarget: { ccacheMinHitRatePercent: 50 },
  };
  commands = [
    {
      id: 'build',
      command: 'stim android',
      startedAt: new Date(Date.now() - 1000).toISOString(),
      endedAt: new Date(Date.now() + 1000).toISOString(),
      exitCode: 1,
      output: 'build compiling debug\nbuild ok (28s)\nerror STIM_LAUNCH_FAILED: device offline',
    },
  ];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const evidence = (capture = true) => ccacheLogEvidence({ runDir, meta, commands, worktree, capture });

describe('captured compiler cache evidence', () => {
  it('retains exact command identity for a scoped build with a reported launch failure', () => {
    commands[0].command = `cd ${worktree} && stim android --system-image "system-images;android-36;arm64-v8a"; echo "EXIT=$?"`;
    commands[0].exitCode = 0;
    commands[0].output += '\nEXIT=1\n';
    const before = JSON.stringify(commands);
    expect(evidence()).toMatchObject({ hits: 2, misses: 0, commandId: 'build' });
    expect(JSON.stringify(commands)).toBe(before);
    expect(evidence(false)).not.toBeNull();
  });

  it.each([
    'wrong directory',
    'unconditional cd',
    'extra command',
    'missing status',
    'duplicate status',
    'bad status',
    'substitution',
  ])('rejects scoped wrappers with %s', (failure) => {
    commands[0].command = `cd ${worktree} && stim android; echo "EXIT=$?"`;
    commands[0].exitCode = 0;
    commands[0].output += '\nEXIT=1\n';
    if (failure === 'wrong directory') commands[0].command = commands[0].command.replace(worktree, `${root}/other`);
    if (failure === 'unconditional cd') commands[0].command = commands[0].command.replace(' && ', '; ');
    if (failure === 'extra command') commands[0].command += '; echo done';
    if (failure === 'missing status') commands[0].output = commands[0].output.replace('EXIT=1', '');
    if (failure === 'duplicate status') commands[0].output += 'EXIT=0\n';
    if (failure === 'bad status') commands[0].output = commands[0].output.replace('EXIT=1', 'EXIT=143');
    if (failure === 'substitution')
      commands[0].command = commands[0].command.replace('stim android', 'stim android "$(echo extra)"');
    expect(evidence()).toBeNull();
  });

  it('captures the completed build independently of launch and survives cleanup without editing commands', () => {
    const before = JSON.stringify(commands);
    const measurement = evidence();
    expect(measurement).toMatchObject({ commandId: 'build', hits: 2, misses: 0, source: 'stats-log' });
    expect(benchmarkCcache(meta, commands, measurement)).toMatchObject({ status: 'measured', invalidReasons: [] });
    expect(JSON.stringify(commands)).toBe(before);
    rmSync(join(runDir, 'stim-home'), { recursive: true });
    rmSync(worktree, { recursive: true });
    expect(evidence(false)).toEqual(measurement);
  });

  it('keeps low-hit alerts and refuses to reuse the last log for multiple or ambiguous builds', () => {
    writeFileSync(statsLog, 'direct_cache_hit\ncache_miss\ncache_miss\n');
    expect(benchmarkCcache(meta, commands, evidence()).invalidReasons).toContain('ccache-hit-rate-below-target');
    commands.push({ ...commands[0], id: 'second' });
    expect(evidence(false)).toBeNull();
    commands.pop();
    commands[0].parallelTimingAmbiguous = true;
    expect(evidence(false)).toBeNull();
  });

  it.each(['stale', 'late', 'wrong workspace', 'multiple logs', 'unfinished', 'chained', 'repeated build'])(
    'refuses %s capture',
    (failure) => {
      if (failure === 'stale') utimesSync(statsLog, new Date(0), new Date(0));
      if (failure === 'late') utimesSync(statsLog, new Date(Date.now() + 60000), new Date(Date.now() + 60000));
      if (failure === 'wrong workspace') writeFileSync(join(runDir, 'stim-home/config.json'), '{"projects":{}}');
      if (failure === 'multiple logs') {
        mkdirSync(join(runDir, 'stim-home/workspaces/other/logs'), { recursive: true });
        writeFileSync(join(runDir, 'stim-home/workspaces/other/logs/ccache-stats.log'), 'cache_miss');
      }
      if (failure === 'unfinished') commands[0].exitCode = null;
      if (failure === 'chained') commands[0].command = 'stim android; echo done';
      if (failure === 'repeated build') commands[0].output += '\nbuild compiling debug\nbuild ok (1s)';
      expect(evidence()).toBeNull();
      expect(benchmarkCcache(meta, commands).invalidReasons).toContain('ccache-evidence-missing');
    },
  );

  it.each(['stats', 'events', 'meta', 'command', 'worktree', 'missing log', 'missing record'])(
    'refuses changed %s evidence without recapturing it',
    (failure) => {
      expect(evidence()).not.toBeNull();
      if (failure === 'stats') writeFileSync(join(runDir, 'ccache-evidence.log'), 'cache_miss');
      if (failure === 'events') writeFileSync(join(runDir, 'events.jsonl'), 'changed events');
      if (failure === 'meta') meta.runId = 'other';
      if (failure === 'command') commands[0].output += '\nchanged';
      if (failure === 'worktree') worktree = join(root, 'other-worktree');
      if (failure === 'missing log') rmSync(join(runDir, 'ccache-evidence.log'));
      if (failure === 'missing record') rmSync(join(runDir, 'ccache-evidence.json'));
      expect(evidence()).toBeNull();
    },
  );

  it('does not override unavailable command counters or excuse another attempt with missing evidence', () => {
    const measurement = evidence();
    commands.push({ id: 'unknown', command: 'stim android', exitCode: 1, output: 'unexpected failure' });
    expect(benchmarkCcache(meta, commands, measurement).invalidReasons).toContain('ccache-evidence-missing');
    commands.pop();
    commands[0].output += '\ncompilation cache unavailable';
    expect(benchmarkCcache(meta, commands, measurement).invalidReasons).toContain('ccache-evidence-missing');
    expect(readFileSync(join(runDir, 'ccache-evidence.log'), 'utf8')).toContain('preprocessed_cache_hit');
  });
});
