import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  enforceBudget,
  inspectBudget,
  resolveBudget,
  type Budget,
  type BudgetDeps,
  type ReclaimStepName,
} from '../budget.ts';
import { upsertProject } from '../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceDir } from '../workspace/paths.ts';

const GB = 1024;
const BUDGET_ENV = [
  'STIM_BUDGET_MIN_FREE_DISK_GB',
  'STIM_BUDGET_HARD_FLOOR_DISK_GB',
  'STIM_BUDGET_MAX_COMMITTED_MEMORY_GB',
  'STIM_BUDGET_MAX_LIVE_WORKSPACES',
];

let home: string;
let apps: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-budget-'));
  apps = realpathSync(mkdtempSync(join(tmpdir(), 'stim-budget-apps-')));
  process.env.STIM_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(apps, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  for (const key of BUDGET_ENV) delete process.env[key];
});

describe('resolveBudget', () => {
  test('is on by default: 20 GB floor, 5 GB hard floor, 60% of memory, no workspace limit', () => {
    const { budget, error } = resolveBudget({ config: null, env: {}, totalMemoryMb: 32 * GB });
    expect(error).toBeNull();
    expect(budget).toEqual({
      minFreeDiskMb: 20 * GB,
      hardFloorDiskMb: 5 * GB,
      maxCommittedMemoryMb: Math.round(32 * GB * 0.6),
      maxLiveWorkspaces: 0,
    });
  });

  test('a STIM_HOME turns the budget off unless its environment variable is set', () => {
    const scoped = resolveBudget({ config: null, env: { STIM_HOME: home }, totalMemoryMb: 32 * GB });
    expect(scoped.budget).toEqual({
      minFreeDiskMb: 0,
      hardFloorDiskMb: 0,
      maxCommittedMemoryMb: 0,
      maxLiveWorkspaces: 0,
    });
    const opted = resolveBudget({
      config: null,
      env: { STIM_HOME: home, STIM_BUDGET_MIN_FREE_DISK_GB: '30', STIM_BUDGET_MAX_LIVE_WORKSPACES: '2' },
      totalMemoryMb: 32 * GB,
    });
    expect(opted.budget).toMatchObject({ minFreeDiskMb: 30 * GB, hardFloorDiskMb: 0, maxLiveWorkspaces: 2 });
  });

  test('the environment overrides the machine config, and a bad value is an error, not a default', () => {
    const config = { projects: {}, repos: {}, budget: { minFreeDiskGb: 50, hardFloorDiskGb: 0 } };
    expect(resolveBudget({ config, env: {}, totalMemoryMb: GB }).budget).toMatchObject({
      minFreeDiskMb: 50 * GB,
      hardFloorDiskMb: 0,
    });
    expect(
      resolveBudget({ config, env: { STIM_BUDGET_MIN_FREE_DISK_GB: '10' }, totalMemoryMb: GB }).budget.minFreeDiskMb,
    ).toBe(10 * GB);
    expect(resolveBudget({ config, env: { STIM_BUDGET_HARD_FLOOR_DISK_GB: 'lots' }, totalMemoryMb: GB }).error).toMatch(
      /STIM_BUDGET_HARD_FLOOR_DISK_GB/,
    );
    expect(
      resolveBudget({ config: { ...config, budget: { maxLiveWorkspaces: 1.5 } }, env: {}, totalMemoryMb: GB }).error,
    ).toMatch(/budget\.maxLiveWorkspaces/);
  });
});

function limits(overrides: Partial<Budget> = {}): Budget {
  return {
    minFreeDiskMb: 20 * GB,
    hardFloorDiskMb: 5 * GB,
    maxCommittedMemoryMb: 0,
    maxLiveWorkspaces: 0,
    ...overrides,
  };
}

function fakeDeps(freeAfterStep: number[], memory: number[] = []) {
  const steps: ReclaimStepName[] = [];
  const deps: Partial<BudgetDeps> = {
    volumes: () => [{ volume: '/', freeMb: freeAfterStep[Math.min(steps.length, freeAfterStep.length - 1)]! }],
    memory: () => ({ committedMb: memory[Math.min(steps.length, memory.length - 1)] ?? 0, liveWorkspaces: 1 }),
    step: async (step) => {
      steps.push(step);
      return { targets: [`${step}-target`], failures: 0 };
    },
    usage: () => ['Stim state /x: 59.0G'],
  };
  return { deps, steps };
}

