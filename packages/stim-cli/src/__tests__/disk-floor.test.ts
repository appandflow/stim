import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonClaimRoot, daemonNdjsonFile, readDormantStage } from '@stim-cli/core/state';
import * as budget from '../stimd/passes/budget.ts';
import * as client from '../daemon/client.ts';
import { beforeCommand } from '../daemon/client.ts';
import { diskFloorGate } from '../daemon/floor.ts';
import { runPassesInProcess } from '../daemon/passes.ts';
import { HOME_PASSES_TEST_GUARD_ENV } from '../daemon/passes-guard-env.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { saveConfig, upsertProject } from '../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceLogsDir } from '../workspace/paths.ts';
import { readWorkspaceState, recordWorkspaceUse } from '../workspace/workspace-state.ts';
import { liveClaimOwner, plantClaim } from './_factories.ts';

const GB = 1024;
let home: string;
let free: number;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-floor-')));
  process.env.STIM_HOME = home;
  process.env.STIM_DISK_HARD_FLOOR_GB = '5';
  saveConfig({ version: 2, projects: {}, repos: {} });
  free = 100 * GB;
  vi.spyOn(budget, 'readVolumeSpaceAsync').mockImplementation(async () => [{ volume: '/', freeMb: free }]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetExecutor();
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  delete process.env.STIM_DISK_HARD_FLOOR_GB;
});

const gate = (env: NodeJS.ProcessEnv = process.env) =>
  diskFloorGate({ root: home, note: () => {}, env: { ...env, HOME: home, USERPROFILE: home } });

describe('with a daemon holding the home', () => {
  beforeEach(() => {
    plantClaim(daemonClaimRoot(), 'exclusive', liveClaimOwner());
  });

  test('above the hard floor it asks for no tick and refuses nothing', async () => {
    const tick = vi.spyOn(client, 'requestDaemonTick').mockResolvedValue(true);
    await expect(gate({ ...process.env, STIM_DAEMON: 'on' })).resolves.toEqual({ refusal: null });
    expect(tick).not.toHaveBeenCalled();
  });

  test('under the hard floor it runs the ladder first, and refuses STIM_LOW_DISK only when that did not free enough', async () => {
    free = 4 * GB;
    const tick = vi.spyOn(client, 'requestDaemonTick').mockImplementation(async () => {
      free = 4.5 * GB;
      return true;
    });
    await expect(gate({ ...process.env, STIM_DAEMON: 'on' })).resolves.toMatchObject({
      refusal: { code: 'STIM_LOW_DISK', message: expect.stringContaining("after the stim-daemon's pressure ladder") },
    });
    expect(tick).toHaveBeenCalledOnce();

    free = 4 * GB;
    tick.mockImplementation(async () => {
      free = 9 * GB;
      return true;
    });
    await expect(gate({ ...process.env, STIM_DAEMON: 'on' })).resolves.toEqual({ refusal: null });
  });
});

describe('with no daemon holding the home, as on Windows', () => {
  let root: string;

  beforeEach(() => {
    const real = getExecutor();
    setExecutor({ ...real, runFileQuiet: (file) => (file === 'ps' ? '' : null) });
    root = join(home, 'old');
    mkdirSync(root);
    ensureWorkspaceStorage(root);
    upsertProject(root, {});
    recordWorkspaceUse(root, new Date(Date.now() - 4 * 24 * 60 * 60_000));
    mkdirSync(workspaceLogsDir(root), { recursive: true });
    writeFileSync(join(workspaceLogsDir(root), 'metro.ndjson'), '');
    writeFileSync(join(workspaceLogsDir(root), 'device.ndjson'), '{}\n');
  });

  test('under the hard floor the gate runs the ladder in the command from rung 2', async () => {
    free = 4 * GB;
    const tick = vi.spyOn(client, 'requestDaemonTick').mockResolvedValue(false);
    await expect(gate({ ...process.env, STIM_DAEMON: 'on' })).resolves.toMatchObject({
      refusal: { code: 'STIM_LOW_DISK' },
    });
    expect(tick).toHaveBeenCalledOnce();
    expect(readDormantStage(readWorkspaceState(root))).toMatchObject({ dormantDays: 3 });
    const rungs = readFileSync(daemonNdjsonFile(), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((entry) => typeof entry.rung === 'number');
    expect(rungs.length).toBeGreaterThan(0);
    expect(rungs.every((entry) => entry.src === 'command' && entry.rung >= 2)).toBe(true);
  });

  test.each([
    { level: 'high', freeGb: 10 },
    { level: 'critical', freeGb: 5.5 },
  ])("at $level pressure a command's passes never take its own workspace", async ({ freeGb }) => {
    free = freeGb * GB;
    writeFileSync(join(root, 'package.json'), '{}');
    const other = join(home, 'other');
    mkdirSync(other);
    ensureWorkspaceStorage(other);
    upsertProject(other, {});
    recordWorkspaceUse(other, new Date(Date.now() - 4 * 24 * 60 * 60_000));
    mkdirSync(workspaceLogsDir(other), { recursive: true });
    writeFileSync(join(workspaceLogsDir(other), 'device.ndjson'), '{}\n');
    const env: NodeJS.ProcessEnv = { ...process.env, STIM_DAEMON: 'on', HOME: home, USERPROFILE: home };
    delete env[HOME_PASSES_TEST_GUARD_ENV];
    const cwd = process.cwd();
    process.chdir(root);
    try {
      await runPassesInProcess('ios', env);
    } finally {
      process.chdir(cwd);
    }
    expect(readDormantStage(readWorkspaceState(root))).toBeNull();
    expect(readDormantStage(readWorkspaceState(other))).toMatchObject({ dormantDays: 3 });
  });

  test('a command that creates running state records its use before any pass runs', async () => {
    writeFileSync(join(root, 'package.json'), '{}');
    const cwd = process.cwd();
    process.chdir(root);
    try {
      await beforeCommand(
        'ios',
        { ...process.env, STIM_DAEMON: 'off', HOME: home, USERPROFILE: home },
        { cwd: root, recordUse: true, passes: true, deviceLogs: false },
      );
    } finally {
      process.chdir(cwd);
    }
    expect(Date.now() - Date.parse(String(readWorkspaceState(root)?.lastUsedAt))).toBeLessThan(60_000);
  });

  test('at normal pressure the command runs no activity pass, so it takes no workspace dormant', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, STIM_DAEMON: 'on', HOME: home, USERPROFILE: home };
    delete env[HOME_PASSES_TEST_GUARD_ENV];
    await runPassesInProcess('ios', env);
    expect(readDormantStage(readWorkspaceState(root))).toBeNull();
    expect(existsSync(join(workspaceLogsDir(root), 'device.ndjson'))).toBe(true);
  });
});
