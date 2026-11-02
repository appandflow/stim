import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonClaimRoot, readDormantStage } from '@stim-cli/core/state';
import * as budget from '../budget.ts';
import * as client from '../daemon/client.ts';
import { diskFloorGate } from '../daemon/floor.ts';
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
  process.env.STIM_BUDGET_HARD_FLOOR_DISK_GB = '5';
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
  delete process.env.STIM_BUDGET_HARD_FLOOR_DISK_GB;
});

const gate = (env: NodeJS.ProcessEnv = process.env) => diskFloorGate({ root: home, note: () => {}, env });

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

test('with no daemon holding the home, as on Windows, the activity and pressure passes run in the command', async () => {
  const real = getExecutor();
  setExecutor({ ...real, runFileQuiet: (file) => (file === 'ps' ? '' : null) });
  const tick = vi.spyOn(client, 'requestDaemonTick');
  const root = join(home, 'old');
  mkdirSync(root);
  ensureWorkspaceStorage(root);
  upsertProject(root, {});
  recordWorkspaceUse(root, new Date(Date.now() - 4 * 24 * 60 * 60_000));
  mkdirSync(workspaceLogsDir(root), { recursive: true });
  writeFileSync(join(workspaceLogsDir(root), 'metro.ndjson'), '');
  writeFileSync(join(workspaceLogsDir(root), 'device.ndjson'), '{}\n');

  const pending = gate({ ...process.env, STIM_DAEMON: 'on' });
  await vi.advanceTimersByTimeAsync(3_100);
  await expect(pending).resolves.toEqual({ refusal: null });

  expect(readDormantStage(readWorkspaceState(root))).toMatchObject({ dormantDays: 3 });
  expect(tick).not.toHaveBeenCalled();
});