describe('enforceBudget', () => {
  test('reclaims in order and stops as soon as free disk is back above the floor', async () => {
    const { deps, steps } = fakeDeps([10 * GB, 12 * GB, 25 * GB]);
    const outcome = await enforceBudget({ root: apps, note: () => {}, budget: limits() }, deps);
    expect(steps).toEqual(['idle-devices', 'idle-dev-servers']);
    expect(outcome).toMatchObject({
      status: 'ok',
      reclaimed: [
        { step: 'idle-devices', targets: ['idle-devices-target'], freedMb: 2 * GB },
        { step: 'idle-dev-servers', targets: ['idle-dev-servers-target'], freedMb: 13 * GB },
      ],
    });
  });

  test('memory alone reclaims devices and dev servers, never build outputs or caches, and never refuses', async () => {
    const { deps, steps } = fakeDeps([100 * GB], [30 * GB]);
    const notes: string[] = [];
    const outcome = await enforceBudget(
      { root: apps, note: (line) => notes.push(line), budget: limits({ maxCommittedMemoryMb: 16 * GB }) },
      deps,
    );
    expect(steps).toEqual(['idle-devices', 'idle-dev-servers']);
    expect(outcome.status).toBe('ok');
    expect(notes.join('\n')).toMatch(/still over budget/);
  });

  test('below the hard floor after every step, it refuses with STIM_LOW_DISK naming what uses space', async () => {
    const { deps, steps } = fakeDeps([GB]);
    const outcome = await enforceBudget({ root: apps, note: () => {}, budget: limits() }, deps);
    expect(steps).toEqual(['idle-devices', 'idle-dev-servers', 'workspace-outputs', 'stale-cache-entries']);
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    expect(outcome.refusal.code).toBe('STIM_LOW_DISK');
    expect(outcome.refusal.message).toMatch(/Stim state \/x: 59\.0G/);
    expect(outcome.refusal.remedy).toMatch(/stim gc/);
    expect(outcome.reclaimed.map((entry) => entry.step)).toEqual(steps);
  });

  test('under budget it measures and reclaims nothing', async () => {
    const { deps, steps } = fakeDeps([200 * GB]);
    const outcome = await enforceBudget({ root: apps, note: () => {}, budget: limits() }, deps);
    expect(steps).toEqual([]);
    expect(outcome).toMatchObject({ status: 'ok', reclaimed: [] });
  });
});

describe('reclaiming in a scratch STIM_HOME with a floor above the free disk', () => {
  function workspaceWithOutputs(name: string): string {
    const root = join(apps, name);
    mkdirSync(root);
    upsertProject(root, { isExpo: false });
    mkdirSync(join(ensureWorkspaceStorage(root), 'derived-data', 'Build'), { recursive: true });
    return root;
  }

  test('the dry run plans the idle workspace outputs of other workspaces and deletes nothing', async () => {
    process.env.STIM_BUDGET_MIN_FREE_DISK_GB = '1000000000';
    const current = workspaceWithOutputs('current');
    const other = workspaceWithOutputs('other');
    const outcome = await enforceBudget({ root: current, note: () => {}, dryRun: true });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    const outputs = outcome.reclaimed.find((entry) => entry.step === 'workspace-outputs');
    expect(outputs?.targets).toEqual([other]);
    expect(outcome.reclaimed.map((entry) => entry.step)).not.toContain('idle-devices');
    expect(existsSync(join(workspaceDir(other), 'derived-data'))).toBe(true);

    const doctor = await inspectBudget(current);
    expect(doctor.report?.plan.find((entry) => entry.step === 'workspace-outputs')?.targets).toEqual([other]);
    expect(doctor.findings.map((finding) => finding.title)).toContain('Free disk is below the Stim budget');
  });

  test('a real run clears only the other workspace outputs, then refuses below the hard floor', async () => {
    process.env.STIM_BUDGET_MIN_FREE_DISK_GB = '1000000000';
    process.env.STIM_BUDGET_HARD_FLOOR_DISK_GB = '1000000000';
    const current = workspaceWithOutputs('current');
    const other = workspaceWithOutputs('other');
    const outcome = await enforceBudget({ root: current, note: () => {} }, { usage: () => [] });
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    expect(outcome.refusal.code).toBe('STIM_LOW_DISK');
    expect(outcome.reclaimed.find((entry) => entry.step === 'workspace-outputs')?.targets).toEqual([other]);
    expect(existsSync(join(workspaceDir(other), 'derived-data'))).toBe(false);
    expect(existsSync(join(workspaceDir(current), 'derived-data'))).toBe(true);
  });
});
