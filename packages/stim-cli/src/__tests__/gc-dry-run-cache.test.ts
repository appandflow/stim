import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gcReportCacheFile,
  GC_REPORT_CACHE_VERSION,
  type DaemonPressure,
  type GcReportCache,
} from '@stim-cli/core/state';
import { writeCacheFile } from '../cache-file.ts';
import { runGc } from '../commands/gc.ts';
import { readGcReportThroughStimd, stimdLive } from '../daemon/client.ts';
import { runMaintenanceAtLevel, type LevelRun } from '../stimd/passes/level-run.ts';

vi.mock('../stimd/passes/level-run.ts', () => ({ runMaintenanceAtLevel: vi.fn<typeof runMaintenanceAtLevel>() }));
vi.mock('../daemon/client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../daemon/client.ts')>();
  return {
    ...actual,
    stimdLive: vi.fn<typeof actual.stimdLive>(() => false),
    readGcReportThroughStimd: vi.fn<typeof actual.readGcReportThroughStimd>(async () => null),
  };
});

const PRESSURE: DaemonPressure = {
  level: 'normal',
  disk: 'normal',
  memory: 'normal',
  reasons: [],
  memoryWarningSince: null,
};
const action = {
  rung: null,
  kind: 'clear-outputs',
  target: '/cached/project',
  outcome: 'would',
  bytes: 4096,
  reason: 'idle',
  detail: '',
} as const;

let home: string;
let out: string[];
let err: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-gc-dry-run-cache-'));
  vi.stubEnv('STIM_HOME', home);
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void out.push(line));
  vi.spyOn(console, 'error').mockImplementation((line: string) => void err.push(line));
  vi.clearAllMocks();
  vi.mocked(stimdLive).mockReturnValue(false);
  vi.mocked(readGcReportThroughStimd).mockResolvedValue(null);
  vi.mocked(runMaintenanceAtLevel).mockResolvedValue({
    pressure: PRESSURE,
    level: 'normal',
    actions: [{ ...action, target: '/scanned/project' }],
    blocked: [],
    discovered: [],
    outside: [],
    usage: [],
    cachePaths: [],
    sweptCachePaths: [],
  } satisfies LevelRun);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  rmSync(home, { recursive: true, force: true });
});

function cache(measuredAt: string): GcReportCache {
  const cached: GcReportCache = {
    version: GC_REPORT_CACHE_VERSION,
    measuredAt,
    parts: { plan: measuredAt, sections: measuredAt, inventory: measuredAt },
    report: {
      mode: 'dry-run',
      level: 'normal',
      pressure: PRESSURE,
      actionable: true,
      failures: null,
      actions: [action],
      blocked: [],
      discovered: [],
      outside: [],
      results: [],
      sections: {},
      inventory: null,
    },
    run: { usage: [], cachePaths: [], sweptCachePaths: [] },
  };
  writeCacheFile(gcReportCacheFile(), cached);
  return cached;
}

test('a dry run answers from the cached report with its times and scans nothing', async () => {
  const cached = cache(new Date().toISOString());

  await runGc({ dryRun: true, json: true });
  expect(out).toHaveLength(1);
  expect(JSON.parse(out[0] ?? '')).toMatchObject({
    actions: [{ target: '/cached/project' }],
    measured: { from: 'cache', at: cached.measuredAt, parts: cached.parts },
  });

  out = [];
  await runGc({ dryRun: true });
  expect(out[0]).toMatch(/^Cached report measured .* ago, at .*; stim gc --dry-run --refresh measures again\.$/);
  expect(out.some((line) => line.includes('/cached/project'))).toBe(true);
  expect(runMaintenanceAtLevel).not.toHaveBeenCalled();
});

test('a stale cached report still answers and says how to measure again', async () => {
  cache(new Date(Date.now() - 2 * 60 * 60_000).toISOString());
  await runGc({ dryRun: true, json: true });
  expect(JSON.parse(out[0] ?? '')).toMatchObject({ measured: { from: 'cache' } });
  expect(err.join('\n')).toMatch(/cached gc report is 2h old; pass --refresh/);
  expect(readGcReportThroughStimd).toHaveBeenCalledWith({ background: true });
});

test.each([
  ['--refresh', { refresh: true }, { fresh: true }],
  ['no cached report', {}, { fresh: false }],
])('with %s and a stimd, the dry run prints the report stimd measured', async (_case, options, asked) => {
  vi.mocked(stimdLive).mockReturnValue(true);
  const swept = cache(new Date().toISOString());
  rmSync(gcReportCacheFile());
  vi.mocked(readGcReportThroughStimd).mockResolvedValue(swept);
  await runGc({ dryRun: true, json: true, ...options });
  expect(readGcReportThroughStimd).toHaveBeenCalledWith(asked, undefined, expect.any(Function));
  expect(JSON.parse(out[0] ?? '')).toMatchObject({ measured: { from: 'stimd', at: swept.measuredAt } });
  expect(runMaintenanceAtLevel).not.toHaveBeenCalled();
});

test('a refreshing dry run names each part stimd has read on stderr and keeps stdout to one payload', async () => {
  vi.mocked(stimdLive).mockReturnValue(true);
  const swept = cache(new Date().toISOString());
  vi.mocked(readGcReportThroughStimd).mockImplementation(async (_options, _signal, onPart) => {
    onPart?.({ measuredAt: swept.measuredAt, part: 'plan', at: swept.parts.plan, value: {} });
    onPart?.({ measuredAt: swept.measuredAt, part: 'sections', at: swept.parts.sections, value: {} });
    return swept;
  });
  await runGc({ dryRun: true, refresh: true, json: true });
  expect(out).toHaveLength(1);
  expect(err.filter((line) => line.includes('stimd measured the'))).toEqual([
    `Stim: stimd measured the maintenance plan (started ${swept.parts.plan}).`,
    `Stim: stimd measured the storage sections (started ${swept.parts.sections}).`,
  ]);
});

test('a dry run whose stimd refuses the report scans in this process and says why', async () => {
  vi.mocked(stimdLive).mockReturnValue(true);
  vi.mocked(readGcReportThroughStimd).mockRejectedValue(new Error('stimd is ending'));
  await runGc({ dryRun: true });
  expect(runMaintenanceAtLevel).toHaveBeenCalledOnce();
  expect(err.join('\n')).toMatch(/gc report failed \(stimd is ending\), so this dry run scans in this process/);
});

test.each([
  ['no cached report', {}, /no stimd answers .* scans in this process/],
  ['--refresh', { refresh: true }, /no stimd answers .* scans in this process/],
  ['--pressure', { pressure: 'high' as const }, /^$/],
])('with %s and no stimd, a dry run scans in this process', async (_case, options, note) => {
  cache(new Date().toISOString());
  if (!('refresh' in options) && !('pressure' in options)) rmSync(gcReportCacheFile());
  await runGc({ dryRun: true, ...options });
  expect(runMaintenanceAtLevel).toHaveBeenCalledOnce();
  expect(out.some((line) => line.includes('/scanned/project'))).toBe(true);
  expect(err.filter((line) => !line.startsWith('Stim: no gc report is cached')).join('\n')).toMatch(note);
});

test('--refresh without --dry-run is refused, since an acting gc reads every candidate fresh', async () => {
  await runGc({ refresh: true, json: true });
  expect(JSON.parse(out[0] ?? '')).toMatchObject({ code: 'STIM_BAD_ARG' });
  expect(process.exitCode).toBe(1);
  expect(runMaintenanceAtLevel).not.toHaveBeenCalled();
});
