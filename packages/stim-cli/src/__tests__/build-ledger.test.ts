import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLedgerFile, readBuildLedger } from '@stim-cli/core/state';
import { errorRemedy, buildLedgerRecord, type BuildLedgerRun } from '../engine/build-ledger.ts';

import { recordFinishedBuild, startBuildProgress } from '../engine/build-progress.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';

const T0 = Date.parse('2026-10-22T10:00:00.000Z');

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-build-ledger-'));
  vi.stubEnv('STIM_HOME', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function run(overrides: Partial<BuildLedgerRun> & { record?: Record<string, unknown> } = {}): BuildLedgerRun {
  const { record, ...rest } = overrides;
  return {
    id: 'run-1',
    now: T0 + 90_000,
    root: '/work/app',
    workspace: 'app--0123456789abcdef',
    branch: 'feat/x',
    version: '9.9.9',
    outcome: 'succeeded',
    extras: {},
    phases: { prepare: 1_000, compile: 80_000 },
    phase: 'launch',
    ...rest,
    record: {
      platform: 'ios',
      status: 'ok',
      configuration: 'Debug',
      fingerprint: 'fp',
      cacheKey: 'key',
      cacheHit: false,
      cacheSkipped: false,
      durationMs: 90_000,
      startedAt: new Date(T0).toISOString(),
      buildMachine: 'auto',
      ...record,
    },
  };
}

describe('buildLedgerRecord', () => {
  test('a cancelled run is a warning', () => {
    const record = buildLedgerRecord(
      run({ outcome: 'cancelled', record: { status: 'failed', errorCode: 'STIM_CANCELLED' } }),
    );
    expect(record.level).toBe('warn');
    expect(record.outcome).toBe('cancelled');
  });
});

describe('errorRemedy', () => {
  test('reads the remedy a thrown error carries', () => {
    expect(errorRemedy(Object.assign(new Error('x'), { remedy: 'Run stim doctor' }))).toBe('Run stim doctor');
    expect(errorRemedy(new Error('x'))).toBeUndefined();
    expect(errorRemedy('x')).toBeUndefined();
  });
});

describe('recordFinishedBuild', () => {
  test('writes one record with the run phases, the load at start and its first boot, and keeps ledger-only fields out of the workspace state', () => {
    const root = join(home, 'app');
    mkdirSync(root, { recursive: true });
    const attempt = tryAcquireClaim({ root: join(home, 'native-run.lock'), mode: 'exclusive', label: 'lock' });
    if (!attempt.acquired) throw new Error('claim not acquired');
    let now = T0;
    const loads = [3.2, 7.5, 9.9];
    const progress = startBuildProgress({
      root,
      platform: 'ios',
      slot: 'default',
      claim: attempt.acquired,
      now: () => now,
      load: () => loads.shift() ?? 0,
    });
    now += 2_000;
    progress.bootStarted();
    progress.step('compile');
    progress.place({ host: 'mini', phase: 'sync' });
    now += 3_000;
    progress.place({ host: 'mini', phase: 'build' });
    now += 40_000;
    progress.place(null);
    progress.bootStarted();
    progress.step('install');
    now += 1_000;
    recordFinishedBuild(
      root,
      {
        platform: 'ios',
        status: 'ok',
        startedAt: new Date(T0).toISOString(),
        durationMs: 46_000,
        configuration: 'Debug',
        cacheHit: false,
        offloadedTo: 'mini',
        ledger: { scheme: 'App' },
      },
      { now: () => now },
    );
    progress.clear();
    releaseClaim(attempt.acquired);

    expect(JSON.stringify(readWorkspaceState(root))).not.toContain('"scheme"');
    const [record] = readBuildLedger();
    expect(record).toMatchObject({
      platform: 'ios',
      scheme: 'App',
      placement: { where: 'offloaded', machine: 'mini' },
      offloadPhases: { sync: 3_000, build: 40_000 },
      phases: { prepare: 2_000, compile: 43_000, install: 1_000 },
      outcome: 'succeeded',
      loadPerCore: 3.2,
      boot: { startedAt: T0 + 2_000, loadPerCore: 7.5 },
    });
    expect(readFileSync(buildLedgerFile(), 'utf-8').split('\n').filter(Boolean)).toHaveLength(1);
  });
});
