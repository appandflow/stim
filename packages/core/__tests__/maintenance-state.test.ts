import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maintenanceDir, maintenanceStateFile } from '../state/paths.ts';
import { readMaintenanceState, type MaintenanceState } from '../state/maintenance.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-maintenance-state-'));
  process.env.STIM_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test('status readers ignore missing, corrupt and unsupported maintenance state instead of failing status', () => {
  expect(readMaintenanceState()).toBeNull();
  mkdirSync(maintenanceDir());
  const state: MaintenanceState = {
    version: 1,
    lastAt: { pressure: 10 },
    pressure: null,
    sizes: [],
    lastPass: null,
    recent: [],
    plan: [],
  };
  for (const payload of [
    '{',
    'null',
    '[]',
    JSON.stringify({ ...state, version: 2 }),
    JSON.stringify({ ...state, pressure: {} }),
    JSON.stringify({ ...state, sizes: [null] }),
    JSON.stringify({ ...state, lastAt: { pressure: 'yesterday' } }),
    JSON.stringify({ ...state, plan: [{ kind: 'clear-outputs' }] }),
    JSON.stringify({
      ...state,
      recent: [{ src: 'maintenance', ts: 1, msg: 'corrupt record', event: 'maintenance_action' }],
    }),
  ]) {
    writeFileSync(maintenanceStateFile(), payload);
    expect(readMaintenanceState()).toBeNull();
  }
  writeFileSync(maintenanceStateFile(), JSON.stringify(state));
  expect(readMaintenanceState()).toEqual(state);
});

test('state written by an acting pass is read back, and an unknown pass mode is not', () => {
  mkdirSync(maintenanceDir());
  const state: MaintenanceState = {
    version: 1,
    lastAt: { pressure: 10, worktree: 20, sweep: 30 },
    pressure: null,
    sizes: [],
    lastPass: {
      startedAt: 1,
      durationMs: 2,
      trigger: 'status',
      mode: 'on',
      freedBytes: 4096,
      actions: 1,
      stopped: 0,
      blocked: [],
    },
    recent: [],
    plan: [
      { kind: 'would-remove-worktree', target: '/w', bytes: 0, reason: 'PR #1 merged', check: 'worktree' },
      {
        kind: 'would-trim-cache',
        target: 'Build cache',
        bytes: 0,
        reason: 'old',
        dir: '/c',
        olderThanDays: 7,
        check: 'sweep',
      },
    ],
  };
  writeFileSync(maintenanceStateFile(), JSON.stringify(state));
  expect(readMaintenanceState()).toEqual(state);
  writeFileSync(maintenanceStateFile(), JSON.stringify({ ...state, lastPass: { ...state.lastPass, mode: 'maybe' } }));
  expect(readMaintenanceState()).toBeNull();
});
