import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILD_LEDGER_CAP, buildLedgerFile, readBuildLedger } from '@stim-cli/core/state';
import {
  appendBuildLedger,
  appendCapped,
  errorRemedy,
  buildLedgerRecord,
  writeBuildLedger,
  type BuildLedgerRun,
} from '../engine/build-ledger.ts';
import { lastBuildRecord as androidLastBuildRecord } from '../commands/android/result.ts';
import { iosLedgerDevice } from '../commands/ios/result.ts';
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
  test('maps a local cache miss that succeeded', () => {
    const record = buildLedgerRecord(
      run({ extras: { scheme: 'App', device: { name: 'stim-a (iPhone 17)', runtime: 'iOS 26.0' } } }),
    );
    expect(record).toMatchObject({
      ts: T0 + 90_000,
      startedAt: T0,
      src: 'builds',
      event: 'build',
      level: 'info',
      id: 'run-1',
      project: '/work/app',
      workspace: 'app--0123456789abcdef',
      branch: 'feat/x',
      platform: 'ios',
      scheme: 'App',
      configuration: 'Debug',
      placement: { where: 'local' },
      cache: { result: 'miss', key: 'key', fingerprint: 'fp' },
      durationMs: 90_000,
      phases: { prepare: 1_000, compile: 80_000 },
      outcome: 'succeeded',
      device: { name: 'stim-a (iPhone 17)', runtime: 'iOS 26.0' },
      stimVersion: '9.9.9',
    });
    expect(record.failure).toBeUndefined();
    expect(record.offloadPhases).toBeUndefined();
    expect(record).not.toHaveProperty('loadPerCore');
    expect(record).not.toHaveProperty('boot');
    expect(record.msg).toBe('ios build succeeded here in 1m30s (miss)');
  });

  test('maps a failure with its code, message, remedy and phase', () => {
    const record = buildLedgerRecord(
      run({
        outcome: 'failed',
        phase: 'compile',
        record: { status: 'failed', errorCode: 'STIM_BUILD_FAILED' },
        extras: { message: 'xcodebuild exited 65', remedy: 'Run stim logs --errors' },
      }),
    );
    expect(record.level).toBe('error');
    expect(record.failure).toEqual({
      code: 'STIM_BUILD_FAILED',
      message: 'xcodebuild exited 65',
      remedy: 'Run stim logs --errors',
      phase: 'compile',
    });
    expect(record.msg).toContain('STIM_BUILD_FAILED: xcodebuild exited 65');
  });

  test('maps an offloaded build with the build machine and its phases', () => {
    const record = buildLedgerRecord(
      run({
        record: { offloadedTo: 'mini', builtOn: 'mini' },
        offload: { host: 'mini', phaseMs: { sync: 4_000.4, build: 60_000, fetch: 0 } },
      }),
    );
    expect(record.placement).toEqual({ where: 'offloaded', machine: 'mini' });
    expect(record.offloadPhases).toEqual({ sync: 4_000, build: 60_000 });
    expect(record.msg).toContain('on mini');
  });

  test('a build that failed on the machine is still placed there', () => {
    const record = buildLedgerRecord(
      run({
        outcome: 'failed',
        record: { status: 'failed', errorCode: 'STIM_OFFLOAD_FAILED' },
        offload: { host: 'mini', phaseMs: { sync: 1_000 } },
      }),
    );
    expect(record.placement).toEqual({ where: 'offloaded', machine: 'mini' });
  });

  test('maps a build that fell back to this Mac with the reason', () => {
    const record = buildLedgerRecord(run({ record: { offloadFallback: 'mini refused: busy' } }));
    expect(record.placement).toEqual({ where: 'local', fellBack: true, reason: 'mini refused: busy' });
  });

  test('an offload that started and then fell back is recorded as a local build', () => {
    const record = buildLedgerRecord(
      run({
        record: { offloadFallback: 'mini lost its connection' },
        offload: { host: 'mini', phaseMs: { sync: 2_000 } },
      }),
    );
    expect(record.placement).toEqual({ where: 'local', fellBack: true, reason: 'mini lost its connection' });
  });

  test('a remote lookup that ended in a build here is recorded as a local build', () => {
    const record = buildLedgerRecord(
      run({ record: { builtOn: 'here' }, offload: { host: 'mini', phaseMs: { fetch: 1_000 } } }),
    );
    expect(record.placement).toEqual({ where: 'local' });
  });

  test('maps cache hits, bypasses and miss reasons', () => {
    expect(buildLedgerRecord(run({ record: { cacheHit: 'remote' } })).cache).toMatchObject({
      result: 'hit',
      source: 'remote',
    });
    expect(buildLedgerRecord(run({ record: { cacheHit: 'local', cacheSkipped: true } })).cache).toEqual({
      result: 'bypassed',
      key: 'key',
      fingerprint: 'fp',
    });
    expect(buildLedgerRecord(run({ record: { missReason: 'no-entry' } })).cache.missReason).toBe('no-entry');
  });

  test('an Android build records its variant and a macOS build has no device', () => {
    const android = buildLedgerRecord(
      run({ record: { platform: 'android', configuration: 'debug' }, extras: { device: { name: 'stim-a' } } }),
    );
    expect(android).toMatchObject({ variant: 'debug', device: { name: 'stim-a' } });
    expect(buildLedgerRecord(run({ record: { platform: 'macos' } })).device).toBeUndefined();
  });

  test('a cancelled run is a warning', () => {
    const record = buildLedgerRecord(
      run({ outcome: 'cancelled', record: { status: 'failed', errorCode: 'STIM_CANCELLED' } }),
    );
    expect(record.level).toBe('warn');
    expect(record.outcome).toBe('cancelled');
  });
});

