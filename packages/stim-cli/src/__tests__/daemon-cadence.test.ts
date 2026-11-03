import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonNdjsonFile, readDaemonSnapshot, readDormantStage } from '@stim-cli/core/state';
import * as measure from '../daemon/measure.ts';
import { runDaemon } from '../daemon/run.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import * as maintenanceRun from '../maintenance/run.ts';
import { saveConfig, upsertProject } from '../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceLogsDir } from '../workspace/paths.ts';
import { readWorkspaceState, recordWorkspaceUse } from '../workspace/workspace-state.ts';

const MINUTE_MS = 60_000;
let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-cadence-')));
  process.env.STIM_HOME = home;
  const real = getExecutor();
  setExecutor({ ...real, runFileQuiet: (file) => (file === 'ps' ? '' : null) });
  vi.spyOn(maintenanceRun, 'runMaintenance').mockResolvedValue(undefined as never);
  vi.spyOn(measure, 'measureTick').mockImplementation(async () => ({
    measurement: {
      disk: [{ volume: '/', freeMb: 500_000 }],
      memory: { level: 'normal', availableBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 },
      load1: 0,
      cores: 8,
      bootedSimulators: 0,
      runningEmulators: null,
      interaction: null,
    },
    sims: [],
    simsError: null,
    devices: [],
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  resetExecutor();
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function ticks(): { at: number; msg: string }[] {
  return readFileSync(daemonNdjsonFile(), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.event === 'daemon_tick')
    .map((entry) => ({ at: entry.ts, msg: entry.msg }));
}

test('a quiet home with a workspace not yet dormant keeps the daemon at the 5-minute cadence until dormancy, then it exits two slow ticks later', async () => {
  saveConfig({ version: 2, projects: {}, repos: {}, idle: { dormantDays: 0.01 } });
  const root = join(home, 'app');
  mkdirSync(root);
  ensureWorkspaceStorage(root);
  upsertProject(root, {});
  mkdirSync(workspaceLogsDir(root), { recursive: true });
  writeFileSync(join(workspaceLogsDir(root), 'device.ndjson'), '{}\n');
  const started = Date.now();
  recordWorkspaceUse(root, new Date(started - MINUTE_MS));

  let exited = false;
  const daemon = (async () => {
    await runDaemon({ mode: 'on' });
    exited = true;
  })();
  await vi.advanceTimersByTimeAsync(MINUTE_MS);
  await vi.waitFor(() => expect(ticks()).toHaveLength(1));
  expect(readDaemonSnapshot()).toMatchObject({ intervalMs: 5 * MINUTE_MS });
  expect(ticks()[0]?.msg).toContain('not dormant yet');

  await vi.advanceTimersByTimeAsync(2 * 5 * MINUTE_MS);
  await vi.waitFor(() => expect(ticks()).toHaveLength(3));
  expect(readDormantStage(readWorkspaceState(root))).toBeNull();

  await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
  await vi.waitFor(() => expect(ticks()).toHaveLength(4));
  expect(readDormantStage(readWorkspaceState(root))).toMatchObject({ dormantDays: 0.01 });
  expect(exited).toBe(false);

  await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
  await vi.waitFor(() => expect(ticks()).toHaveLength(5));
  expect(exited).toBe(false);
  await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
  await vi.waitFor(() => expect(exited).toBe(true));
  await daemon;
  expect(ticks().map(({ at }) => Math.round((at - started) / MINUTE_MS))).toEqual([1, 6, 11, 16, 21, 26]);
});