describe('the device of a record', () => {
  test('a name that is a serial or UDID is left out', () => {
    expect(iosLedgerDevice({ deviceName: 'iPhone 15', deviceUdid: '00008110-001A', runtime: 'iOS 26' })).toEqual({
      name: 'iPhone 15',
      runtime: 'iOS 26',
    });
    expect(iosLedgerDevice({ deviceName: '00008110-001A', deviceUdid: '00008110-001A' })).toBeNull();
    const android = (deviceName: string) =>
      androidLastBuildRecord({ startedAt: 'T', status: 'ok', deviceName, deviceSerial: 'R5CT1234' }).ledger;
    expect(android('Pixel 8')).toEqual({ device: { name: 'Pixel 8' } });
    expect(android('R5CT1234')).toBeUndefined();
  });
});

describe('errorRemedy', () => {
  test('reads the remedy a thrown error carries', () => {
    expect(errorRemedy(Object.assign(new Error('x'), { remedy: 'Run stim doctor' }))).toBe('Run stim doctor');
    expect(errorRemedy(new Error('x'))).toBeUndefined();
    expect(errorRemedy('x')).toBeUndefined();
  });
});

describe('the ledger file', () => {
  test('appendCapped keeps the newest records', () => {
    const existing = '{"n":1}\n{"n":2}\n{"n":3}\n';
    expect(appendCapped(existing, '{"n":4}', 2)).toBe('{"n":3}\n{"n":4}\n');
    expect(appendCapped('', '{"n":1}', 2)).toBe('{"n":1}\n');
  });

  test('a run that records twice keeps its last record', () => {
    appendBuildLedger(buildLedgerRecord(run({ id: 'same', now: T0 + 1 })));
    appendBuildLedger(buildLedgerRecord(run({ id: 'other', now: T0 + 2 })));
    appendBuildLedger(
      buildLedgerRecord(
        run({
          id: 'same',
          now: T0 + 3,
          outcome: 'failed',
          record: { status: 'failed', errorCode: 'STIM_LAUNCH_FAILED' },
        }),
      ),
    );
    expect(readBuildLedger().map((record) => [record.id, record.outcome])).toEqual([
      ['other', 'succeeded'],
      ['same', 'failed'],
    ]);
  });

  test('keeps the last 500 records in order and reads them oldest first', () => {
    mkdirSync(join(home, 'builds'));
    writeFileSync(
      buildLedgerFile(),
      Array.from(
        { length: BUILD_LEDGER_CAP },
        (_, i) => `${JSON.stringify(buildLedgerRecord(run({ id: `run-${i}`, now: T0 + i })))}\n`,
      ).join(''),
    );
    for (let i = BUILD_LEDGER_CAP; i < BUILD_LEDGER_CAP + 3; i++) {
      appendBuildLedger(buildLedgerRecord(run({ id: `run-${i}`, now: T0 + i })));
    }
    const records = readBuildLedger();
    expect(records).toHaveLength(BUILD_LEDGER_CAP);
    expect(records[0]?.id).toBe('run-3');
    expect(records.at(-1)?.id).toBe(`run-${BUILD_LEDGER_CAP + 2}`);
  });

  test('a missing ledger and unrelated lines read as empty', () => {
    expect(readBuildLedger()).toEqual([]);
    mkdirSync(join(home, 'builds'));
    writeFileSync(buildLedgerFile(), 'not json\n{"src":"gc"}\n');
    expect(readBuildLedger()).toEqual([]);
  });

  test('a ledger that cannot be written never throws', () => {
    writeFileSync(join(home, 'builds'), 'a file where the directory should be');
    expect(() => writeBuildLedger('/work/app', run())).not.toThrow();
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
